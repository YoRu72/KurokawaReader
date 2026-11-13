; KurokawaReader — the Windows installer's hooks (stage R6b). Named by tauri.conf.json (bundle.windows.nsis.installerHooks)
; and inserted by Tauri's own NSIS template into its install section (NSIS_HOOK_POSTINSTALL: after the new program's
; files, registry entries and file types are in place). Only macros here: they are expanded where Tauri inserts them,
; so nothing depends on where this file itself is included.
;
; What it does: replaces an installed ELECTRON KurokawaReader (electron-builder's per-user NSIS install, see
; apps/reader/desktop/package.json build.nsis: perMachine false — its folder %LOCALAPPDATA%\Programs\KurokawaReader, its
; uninstall entry HKCU\...\Uninstall\<its GUID> named «KurokawaReader», its own program KurokawaReader.exe with
; resources\app.asar beside it) — AFTER the new program is in place:
;   1. its shortcuts (desktop, Start menu, pinned on the taskbar) pointed at the new program;
;   2. the kurokawareader:// links pointed at the new program (the kinds of file are Tauri's own registrations: the
;      same class names as Electron's, so they now open the new program);
;   3. its program files removed (retried while its processes end; else at the next restart), its uninstall entry and
;      install key removed.
;
; ONLY WHEN IT IS SAFE (0.62.0, the switch-over): the Electron copy is replaced only when its library has been handed
; over — a finished hand-over in its data folder (handover\marker.json: written last, after every file was checked, by
; the Electron «bridge» build) — or when it has no library at all (no IndexedDB in its data folder). Otherwise it is
; KEPT, untouched, beside the new program: the person opens it once, it updates itself to the bridge build, which
; makes the hand-over and runs this installer again — then it is replaced. The setup program passes its own decision
; as /KROLD=keep|replace (setup/src-tauri/src/logic.rs old_decision, the same rule); with no switch the rule is applied
; here; anything else keeps it. (CI: installtest.ps1 / setuptest.ps1 check both ways.)
; Its DATA FOLDER (%APPDATA%\KurokawaReader — the library, settings, the hand-over backup) is never touched, and its
; uninstaller is never run (it would take the file types away from the new program). An Electron install for all users
; (HKLM, Program Files) needs an administrator to remove: it is left as it is (the new program's per-user
; registrations come first anyway).
!define KR_HOOKS
!include LogicLib.nsh
!include FileFunc.nsh

; (Set by the one-page screen, installer/onepage.nsh, when it is used: 1 = the screen, its choices below.)
Var KrGui
Var KrDesk
Var KrRun
Var KrAssoc
Var KrOldDir
Var KrOldKey
Var KrOld

!define KR_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall"

; (CI: with KR_INSTALL_TRACE=<file> in the environment — installtest.ps1 sets it —, each step of an install or an
; uninstall is noted there, one line each: the step, this installer's version, the uninstall entry's DisplayVersion at
; that moment, the tick count, the command line. Nothing is read or written without it.)
!macro KR_TRACE WHAT
  Push $0
  Push $1
  Push $2
  ClearErrors
  ReadEnvStr $0 KR_INSTALL_TRACE
  ${IfNot} ${Errors}
  ${AndIf} $0 != ""
    ; (Tauri's own entry is named after the product, see KR_FIND_ELECTRON.)
    ReadRegStr $1 HKCU "${KR_UNINST}\KurokawaReader" "DisplayVersion"
    System::Call 'kernel32::GetTickCount()i .r2'
    ClearErrors
    FileOpen $0 $0 a
    ${IfNot} ${Errors}
      FileSeek $0 0 END
      !ifdef VERSION
        FileWrite $0 "${WHAT} v${VERSION} entry=[$1] tick=$2 cmd=$CMDLINE$\r$\n"
      !else
        FileWrite $0 "${WHAT} entry=[$1] tick=$2 cmd=$CMDLINE$\r$\n"
      !endif
      FileClose $0
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $2
  Pop $1
  Pop $0
!macroend

; The Electron install: its folder in $KrOldDir and its uninstall key's name in $KrOldKey ("" when there is none).
!macro KR_FIND_ELECTRON
  StrCpy $KrOldDir ""
  StrCpy $KrOldKey ""
  StrCpy $R9 0
  ${Do}
    ClearErrors
    EnumRegKey $R8 HKCU "${KR_UNINST}" $R9
    ${If} ${Errors}
    ${OrIf} $R8 == ""
      ${Break}
    ${EndIf}
    IntOp $R9 $R9 + 1
    ; (Tauri's own entry is named after the product; Electron's after its GUID.)
    ${If} $R8 != "KurokawaReader"
      ReadRegStr $R7 HKCU "${KR_UNINST}\$R8" "DisplayName"
      ${If} $R7 == "KurokawaReader"
        ReadRegStr $R6 HKCU "${KR_UNINST}\$R8" "InstallLocation"
        ${If} ${FileExists} "$R6\resources\app.asar"
        ${AndIf} ${FileExists} "$R6\KurokawaReader.exe"
          StrCpy $KrOldDir $R6
          StrCpy $KrOldKey $R8
          ${Break}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${Loop}
  ; (No entry found: electron-builder's default folder, when it holds an Electron KurokawaReader.)
  ${If} $KrOldDir == ""
    ${If} ${FileExists} "$LOCALAPPDATA\Programs\KurokawaReader\resources\app.asar"
      StrCpy $KrOldDir "$LOCALAPPDATA\Programs\KurokawaReader"
    ${EndIf}
  ${EndIf}
  ; (Never this installation's own folder.)
  ${If} $KrOldDir == $INSTDIR
    StrCpy $KrOldDir ""
  ${EndIf}
!macroend

; Whether the Electron copy found may be replaced → $KrOld = "replace" | "keep". /KROLD=keep|replace (the setup
; program's decision) wins; else: replace when its library was handed over (a finished hand-over's marker in its data
; folder) or when it has no library (no IndexedDB there); keep otherwise — and for any other value.
!macro KR_OLD_DECISION
  Push $0
  StrCpy $KrOld ""
  ClearErrors
  ${GetOptions} $CMDLINE "/KROLD=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "replace"
      StrCpy $KrOld "replace"
    ${Else}
      StrCpy $KrOld "keep"
    ${EndIf}
  ${Else}
    ${If} ${FileExists} "$APPDATA\KurokawaReader\handover\marker.json"
      StrCpy $KrOld "replace"
    ${ElseIfNot} ${FileExists} "$APPDATA\KurokawaReader\IndexedDB\*.*"
      StrCpy $KrOld "replace"
    ${Else}
      StrCpy $KrOld "keep"
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $0
!macroend

; A shortcut of the Electron build, where there is one, made anew for the new program.
!macro KR_REPOINT_LNK LNK
  ${If} ${FileExists} "${LNK}"
    CreateShortCut "${LNK}" "$INSTDIR\KurokawaReader.exe" "" "$INSTDIR\KurokawaReader.exe" 0
  ${EndIf}
!macroend

!macro KR_REPLACE_ELECTRON
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  !insertmacro KR_FIND_ELECTRON
  !insertmacro KR_OLD_DECISION
  ${If} $KrOldDir != ""
  ${AndIf} $KrOld != "replace"
    DetailPrint "KurokawaReader: the earlier version in $KrOldDir is kept beside this one: its library has not been handed over yet"
    !insertmacro KR_TRACE "electron-kept"
  ${EndIf}
  ${If} $KrOldDir != ""
  ${AndIf} $KrOld == "replace"
    !insertmacro KR_TRACE "electron-replaced"
    DetailPrint "KurokawaReader: replacing the earlier version in $KrOldDir (its data is kept)"
    ; 1. Shortcuts. (The Start menu's: where Tauri made its own in a folder, the old one goes; else it is made anew.)
    !insertmacro KR_REPOINT_LNK "$DESKTOP\KurokawaReader.lnk"
    !insertmacro KR_REPOINT_LNK "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\KurokawaReader.lnk"
    ${If} ${FileExists} "$SMPROGRAMS\KurokawaReader\KurokawaReader.lnk"
      Delete "$SMPROGRAMS\KurokawaReader.lnk"
    ${Else}
      !insertmacro KR_REPOINT_LNK "$SMPROGRAMS\KurokawaReader.lnk"
    ${EndIf}
    ; 2. The app's links (kurokawareader://), where Electron registered them.
    ReadRegStr $R7 HKCU "Software\Classes\kurokawareader\shell\open\command" ""
    ${If} $R7 != ""
      WriteRegStr HKCU "Software\Classes\kurokawareader" "" "URL:kurokawareader"
      WriteRegStr HKCU "Software\Classes\kurokawareader" "URL Protocol" ""
      WriteRegStr HKCU "Software\Classes\kurokawareader\shell\open\command" "" '"$INSTDIR\KurokawaReader.exe" "%1"'
    ${EndIf}
    ; 3. Its program files (only a folder that is Electron's: resources\app.asar in it), retried while its processes end.
    ${If} ${FileExists} "$KrOldDir\resources\app.asar"
      StrCpy $R9 0
      ${Do}
        RMDir /r "$KrOldDir"
        ${IfNot} ${FileExists} "$KrOldDir\*.*"
          ${Break}
        ${EndIf}
        IntOp $R9 $R9 + 1
        ${If} $R9 >= 20
          RMDir /r /REBOOTOK "$KrOldDir"
          ${Break}
        ${EndIf}
        Sleep 500
      ${Loop}
    ${EndIf}
    ${If} $KrOldKey != ""
      DeleteRegKey HKCU "${KR_UNINST}\$KrOldKey"
      ReadRegStr $R7 HKCU "Software\$KrOldKey" "InstallLocation"
      ${If} $R7 == $KrOldDir
        DeleteRegKey HKCU "Software\$KrOldKey"
      ${EndIf}
    ${EndIf}
    ; (Explorer told: file types and shortcuts changed.)
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KR_TRACE "preinstall"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro KR_TRACE "postinstall"
  ${If} $KrGui = 1
    DetailPrint "KurokawaReader: desktop shortcut $KrDesk, open when done $KrRun, open books with it $KrAssoc"
  ${EndIf}
  !insertmacro KR_REPLACE_ELECTRON
!macroend

; (The uninstaller: only traced — CI's KR_INSTALL_TRACE —, whether it is run by a person, by /S, or by an installer.)
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KR_TRACE "preuninstall"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro KR_TRACE "postuninstall"
!macroend
