; KurokawaReader — the installer's one screen (stage R6b). Put in place of the first of Tauri's own pages by
; installer/onepage.cjs, which also points Tauri's other installer pages at KrPre_* (skipped once this screen was used)
; and calls KrAfterInstall first in .onInstSuccess. Included where the pages are declared, after Tauri's defines
; (PRODUCTNAME, VERSION, MAINBINARYNAME) and its variables (PassiveMode). Its words are installer/onepage-lang.nsh's.
;
; One screen: the app's icon and name, what it does, «Install» (or «Update»); an «Options» disclosure with the folder,
; a desktop shortcut, opening books with the app, opening it when done. «Install» then runs Tauri's own install as
; its passive mode does — a progress bar, nothing to answer: the earlier version (if any) updated in place, the app
; closed if it runs, shortcuts made — and closes by itself; the choices are applied after (KrAfterInstall).
; Run with /P (passive) or /S (silent), as the app's updater and CI do, this screen is not shown.
!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh
!include FileFunc.nsh

!ifndef KR_HOOKS
  Var KrGui
  Var KrDesk
  Var KrRun
  Var KrAssoc
!endif
Var KrDlg
Var KrOptOpen
Var KrOptLink
Var KrDirLabel
Var KrDirBox
Var KrBrowseBtn
Var KrDeskBox
Var KrAssocBox
Var KrRunBox
Var KrIcon
Var KrFontTitle
Var KrUpgrade

; Tauri's pages after this one: skipped when this screen was used (each wrapper made by onepage.cjs also calls the
; page's own PRE function, if it had one).
!macro KR_SKIP_IF_ONE_PAGE
  ${If} $KrGui = 1
    Abort
  ${EndIf}
!macroend

Function KrShowOptions
  ${If} $KrOptOpen = 1
    StrCpy $0 ${SW_SHOW}
    ${NSD_SetText} $KrOptLink "$(KrOptions)  ▾"
  ${Else}
    StrCpy $0 ${SW_HIDE}
    ${NSD_SetText} $KrOptLink "$(KrOptions)  ▸"
  ${EndIf}
  ShowWindow $KrDirLabel $0
  ShowWindow $KrDirBox $0
  ShowWindow $KrBrowseBtn $0
  ShowWindow $KrDeskBox $0
  ShowWindow $KrAssocBox $0
  ShowWindow $KrRunBox $0
FunctionEnd

Function KrToggle
  Pop $0
  ${If} $KrOptOpen = 1
    StrCpy $KrOptOpen 0
  ${Else}
    StrCpy $KrOptOpen 1
  ${EndIf}
  Call KrShowOptions
FunctionEnd

Function KrBrowseDir
  Pop $0
  ${NSD_GetText} $KrDirBox $1
  nsDialogs::SelectFolderDialog "$(KrFolder)" "$1"
  Pop $1
  ${If} $1 != error
  ${AndIf} $1 != ""
    ${NSD_SetText} $KrDirBox "$1\${PRODUCTNAME}"
  ${EndIf}
FunctionEnd

Function KrOnePage
  ; (Passive or silent from the command line: Tauri's own way, no screen.)
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  StrCpy $KrGui 1
  ReadRegStr $KrUpgrade HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "DisplayVersion"
  ${If} $KrUpgrade == ""
    !insertmacro MUI_HEADER_TEXT "$(KrReady)" "${PRODUCTNAME} ${VERSION}"
  ${Else}
    !insertmacro MUI_HEADER_TEXT "$(KrReadyUpd)" "${PRODUCTNAME} $KrUpgrade → ${VERSION}"
  ${EndIf}
  ; (The choices' first values: a desktop shortcut on a first install, or as it is on an update; the kinds of file;
  ; opened when done.)
  ${If} $KrDesk == ""
    ${If} $KrUpgrade == ""
    ${OrIf} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      StrCpy $KrDesk 1
    ${Else}
      StrCpy $KrDesk 0
    ${EndIf}
    StrCpy $KrAssoc 1
    StrCpy $KrRun 1
  ${EndIf}
  ; (A command-line switch for CI's screenshot: the options open.)
  ClearErrors
  ${GetOptions} $CMDLINE "/KROPTIONS" $0
  ${IfNot} ${Errors}
    StrCpy $KrOptOpen 1
  ${EndIf}

  nsDialogs::Create 1018
  Pop $KrDlg
  ${If} $KrDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateIcon} 0u 0u 28u 28u ""
  Pop $0
  ${NSD_SetIconFromInstaller} $0 $KrIcon
  ${NSD_CreateLabel} 38u 0u -38u 16u "${PRODUCTNAME}"
  Pop $0
  CreateFont $KrFontTitle "Segoe UI Semibold" 16 600
  SendMessage $0 ${WM_SETFONT} $KrFontTitle 1
  ${NSD_CreateLabel} 38u 16u -38u 12u "$(KrTagline)"
  Pop $0
  ${NSD_CreateLabel} 0u 36u 100% 20u "$(KrBody)"
  Pop $0
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\KurokawaReader\resources\app.asar"
    ${NSD_CreateLabel} 0u 54u 100% 12u "$(KrReplaces)"
    Pop $0
  ${EndIf}

  ${NSD_CreateLink} 0u 70u 100% 11u "$(KrOptions)  ▸"
  Pop $KrOptLink
  ${NSD_OnClick} $KrOptLink KrToggle
  ${NSD_CreateLabel} 0u 84u 100% 9u "$(KrFolder)"
  Pop $KrDirLabel
  ${NSD_CreateDirRequest} 0u 94u -62u 13u "$INSTDIR"
  Pop $KrDirBox
  ${NSD_CreateBrowseButton} -58u 93u 58u 15u "$(KrBrowse)"
  Pop $KrBrowseBtn
  ${NSD_OnClick} $KrBrowseBtn KrBrowseDir
  ${NSD_CreateCheckbox} 0u 111u 100% 10u "$(KrDesktop)"
  Pop $KrDeskBox
  ${NSD_CreateCheckbox} 0u 122u 100% 10u "$(KrAssocText)"
  Pop $KrAssocBox
  ${NSD_CreateCheckbox} 0u 133u 100% 10u "$(KrRunText)"
  Pop $KrRunBox
  ${If} $KrDesk = 1
    ${NSD_Check} $KrDeskBox
  ${EndIf}
  ${If} $KrAssoc = 1
    ${NSD_Check} $KrAssocBox
  ${EndIf}
  ${If} $KrRun = 1
    ${NSD_Check} $KrRunBox
  ${EndIf}
  Call KrShowOptions

  ; (The bottom bar: «Install» / «Update» in place of «Next», no «Back».)
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $KrUpgrade == ""
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(KrInstall)"
  ${Else}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(KrUpdate)"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}

  nsDialogs::Show
  ${NSD_FreeIcon} $KrIcon
FunctionEnd

Function KrOnePageLeave
  ${NSD_GetText} $KrDirBox $0
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
  ${NSD_GetState} $KrDeskBox $KrDesk
  ${NSD_GetState} $KrAssocBox $KrAssoc
  ${NSD_GetState} $KrRunBox $KrRun
  ; (From here on, Tauri's own passive install: its pages skip themselves, its progress page closes by itself.)
  StrCpy $PassiveMode 1
  SetAutoClose true
FunctionEnd

; The kinds of file taken back when «Open books with KurokawaReader» was unticked (what Tauri's APP_ASSOCIATE wrote:
; .<ext> → its class, the class itself; the earlier owner put back). The list is tauri.conf.json's fileAssociations
; (tests/tauribridge.cjs keeps them equal).
!macro KR_UNASSOC EXT CLASS
  ReadRegStr $0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $0 == "${CLASS}"
    ReadRegStr $1 SHCTX "Software\Classes\.${EXT}" "${CLASS}_backup"
    ${If} $1 == ""
      DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
    ${Else}
      WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "$1"
    ${EndIf}
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${CLASS}_backup"
    DeleteRegKey SHCTX "Software\Classes\${CLASS}"
  ${EndIf}
!macroend

Function KrAfterInstall
  !ifmacrodef KR_TRACE
    !insertmacro KR_TRACE "success"
  !endif
  ; (Stage R6c: the designed setup program — setup/ — runs this installer silently with the choices as switches:
  ; /KRDESK=0|1 /KRASSOC=0|1. Read here, so they are applied as the one screen's are: no desktop shortcut, the kinds
  ; of file taken back. «Open when done» is the setup program's own. Without either switch nothing changes: the
  ; updater's /P /R /UPDATE, /S /UPDATE, CI's /S and the one screen behave as in R6b.)
  ${If} $KrGui != 1
    StrCpy $1 ""
    StrCpy $2 ""
    ClearErrors
    ${GetOptions} $CMDLINE "/KRDESK=" $0
    ${IfNot} ${Errors}
      StrCpy $1 $0 1
    ${EndIf}
    ClearErrors
    ${GetOptions} $CMDLINE "/KRASSOC=" $0
    ${IfNot} ${Errors}
      StrCpy $2 $0 1
    ${EndIf}
    ClearErrors
    ${If} "$1$2" != ""
      ; (Either switch alone: the other choice left as Tauri's silent install made it.)
      StrCpy $KrGui 1
      StrCpy $KrRun 0
      StrCpy $KrDesk 1
      StrCpy $KrAssoc 1
      ${If} $1 == "0"
        StrCpy $KrDesk 0
      ${EndIf}
      ${If} $2 == "0"
        StrCpy $KrAssoc 0
      ${EndIf}
      ; (Asked for and not there — an update, where Tauri's silent install makes none: made here.)
      ${If} $1 == "1"
      ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $KrGui = 1
    ${If} $KrDesk = 0
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} $KrAssoc = 0
      !insertmacro KR_UNASSOC "epub" "EPUB book"
      !insertmacro KR_UNASSOC "pdf" "PDF document"
      !insertmacro KR_UNASSOC "docx" "Word document"
      !insertmacro KR_UNASSOC "xlsx" "Excel workbook"
      !insertmacro KR_UNASSOC "pptx" "PowerPoint presentation"
      !insertmacro KR_UNASSOC "txt" "Text"
      !insertmacro KR_UNASSOC "md" "Markdown"
      !insertmacro KR_UNASSOC "fb2" "FictionBook"
      !insertmacro KR_UNASSOC "cbz" "Comic archive"
      !insertmacro KR_UNASSOC "otf" "OpenType font"
      !insertmacro KR_UNASSOC "ttf" "TrueType font"
      !insertmacro KR_UNASSOC "odt" "OpenDocument text"
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ${EndIf}
    ${If} $KrRun = 1
      Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
    ${EndIf}
  ${EndIf}
FunctionEnd
