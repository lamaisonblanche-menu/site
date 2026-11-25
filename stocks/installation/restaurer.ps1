# Restauration d'une sauvegarde des stocks (SRV MB, administrateur).
$ErrorActionPreference = "Stop"
$App = "C:\MBStocks\app"; $Data = "C:\MBStocks\data"
$py = (& cmd /c "py -3 -c ""import sys;print(sys.executable)""").Trim()
$cfg = Get-Content "$Data\config.json" -Raw | ConvertFrom-Json
$dirs = @("$Data\sauvegardes") + @($cfg.sauvegardes_externes)
$list = foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem $d -Filter "stocks-*.zip" } }
$list = $list | Sort-Object LastWriteTime -Descending | Select-Object -First 30
if (-not $list) { throw "Aucune sauvegarde trouvée." }
for ($i = 0; $i -lt $list.Count; $i++) { "{0,3}. {1}  ({2:N0} Ko)  {3}" -f ($i + 1), $list[$i].LastWriteTime, ($list[$i].Length / 1KB), $list[$i].FullName }
$n = [int](Read-Host "Numéro de la sauvegarde à restaurer (0 = annuler)")
if ($n -lt 1 -or $n -gt $list.Count) { "Annulé."; return }
$f = $list[$n - 1].FullName
& $py "$App\backup.py" --data $Data verifier $f; if ($LASTEXITCODE -ne 0) { throw "Sauvegarde invalide." }
if ((Read-Host "Restaurer $f ? L'état actuel sera mis de côté. Tapez OUI") -ne "OUI") { "Annulé."; return }
Stop-ScheduledTask -TaskName "MB Stocks - Serveur"; Start-Sleep 3
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -like "*MBStocks*server.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
& $py "$App\backup.py" --data $Data restaurer $f --oui
Start-ScheduledTask -TaskName "MB Stocks - Serveur"
"Restauration terminée, serveur relancé."
