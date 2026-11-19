@echo off
setlocal EnableExtensions
title LOOM Personal Preview
if not exist "%~dp0Manage-Loom.ps1" (
  echo LOOM is incomplete: Manage-Loom.ps1 is missing.
  echo Extract the full ZIP again, then run Start-Loom.cmd.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -File "%~dp0Manage-Loom.ps1" -Action Portable -PackageDirectory "%~dp0\"
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
