@echo off
rem ============================================================
rem  Local Image Studio launcher
rem    serve.cmd            - Z-Image Turbo (default)
rem    serve.cmd sd15       - SD 1.5 (fast)
rem    serve.cmd z 1234     - custom port
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
if errorlevel 1 pause
