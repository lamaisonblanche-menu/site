# Installation du poste magasinier (client). À lancer EN ADMINISTRATEUR via « Installer le poste.cmd »,
# depuis le dossier « pour-le-pc-magasinier » préparé sur SRV MB.
$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Lancez ce script en administrateur."
}
$here = $PSScriptRoot
$cfg = Get-Content "$here\serveur.json" -Raw | ConvertFrom-Json
$nom = $cfg.serveur; $ip = $cfg.ip; $port = $cfg.port

Write-Host "1. Autorité de certification La Maison Blanche"
Import-Certificate -FilePath "$here\autorite-mb.crt" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host ("   Empreinte : " + (Get-PfxCertificate "$here\autorite-mb.crt").Thumbprint + "  (doit être identique à celle affichée sur SRV MB)")

Write-Host "2. Résolution du nom $nom"
$resolu = $false; try { $r = Resolve-DnsName $nom -Type A -ErrorAction Stop | Where-Object { $_.IPAddress -eq $ip }; $resolu = [bool]$r } catch {}
if (-not $resolu) {
  $hosts = "$env:WINDIR\System32\drivers\etc\hosts"
  $lignes = Get-Content $hosts | Where-Object { $_ -notmatch "\s$nom(\s|$)" }
  $lignes + "$ip`t$nom`t# MB Stocks" | Set-Content $hosts -Encoding ASCII
  Write-Host "   ajouté au fichier hosts : $ip $nom"
}

Write-Host "3. Raccourci sur le bureau"
New-Item -ItemType Directory -Force "C:\MBStocks" | Out-Null; Copy-Item "$here\stocks.ico" "C:\MBStocks\stocks.ico" -Force
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"; if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$sh = New-Object -ComObject WScript.Shell
$l = $sh.CreateShortcut([Environment]::GetFolderPath("CommonDesktopDirectory") + "\Stocks La Maison Blanche.lnk")
$l.TargetPath = $edge; $l.Arguments = "--app=https://${nom}:$port/ --window-size=1440,900"; $l.IconLocation = "C:\MBStocks\stocks.ico"; $l.Save()

Write-Host "4. Test de connexion"
try { $p = Invoke-WebRequest -UseBasicParsing "https://${nom}:$port/api/ping" -TimeoutSec 5; Write-Host "   OK : SRV MB répond ($($p.StatusCode))" -ForegroundColor Green }
catch { Write-Host "   SRV MB ne répond pas : vérifiez qu'il est allumé, sur le même réseau, et que le réseau est en profil Privé. $_" -ForegroundColor Red }
Write-Host "`nTerminé : double-cliquez sur « Stocks La Maison Blanche » sur le bureau." -ForegroundColor Green
