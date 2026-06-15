@echo off
echo.
echo   Configurando Chrome para Fullsite POS...
echo.

:: Set Chrome homepage to Fullsite POS
reg add "HKCU\Software\Policies\Google\Chrome" /v HomepageLocation /t REG_SZ /d "https://app.fullsite.mx/pos" /f >nul 2>&1
reg add "HKCU\Software\Policies\Google\Chrome" /v HomepageIsNewTabPage /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKCU\Software\Policies\Google\Chrome\RestoreOnStartup" /ve /t REG_DWORD /d 4 /f >nul 2>&1
reg add "HKCU\Software\Policies\Google\Chrome\RestoreOnStartupURLs" /v 1 /t REG_SZ /d "https://app.fullsite.mx/pos" /f >nul 2>&1

:: Create desktop shortcut for POS (Chrome app mode — no address bar)
echo Set oWS = WScript.CreateObject("WScript.Shell") > "%TEMP%\shortcut.vbs"
echo sLinkFile = "%USERPROFILE%\Desktop\Fullsite POS.lnk" >> "%TEMP%\shortcut.vbs"
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%TEMP%\shortcut.vbs"
echo oLink.TargetPath = "C:\Program Files\Google\Chrome\Application\chrome.exe" >> "%TEMP%\shortcut.vbs"
echo oLink.Arguments = "--app=https://app.fullsite.mx/pos --start-fullscreen" >> "%TEMP%\shortcut.vbs"
echo oLink.Description = "Fullsite POS" >> "%TEMP%\shortcut.vbs"
echo oLink.Save >> "%TEMP%\shortcut.vbs"
cscript "%TEMP%\shortcut.vbs" >nul 2>&1
del "%TEMP%\shortcut.vbs" >nul 2>&1

echo   Listo. Chrome abrira Fullsite POS al iniciar.
echo   Acceso directo creado en el escritorio.
echo.
pause
