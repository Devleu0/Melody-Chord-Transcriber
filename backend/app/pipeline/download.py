import logging
import re
import subprocess
from pathlib import Path

import soundfile as sf
import yt_dlp

from ..config import MAX_DURATION_SEC, MIN_DURATION_SEC

log = logging.getLogger(__name__)

# 11-character YouTube video id in watch / youtu.be / shorts / embed / live URLs
_YT_ID = re.compile(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})")


def youtube_id(url: str) -> str | None:
    m = _YT_ID.search(url or "")
    return m.group(1) if m else None


def _check_duration(duration: float, what: str) -> None:
    if duration and duration < MIN_DURATION_SEC:
        raise DownloadError(f"{what} is too short ({duration:.0f} s). Min {MIN_DURATION_SEC} s")
    if duration > MAX_DURATION_SEC:
        raise DownloadError(f"{what} is too long ({int(duration) // 60} min). Max {MAX_DURATION_SEC // 60} min")


_COMMON = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "socket_timeout": 15,
    # Recent YouTube requires solving a JS challenge. Fall back to installed node if deno is missing
    "js_runtimes": {"deno": {}, "node": {}},
}


def probe(url: str) -> dict:
    """Metadata only (no download) for the pre-submit preview."""
    try:
        # extract_flat: don't resolve every entry of a playlist-only link (slow, and may need sign-in)
        with yt_dlp.YoutubeDL({**_COMMON, "extract_flat": "in_playlist"}) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(str(e).removeprefix("ERROR: ")) from e
    if info.get("_type") == "playlist":
        raise DownloadError("This is a playlist link. Paste the link of a single video")
    return {
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail"),
        "webpage_url": info.get("webpage_url", url),
        "video_id": info.get("id") if info.get("extractor_key") == "Youtube" else None,
        "is_live": bool(info.get("is_live")),
    }

class DownloadError(Exception):
    pass


def download_audio(url: str, out_dir: Path) -> dict:
    """Download only the audio from a YouTube URL and save it as out_dir/source.wav."""
    out_dir.mkdir(parents=True, exist_ok=True)
    with yt_dlp.YoutubeDL(_COMMON) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("is_live"):
        raise DownloadError("Live streams are not supported")
    duration = info.get("duration") or 0
    _check_duration(duration, "Video")

    opts = {
        **_COMMON,
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav"},
        ],
        # Normalize to 44.1kHz stereo
        "postprocessor_args": {"extractaudio": ["-ar", "44100", "-ac", "2"]},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    wav = out_dir / "source.wav"
    if not wav.exists():
        raise DownloadError("Audio extraction failed (check ffmpeg)")
    return {
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": duration,
        "thumbnail": info.get("thumbnail"),
        "webpage_url": info.get("webpage_url", url),
        "video_id": info.get("id") if info.get("extractor_key") == "Youtube" else None,
    }


def import_audio(src: Path, out_dir: Path, title: str) -> dict:
    """Convert an uploaded audio/video file to out_dir/source.wav (44.1kHz stereo)."""
    wav = out_dir / "source.wav"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ar", "44100", "-ac", "2", str(wav)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not wav.exists():
        # Full ffmpeg output goes to the server log only (it contains local paths)
        log.warning("ffmpeg failed on %s: %s", src.name, proc.stderr.strip())
        raise DownloadError("Could not decode the file. Is it a valid audio or video file?")
    duration = sf.info(wav).duration
    _check_duration(duration, "Audio")
    src.unlink(missing_ok=True)  # the decoded wav is all the pipeline needs
    return {"title": title, "uploader": None, "duration": round(duration), "thumbnail": None, "webpage_url": None}
