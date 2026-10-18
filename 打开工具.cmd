@echo off
chcp 65001 >nul
title GPT Reset Alert - Launcher v2
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "launch_exit=%errorlevel%"
if not "%launch_exit%"=="0" (
  echo.
  echo Launcher v2: Could not start. Please check the message above.
  pause
)
exit /b %launch_exit%
