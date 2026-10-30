"""Vocal stem -> RMVPE f0 -> note segmentation."""
from pathlib import Path

import librosa
import numpy as np
from scipy.ndimage import median_filter

from .rmvpe import HOP, RMVPE, SR

FPS = SR / HOP  # 100

# Parameters adjustable from the UI, with defaults
DEFAULT_PARAMS = {"conf_threshold": 0.3, "min_note_sec": 0.08, "silence_db": -40.0}

_model: RMVPE | None = None


def _get_model() -> RMVPE:
    global _model
    if _model is None:
        _model = RMVPE()
    return _model


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """List of [start, end) frame ranges where the mask is True."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def _analyze(wav: Path, cache: Path | None) -> dict[str, np.ndarray]:
    """f0/confidence/energy/onsets. Cached as npz so re-transcription skips GPU inference."""
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

    # Energy gate to drop residual reverb/breaths from separation (ignore frames below silence_db relative to the max)
    voiced = (f0 > 0) & (conf >= p["conf_threshold"]) & (db > p["silence_db"])
    midi = np.zeros(n, dtype=np.float32)
    midi[voiced] = librosa.hz_to_midi(f0[voiced])

    min_frames = max(1, int(round(p["min_note_sec"] * FPS)))
    notes = []
    for a0, b0 in _runs(voiced):
        if b0 - a0 < min_frames:
            continue
        seg = midi[a0:b0]
        # Smooth out vibrato (about ±0.5 semitone) so it reads as one note
        smooth = median_filter(seg, size=min(9, (b0 - a0) | 1), mode="nearest")
        q = np.round(smooth).astype(int)

        # Accept a boundary only when the rounded pitch holds for at least min_frames
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

    # Continuous pitch curve drawn over the piano roll (unvoiced = None)
    curve = [round(float(m), 2) if v else None for m, v in zip(midi, voiced)]
    return {"notes": notes, "pitch_curve": {"fps": FPS, "values": curve}, "params": p}
