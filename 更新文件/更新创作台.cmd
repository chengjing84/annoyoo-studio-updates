@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-studio.ps1" -RootPath "%~dp0." -Interactive -Restart
if errorlevel 1 pause
