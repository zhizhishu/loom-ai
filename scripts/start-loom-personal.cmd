@echo off
setlocal EnableExtensions
title LOOM Personal Preview
if not defined LOCALAPPDATA (
  echo LOCALAPPDATA is unavailable. No data directory was selected.
  pause
  exit /b 1
)
set "LOOM_PERSONAL_PORT=64852"
set "ROVAI_EMBEDDED_PI_ROOT=%~dp0runtime\pi"
set "LOOM_PREVIEW_DATA=%LOCALAPPDATA%\LOOM\personal-preview-20261116"
set "PI_CODING_AGENT_DIR=%LOOM_PREVIEW_DATA%\runtime-home\pi"
set "CODEX_HOME=%LOOM_PREVIEW_DATA%\runtime-home\codex"
set "CLAUDE_CONFIG_DIR=%LOOM_PREVIEW_DATA%\runtime-home\claude"
set "DSH_HOME=%LOOM_PREVIEW_DATA%\runtime-home\dsh"
echo LOOM personal development candidate - not a production release.
echo Open http://127.0.0.1:%LOOM_PERSONAL_PORT%/ after the server reports ready.
echo This uses a separate preview data directory and does not open daily data.
echo Keep this window open. Press Ctrl+C to stop cleanly.
"%~dp0rovai-server.exe" --data-dir "%LOOM_PREVIEW_DATA%" --listen "127.0.0.1:%LOOM_PERSONAL_PORT%"
set "LOOM_EXIT=%ERRORLEVEL%"
if not "%LOOM_EXIT%"=="0" (
  echo The preview stopped with an error. Other running servers were not terminated.
  pause
)
exit /b %LOOM_EXIT%
