# yt-amt — YouTube 오디오 멜로디 채보

YouTube 링크 → 오디오 다운로드 → 보컬/반주 분리 → 채보 → 웹 피아노롤(DAW 스타일)

```
yt-dlp(+ffmpeg) → audio-separator (Mel-RoFormer | Demucs htdemucs_ft)
                → 보컬: RMVPE f0 → 노트 분할      (backend/app/pipeline/vocal.py)
                → 반주: Basic Pitch (ONNX)         (backend/app/pipeline/accomp.py)
                → result.json + MIDI
                → React + Canvas2D 피아노롤 + Web Audio 스템 재생
```

## 실행

요구 사항: Python 3.11 (uv), Node 18+, ffmpeg, (선택) NVIDIA GPU

```bash
cd backend
python -m uv sync
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000
```

```bash
cd frontend
npm install
npm run dev
```

http://localhost:5173 에 접속합니다. 모델 가중치는 첫 실행 때 `backend/models/`에 자동으로 받아집니다.

## 분리 엔진

| 엔진 | 트랙 | 채보 |
|---|---|---|
| RoFormer (`vocals_mel_band_roformer.ckpt`) | 보컬, 반주 | 보컬=RMVPE, 반주=Basic Pitch |
| Demucs (`htdemucs_ft`) | 보컬, 베이스, 기타 악기, 드럼 (+반주 합) | 보컬=RMVPE, 베이스/기타=Basic Pitch, 드럼=재생만 |

## 코드 진행 분석

반주 stem → BTC (Bi-directional Transformer, ISMIR 2019, 170 클래스, MIT) 프레임 확률 → 비트 단위 평균 → Viterbi 평활화 → 베이스음으로 전위(F/A) 판정.
가중치를 쓸 수 없으면 CQT 크로마 + 장/단 3화음 템플릿으로 대체한다. 가중치는 SHA-256 검증 후 `weights_only=True`로 로드한다.
모델 코드는 `backend/app/pipeline/btc/`에 그대로 포함(원본 라이선스 동봉).

## 피아노롤 조작

- Space: 재생/정지, Home: 처음으로
- 휠: 세로 스크롤 / Shift+휠: 가로 / Ctrl+휠: 시간 줌 / Alt+휠: 건반 높이
- 룰러 클릭/드래그: 탐색, 건반 클릭: 음 미리듣기, 노트 클릭: 선택 + 미리듣기, 빈 곳 드래그: 이동
- 트랙: M(음소거) S(솔로) 노트(표시) 신스(채보 결과를 신스로 재생) — 원곡과 채보를 겹쳐 들으며 검증
- 레인: 미니맵(클릭/드래그 이동) · 마디 룰러(드래그 = 반복 구간) · 코드(호버 = 구성음, 클릭 = 그 코드 반복) · 파형
- E 편집 모드: 드래그 이동, 끝 드래그 길이, 더블클릭 추가, 우클릭/Delete 삭제, Q 퀀타이즈, Ctrl+Z/Ctrl+Shift+Z — 0.6초 후 자동 저장, MIDI 재생성
- ⚙: 트랙별 채보 민감도 / 코드 변경 억제 조절 후 해당 부분만 재처리 (보컬 f0 는 캐시되어 수 초)
- F 화면 맞춤, +/− 줌, ←/→ 마디 이동, L 반복, 속도 0.5–0.9×(음정 유지), 마스터 볼륨
- 내보내기: 전체/코드 MIDI, 코드 리드시트(.txt), MusicXML(트랙 선율 + 코드 심볼)

## 구조

```
backend/app/
  main.py          FastAPI (POST/GET /api/jobs, /files 정적 제공)
  jobs.py          단일 GPU 워커 큐, data/jobs/{id}/ 에 결과 저장
  pipeline/        download / separate / rmvpe / vocal / accomp / export
frontend/src/
  App.tsx          작업 제출·진행률·트랜스포트
  audio/engine.ts  Web Audio 다중 스템 동기 재생 + 노트 신스
  components/PianoRoll.tsx  Canvas2D 피아노롤 (세로 건반, 룰러, 노트, 피치 곡선)
```

YouTube 콘텐츠는 개인 학습/연구 용도로만 사용하세요.
