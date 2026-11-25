# Retour arrière : retire le démarrage automatique, le pare-feu et les raccourcis. Les DONNÉES sont conservées
# (C:\MBStocks\data) ; supprimez-les à la main seulement après une sauvegarde externe.
$ErrorActionPreference = "Continue"
foreach ($t in @("MB Stocks - Serveur", "MB Stocks - Sauvegarde du soir")) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" | Where-Object { $_.CommandLine -like "*MBStocks*server.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
Get-NetFirewallRule -DisplayName "MB Stocks*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item ([Environment]::GetFolderPath("CommonDesktopDirectory") + "\Stocks La Maison Blanche.lnk") -ErrorAction SilentlyContinue
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*La Maison Blanche (stocks)*" } | Remove-Item
Write-Host "Logiciel de stocks désinstallé (données conservées dans C:\MBStocks\data). La caisse n'est pas concernée."
