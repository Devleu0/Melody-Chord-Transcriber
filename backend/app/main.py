import subprocess
from dataclasses import asdict
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import DATA_DIR
from .jobs import JobManager

app = FastAPI(title="yt-amt")
manager = JobManager()


class JobRequest(BaseModel):
    url: str
    separator: Literal["roformer", "demucs"] = "roformer"


def _public(job) -> dict:
    return asdict(job)


@app.post("/api/jobs")
def create_job(req: JobRequest):
    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL 형식이 올바르지 않습니다")
    return _public(manager.submit(req.url, req.separator))


@app.get("/api/jobs")
def list_jobs():
    jobs = sorted(manager.jobs.values(), key=lambda j: j.created_at, reverse=True)
    return [_public(j) for j in jobs]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = manager.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return _public(job)


@app.get("/api/jobs/{job_id}/result")
def get_result(job_id: str):
    job = manager.jobs.get(job_id)
    path = DATA_DIR / job_id / "result.json"
    if not job or not path.exists():
        raise HTTPException(404, "result not ready")
    return FileResponse(path, media_type="application/json")


SPEEDS = {0.5, 0.6, 0.75, 0.9}


@app.get("/api/jobs/{job_id}/audio")
def get_stretched_audio(job_id: str, path: str, speed: float):
    """음정 유지 속도 변환(ffmpeg atempo) 오디오. 결과는 job 폴더에 캐시."""
    if speed not in SPEEDS:
        raise HTTPException(400, f"speed must be one of {sorted(SPEEDS)}")
    job_dir = (DATA_DIR / job_id).resolve()
    src = (job_dir / path).resolve()
    if job_dir not in src.parents or src.suffix != ".wav" or not src.exists():
        raise HTTPException(404, "audio not found")
    out = job_dir / "speed" / f"{speed}" / src.relative_to(job_dir)
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp.wav")
        proc = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-filter:a", f"atempo={speed}", str(tmp)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise HTTPException(500, f"ffmpeg 실패: {proc.stderr[-300:]}")
        tmp.replace(out)
    return FileResponse(out, media_type="audio/wav")


# 스템 wav / MIDI 파일 (data/jobs/{id}/...)
app.mount("/files", StaticFiles(directory=DATA_DIR), name="files")
