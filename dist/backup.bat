@echo off
title Fullsite Backup
echo.
echo   Respaldando C:\fullsite\ ...
echo.

:: Create backup folder with timestamp
set BACKUP_DIR=%USERPROFILE%\Desktop\fullsite-backup-%DATE:~-4%-%DATE:~-10,2%-%DATE:~-7,2%
mkdir "%BACKUP_DIR%" 2>nul

:: Copy all files
xcopy /E /Y /Q "C:\fullsite\*" "%BACKUP_DIR%\" >nul 2>&1

:: Also backup to a cloud-accessible location (OneDrive/Google Drive if available)
if exist "%USERPROFILE%\OneDrive" (
    xcopy /E /Y /Q "C:\fullsite\*" "%USERPROFILE%\OneDrive\fullsite-backup\" >nul 2>&1
    echo   Copiado a OneDrive.
)
if exist "%USERPROFILE%\Google Drive" (
    xcopy /E /Y /Q "C:\fullsite\*" "%USERPROFILE%\Google Drive\fullsite-backup\" >nul 2>&1
    echo   Copiado a Google Drive.
)

echo   Respaldo completado en: %BACKUP_DIR%
echo.
pause
