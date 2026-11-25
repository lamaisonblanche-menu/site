@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command Start-ScheduledTask -TaskName \"MB Stocks - Serveur\"'"
echo Serveur des stocks démarré.
timeout /t 4
