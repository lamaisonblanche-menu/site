; Installateur Windows de « Rapports La Maison Blanche » (PC du bureau)
; Installation pour l'utilisateur de la session : aucune fenêtre administrateur, ne touche pas à la caisse.
Unicode true
!include "MUI2.nsh"
!define NOM "Rapports La Maison Blanche"
!define EXE "Rapports La Maison Blanche.exe"
!define CLE_DESINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\RapportsLaMaisonBlanche"
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
Name "${NOM}"
OutFile "..\dist\Installer-Rapports-La-Maison-Blanche.exe"
InstallDir "$LOCALAPPDATA\Programs\${NOM}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "La Maison Blanche"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${NOM}"
VIAddVersionKey "FileDescription" "Installation des rapports La Maison Blanche"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "La Maison Blanche"
VIAddVersionKey "LegalCopyright" "La Maison Blanche"
!define MUI_ICON "..\build\icon.ico"
!define MUI_UNICON "..\build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Rapports La Maison Blanche"
!define MUI_WELCOMEPAGE_TEXT "Ce logiciel affiche les ventes de la caisse principale sur ce PC du bureau, en lecture seule.$\r$\n$\r$\nUne icône « ${NOM} » sera placée sur le bureau. Il n'y a rien à régler : au premier lancement, le logiciel trouve la caisse tout seul."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Ouvrir les rapports maintenant"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

Section "Rapports"
  SetShellVarContext current
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 800
  SetOutPath "$INSTDIR"
  File /r "..\dist\win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Desinstaller.exe"
  CreateShortcut "$DESKTOP\${NOM}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateDirectory "$SMPROGRAMS\${NOM}"
  CreateShortcut "$SMPROGRAMS\${NOM}\${NOM}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortcut "$SMPROGRAMS\${NOM}\Désinstaller.lnk" "$INSTDIR\Desinstaller.exe"
  WriteRegStr HKCU "${CLE_DESINST}" "DisplayName" "${NOM}"
  WriteRegStr HKCU "${CLE_DESINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${CLE_DESINST}" "Publisher" "La Maison Blanche"
  WriteRegStr HKCU "${CLE_DESINST}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${CLE_DESINST}" "UninstallString" '"$INSTDIR\Desinstaller.exe"'
  WriteRegDWORD HKCU "${CLE_DESINST}" "NoModify" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 800
  Delete "$DESKTOP\${NOM}.lnk"
  RMDir /r "$SMPROGRAMS\${NOM}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${CLE_DESINST}"
  ; l'association à la caisse (dossier AppData\Roaming\Rapports La Maison Blanche) est gardée
SectionEnd
