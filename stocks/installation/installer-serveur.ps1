# Installation du serveur de stocks La Maison Blanche sur SRV MB (Windows 11).
# À lancer EN ADMINISTRATEUR via « Installer le serveur.cmd ».
# Ne touche à rien de la caisse (dossier, port 8080 et tâches de la caisse inchangés).
param(
  [string]$Dossier = "C:\MBStocks",
  [int]$Port = 8765,
  [string]$SauvegardeExterne = "",   # ex. "E:\Sauvegardes-Stocks" (clé USB / disque) ou "\\NAS\stocks"
  [switch]$SansComptes
)
$ErrorActionPreference = "Stop"
function Etape($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Lancez ce script en administrateur (clic droit > Exécuter en tant qu'administrateur)."
}
$Source = Split-Path -Parent $PSScriptRoot          # dossier « stocks » du dépôt
$App = Join-Path $Dossier "app"; $Data = Join-Path $Dossier "data"

Etape "1. Python"
$py = $null
foreach ($c in @("py -3", "python")) { try { $v = & cmd /c "$c --version 2>&1"; if ($v -match "Python 3\.(\d+)" -and [int]$Matches[1] -ge 10) { $py = $c; break } } catch {} }
if (-not $py) {
  Write-Host "  Python 3.10+ absent : installation avec winget (connexion Internet nécessaire une seule fois)…"
  winget install -e --id Python.Python.3.12 --scope machine --accept-package-agreements --accept-source-agreements --silent
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $py = "py -3"
}
$pyExe = (& cmd /c "$py -c ""import sys;print(sys.executable)""").Trim()
$pywExe = Join-Path (Split-Path $pyExe) "pythonw.exe"
Ok "Python : $pyExe"
& $pyExe -m pip install --quiet --disable-pip-version-check cryptography | Out-Null
Ok "module cryptography (certificats)"

Etape "2. Copie du logiciel dans $App"
$tache = Get-ScheduledTask -TaskName "MB Stocks - Serveur" -ErrorAction SilentlyContinue
if ($tache) { Stop-ScheduledTask -TaskName "MB Stocks - Serveur"; Start-Sleep 2 }
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" | Where-Object { $_.CommandLine -like "*MBStocks*server.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $App, $Data | Out-Null
robocopy $Source $App /MIR /XD data tests __pycache__ .git /XF *.pyc /NFL /NDL /NJH /NJS /NP | Out-Null
Ok "fichiers copiés (les données de $Data ne sont jamais écrasées)"

Etape "3. Droits du dossier des données"
icacls $Data /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${env:USERNAME}:(OI)(CI)F" | Out-Null
Ok "accès limité à SYSTEM, aux administrateurs et à $env:USERNAME"

Etape "4. Adresse réseau et certificat HTTPS"
$ipObj = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" -and $_.PrefixOrigin -ne "WellKnown" } |
         Sort-Object { (Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4).InterfaceMetric } | Select-Object -First 1
if (-not $ipObj) { throw "Aucune adresse IP locale trouvée : vérifiez le câble / Wi-Fi." }
$ip = $ipObj.IPAddress; $pref = $ipObj.PrefixLength; $nom = $env:COMPUTERNAME
$o = $ip.Split('.') | ForEach-Object {[int]$_}; $mask = [uint32]([math]::Pow(2,32) - [math]::Pow(2, 32 - $pref))
$n = (([uint32]$o[0] -shl 24) -bor ($o[1] -shl 16) -bor ($o[2] -shl 8) -bor $o[3]) -band $mask
$reseau = "{0}.{1}.{2}.{3}/{4}" -f (($n -shr 24) -band 255), (($n -shr 16) -band 255), (($n -shr 8) -band 255), ($n -band 255), $pref
& $pyExe "$App\outils\creer_certificats.py" --data $Data --nom $nom --nom "srv-mb" --ip $ip
Import-Certificate -FilePath "$Data\tls\autorite-mb.crt" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Ok "certificat pour $nom / $ip ; autorité installée sur ce PC"

Etape "5. Configuration"
$cfg = [ordered]@{ host = "0.0.0.0"; port = $Port; cert = "tls\serveur.crt"; key = "tls\serveur.key"; reseaux_autorises = @($reseau); sauvegardes_externes = @() }
if ($SauvegardeExterne) { $cfg.sauvegardes_externes = @($SauvegardeExterne) }
$cfgPath = Join-Path $Data "config.json"
if (Test-Path $cfgPath) {
  $old = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if ($old.sauvegardes_externes -and -not $SauvegardeExterne) { $cfg.sauvegardes_externes = @($old.sauvegardes_externes) }
}
$cfg | ConvertTo-Json | Set-Content -Encoding UTF8 $cfgPath
Ok "réseau autorisé : $reseau ; port $Port ; sauvegarde externe : $($cfg.sauvegardes_externes -join ', ')"

Etape "6. Comptes"
if (-not $SansComptes -and -not (Test-Path "$Data\stocks.sqlite3")) {
  foreach ($c in @(@("direction", "direction", "Direction"), @("magasinier", "magasinier", "Magasinier"))) {
    $id = Read-Host "Identifiant du compte $($c[1]) [$($c[0])]"; if (-not $id) { $id = $c[0] }
    $nomAff = Read-Host "Nom affiché [$($c[2])]"; if (-not $nomAff) { $nomAff = $c[2] }
    do {
      $s = Read-Host "Mot de passe pour $id (10 caractères minimum)" -AsSecureString
      $env:MB_PW = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
      & $pyExe "$App\server.py" --data $Data creer-compte $id $c[1] $nomAff --mot-de-passe-env MB_PW
    } while ($LASTEXITCODE -ne 0)
    Remove-Item Env:\MB_PW
  }
} else { Ok "base existante : comptes conservés" }

Etape "7. Pare-feu (réseau local uniquement)"
Get-NetFirewallRule -DisplayName "MB Stocks*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "MB Stocks (HTTPS $Port, réseau local)" -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Action Allow -Profile Private,Domain | Out-Null
$prof = (Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory
if ($prof -eq "Public") { Write-Host "  ATTENTION : le réseau est en profil « Public » : passez-le en « Privé » (Paramètres > Réseau) pour autoriser le PC magasinier." -ForegroundColor Yellow }
Ok "port $Port ouvert seulement pour le réseau local"

Etape "8. Démarrage automatique"
$act = New-ScheduledTaskAction -Execute $pywExe -Argument "`"$App\server.py`" --data `"$Data`"" -WorkingDirectory $App
$trg = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$prn = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "MB Stocks - Serveur" -Action $act -Trigger $trg -Settings $set -Principal $prn -Force | Out-Null
$act2 = New-ScheduledTaskAction -Execute $pywExe -Argument "`"$App\backup.py`" --data `"$Data`" sauvegarder --label auto" -WorkingDirectory $App
Register-ScheduledTask -TaskName "MB Stocks - Sauvegarde du soir" -Action $act2 -Trigger (New-ScheduledTaskTrigger -Daily -At "23:50") -Settings $set -Principal $prn -Force | Out-Null
Start-ScheduledTask -TaskName "MB Stocks - Serveur"
Ok "serveur lancé au démarrage du PC (compte SYSTEM, relance automatique) + sauvegarde chaque soir à 23 h 50"

Etape "9. Raccourcis"
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"; if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$url = "https://${nom}:$Port/"
$sh = New-Object -ComObject WScript.Shell
foreach ($d in @([Environment]::GetFolderPath("CommonDesktopDirectory"))) {
  $l = $sh.CreateShortcut("$d\Stocks La Maison Blanche.lnk"); $l.TargetPath = $edge; $l.Arguments = "--app=$url --window-size=1440,900"
  $l.IconLocation = "$App\installation\stocks.ico"; $l.Description = "Gestion des stocks La Maison Blanche"; $l.Save()
}
foreach ($f in @("Arrêter le serveur.cmd", "Démarrer le serveur.cmd", "Restaurer une sauvegarde.cmd")) { Copy-Item "$App\installation\$f" $Dossier -Force }
Ok "raccourci « Stocks La Maison Blanche » sur le bureau"

Etape "10. Dossier pour le PC magasinier"
$poste = Join-Path $Dossier "pour-le-pc-magasinier"; New-Item -ItemType Directory -Force $poste | Out-Null
Copy-Item "$Data\tls\autorite-mb.crt", "$App\installation\installer-poste.ps1", "$App\installation\Installer le poste.cmd", "$App\installation\stocks.ico" $poste -Force
@{ serveur = $nom; ip = $ip; port = $Port } | ConvertTo-Json | Set-Content -Encoding UTF8 "$poste\serveur.json"
Ok "copiez le dossier $poste sur le PC magasinier (clé USB) puis lancez « Installer le poste.cmd »"

Etape "11. Vérification"
$okSrv = $false
for ($i = 0; $i -lt 30; $i++) { try { Invoke-WebRequest -UseBasicParsing "https://${nom}:$Port/api/ping" -TimeoutSec 3 | Out-Null; $okSrv = $true; break } catch { Start-Sleep 1 } }
if ($okSrv) { Ok "le serveur répond sur $url" } else { Write-Host "  Le serveur ne répond pas : voir $Data\journaux\" -ForegroundColor Red }
$fp = (Get-PfxCertificate "$Data\tls\autorite-mb.crt").Thumbprint
Write-Host "`nInstallation terminée. Adresse : $url  (IP $ip)`nEmpreinte de l'autorité : $fp`nConseil : réservez l'adresse $ip pour ce PC dans la box (bail DHCP fixe)." -ForegroundColor Green
