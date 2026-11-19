@echo off
setlocal EnableExtensions
title Install LOOM
powershell.exe -NoLogo -NoProfile -File "%~dp0Manage-Loom.ps1" -Action Install -PackageDirectory "%~dp0\"
if errorlevel 1 (
  echo Installation did not finish. Existing data and versions were kept.
)
pause
