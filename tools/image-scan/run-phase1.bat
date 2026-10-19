@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Smouha Pick — Image Scan Phase 1 (EGY)
echo.
echo === Phase 1: EGY CDN scan ===
echo Working dir: %CD%
echo.
where python >nul 2>&1
if errorlevel 1 (
  echo Python not found in PATH. Install Python 3 and retry.
  pause
  exit /b 1
)
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo pip install failed
  pause
  exit /b 1
)
echo.
python scan_egy.py --products ..\..\data\products.json --out-dir .\out
echo.
echo Done. See out\image-scan-summary.json and out\image-miss.json
pause
