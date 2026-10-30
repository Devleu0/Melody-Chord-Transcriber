# Third-party notices

yt-amt itself is MIT-licensed (see [LICENSE](LICENSE)). It builds on the work below.

## Code included in this repository

| Component | Location | License |
|---|---|---|
| BTC — Bi-directional Transformer for Chord recognition (Park et al., ISMIR 2019) | `backend/app/pipeline/btc/` | MIT — © 2019 Jonggwon Park, see [`btc/LICENSE`](backend/app/pipeline/btc/LICENSE). Source: [jayg996/BTC-ISMIR19](https://github.com/jayg996/BTC-ISMIR19) |
| RMVPE network definition (Wei et al., 2023), re-implemented after the RVC project | `backend/app/pipeline/rmvpe.py` | MIT — [RVC-Project/Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) |

## Model weights (downloaded at first run, not redistributed here)

| Model | Fetched from | License |
|---|---|---|
| RMVPE `rmvpe.pt` | [huggingface.co/lj1995/VoiceConversionWebUI](https://huggingface.co/lj1995/VoiceConversionWebUI) | MIT |
| BTC `btc_model_large_voca.pt` (SHA-256 pinned) | [jayg996/BTC-ISMIR19](https://github.com/jayg996/BTC-ISMIR19) | MIT |
| Mel-Band RoFormer vocal model (Kimberley Jensen) | via `audio-separator` | See [KimberleyJensen/Mel-Band-Roformer-Vocal-Model](https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model) |
| Demucs `htdemucs_ft` | via `audio-separator` | MIT — [facebookresearch/demucs](https://github.com/facebookresearch/demucs) |
| Basic Pitch ICASSP 2022 model | bundled in the `basic-pitch` package | Apache-2.0 — [spotify/basic-pitch](https://github.com/spotify/basic-pitch) |

## Main libraries

| Library | License |
|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense |
| [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | MIT |
| [Basic Pitch](https://github.com/spotify/basic-pitch) | Apache-2.0 |
| [PyTorch](https://github.com/pytorch/pytorch) | BSD-3-Clause |
| [librosa](https://github.com/librosa/librosa) | ISC |
| [music21](https://github.com/cuthbertLab/music21) | BSD-3-Clause |
| [pretty_midi](https://github.com/craffel/pretty-midi) | MIT |
| [FastAPI](https://github.com/fastapi/fastapi) | MIT |
| [React](https://github.com/facebook/react) | MIT |
| [Vite](https://github.com/vitejs/vite) | MIT |
| [FFmpeg](https://ffmpeg.org/) (external binary, not bundled) | LGPL/GPL |

## Demo media

Screenshots in `docs/images/` show **"Same Boat" by Josh Woodward** ([joshwoodward.com](https://www.joshwoodward.com/)), licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The transcription overlay is a derivative visualization.
