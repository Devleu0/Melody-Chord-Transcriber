"""코드 진행 인식.

주 엔진: BTC (Park et al., ISMIR 2019, large vocabulary 170 클래스)
예비 엔진: CQT 크로마 + 장/단 3화음 템플릿
두 엔진 모두 비트 단위로 확률을 모은 뒤 Viterbi 로 평활화하고, 베이스음으로 전위를 판정한다.
"""
import hashlib
import logging
import urllib.request
from pathlib import Path

import librosa
import numpy as np
import torch

from ..config import MODELS_DIR

log = logging.getLogger(__name__)

BTC_URL = "https://github.com/jayg996/BTC-ISMIR19/raw/master/test/btc_model_large_voca.pt"
BTC_PATH = MODELS_DIR / "btc" / "btc_model_large_voca.pt"
BTC_SHA256 = "1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51"
BTC_SR = 22050
BTC_HOP = 2048
BTC_TIMESTEP = 108
BTC_FPS = BTC_TIMESTEP / 10.0  # 원본 구현과 동일 (inst_len 10초 / 108 프레임)

QUALITIES = ["min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4"]
INTERVALS = {
    "maj": [0, 4, 7],
    "min": [0, 3, 7],
    "dim": [0, 3, 6],
    "aug": [0, 4, 8],
    "min6": [0, 3, 7, 9],
    "maj6": [0, 4, 7, 9],
    "min7": [0, 3, 7, 10],
    "minmaj7": [0, 3, 7, 11],
    "maj7": [0, 4, 7, 11],
    "7": [0, 4, 7, 10],
    "dim7": [0, 3, 6, 9],
    "hdim7": [0, 3, 6, 10],
    "sus2": [0, 2, 7],
    "sus4": [0, 5, 7],
}
N_CLASS = 169  # BTC: 168 = X(unknown), 169 = N(no chord)


def _btc_label(idx: int) -> tuple[int | None, str | None]:
    """BTC 클래스 -> (root pitch class, quality). N/X 는 (None, None)."""
    if idx >= 168:
        return None, None
    return idx // 14, QUALITIES[idx % 14]


_btc_model = None


def _load_btc():
    global _btc_model
    if _btc_model is None:
        from .btc.model import BTC_model

        if not BTC_PATH.exists():
            BTC_PATH.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(BTC_URL, BTC_PATH)
        digest = hashlib.sha256(BTC_PATH.read_bytes()).hexdigest()
        if digest != BTC_SHA256:
            raise RuntimeError(f"BTC 가중치 해시 불일치: {digest}")
        config = {
            "feature_size": 144,
            "timestep": BTC_TIMESTEP,
            "num_chords": 170,
            "input_dropout": 0.2,
            "layer_dropout": 0.2,
            "attention_dropout": 0.2,
            "relu_dropout": 0.2,
            "num_layers": 8,
            "num_heads": 4,
            "hidden_size": 128,
            "total_key_depth": 128,
            "total_value_depth": 128,
            "filter_size": 128,
            "loss": "ce",
            "probs_out": False,
        }
        device = "cuda" if torch.cuda.is_available() else "cpu"
        # pickle 임의 코드 실행 방지: 텐서 + numpy 스칼라(mean/std)만 허용
        # 체크포인트는 numpy 1.x 로 저장되어 numpy.core.* 경로를 참조한다
        safe = [
            (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"),
            (np._core.multiarray._reconstruct, "numpy.core.multiarray._reconstruct"),
            np._core.multiarray.scalar,
            np._core.multiarray._reconstruct,
            np.ndarray,
            np.dtype,
            np.dtypes.Float64DType,
            np.dtypes.Float32DType,
        ]
        with torch.serialization.safe_globals(safe):
            ckpt = torch.load(BTC_PATH, map_location="cpu", weights_only=True)
        model = BTC_model(config=config)
        model.load_state_dict(ckpt["model"])
        _btc_model = (model.eval().to(device), float(ckpt["mean"]), float(ckpt["std"]), device)
    return _btc_model


def _btc_probs(y: np.ndarray) -> tuple[np.ndarray, float]:
    """(frames, 170) 확률과 초당 프레임 수."""
    model, mean, std, device = _load_btc()
    # 원본과 동일하게 10초 단위 CQT 이어붙이기
    seg = int(BTC_SR * 10.0)
    feats = [
        librosa.cqt(y[i : i + seg], sr=BTC_SR, n_bins=144, bins_per_octave=24, hop_length=BTC_HOP)
        for i in range(0, len(y), seg)
        if len(y[i : i + seg]) > BTC_HOP
    ]
    feat = np.log(np.abs(np.concatenate(feats, axis=1)) + 1e-6).T
    feat = (feat - mean) / std
    n = feat.shape[0]
    pad = (-n) % BTC_TIMESTEP
    feat = np.pad(feat, ((0, pad), (0, 0)))
    x = torch.tensor(feat, dtype=torch.float32, device=device).unsqueeze(0)
    out = []
    with torch.no_grad():
        for t in range(feat.shape[0] // BTC_TIMESTEP):
            h, _ = model.self_attn_layers(x[:, t * BTC_TIMESTEP : (t + 1) * BTC_TIMESTEP])
            logits = model.output_layer.output_projection(h)
            out.append(torch.softmax(logits, -1)[0].cpu().numpy())
    return np.concatenate(out)[:n], BTC_FPS


def _template_probs(y: np.ndarray) -> tuple[np.ndarray, float, list[tuple[int | None, str | None]]]:
    """예비: 크로마-템플릿 유사도를 확률처럼 사용 (장/단 24 + N)."""
    hop = 2048
    chroma = librosa.feature.chroma_cqt(y=y, sr=BTC_SR, hop_length=hop).T  # (T, 12)
    labels: list[tuple[int | None, str | None]] = []
    templates = []
    for q in ("maj", "min"):
        for r in range(12):
            t = np.zeros(12)
            t[[(r + i) % 12 for i in INTERVALS[q]]] = 1
            templates.append(t / np.linalg.norm(t))
            labels.append((r, q))
    labels.append((None, None))
    T = np.array(templates)
    energy = chroma.sum(1, keepdims=True)
    sim = (chroma / np.maximum(np.linalg.norm(chroma, axis=1, keepdims=True), 1e-9)) @ T.T
    no_chord = np.where(energy < 0.5, 1.0, 0.3)
    # 코사인 유사도 차이가 작아 대비를 크게 줘야 Viterbi 변경 패널티를 넘을 수 있다
    scores = np.concatenate([sim, no_chord], axis=1) * 25
    probs = np.exp(scores - scores.max(1, keepdims=True))
    probs /= probs.sum(1, keepdims=True)
    return probs, BTC_SR / hop, labels


def _beat_sync(probs: np.ndarray, fps: float, bounds: np.ndarray) -> np.ndarray:
    """프레임 확률을 비트 구간 평균으로."""
    out = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        i0, i1 = int(a * fps), max(int(a * fps) + 1, int(b * fps))
        out.append(probs[i0:i1].mean(0) if i0 < len(probs) else probs[-1])
    return np.array(out)


def _viterbi(probs: np.ndarray, change_penalty: float) -> np.ndarray:
    """코드가 바뀔 때 고정 패널티를 주는 Viterbi (구간마다 최적 경로)."""
    logp = np.log(probs + 1e-9)
    n, k = logp.shape
    score = logp[0].copy()
    back = np.zeros((n, k), dtype=np.int32)
    for i in range(1, n):
        best_prev = int(score.argmax())
        switch = score[best_prev] - change_penalty
        stay = score >= switch
        back[i] = np.where(stay, np.arange(k), best_prev)
        score = np.where(stay, score, switch) + logp[i]
    path = np.zeros(n, dtype=np.int32)
    path[-1] = int(score.argmax())
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return path


def _bass_pc(bass_notes: list[dict], start: float, end: float) -> int | None:
    """구간에서 가장 오래 울린 저음 pitch class (구간 길이의 40% 이상일 때만)."""
    weight = np.zeros(12)
    for n in bass_notes:
        overlap = min(end, n["end"]) - max(start, n["start"])
        if overlap > 0:
            weight[n["pitch"] % 12] += overlap
    if weight.max() < 0.4 * (end - start):
        return None
    return int(weight.argmax())


def recognize_chords(
    wav: Path,
    beats: list[float],
    duration: float,
    bass_notes: list[dict],
    change_penalty: float = 3.0,
) -> dict:
    y, _ = librosa.load(str(wav), sr=BTC_SR, mono=True)
    try:
        probs, fps = _btc_probs(y)
        labels = [_btc_label(i) for i in range(170)]
        engine = "btc"
    except Exception:
        log.exception("BTC 실패, 템플릿 엔진으로 대체")
        probs, fps, labels = _template_probs(y)
        engine = "template"

    # 비트가 없으면 0.5초 격자
    grid = np.array(beats) if len(beats) > 1 else np.arange(0, duration, 0.5)
    bounds = np.unique(np.concatenate([[0.0], grid[grid < duration], [duration]]))
    bounds = bounds[np.concatenate([[True], np.diff(bounds) > 0.05])]
    # 템플릿 엔진은 확률 대비가 약해 패널티를 낮춘다
    penalty = change_penalty if engine == "btc" else change_penalty * 0.5
    path = _viterbi(_beat_sync(probs, fps, bounds), penalty)

    chords = []
    i = 0
    while i < len(path):
        j = i
        while j + 1 < len(path) and path[j + 1] == path[i]:
            j += 1
        root, quality = labels[path[i]]
        start, end = float(bounds[i]), float(bounds[j + 1])
        if root is not None:
            pcs = [(root + iv) % 12 for iv in INTERVALS[quality]]
            bass = _bass_pc(bass_notes, start, end)
            chords.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "root": root,
                "quality": quality,
                # 근음이 아닌 구성음이 베이스면 전위 (C/E). 비구성음 베이스는 무시
                "bass": bass if bass is not None and bass != root and bass in pcs else None,
                "pcs": pcs,
            })
        i = j + 1
    return {"engine": engine, "chords": chords}
