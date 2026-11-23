; Installateur Windows de la caisse La Maison Blanche
Unicode true
!include "MUI2.nsh"
!define NOM "Caisse La Maison Blanche"
!define EXE "Caisse La Maison Blanche.exe"
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
Name "${NOM}"
OutFile "..\dist\Installer-Caisse-La-Maison-Blanche.exe"
InstallDir "$PROGRAMFILES64\${NOM}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "La Maison Blanche"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${NOM}"
VIAddVersionKey "FileDescription" "Installation de la caisse La Maison Blanche"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "La Maison Blanche"
VIAddVersionKey "LegalCopyright" "La Maison Blanche"
!define MUI_ICON "..\build\icon.ico"
!define MUI_UNICON "..\build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Installation de la caisse La Maison Blanche"
!define MUI_WELCOMEPAGE_TEXT "La caisse va s'installer sur ce PC. Elle démarrera toute seule à chaque allumage.$\r$\n$\r$\nSi l'ancienne caisse (fenêtre noire) tourne encore, elle sera arrêtée et ses données seront reprises."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Ouvrir la caisse maintenant"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

Section "Caisse"
  SetShellVarContext all
  ; arrêter la caisse si elle tourne (mise à jour de l'application)
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  ; arrêter l'ancienne caisse en fenêtre noire (node server.js)
  nsExec::Exec 'taskkill /F /T /FI "IMAGENAME eq cmd.exe" /FI "WINDOWTITLE eq Caisse La Maison Blanche*"'
  Sleep 1500
  SetOutPath "$INSTDIR"
  File /r "..\dist\win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Desinstaller.exe"
  CreateShortcut "$DESKTOP\${NOM}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateDirectory "$SMPROGRAMS\${NOM}"
  CreateShortcut "$SMPROGRAMS\${NOM}\${NOM}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortcut "$SMPROGRAMS\${NOM}\Désinstaller.lnk" "$INSTDIR\Desinstaller.exe"
  ; autoriser la caisse sur le réseau (écrans de salle, imprimantes) sans fenêtre du pare-feu
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${NOM}"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${NOM}" dir=in action=allow program="$INSTDIR\${EXE}" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${NOM}" dir=in action=allow protocol=TCP localport=8080 enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${NOM}" dir=in action=allow protocol=UDP localport=41234 enable=yes profile=any'
  ; ne pas mettre l'écran en veille
  nsExec::Exec 'powercfg /change monitor-timeout-ac 0'
  nsExec::Exec 'powercfg /change standby-timeout-ac 0'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOM}" "DisplayName" "${NOM}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOM}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOM}" "Publisher" "La Maison Blanche"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOM}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOM}" "UninstallString" '"$INSTDIR\Desinstaller.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOM}" "NoModify" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 1000
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${NOM}"'
  Delete "$DESKTOP\${NOM}.lnk"
  RMDir /r "$SMPROGRAMS\${NOM}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOM}"
  ; les ventes (dossier AppData) ne sont jamais effacées
SectionEnd
