"""단일 GPU 워커로 작업을 순차 처리하는 간단한 in-process 큐."""
import json
import queue
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import DATA_DIR

STAGES = ["queued", "downloading", "separating", "transcribing", "finalizing", "done"]


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

    def _update(self, job: Job, status: str, message: str, progress: float) -> None:
        job.status, job.message, job.progress = status, message, progress
        job.save()

    def _worker(self) -> None:
        while True:
            job = self.jobs[self.q.get()]
            try:
                self._run(job)
            except Exception as e:
                traceback.print_exc()
                job.error = str(e)
                self._update(job, "error", "실패", job.progress)

    def _run(self, job: Job) -> None:
        # 무거운 모듈은 워커에서 지연 import (서버 기동을 빠르게)
        from .pipeline.accomp import transcribe_poly
        from .pipeline.download import download_audio
        from .pipeline.export import analyze_beats, write_midi
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
            self._update(job, "transcribing", f"채보 중: {name}", 0.55 + 0.35 * i / len(targets))
            if name == "vocals":
                transcribed[name] = transcribe_vocal(stems[name])
            else:
                transcribed[name] = transcribe_poly(stems[name], name)

        self._update(job, "finalizing", "비트 분석 / MIDI 생성", 0.92)
        beats = analyze_beats(source)
        midi_dir = job.dir / "midi"
        midi_dir.mkdir(exist_ok=True)
        write_midi({k: v["notes"] for k, v in transcribed.items()}, midi_dir / "all.mid", beats["tempo"])
        for k, v in transcribed.items():
            write_midi({k: v["notes"]}, midi_dir / f"{k}.mid", beats["tempo"])

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
        (job.dir / "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        self._update(job, "done", "완료", 1.0)
