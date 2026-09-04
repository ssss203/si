@echo off
echo Stopping pet...
rem 1) kill run-dev by pid from activity.lock (it cleans up Electron children)
powershell -NoProfile -Command "$lock='F:\ss_yong\si\pet-si\pet-app\.build\activity.lock'; if(Test-Path $lock){try{$o=Get-Content $lock -Raw|ConvertFrom-Json}catch{$o=$null}; if($o -and $o.pid){taskkill /PID $o.pid /T /F 2>$null | Out-Null}}"
rem 2) fallback: kill leftover electron.exe (only this pet uses it in dev)
taskkill /IM electron.exe /F >nul 2>&1
echo Stopped. Press any key to close...
pause >nul
