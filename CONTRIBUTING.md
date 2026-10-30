# Contributing

[한국어](#기여-가이드) · English

Thanks for your interest in yt-amt! Bug reports, ideas and pull requests are all welcome.

## Development setup

```bash
# backend (Python 3.11 via uv)
cd backend
python -m pip install uv
python -m uv sync
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000   # Windows
.venv/bin/python -m uvicorn app.main:app --reload --port 8000       # macOS / Linux

# frontend (Node 18+)
cd frontend
npm install
npm run dev   # http://localhost:5173, proxies /api and /files to :8000
```

## Before opening a pull request

- Frontend: `npx tsc -b` and `npx eslint src` must pass.
- Backend: `python -m compileall -q app` must pass. Keep heavy imports (torch, models) lazy so the server starts fast.
- UI text goes through `src/i18n.tsx` — add both the `ko` and `en` strings.
- Keep comments in English and match the surrounding style.
- Do not commit audio, model weights or anything under `backend/data/` / `backend/models/`.
- Describe how you tested the change (song length, separator, GPU/CPU).

## Reporting bugs

Use the issue template. Please include OS, GPU / VRAM, the separator you used, and the backend log around the error.
Do **not** attach copyrighted audio; a public YouTube link is enough.

---

# 기여 가이드

yt-amt에 관심 가져 주셔서 감사합니다! 버그 제보, 아이디어, PR 모두 환영합니다.

## 개발 환경

위 **Development setup**의 명령어를 그대로 사용하세요. 백엔드는 uv로 Python 3.11 가상환경을 만들고, 프론트엔드는 Vite 개발 서버(5173)가 `/api`, `/files` 요청을 백엔드(8000)로 넘깁니다.

## PR 전에 확인할 것

- 프론트엔드: `npx tsc -b`, `npx eslint src` 통과
- 백엔드: `python -m compileall -q app` 통과. torch·모델 같은 무거운 import는 지연 로딩 유지
- UI 문구는 `src/i18n.tsx`에 `ko`, `en` 둘 다 추가
- 주석은 영어로, 주변 코드 스타일에 맞게
- 오디오, 모델 가중치, `backend/data/`, `backend/models/` 아래 파일은 커밋하지 않기
- 어떻게 테스트했는지(곡 길이, 분리 엔진, GPU/CPU) 적어 주기

## 버그 제보

이슈 템플릿을 사용해 주세요. OS, GPU/VRAM, 사용한 분리 엔진, 오류 전후의 백엔드 로그를 함께 적어 주시면 좋습니다.
저작권이 있는 오디오 파일은 첨부하지 말고 공개 YouTube 링크만 적어 주세요.
