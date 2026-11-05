@echo off
call "%~dp0runtime\node\node.exe" "%~dp0scripts\launch.mjs" %*
if errorlevel 1 pause
