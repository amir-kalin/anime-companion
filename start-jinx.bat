@echo off
REM ---------------------------------------------------------------------
REM  Start Jinx - Smart AI Companion with Voice + Desktop Overlay
REM ---------------------------------------------------------------------
cd /d "%~dp0"

echo ==========================================================
echo   [Jinx] Starting 3D Anime AI Companion
echo ==========================================================

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH.
  pause
  exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python not found on PATH.
  pause
  exit /b 1
)

REM 1. Check Voice Service on port 4123
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WebRequest 'http://127.0.0.1:4123/health' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo   * Starting Voice Service on port 4123...
  start /min "Jinx Voice Service" cmd /c "python voice\local_voice.py --port 4123 --no-stt"
  ping 127.0.0.1 -n 3 >nul
) else (
  echo   * Voice Service is already active on port 4123.
)

REM 2. Check Gemini Agent Listener on port 5200
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WebRequest 'http://127.0.0.1:5200/health' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo   * Starting Gemini Agent Listener on port 5200...
  start /min "Jinx Gemini Listener" cmd /c "node tools\agent-listener.mjs"
  ping 127.0.0.1 -n 2 >nul
) else (
  echo   * Gemini Listener is already active on port 5200.
)

REM 3. Check Web App on port 5180
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WebRequest 'http://127.0.0.1:5180' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo   * Starting Web Server on port 5180...
  start /min "Jinx Web Server" cmd /c "npm run dev -- --port 5180"
  ping 127.0.0.1 -n 3 >nul
) else (
  echo   * Web Server is already active on port 5180.
)

echo.
echo ==========================================================
echo   * Checking Jinx Desktop Overlay...
echo ==========================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*desktop_overlay.py*' }; if ($p) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo   * Launching Jinx Desktop Overlay...
  python tools\desktop_overlay.py
  if errorlevel 1 (
    echo [ERROR] Failed to start Desktop Overlay.
    pause
  )
) else (
  echo   * Desktop Overlay is already active on your screen.
  pause
)
