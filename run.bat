@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo [yt-amt] 실행 준비 중...

rem --- 필수 도구 확인 ---
where python >nul 2>nul || (echo [오류] python 이 PATH 에 없습니다. & pause & exit /b 1)
where npm >nul 2>nul || (echo [오류] npm^(Node.js^) 이 PATH 에 없습니다. & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo [오류] ffmpeg 이 PATH 에 없습니다. & pause & exit /b 1)

rem --- 첫 실행 시 의존성 설치 ---
if not exist "backend\.venv\Scripts\python.exe" (
    echo [yt-amt] 백엔드 의존성 설치 중 ^(처음 한 번, 수 분 소요^)...
    python -m uv --version >nul 2>nul || python -m pip install --user uv || goto :fail
    pushd backend
    python -m uv sync --python 3.11 || (popd & goto :fail)
    popd
)
if not exist "frontend\node_modules" (
    echo [yt-amt] 프론트엔드 의존성 설치 중...
    pushd frontend
    call npm install || (popd & goto :fail)
    popd
)

rem --- 서버 실행 (각각 별도 창) ---
echo [yt-amt] 백엔드 시작 (http://localhost:8000)
start "yt-amt backend" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"

echo [yt-amt] 프론트엔드 시작 (http://localhost:5173)
start "yt-amt frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

rem --- 프론트엔드가 뜰 때까지 기다렸다가 브라우저 열기 ---
set /a tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries+=1
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:5173 -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 if %tries% lss 30 goto :wait

start "" http://localhost:5173
echo [yt-amt] 실행 완료. 종료하려면 열린 두 서버 창을 닫으세요.
timeout /t 3 >nul
exit /b 0

:fail
echo [오류] 설치에 실패했습니다. 위 메시지를 확인하세요.
pause
exit /b 1
