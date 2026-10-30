import logging
import re
from pathlib import Path

import numpy as np
import soundfile as sf

from ..config import MODELS_DIR, SEPARATORS

# Stem labels like "(Vocals)" in audio-separator output filenames -> our track id
STEM_IDS = {
    "vocals": "vocals",
    "instrumental": "accompaniment",
    "other": "other",
    "drums": "drums",
    "bass": "bass",
}


def separate(source: Path, stems_dir: Path, engine: str) -> dict[str, Path]:
    """Separate source.wav and return {track_id: wav_path}. The accompaniment is always included."""
    from audio_separator.separator import Separator

    stems_dir.mkdir(parents=True, exist_ok=True)
    sep = Separator(
        log_level=logging.WARNING,
        model_file_dir=str(MODELS_DIR),
        output_dir=str(stems_dir),
        output_format="WAV",
        # For 4GB VRAM: fewer demucs shifts to save time/memory
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
        raise RuntimeError(f"Vocal stem not found: {outputs}")

    if "accompaniment" not in stems and not ({"drums", "bass"} & stems.keys()) and "other" in stems:
        # Some 2-stem models (Kim Mel-RoFormer) output the accompaniment as "(Other)"
        target = stems_dir / "accompaniment.wav"
        target.unlink(missing_ok=True)
        stems["other"].rename(target)
        stems["accompaniment"] = target
        del stems["other"]

    if "accompaniment" not in stems:
        # demucs: sum of non-vocal stems = accompaniment (for playback)
        parts = [sf.read(stems[k], dtype="float32") for k in ("drums", "bass", "other") if k in stems]
        sr = parts[0][1]
        n = min(len(p[0]) for p in parts)
        mix = np.sum([p[0][:n] for p in parts], axis=0)
        mix = np.clip(mix, -1.0, 1.0)
        target = stems_dir / "accompaniment.wav"
        sf.write(target, mix, sr)
        stems["accompaniment"] = target

    return stems
