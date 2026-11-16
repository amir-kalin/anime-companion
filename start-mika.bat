@echo off
REM ---------------------------------------------------------------------
REM  Start Mika. One click.
REM
REM  Order matters and is the whole point of this file:
REM    1. LM Studio  (port 1234) - must ALREADY be running, with the model
REM       loaded. This is a desktop app; there is nothing to launch here.
REM    2. voice service (4123) - started and waited for.
REM    3. dev server  (5180)   - started and waited for.
REM
REM  The browser is only opened once the app genuinely answers. An earlier
REM  version opened it after a fixed 6s sleep, so if LM Studio was closed it
REM  opened a dead page and looked like the launcher was broken.
REM
REM  If something is wrong, this window stays open and says what.
REM ---------------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not on PATH. Install it from https://nodejs.org
  echo   and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "logs" mkdir logs

echo.
echo   Starting Mika...
echo.

REM ---- 1. LM Studio must already be up. Check before doing anything else.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WebRequest 'http://127.0.0.1:1234/v1/models' -TimeoutSec 5 -UseBasicParsing; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo   ==========================================================
  echo    LM Studio is not running, so she has no brain.
  echo   ==========================================================
  echo.
  echo   Do this first:
  echo     1. Open LM Studio
  echo     2. Load the model: prism-ml/bonsai-27b
  echo     3. Press "Start Server"  - the local server, port 1234
  echo.
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo   [1/3] LM Studio is up.

REM ---- 2 + 3. Start the launcher in the background; it owns both services.
start "" /min cmd /c "node start-all.mjs > logs\launcher.log 2>&1"

REM ---- Wait for the app to actually answer, rather than guessing.
set /a TRIES=0
:waitloop
set /a TRIES+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WebRequest 'http://127.0.0.1:5180/api/health' -TimeoutSec 4 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
if %TRIES% geq 45 goto slow
timeout /t 2 >nul
goto waitloop

:slow
echo.
echo   ==========================================================
echo    Took longer than expected. The log is below.
echo   ==========================================================
echo.
type logs\launcher.log
echo.
pause
exit /b 1

:ready
echo   [2/3] Voice service and app are up.
echo   [3/3] Opening her.
echo.
start "" http://127.0.0.1:5180

echo   Mika is awake at http://127.0.0.1:5180
echo   Press F for fullscreen, S to sit. To stop everything:
echo     taskkill /f /im node.exe
echo.
timeout /t 5 >nul
exit /b 0
