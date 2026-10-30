from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data" / "jobs"
MODELS_DIR = BACKEND_DIR / "models"

DATA_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# Reject overly long videos (4GB VRAM / processing time)
MAX_DURATION_SEC = 15 * 60
# Too short for beat tracking / chord analysis to mean anything
MIN_DURATION_SEC = 10
# Above this the UI warns about processing time and GPU memory
WARN_DURATION_SEC = 8 * 60

# Rough processing time per second of audio on a CUDA GPU, measured on an RTX 3050 Laptop (4 GB)
GPU_SECONDS_PER_AUDIO_SECOND = {"roformer": 0.65, "demucs": 0.5}

# Local file uploads: anything ffmpeg can decode; video containers keep only the audio track
UPLOAD_EXTS = {
    ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wma", ".aif", ".aiff",
    ".webm", ".mp4", ".mkv", ".mov",
}
MAX_UPLOAD_BYTES = 300 * 1024 * 1024

SEPARATORS = {
    # Vocals/accompaniment 2-stem, top-tier vocal quality
    "roformer": "vocals_mel_band_roformer.ckpt",
    # Vocals/drums/bass/other 4-stem
    "demucs": "htdemucs_ft.yaml",
}
