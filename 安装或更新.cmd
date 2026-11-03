@echo off
setlocal
set "UPDATE_SCRIPT="
for /d %%D in ("%~dp0*") do if exist "%%~fD\scripts\update-studio.ps1" set "UPDATE_SCRIPT=%%~fD\scripts\update-studio.ps1"
if not defined UPDATE_SCRIPT (
  echo Update files are missing. Please download and extract the complete update folder.
  pause
  exit /b 1
)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%UPDATE_SCRIPT%" -LocalUpdatePath "%~dp0." -Interactive -Restart
if errorlevel 1 pause
