@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo   VideoMerge local dev server
echo   ---------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Reinstall Node.js.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo [OK] Node %%v

if not exist "node_modules\" (
  echo [..] Running npm install ...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  echo [OK] Dependencies installed.
) else (
  echo [OK] Dependencies ready.
)

if not defined PORT set "PORT=5173"

echo [..] Starting http://localhost:%PORT%/
echo [..] Press Ctrl+C to stop.
echo.

call npm.cmd run dev -- --host 127.0.0.1 --port %PORT% --open
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo [ERROR] Dev server exited with code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
