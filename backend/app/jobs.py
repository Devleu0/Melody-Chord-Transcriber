"""단일 GPU 워커로 작업을 순차 처리하는 간단한 in-process 큐와 결과 편집 연산."""
import json
import queue
import shutil
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import DATA_DIR

STAGES = ["queued", "downloading", "separating", "transcribing", "chords", "finalizing", "done"]

# 파이프라인 워커와 재분석 API 가 GPU 를 동시에 쓰지 않도록 직렬화
gpu_lock = threading.Lock()


@dataclass
class Job:
    id: str
    url: str
    separator: str
    status: str = "queued"
    message: str = "대기 중"
    progress: float = 0.0
    error: str | None = None
    meta: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)

    @property
    def dir(self) -> Path:
        return DATA_DIR / self.id

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "job.json").write_text(json.dumps(asdict(self), ensure_ascii=False), encoding="utf-8")


def _bass_notes(result: dict) -> list[dict]:
    """전위 판정용 저음 노트: demucs 는 베이스 트랙, 그 외는 반주의 E3 이하."""
    tracks = {t["id"]: t for t in result["tracks"]}
    if "bass" in tracks and tracks["bass"].get("notes") is not None:
        return tracks["bass"]["notes"]
    return [n for n in tracks.get("accompaniment", {}).get("notes") or [] if n["pitch"] <= 52]


def _duration(job_dir: Path) -> float:
    import soundfile as sf

    return float(sf.info(job_dir / "source.wav").duration)


class JobManager:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self.q: queue.Queue[str] = queue.Queue()
        self._load_existing()
        threading.Thread(target=self._worker, daemon=True).start()

    def _load_existing(self) -> None:
        for f in DATA_DIR.glob("*/job.json"):
            job = Job(**json.loads(f.read_text(encoding="utf-8")))
            if job.status not in ("done", "error"):
                job.status, job.error, job.message = "error", "서버 재시작으로 중단됨", "중단됨"
            self.jobs[job.id] = job

    def submit(self, url: str, separator: str) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], url=url, separator=separator)
        job.save()
        self.jobs[job.id] = job
        self.q.put(job.id)
        return job

    def delete(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.status not in ("done", "error"):
            raise RuntimeError("진행 중인 작업은 삭제할 수 없습니다")
        del self.jobs[job_id]
        shutil.rmtree(job.dir, ignore_errors=True)

    def _update(self, job: Job, status: str, message: str, progress: float) -> None:
        job.status, job.message, job.progress = status, message, progress
        job.save()

    def _worker(self) -> None:
        while True:
            job = self.jobs.get(self.q.get())
            if job is None:
                continue
            try:
                with gpu_lock:
                    self._run(job)
            except Exception as e:
                traceback.print_exc()
                job.error = str(e)
                self._update(job, "error", "실패", job.progress)

    def _run(self, job: Job) -> None:
        # 무거운 모듈은 워커에서 지연 import (서버 기동을 빠르게)
        from .pipeline.accomp import transcribe_poly
        from .pipeline.chords import recognize_chords
        from .pipeline.download import download_audio
        from .pipeline.export import analyze_beats
        from .pipeline.separate import separate
        from .pipeline.vocal import transcribe_vocal

        self._update(job, "downloading", "YouTube 오디오 다운로드 중", 0.05)
        job.meta = download_audio(job.url, job.dir)
        source = job.dir / "source.wav"

        self._update(job, "separating", f"음원 분리 중 ({job.separator})", 0.15)
        stems = separate(source, job.dir / "stems", job.separator)

        # 채보 대상: 보컬은 RMVPE, 나머지는 Basic Pitch. 드럼은 재생만.
        targets = ["vocals"] + (["bass", "other"] if job.separator == "demucs" else ["accompaniment"])
        transcribed: dict[str, dict] = {}
        for i, name in enumerate(targets):
            self._update(job, "transcribing", f"채보 중: {name}", 0.5 + 0.3 * i / len(targets))
            if name == "vocals":
                transcribed[name] = transcribe_vocal(stems[name], cache=job.dir / "vocal_f0.npz")
            else:
                transcribed[name] = transcribe_poly(stems[name], name)

        self._update(job, "chords", "비트 / 코드 진행 분석 중", 0.85)
        beats = analyze_beats(source)
        tracks = [{"id": "mix", "kind": "audio", "audio": "source.wav"}]
        for stem in stems:
            tracks.append({
                "id": stem,
                "kind": "midi" if stem in transcribed else "audio",
                "audio": f"stems/{stem}.wav",
                "midi": f"midi/{stem}.mid" if stem in transcribed else None,
                **transcribed.get(stem, {}),
            })
        result = {"job_id": job.id, "meta": job.meta, "separator": job.separator, **beats, "tracks": tracks}
        result["chords"] = recognize_chords(stems["accompaniment"], beats["beats"], _duration(job.dir), _bass_notes(result))

        self._update(job, "finalizing", "MIDI 생성", 0.95)
        save_result(job.dir, result)
        self._update(job, "done", "완료", 1.0)


# --- 결과 편집 연산 (API 에서 호출) ---


def load_result(job_dir: Path) -> dict:
    return json.loads((job_dir / "result.json").read_text(encoding="utf-8"))


def save_result(job_dir: Path, result: dict) -> None:
    """result.json 저장 + MIDI 재생성 (전체 / 트랙별 / 코드)."""
    from .pipeline.export import write_midi

    midi_dir = job_dir / "midi"
    midi_dir.mkdir(exist_ok=True)
    note_tracks = {t["id"]: t["notes"] for t in result["tracks"] if t.get("notes") is not None}
    chords = (result.get("chords") or {}).get("chords") or []
    tempo = result.get("tempo", 120.0)
    write_midi(note_tracks, midi_dir / "all.mid", tempo, chords)
    for k, notes in note_tracks.items():
        write_midi({k: notes}, midi_dir / f"{k}.mid", tempo)
    write_midi({}, midi_dir / "chords.mid", tempo, chords)
    tmp = job_dir / "result.json.tmp"
    tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    tmp.replace(job_dir / "result.json")


def reanalyze_chords(job_dir: Path, change_penalty: float) -> dict:
    from .pipeline.chords import recognize_chords

    result = load_result(job_dir)
    with gpu_lock:
        result["chords"] = recognize_chords(
            job_dir / "stems" / "accompaniment.wav",
            result["beats"],
            _duration(job_dir),
            _bass_notes(result),
            change_penalty=change_penalty,
        )
    result["chords"]["change_penalty"] = change_penalty
    save_result(job_dir, result)
    return result["chords"]


def retranscribe(job_dir: Path, track: str, params: dict) -> dict:
    from .pipeline.accomp import transcribe_poly
    from .pipeline.vocal import transcribe_vocal

    result = load_result(job_dir)
    entry = next((t for t in result["tracks"] if t["id"] == track and t.get("notes") is not None), None)
    if entry is None:
        raise KeyError(track)
    wav = job_dir / entry["audio"]
    with gpu_lock:
        if track == "vocals":
            data = transcribe_vocal(wav, params, cache=job_dir / "vocal_f0.npz")
        else:
            data = transcribe_poly(wav, track, params)
    entry.update(data)
    entry.pop("edited", None)
    save_result(job_dir, result)
    return entry


def update_notes(job_dir: Path, track: str, notes: list[dict]) -> None:
    result = load_result(job_dir)
    entry = next((t for t in result["tracks"] if t["id"] == track and t.get("notes") is not None), None)
    if entry is None:
        raise KeyError(track)
    entry["notes"] = sorted(notes, key=lambda n: (n["start"], n["pitch"]))
    entry["edited"] = True
    save_result(job_dir, result)
