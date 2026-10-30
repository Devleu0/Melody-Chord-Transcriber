from pathlib import Path

import yt_dlp

from ..config import MAX_DURATION_SEC


class DownloadError(Exception):
    pass


def download_audio(url: str, out_dir: Path) -> dict:
    """Download only the audio from a YouTube URL and save it as out_dir/source.wav."""
    out_dir.mkdir(parents=True, exist_ok=True)
    common = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        # Recent YouTube requires solving a JS challenge. Fall back to installed node if deno is missing
        "js_runtimes": {"deno": {}, "node": {}},
    }

    with yt_dlp.YoutubeDL(common) as ydl:
        info = ydl.extract_info(url, download=False)
    duration = info.get("duration") or 0
    if duration > MAX_DURATION_SEC:
        raise DownloadError(f"Video is too long ({duration // 60} min). Max {MAX_DURATION_SEC // 60} min")

    opts = {
        **common,
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
    }
