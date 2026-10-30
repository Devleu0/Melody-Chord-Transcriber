from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data" / "jobs"
MODELS_DIR = BACKEND_DIR / "models"

DATA_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# Reject overly long videos (4GB VRAM / processing time)
MAX_DURATION_SEC = 15 * 60

SEPARATORS = {
    # Vocals/accompaniment 2-stem, top-tier vocal quality
    "roformer": "vocals_mel_band_roformer.ckpt",
    # Vocals/drums/bass/other 4-stem
    "demucs": "htdemucs_ft.yaml",
}
