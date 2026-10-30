import logging
import re
from pathlib import Path

import numpy as np
import soundfile as sf

from ..config import MODELS_DIR, SEPARATORS

# audio-separator 출력 파일명의 "(Vocals)" 같은 stem 표기 -> 우리 트랙 id
STEM_IDS = {
    "vocals": "vocals",
    "instrumental": "accompaniment",
    "other": "other",
    "drums": "drums",
    "bass": "bass",
}


def separate(source: Path, stems_dir: Path, engine: str) -> dict[str, Path]:
    """source.wav 를 분리해 {track_id: wav_path} 반환. 반주(accompaniment)는 항상 포함된다."""
    from audio_separator.separator import Separator

    stems_dir.mkdir(parents=True, exist_ok=True)
    sep = Separator(
        log_level=logging.WARNING,
        model_file_dir=str(MODELS_DIR),
        output_dir=str(stems_dir),
        output_format="WAV",
        # 4GB VRAM 대응: demucs shift 수를 줄여 속도/메모리 절약
        demucs_params={"segment_size": "Default", "shifts": 1, "overlap": 0.25, "segments_enabled": True},
    )
    sep.load_model(model_filename=SEPARATORS[engine])
    outputs = sep.separate(str(source))

    stems: dict[str, Path] = {}
    for name in outputs:
        path = Path(name)
        if not path.is_absolute():
            path = stems_dir / path
        m = re.search(r"_\(([^)]+)\)", path.name)
        if not m:
            continue
        stem = STEM_IDS.get(m.group(1).lower())
        if stem is None:
            continue
        target = stems_dir / f"{stem}.wav"
        target.unlink(missing_ok=True)
        path.rename(target)
        stems[stem] = target

    if "vocals" not in stems:
        raise RuntimeError(f"보컬 stem 을 찾지 못했습니다: {outputs}")

    if "accompaniment" not in stems and not ({"drums", "bass"} & stems.keys()) and "other" in stems:
        # 2-stem 모델 중 일부(Kim Mel-RoFormer)는 반주를 "(Other)"로 출력
        target = stems_dir / "accompaniment.wav"
        target.unlink(missing_ok=True)
        stems["other"].rename(target)
        stems["accompaniment"] = target
        del stems["other"]

    if "accompaniment" not in stems:
        # demucs: 보컬 외 stem 합 = 반주 (재생용)
        parts = [sf.read(stems[k], dtype="float32") for k in ("drums", "bass", "other") if k in stems]
        sr = parts[0][1]
        n = min(len(p[0]) for p in parts)
        mix = np.sum([p[0][:n] for p in parts], axis=0)
        mix = np.clip(mix, -1.0, 1.0)
        target = stems_dir / "accompaniment.wav"
        sf.write(target, mix, sr)
        stems["accompaniment"] = target

    return stems
