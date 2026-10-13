; Installer hooks for the Windows setup (referenced from tauri.conf.json: bundle.windows.nsis.installerHooks).
;
; The setup already replaces an earlier setup-installed HiveTeX. This hook additionally removes a HiveTeX installed from
; the MSI (a different product that would otherwise stay listed next to the new one). Only the program is removed:
; Upgrade replacement preserves user state. Explicit uninstall removes HiveTeX-owned user data and credentials.

!macro HiveTeXRemoveMsiFrom ROOT VIEW
  SetRegView ${VIEW}
  StrCpy $R0 0
  hivetex_next_${ROOT}_${VIEW}:
    EnumRegKey $R1 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    StrCmp $R1 "" hivetex_done_${ROOT}_${VIEW}
    IntOp $R0 $R0 + 1
    ; MSI products are registered under their product code, a {GUID} with WindowsInstaller=1.
    StrCpy $R2 $R1 1
    StrCmp $R2 "{" 0 hivetex_next_${ROOT}_${VIEW}
    ReadRegDWORD $R3 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "WindowsInstaller"
    StrCmp $R3 1 0 hivetex_next_${ROOT}_${VIEW}
    ReadRegStr $R4 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCmp $R4 "${PRODUCTNAME}" 0 hivetex_next_${ROOT}_${VIEW}
    DetailPrint "Removing the earlier ${PRODUCTNAME} installation (MSI)"
    ; "runas" asks for administrator rights only when needed (a per-machine MSI cannot be removed without them).
    ExecShellWait "runas" "msiexec.exe" "/x $R1 /qn /norestart HIVETEX_UPGRADE=1" SW_HIDE
    ReadRegStr $R4 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    ; A declined/failed uninstall must not leave two installations behind.
    StrCmp $R4 "" hivetex_removed_${ROOT}_${VIEW}
    MessageBox MB_OK|MB_ICONSTOP "The earlier HiveTeX MSI could not be removed. Close HiveTeX and retry setup."
    Abort
  hivetex_removed_${ROOT}_${VIEW}:
    StrCpy $R0 0
    Goto hivetex_next_${ROOT}_${VIEW}
  hivetex_done_${ROOT}_${VIEW}:
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  !insertmacro HiveTeXRemoveMsiFrom HKLM 64
  !insertmacro HiveTeXRemoveMsiFrom HKLM 32
  !insertmacro HiveTeXRemoveMsiFrom HKCU 64
  !insertmacro HiveTeXRemoveMsiFrom HKCU 32
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    SetRegView 32
  ${EndIf}
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; /UPDATE is used by the updater. _?= is added when setup invokes the previous uninstaller for replacement,
  ; including an ordinary manual upgrade (which does not necessarily pass /UPDATE).
  ${If} $UpdateMode <> 1
    Push $R0
    Push $R1
    ClearErrors
    ${GetOptions} $CMDLINE "_?=" $R0
    ${If} ${Errors}
      DetailPrint "Removing HiveTeX user data, compiler caches, credentials and login startup"
      ; Reset the parameter-probe state before running maintenance.
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-cleanup' $R1
      ${If} ${Errors}
        StrCpy $R1 1
      ${EndIf}
      ${If} $R1 <> 0
        MessageBox MB_OK|MB_ICONSTOP "HiveTeX could not remove all its user data. Close HiveTeX and retry uninstall. Your linked project folders are not removed." /SD IDOK
        SetErrorLevel 1
        Abort
      ${EndIf}
    ${EndIf}
    Pop $R1
    Pop $R0
  ${EndIf}
!macroend
