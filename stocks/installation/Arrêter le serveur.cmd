@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command Stop-ScheduledTask -TaskName \"MB Stocks - Serveur\"'"
echo Serveur des stocks arrêté.
timeout /t 4
