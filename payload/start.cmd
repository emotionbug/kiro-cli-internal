@echo off
setlocal
"%~dp0runtime\node\node.exe" --max-old-space-size=128 "%~dp0app\lib\run.mjs" start %*
exit /b %errorlevel%
