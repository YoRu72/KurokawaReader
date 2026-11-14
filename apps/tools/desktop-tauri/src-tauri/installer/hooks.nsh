; Kurokawa Tools — the Windows installer's hooks (Tools' stage P9; the Reader's installer/hooks.nsh, stage R6b, with
; Tools' names, data and links). Named by tauri.conf.json (bundle.windows.nsis.installerHooks) and inserted by Tauri's own
; NSIS template into its install section (NSIS_HOOK_PREINSTALL: before the new program's files; NSIS_HOOK_POSTINSTALL:
; after its files, registry entries, kinds of file and links are in place). Only macros here: they are expanded where
; Tauri inserts them, so nothing depends on where this file itself is included.
;
; What it does: replaces an installed ELECTRON Kurokawa Tools (electron-builder's per-user NSIS install, see
; apps/tools/desktop/package.json build.nsis: perMachine false — its folder %LOCALAPPDATA%\Programs\Kurokawa Tools, its
; uninstall entry HKCU\...\Uninstall\<its GUID> named «Kurokawa Tools», its own program «Kurokawa Tools.exe» with
; resources\app.asar beside it) — AFTER the new program is in place:
;   1. its shortcuts (desktop, Start menu, pinned on the taskbar) pointed at the new program;
;   2. magnet: and kurokawatools:// links and .torrent files pointed at the new program (Tauri registers them too; here
;      they are made sure of where Electron had them);
;   3. its program files removed (retried while its processes end; else at the next restart), its uninstall entry and
;      install key removed.
;
; ONLY WHEN IT IS SAFE (the switch-over): the Electron copy is replaced only when its data has been handed over — a
; finished hand-over in its data folder (handover\marker.json: written last, after every file was checked, by the
; Electron «bridge» build) — or when it has nothing of the person's (no Local Storage, IndexedDB or tasks.json in its
; data folder). Otherwise it is KEPT, untouched, beside the new program — and so are its links and its .torrent files:
; what Tauri's install pointed at the new program is put back as it was (PREINSTALL kept the values), so magnets go on
; opening the program that holds the person's downloads until it has handed them over. The person opens it once, it
; updates itself to the bridge build, which makes the hand-over and runs this installer again — then it is replaced.
; The setup program passes its own decision as /KROLD=keep|replace (setup/src-tauri/src/logic.rs old_decision, the same
; rule); with no switch the rule is applied here; anything else keeps it. (CI: installtest.ps1 / setuptest.ps1.)
; Its DATA FOLDER (%APPDATA%\Kurokawa Tools — settings, lists, the engine's session, the hand-over) is never touched,
; nor any downloaded file, and its uninstaller is never run (it would take the links away from the new program). An
; Electron install for all users (HKLM, Program Files) needs an administrator to remove: it is left as it is.
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
; (The links and the .torrent kind as they were before Tauri's install wrote its own — PREINSTALL.)
Var KrWasMagnet
Var KrWasKt
Var KrWasTorrentExt
Var KrWasTorrentCmd

!define KR_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define KR_OLD_NAME "Kurokawa Tools"

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
    ReadRegStr $1 HKCU "${KR_UNINST}\${PRODUCTNAME}" "DisplayVersion"
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
    ${If} $R8 != "${PRODUCTNAME}"
      ReadRegStr $R7 HKCU "${KR_UNINST}\$R8" "DisplayName"
      ${If} $R7 == "${KR_OLD_NAME}"
        ReadRegStr $R6 HKCU "${KR_UNINST}\$R8" "InstallLocation"
        ${If} ${FileExists} "$R6\resources\app.asar"
        ${AndIf} ${FileExists} "$R6\${KR_OLD_NAME}.exe"
          StrCpy $KrOldDir $R6
          StrCpy $KrOldKey $R8
          ${Break}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${Loop}
  ; (No entry found: electron-builder's default folder, when it holds an Electron Kurokawa Tools.)
  ${If} $KrOldDir == ""
    ${If} ${FileExists} "$LOCALAPPDATA\Programs\${KR_OLD_NAME}\resources\app.asar"
      StrCpy $KrOldDir "$LOCALAPPDATA\Programs\${KR_OLD_NAME}"
    ${EndIf}
  ${EndIf}
  ; (Never this installation's own folder.)
  ${If} $KrOldDir == $INSTDIR
    StrCpy $KrOldDir ""
  ${EndIf}
!macroend

; Whether the Electron copy found may be replaced → $KrOld = "replace" | "keep". /KROLD=keep|replace (the setup
; program's decision) wins; else: replace when its data was handed over (a finished hand-over's marker in its data
; folder) or when it holds nothing of the person's (no Local Storage, IndexedDB or tasks.json there); keep otherwise —
; and for any other value. (kt-core handoverlogic.rs old_decision / electron_has_data: the same rule.)
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
    ${If} ${FileExists} "$APPDATA\${KR_OLD_NAME}\handover\marker.json"
      StrCpy $KrOld "replace"
    ${ElseIf} ${FileExists} "$APPDATA\${KR_OLD_NAME}\Local Storage\*.*"
      StrCpy $KrOld "keep"
    ${ElseIf} ${FileExists} "$APPDATA\${KR_OLD_NAME}\IndexedDB\*.*"
      StrCpy $KrOld "keep"
    ${ElseIf} ${FileExists} "$APPDATA\${KR_OLD_NAME}\tasks.json"
      StrCpy $KrOld "keep"
    ${Else}
      StrCpy $KrOld "replace"
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $0
!macroend

; A shortcut of the Electron build, where there is one, made anew for the new program.
!macro KR_REPOINT_LNK LNK
  ${If} ${FileExists} "${LNK}"
    CreateShortCut "${LNK}" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ${EndIf}
!macroend

; Whether a command line names a program in the Electron folder → $R5 = 1 | 0.
!macro KR_NAMES_OLD CMD
  StrCpy $R5 0
  ${If} $KrOldDir != ""
    StrLen $R4 "$KrOldDir"
    StrCpy $R3 "${CMD}" $R4 1
    ${If} $R3 == "$KrOldDir"
      StrCpy $R5 1
    ${EndIf}
    StrCpy $R3 "${CMD}" $R4
    ${If} $R3 == "$KrOldDir"
      StrCpy $R5 1
    ${EndIf}
  ${EndIf}
!macroend

; The Electron build's Run value NAME removed (with Windows' «approved» note of it) where it names the old program.
!macro KR_OLD_RUN_GONE NAME
  ReadRegStr $R7 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${NAME}"
  ${If} $R7 != ""
    !insertmacro KR_NAMES_OLD "$R7"
    ${If} $R5 = 1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${NAME}"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${NAME}"
      !insertmacro KR_TRACE "login-old-removed"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

; A link (magnet, kurokawatools) written for the new program.
!macro KR_LINK_NEW SCHEME
  WriteRegStr HKCU "Software\Classes\${SCHEME}" "" "URL:${SCHEME}"
  WriteRegStr HKCU "Software\Classes\${SCHEME}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${SCHEME}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro KR_REPLACE_ELECTRON
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  !insertmacro KR_FIND_ELECTRON
  !insertmacro KR_OLD_DECISION
  ${If} $KrOldDir != ""
  ${AndIf} $KrOld != "replace"
    DetailPrint "Kurokawa Tools: the earlier version in $KrOldDir is kept beside this one: its data has not been handed over yet"
    !insertmacro KR_TRACE "electron-kept"
    ; (Its links and .torrent files stay its own until it has handed its downloads over: what Tauri's install pointed
    ; at the new program is put back where it named the Electron program.)
    !insertmacro KR_NAMES_OLD "$KrWasMagnet"
    ${If} $R5 = 1
      WriteRegStr HKCU "Software\Classes\magnet\shell\open\command" "" "$KrWasMagnet"
    ${EndIf}
    !insertmacro KR_NAMES_OLD "$KrWasKt"
    ${If} $R5 = 1
      WriteRegStr HKCU "Software\Classes\kurokawatools\shell\open\command" "" "$KrWasKt"
    ${EndIf}
    !insertmacro KR_NAMES_OLD "$KrWasTorrentCmd"
    ${If} $R5 = 1
    ${AndIf} $KrWasTorrentExt != ""
      WriteRegStr HKCU "Software\Classes\$KrWasTorrentExt\shell\open\command" "" "$KrWasTorrentCmd"
      WriteRegStr HKCU "Software\Classes\.torrent" "" "$KrWasTorrentExt"
    ${EndIf}
    ; (Its desktop shortcut, where there was one before this install, put back; the new program keeps its Start-menu
    ; entry.)
    ${If} ${FileExists} "$TEMP\kr-old-desktop.lnk"
      CopyFiles /SILENT "$TEMP\kr-old-desktop.lnk" "$DESKTOP\${KR_OLD_NAME}.lnk"
      !insertmacro KR_TRACE "desktop-kept"
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  Delete "$TEMP\kr-old-desktop.lnk"
  ${If} $KrOldDir != ""
  ${AndIf} $KrOld == "replace"
    !insertmacro KR_TRACE "electron-replaced"
    DetailPrint "Kurokawa Tools: replacing the earlier version in $KrOldDir (its data and downloads are kept)"
    ; 1. Shortcuts. (The Start menu's: where Tauri made its own in a folder, the old one goes; else it is made anew.)
    !insertmacro KR_REPOINT_LNK "$DESKTOP\${KR_OLD_NAME}.lnk"
    !insertmacro KR_REPOINT_LNK "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${KR_OLD_NAME}.lnk"
    ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${KR_OLD_NAME}.lnk"
    ${Else}
      !insertmacro KR_REPOINT_LNK "$SMPROGRAMS\${KR_OLD_NAME}.lnk"
    ${EndIf}
    ; 2. The links and .torrent files, where Electron had them (Tauri's install has registered its own as well).
    !insertmacro KR_NAMES_OLD "$KrWasMagnet"
    ${If} $R5 = 1
      !insertmacro KR_LINK_NEW "magnet"
    ${EndIf}
    !insertmacro KR_NAMES_OLD "$KrWasKt"
    ${If} $R5 = 1
      !insertmacro KR_LINK_NEW "kurokawatools"
    ${EndIf}
    ReadRegStr $R7 HKCU "Software\Classes\Torrent\shell\open\command" ""
    !insertmacro KR_NAMES_OLD "$R7"
    ${If} $R5 = 1
      WriteRegStr HKCU "Software\Classes\Torrent\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
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
    ; 4. Start at log-in: the Electron build's own Run value (named by its AppUserModelId) taken away where it names
    ; the old program — the new one writes its own («Kurokawa Tools») when its settings say so: never two at log-in.
    ; (Kept beside: left as it is — KR_OLD keep never reaches here.)
    !insertmacro KR_OLD_RUN_GONE "app.kurokawa.tools"
    !insertmacro KR_OLD_RUN_GONE "electron.app.Kurokawa Tools"
    ; (Explorer told: file types and shortcuts changed.)
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KR_TRACE "preinstall"
  ; (The links and the .torrent kind as they are now — Electron's, another program's, or none —, before Tauri writes its
  ; own: an Electron copy kept beside the new program gets its own back.)
  ReadRegStr $KrWasMagnet HKCU "Software\Classes\magnet\shell\open\command" ""
  ReadRegStr $KrWasKt HKCU "Software\Classes\kurokawatools\shell\open\command" ""
  ReadRegStr $KrWasTorrentExt HKCU "Software\Classes\.torrent" ""
  ${If} $KrWasTorrentExt != ""
    ReadRegStr $KrWasTorrentCmd HKCU "Software\Classes\$KrWasTorrentExt\shell\open\command" ""
  ${EndIf}
  ; (The desktop shortcut as it is now: Tauri's install makes one of the SAME name, «Kurokawa Tools.lnk», over the
  ; Electron program's — run 43551417003 —; an Electron copy kept beside gets its own back.)
  Delete "$TEMP\kr-old-desktop.lnk"
  ${If} ${FileExists} "$DESKTOP\${KR_OLD_NAME}.lnk"
    CopyFiles /SILENT "$DESKTOP\${KR_OLD_NAME}.lnk" "$TEMP\kr-old-desktop.lnk"
  ${EndIf}
  ClearErrors
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro KR_TRACE "postinstall"
  ${If} $KrGui = 1
    DetailPrint "Kurokawa Tools: desktop shortcut $KrDesk, open when done $KrRun, torrents and magnet links $KrAssoc"
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
