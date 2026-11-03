@echo off
if not exist "%~dp0runtime\redist\VC_redist.x64.exe" (
  echo VC++ redistributable not found. Please use the complete local package.
  pause
  exit /b 1
)
start "VC++ Runtime Setup" "%~dp0runtime\redist\VC_redist.x64.exe"
