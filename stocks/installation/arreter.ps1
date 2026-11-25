# Arrête le serveur des stocks (tâche + processus relancé après une mise à jour).
Stop-ScheduledTask -TaskName "MB Stocks - Serveur" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" | Where-Object { $_.CommandLine -like "*MBStocks*server.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
