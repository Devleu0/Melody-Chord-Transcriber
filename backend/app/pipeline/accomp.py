"""반주 계열 stem -> Basic Pitch(ONNX) 다성 채보."""
from pathlib import Path

# UI 에서 조정 가능한 파라미터와 기본값
DEFAULT_PARAMS = {"onset_threshold": 0.5, "frame_threshold": 0.3, "minimum_note_length": 80.0}

# 트랙별 Basic Pitch 주파수 범위 (Hz 범위 제한으로 잡음 노트 감소)
TRACK_RANGES = {
    "bass": {"minimum_frequency": 30.0, "maximum_frequency": 400.0},
    "other": {"minimum_frequency": 60.0},
    "accompaniment": {"minimum_frequency": 40.0},
}


def transcribe_poly(wav: Path, track: str, params: dict | None = None) -> dict:
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    p = {**DEFAULT_PARAMS, **(params or {})}
    _, _, note_events = predict(
        str(wav),
        ICASSP_2022_MODEL_PATH,
        onset_threshold=p["onset_threshold"],
        frame_threshold=p["frame_threshold"],
        minimum_note_length=p["minimum_note_length"],
        melodia_trick=True,
        **TRACK_RANGES.get(track, {}),
    )
    notes = [
        {
            "pitch": int(pitch),
            "start": round(float(start), 3),
            "end": round(float(end), 3),
            "velocity": int(min(127, max(20, round(amp * 127)))),
        }
        for start, end, pitch, amp, _ in note_events
    ]
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return {"notes": notes, "params": p}
