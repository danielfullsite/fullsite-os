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

:: Run bridge from same directory as this .bat
cd /d "%~dp0"
node bridge.js

:: If it crashes, don't close the window
echo.
echo   El bridge se detuvo. Presiona una tecla para cerrar.
pause >nul
