@echo off
chcp 65001 >nul
title Smouha LAN Hub
cd /d "%~dp0"

REM Portable Node on this PC (AppData Local)
set "NODE_EXE=C:\Users\egtmartds60\AppData\Local\node\node.exe"

if exist "%NODE_EXE%" (
  echo Starting Smouha LAN Hub...
  echo Using: %NODE_EXE%
  "%NODE_EXE%" server.mjs
  goto end
)

REM Fallback: node in PATH
where node >nul 2>&1
if not errorlevel 1 (
  echo Starting Smouha LAN Hub (PATH)...
  node server.mjs
  goto end
)

echo.
echo [ERROR] node.exe not found.
echo Expected: C:\Users\egtmartds60\AppData\Local\node\node.exe
echo Or add Node to PATH / set NODE_EXE correctly.
echo.
pause
exit /b 1

:end
pause
