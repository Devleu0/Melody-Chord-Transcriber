from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data" / "jobs"
MODELS_DIR = BACKEND_DIR / "models"

DATA_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# 너무 긴 영상은 4GB VRAM / 처리 시간 때문에 거절
MAX_DURATION_SEC = 15 * 60

SEPARATORS = {
    # 보컬/반주 2분리, 보컬 품질 최상급
    "roformer": "vocals_mel_band_roformer.ckpt",
    # 보컬/드럼/베이스/기타 4분리
    "demucs": "htdemucs_ft.yaml",
}
