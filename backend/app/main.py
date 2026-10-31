import functools
import subprocess
from dataclasses import asdict
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import jobs
from .config import (
    DATA_DIR,
    GPU_SECONDS_PER_AUDIO_SECOND,
    MAX_DURATION_SEC,
    MAX_UPLOAD_BYTES,
    MIN_DURATION_SEC,
    UPLOAD_EXTS,
    WARN_DURATION_SEC,
)
from .jobs import JobManager

app = FastAPI(title="Melody Chord Transcriber")
manager = JobManager()


class JobRequest(BaseModel):
    url: str
    separator: Literal["roformer", "demucs"] = "roformer"


class NoteModel(BaseModel):
    pitch: int = Field(ge=0, le=127)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    velocity: int = Field(ge=1, le=127)


class NotesRequest(BaseModel):
    notes: list[NoteModel]


class RetranscribeRequest(BaseModel):
    params: dict[str, float] = {}


class ChordRequest(BaseModel):
    change_penalty: float = Field(default=3.0, ge=0.0, le=20.0)


def _public(job) -> dict:
    return asdict(job)


def _done_dir(job_id: str):
    job = manager.jobs.get(job_id)
    if not job or job.status != "done":
        raise HTTPException(404, "Job is not finished")
    return job.dir


@app.post("/api/jobs")
def create_job(req: JobRequest):
    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(400, "Invalid URL format")
    return _public(manager.submit(req.url, req.separator))


class ProbeRequest(BaseModel):
    url: str


@functools.cache
def _device() -> dict:
    import torch  # deferred: importing torch takes a couple of seconds

    if torch.cuda.is_available():
        return {"device": "cuda", "gpu": torch.cuda.get_device_name(0)}
    return {"device": "cpu", "gpu": None}


@app.get("/api/info")
def info():
    """Limits and hardware, so the UI can validate input and estimate processing time."""
    return {
        **_device(),
        "min_duration": MIN_DURATION_SEC,
        "warn_duration": WARN_DURATION_SEC,
        "max_duration": MAX_DURATION_SEC,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "upload_exts": sorted(UPLOAD_EXTS),
        "gpu_seconds_per_audio_second": GPU_SECONDS_PER_AUDIO_SECOND,
    }


def _job_media_key(job) -> str | None:
    from .pipeline.download import legacy_media_key

    meta = job.meta or {}
    if meta.get("media_key"):
        return meta["media_key"]
    if meta.get("video_id"):  # jobs from before media_key was introduced
        return f"Youtube:{meta['video_id']}"
    return legacy_media_key(job.url) if job.source != "file" else None


def _duplicates(key: str | None) -> list[dict]:
    """Earlier jobs for the same media item on the same site (finished or still running)."""
    if not key:
        return []
    found = [j for j in manager.jobs.values() if j.status != "error" and _job_media_key(j) == key]
    found.sort(key=lambda j: j.created_at, reverse=True)
    return [{"id": j.id, "separator": j.separator, "status": j.status, "created_at": j.created_at} for j in found]


@app.post("/api/probe")
def probe_url(req: ProbeRequest):
    """Fetch title / duration / thumbnail without downloading, plus earlier jobs for the same media."""
    from .pipeline.download import DownloadError, probe

    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(400, "Invalid URL format")
    try:
        meta = probe(req.url)
    except DownloadError as e:
        raise HTTPException(422, str(e))
    return {**meta, "duplicates": _duplicates(meta["media_key"])}


@app.post("/api/jobs/upload")
async def upload_job(file: UploadFile, separator: Literal["roformer", "demucs"] = Form("roformer")):
    """Start a job from a local audio (or video) file instead of a link."""
    name = Path(file.filename or "audio").name
    ext = Path(name).suffix.lower()
    if ext not in UPLOAD_EXTS:
        raise HTTPException(400, f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(UPLOAD_EXTS))}")
    job = manager.create(name, separator, source="file")
    # The stored name is fixed by the server; the original name is kept only as the job title
    dest = job.dir / f"upload{ext}"
    size = 0
    try:
        with open(dest, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "Empty file")
    except BaseException:
        manager.discard(job)
        raise
    manager.enqueue(job)
    return _public(job)


@app.get("/api/jobs")
def list_jobs():
    items = sorted(manager.jobs.values(), key=lambda j: j.created_at, reverse=True)
    return [_public(j) for j in items]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = manager.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return _public(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    try:
        manager.delete(job_id)
    except KeyError:
        raise HTTPException(404, "job not found")
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.get("/api/jobs/{job_id}/result")
def get_result(job_id: str):
    job = manager.jobs.get(job_id)
    path = DATA_DIR / job_id / "result.json"
    if not job or not path.exists():
        raise HTTPException(404, "result not ready")
    return FileResponse(path, media_type="application/json")


@app.put("/api/jobs/{job_id}/tracks/{track}/notes")
def put_notes(job_id: str, track: str, req: NotesRequest):
    """Save edited notes + regenerate MIDI."""
    try:
        jobs.update_notes(_done_dir(job_id), track, [n.model_dump() for n in req.notes if n.end > n.start])
    except KeyError:
        raise HTTPException(404, "track not found")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/tracks/{track}/retranscribe")
def post_retranscribe(job_id: str, track: str, req: RetranscribeRequest):
    """Re-transcribe only this track with new parameters (vocals reuse the f0 cache)."""
    try:
        return jobs.retranscribe(_done_dir(job_id), track, req.params)
    except KeyError:
        raise HTTPException(404, "track not found")


@app.post("/api/jobs/{job_id}/chords")
def post_chords(job_id: str, req: ChordRequest):
    """Re-analyze only the chord progression (also works on existing jobs)."""
    return jobs.reanalyze_chords(_done_dir(job_id), req.change_penalty)


@app.get("/api/jobs/{job_id}/musicxml")
def get_musicxml(job_id: str, track: str = "vocals"):
    """Lead-sheet MusicXML: monophonic melody + chord symbols."""
    from .pipeline.export import write_musicxml

    job_dir = _done_dir(job_id)
    result = jobs.load_result(job_dir)
    entry = next((t for t in result["tracks"] if t["id"] == track and t.get("notes") is not None), None)
    if entry is None:
        raise HTTPException(404, "track not found")
    out = job_dir / "export" / f"{track}.musicxml"
    out.parent.mkdir(exist_ok=True)
    chords = (result.get("chords") or {}).get("chords") or []
    title = (result.get("meta") or {}).get("title") or job_id
    write_musicxml(entry["notes"], chords, result["beats"], result["tempo"], title, out)
    return FileResponse(out, media_type="application/vnd.recordare.musicxml+xml", filename=f"{track}.musicxml")


SPEEDS = {0.5, 0.6, 0.75, 0.9}


@app.get("/api/jobs/{job_id}/audio")
def get_stretched_audio(job_id: str, path: str, speed: float):
    """Pitch-preserving tempo-changed audio (ffmpeg atempo). Cached in the job folder."""
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
            raise HTTPException(500, f"ffmpeg failed: {proc.stderr[-300:]}")
        tmp.replace(out)
    return FileResponse(out, media_type="audio/wav")


# Stem wav / MIDI files (data/jobs/{id}/...)
app.mount("/files", StaticFiles(directory=DATA_DIR), name="files")
