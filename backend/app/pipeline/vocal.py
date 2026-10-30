"""보컬 stem -> RMVPE f0 -> 노트 분할."""
from pathlib import Path

import librosa
import numpy as np
from scipy.ndimage import median_filter

from .rmvpe import HOP, RMVPE, SR

FPS = SR / HOP  # 100

# UI 에서 조정 가능한 파라미터와 기본값
DEFAULT_PARAMS = {"conf_threshold": 0.3, "min_note_sec": 0.08, "silence_db": -40.0}

_model: RMVPE | None = None


def _get_model() -> RMVPE:
    global _model
    if _model is None:
        _model = RMVPE()
    return _model


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """True 구간들의 [start, end) 프레임 목록."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def _analyze(wav: Path, cache: Path | None) -> dict[str, np.ndarray]:
    """f0/신뢰도/에너지/온셋. 재채보 시 GPU 추론을 건너뛰도록 npz 로 캐시."""
    if cache and cache.exists():
        return dict(np.load(cache))
    audio, _ = librosa.load(str(wav), sr=SR, mono=True)
    f0, conf = _get_model().infer(audio, threshold=0.03)
    n = len(f0)
    rms = librosa.feature.rms(y=audio, frame_length=1024, hop_length=HOP, center=True)[0][:n]
    rms = np.pad(rms, (0, n - len(rms)))
    db = librosa.amplitude_to_db(rms, ref=np.max(rms) + 1e-9)
    onset_env = librosa.onset.onset_strength(y=audio, sr=SR, hop_length=HOP)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=SR, hop_length=HOP, delta=0.2, backtrack=False)
    data = {"f0": f0, "conf": conf, "db": db, "onsets": np.asarray(onsets, dtype=np.int64)}
    if cache:
        np.savez_compressed(cache, **data)
    return data


def transcribe_vocal(wav: Path, params: dict | None = None, cache: Path | None = None) -> dict:
    p = {**DEFAULT_PARAMS, **(params or {})}
    a = _analyze(wav, cache)
    f0, conf, db = a["f0"], a["conf"], a["db"]
    onsets = set(a["onsets"].tolist())
    n = len(f0)

    # 분리 잔향/숨소리 제거용 에너지 게이트 (최대 대비 silence_db 이하 무시)
    voiced = (f0 > 0) & (conf >= p["conf_threshold"]) & (db > p["silence_db"])
    midi = np.zeros(n, dtype=np.float32)
    midi[voiced] = librosa.hz_to_midi(f0[voiced])

    min_frames = max(1, int(round(p["min_note_sec"] * FPS)))
    notes = []
    for a0, b0 in _runs(voiced):
        if b0 - a0 < min_frames:
            continue
        seg = midi[a0:b0]
        # 비브라토(±0.5 반음 내외)는 평활화해 하나의 음으로 본다
        smooth = median_filter(seg, size=min(9, (b0 - a0) | 1), mode="nearest")
        q = np.round(smooth).astype(int)

        # 반올림 음높이가 min_frames 이상 유지될 때만 경계로 인정
        bounds = [0]
        cur = q[0]
        i = 1
        while i < len(q):
            if q[i] != cur:
                j = i
                while j < len(q) and q[j] == q[i]:
                    j += 1
                if j - i >= min_frames:
                    bounds.append(i)
                    cur = q[i]
                i = j
            else:
                if (a0 + i) in onsets and i - bounds[-1] >= min_frames and len(q) - i >= min_frames:
                    bounds.append(i)
                i += 1
        bounds.append(len(q))

        for s, e in zip(bounds[:-1], bounds[1:]):
            if e - s < min_frames:
                continue
            pitch = int(np.round(np.median(seg[s:e])))
            vel_db = float(np.mean(db[a0 + s : a0 + e]))
            velocity = int(np.clip(127 + vel_db * 2.0, 30, 127))
            notes.append({
                "pitch": pitch,
                "start": round((a0 + s) / FPS, 3),
                "end": round((a0 + e) / FPS, 3),
                "velocity": velocity,
            })

    # 피아노롤에 겹쳐 그릴 연속 피치 곡선 (무성 = None)
    curve = [round(float(m), 2) if v else None for m, v in zip(midi, voiced)]
    return {"notes": notes, "pitch_curve": {"fps": FPS, "values": curve}, "params": p}
