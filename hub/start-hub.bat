@echo off
chcp 65001 >nul
title Smouha LAN Hub
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not in PATH.
  echo Set NODE_EXE to full path of portable node.exe then re-run.
  if defined NODE_EXE (
    "%NODE_EXE%" server.mjs
    goto end
  )
  pause
  exit /b 1
)
echo Starting Smouha LAN Hub...
node server.mjs
:end
pause
