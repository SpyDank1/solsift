@echo off
title SolSift
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting SolSift. Your browser will open in a moment.
echo Keep this window open while you use it. Close it to stop.
echo.
node scripts\serve.js --open
pause
