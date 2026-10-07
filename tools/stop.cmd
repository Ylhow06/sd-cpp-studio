@echo off
rem ============================================================
rem  Stop Local Image Studio  (stops sd-server.exe)
rem    stop.cmd        - double-click; pauses so you can read it
rem    stop.cmd /q     - quiet; no pause (for scripts)
rem ============================================================
setlocal
echo.
echo   Stopping Local Image Studio ...
echo.

rem ---- main method: PowerShell Stop-Process ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = @(Get-Process sd-server -ErrorAction SilentlyContinue); if ($p.Count -gt 0) { $p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Write-Host ('  [ OK ] stopped ' + $p.Count + ' process(es)') } else { Write-Host '  [ -  ] sd-server.exe was not running' }"

rem ---- fallback: taskkill, in case the process is stubborn ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Process sd-server -ErrorAction SilentlyContinue) { taskkill /F /IM sd-server.exe 2>&1 | Out-Null; Start-Sleep -Seconds 1 }"

rem ---- report final state ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-Process sd-server -ErrorAction SilentlyContinue; if ($p) { Write-Host '  [ !! ] sd-server.exe is STILL running' } else { Write-Host '  [ OK ] sd-server.exe is stopped' }; $c = Get-NetTCPConnection -LocalPort 1234 -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host '  [ !! ] port 1234 is still busy' } else { Write-Host '  [ OK ] port 1234 is free' }"

echo.
if /i "%~1"=="/q" goto end
echo   Done. You can close this window.
echo.
pause
:end
