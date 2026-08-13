@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where dotnet >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 找不到 .NET SDK。請安裝 https://dotnet.microsoft.com/download
  pause
  exit /b 1
)

echo [..] 啟動 VideoMerge 桌面版
dotnet run --project "%~dp0VideoMerge.Avalonia\VideoMerge.Avalonia.csproj" -c Release --no-launch-profile
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo [ERROR] 桌面版結束代碼 %EXITCODE%
  pause
)
exit /b %EXITCODE%
