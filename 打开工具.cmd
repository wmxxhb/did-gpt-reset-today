@echo off
chcp 65001 >nul
title GPT今天重置了吗？
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动部署.ps1"
if errorlevel 1 (
  echo.
  echo 工具尚未正常打开，请查看上面的提示。
  pause
)
