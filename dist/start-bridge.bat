@echo off
title Fullsite Print Bridge
echo.
echo   Iniciando Fullsite Print Bridge...
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   ERROR: Node.js no esta instalado.
    echo.
    echo   Descarga Node.js de: https://nodejs.org/
    echo   Instala la version LTS y vuelve a correr este archivo.
    echo.
    pause
    exit /b 1
)

:: Auto-update: download latest bridge.js from GitHub (best-effort, skip if offline)
cd /d "%~dp0"
echo   Buscando actualizaciones...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/danielfullsite/fullsite-os/main/dist/bridge.js' -TimeoutSec 5 -ErrorAction Stop; if ($r.Content.Length -gt 100) { [System.IO.File]::WriteAllText('%~dp0bridge.js.new', $r.Content, [System.Text.Encoding]::UTF8); Move-Item -Force '%~dp0bridge.js.new' '%~dp0bridge.js'; Write-Host '  Actualizado.' } } catch { Write-Host '  Sin conexion o sin cambios — usando version local.' }" 2>nul

:: Also update raw-print.ps1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/danielfullsite/fullsite-os/main/dist/raw-print.ps1' -TimeoutSec 5 -ErrorAction Stop; if ($r.Content.Length -gt 100) { [System.IO.File]::WriteAllText('%~dp0raw-print.ps1', $r.Content, [System.Text.Encoding]::UTF8) } } catch {}" 2>nul

echo.
node bridge.js

:: If it crashes, don't close the window
echo.
echo   El bridge se detuvo. Presiona una tecla para cerrar.
pause >nul
