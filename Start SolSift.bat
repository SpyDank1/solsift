@echo off
title SolSift
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if exist ".env" goto run
echo No private key file (.env) was found in this folder.
echo Without a Jupiter API key SolSift still works, but Jupiter will rate limit it.
set "JKEY="
set /p "JKEY=Paste your Jupiter API key and press Enter (or just press Enter to skip): "
if not defined JKEY goto run
>".env" echo JUPITER_API_KEY=%JKEY%
echo Saved to .env in this folder. It stays on this PC.
:run
echo.
echo Starting SolSift. Your browser will open in a moment.
echo Keep this window open while you use it. Close it to stop.
echo.
node scripts\serve.js --open
pause
