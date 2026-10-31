@echo off
setlocal
cd /d "%~dp0"

echo [melody-chord-transcriber] Preparing to start...

rem --- Check required tools ---
where python >nul 2>nul || (echo [ERROR] python is not on PATH. & pause & exit /b 1)
where npm >nul 2>nul || (echo [ERROR] npm^(Node.js^) is not on PATH. & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo [ERROR] ffmpeg is not on PATH. & pause & exit /b 1)

rem --- Install dependencies on first run ---
if not exist "backend\.venv\Scripts\python.exe" (
    echo [melody-chord-transcriber] Installing backend dependencies ^(first run only, takes a few minutes^)...
    python -m uv --version >nul 2>nul || python -m pip install --user uv || goto :fail
    pushd backend
    python -m uv sync --python 3.11 || (popd & goto :fail)
    popd
)
if not exist "frontend\node_modules" (
    echo [melody-chord-transcriber] Installing frontend dependencies...
    pushd frontend
    call npm install || (popd & goto :fail)
    popd
)

rem --- Start servers (each in its own window) ---
echo [melody-chord-transcriber] Starting backend (http://localhost:8000)
start "mct backend" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"

echo [melody-chord-transcriber] Starting frontend (http://localhost:5173)
start "mct frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

rem --- Wait for the frontend to come up, then open the browser ---
set /a tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries+=1
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:5173 -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 if %tries% lss 30 goto :wait

start "" http://localhost:5173
echo [melody-chord-transcriber] Started. Close the two server windows to stop.
timeout /t 3 >nul
exit /b 0

:fail
echo [ERROR] Installation failed. See the messages above.
pause
exit /b 1
