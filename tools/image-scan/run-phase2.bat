@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Smouha Pick — Image Scan Phase 2 (DMart miss)
echo.
echo === Phase 2: DMart images for EGY misses ===
echo 1) Open portal.talabat.com and sign in
echo 2) Extension popup → Export session for image-scan
echo 3) This script auto-finds session-export.json in Downloads if needed
echo.
where python >nul 2>&1
if errorlevel 1 (
  echo Python not found in PATH.
  pause
  exit /b 1
)
python -m pip install -r requirements.txt
echo.
python fetch_dmart_miss.py --miss .\out\image-miss.json --out-dir .\out
echo.
echo Done. See out\image-url-overrides.json
pause
