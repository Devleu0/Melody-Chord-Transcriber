#!/usr/bin/env bash
# One-click launcher for macOS / Linux: installs deps on first run, starts backend + frontend, opens the browser.
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[error] '$1' is not on PATH. $2"; exit 1; }; }
need python3 "Install Python 3.9+ (only used to bootstrap uv)."
need npm "Install Node.js 18+."
need ffmpeg "Install ffmpeg (brew install ffmpeg / apt install ffmpeg)."

UV="python3 -m uv"
if command -v uv >/dev/null 2>&1; then UV="uv"; fi

if [ ! -x backend/.venv/bin/python ]; then
  echo "[yt-amt] Installing backend dependencies (first run, takes a few minutes)..."
  $UV --version >/dev/null 2>&1 || python3 -m pip install --user uv
  (cd backend && $UV sync --python 3.11)
fi
if [ ! -d frontend/node_modules ]; then
  echo "[yt-amt] Installing frontend dependencies..."
  (cd frontend && npm install)
fi

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[yt-amt] Starting backend  (http://localhost:8000)"
(cd backend && .venv/bin/python -m uvicorn app.main:app --port 8000) &
echo "[yt-amt] Starting frontend (http://localhost:5173)"
(cd frontend && npm run dev -- --strictPort) &

# Wait for the dev server, then open the browser
for _ in $(seq 1 30); do
  if curl -s -o /dev/null http://localhost:5173; then break; fi
  sleep 1
done
if command -v open >/dev/null 2>&1; then open http://localhost:5173
elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:5173 >/dev/null 2>&1 || true
fi

echo "[yt-amt] Running. Press Ctrl+C to stop both servers."
wait
