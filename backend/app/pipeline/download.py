from pathlib import Path

import yt_dlp

from ..config import MAX_DURATION_SEC


class DownloadError(Exception):
    pass


def download_audio(url: str, out_dir: Path) -> dict:
    """YouTube URL에서 오디오만 받아 out_dir/source.wav 로 저장한다."""
    out_dir.mkdir(parents=True, exist_ok=True)
    common = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        # 최신 YouTube는 JS 챌린지 풀이가 필요. deno가 없으면 설치된 node 사용
        "js_runtimes": {"deno": {}, "node": {}},
    }

    with yt_dlp.YoutubeDL(common) as ydl:
        info = ydl.extract_info(url, download=False)
    duration = info.get("duration") or 0
    if duration > MAX_DURATION_SEC:
        raise DownloadError(f"영상이 너무 깁니다 ({duration // 60}분). 최대 {MAX_DURATION_SEC // 60}분")

    opts = {
        **common,
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav"},
        ],
        # 44.1kHz 스테레오로 통일
        "postprocessor_args": {"extractaudio": ["-ar", "44100", "-ac", "2"]},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    wav = out_dir / "source.wav"
    if not wav.exists():
        raise DownloadError("오디오 추출 실패 (ffmpeg 확인 필요)")
    return {
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": duration,
        "thumbnail": info.get("thumbnail"),
        "webpage_url": info.get("webpage_url", url),
    }
