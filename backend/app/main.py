import subprocess
from dataclasses import asdict
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import jobs
from .config import DATA_DIR
from .jobs import JobManager

app = FastAPI(title="yt-amt")
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
