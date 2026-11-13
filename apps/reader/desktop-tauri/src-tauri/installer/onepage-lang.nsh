; KurokawaReader — the one screen's words (stage R6b), in the installer's five languages (tauri.conf.json
; bundle.windows.nsis.languages). Appended at the end of Tauri's installer script by installer/onepage.cjs, after its
; MUI_LANGUAGE lines; a language the build did not load is skipped. (NSIS lays Arabic out right to left itself.)
!ifdef LANG_ENGLISH
  LangString KrInstall ${LANG_ENGLISH} "Install"
!endif
!ifdef LANG_ARABIC
  LangString KrInstall ${LANG_ARABIC} "تثبيت"
!endif
!ifdef LANG_JAPANESE
  LangString KrInstall ${LANG_JAPANESE} "インストール"
!endif
!ifdef LANG_KOREAN
  LangString KrInstall ${LANG_KOREAN} "설치"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrInstall ${LANG_SIMPCHINESE} "安装"
!endif
!ifdef LANG_ENGLISH
  LangString KrUpdate ${LANG_ENGLISH} "Update"
!endif
!ifdef LANG_ARABIC
  LangString KrUpdate ${LANG_ARABIC} "تحديث"
!endif
!ifdef LANG_JAPANESE
  LangString KrUpdate ${LANG_JAPANESE} "更新"
!endif
!ifdef LANG_KOREAN
  LangString KrUpdate ${LANG_KOREAN} "업데이트"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrUpdate ${LANG_SIMPCHINESE} "更新"
!endif
!ifdef LANG_ENGLISH
  LangString KrReady ${LANG_ENGLISH} "Ready to install"
!endif
!ifdef LANG_ARABIC
  LangString KrReady ${LANG_ARABIC} "جاهزٌ للتثبيت"
!endif
!ifdef LANG_JAPANESE
  LangString KrReady ${LANG_JAPANESE} "インストールの準備ができました"
!endif
!ifdef LANG_KOREAN
  LangString KrReady ${LANG_KOREAN} "설치 준비 완료"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrReady ${LANG_SIMPCHINESE} "准备安装"
!endif
!ifdef LANG_ENGLISH
  LangString KrReadyUpd ${LANG_ENGLISH} "Ready to update"
!endif
!ifdef LANG_ARABIC
  LangString KrReadyUpd ${LANG_ARABIC} "جاهزٌ للتحديث"
!endif
!ifdef LANG_JAPANESE
  LangString KrReadyUpd ${LANG_JAPANESE} "更新の準備ができました"
!endif
!ifdef LANG_KOREAN
  LangString KrReadyUpd ${LANG_KOREAN} "업데이트 준비 완료"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrReadyUpd ${LANG_SIMPCHINESE} "准备更新"
!endif
!ifdef LANG_ENGLISH
  LangString KrTagline ${LANG_ENGLISH} "A reader for anything that can be read."
!endif
!ifdef LANG_ARABIC
  LangString KrTagline ${LANG_ARABIC} "قارئٌ لكلِّ ما يُقرأ."
!endif
!ifdef LANG_JAPANESE
  LangString KrTagline ${LANG_JAPANESE} "読めるものなら何でも読めるリーダー。"
!endif
!ifdef LANG_KOREAN
  LangString KrTagline ${LANG_KOREAN} "읽을 수 있는 모든 것을 위한 리더."
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrTagline ${LANG_SIMPCHINESE} "能读的都能读。"
!endif
!ifdef LANG_ENGLISH
  LangString KrBody ${LANG_ENGLISH} "Installs for you only — no administrator rights needed. It takes a few seconds."
!endif
!ifdef LANG_ARABIC
  LangString KrBody ${LANG_ARABIC} "يُثبَّت لك وحدك دون حاجةٍ إلى صلاحيات المدير، ولا يستغرق إلا ثوانيَ معدودة."
!endif
!ifdef LANG_JAPANESE
  LangString KrBody ${LANG_JAPANESE} "このユーザーだけにインストールします。管理者権限は不要で、数秒で終わります。"
!endif
!ifdef LANG_KOREAN
  LangString KrBody ${LANG_KOREAN} "현재 사용자에게만 설치되며 관리자 권한이 필요 없습니다. 몇 초면 끝납니다."
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrBody ${LANG_SIMPCHINESE} "仅为当前用户安装,无需管理员权限,几秒即可完成。"
!endif
!ifdef LANG_ENGLISH
  LangString KrReplaces ${LANG_ENGLISH} "Replaces the earlier KurokawaReader on this computer. Your library is kept."
!endif
!ifdef LANG_ARABIC
  LangString KrReplaces ${LANG_ARABIC} "يحُلُّ محلَّ KurokawaReader السابقِ على هذا الحاسوب، ومكتبتُك محفوظة."
!endif
!ifdef LANG_JAPANESE
  LangString KrReplaces ${LANG_JAPANESE} "このパソコンの以前の KurokawaReader と置き換えます。ライブラリはそのまま残ります。"
!endif
!ifdef LANG_KOREAN
  LangString KrReplaces ${LANG_KOREAN} "이 컴퓨터의 이전 KurokawaReader를 대체합니다. 서재는 그대로 유지됩니다."
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrReplaces ${LANG_SIMPCHINESE} "将替换这台电脑上旧版的 KurokawaReader,书库会保留。"
!endif
!ifdef LANG_ENGLISH
  LangString KrOptions ${LANG_ENGLISH} "Options"
!endif
!ifdef LANG_ARABIC
  LangString KrOptions ${LANG_ARABIC} "خيارات"
!endif
!ifdef LANG_JAPANESE
  LangString KrOptions ${LANG_JAPANESE} "オプション"
!endif
!ifdef LANG_KOREAN
  LangString KrOptions ${LANG_KOREAN} "옵션"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrOptions ${LANG_SIMPCHINESE} "选项"
!endif
!ifdef LANG_ENGLISH
  LangString KrFolder ${LANG_ENGLISH} "Install in"
!endif
!ifdef LANG_ARABIC
  LangString KrFolder ${LANG_ARABIC} "مجلَّد التثبيت"
!endif
!ifdef LANG_JAPANESE
  LangString KrFolder ${LANG_JAPANESE} "インストール先"
!endif
!ifdef LANG_KOREAN
  LangString KrFolder ${LANG_KOREAN} "설치 위치"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrFolder ${LANG_SIMPCHINESE} "安装位置"
!endif
!ifdef LANG_ENGLISH
  LangString KrBrowse ${LANG_ENGLISH} "Browse…"
!endif
!ifdef LANG_ARABIC
  LangString KrBrowse ${LANG_ARABIC} "استعراض…"
!endif
!ifdef LANG_JAPANESE
  LangString KrBrowse ${LANG_JAPANESE} "参照…"
!endif
!ifdef LANG_KOREAN
  LangString KrBrowse ${LANG_KOREAN} "찾아보기…"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrBrowse ${LANG_SIMPCHINESE} "浏览…"
!endif
!ifdef LANG_ENGLISH
  LangString KrDesktop ${LANG_ENGLISH} "Add a desktop shortcut"
!endif
!ifdef LANG_ARABIC
  LangString KrDesktop ${LANG_ARABIC} "أضِفِ اختصارًا على سطح المكتب"
!endif
!ifdef LANG_JAPANESE
  LangString KrDesktop ${LANG_JAPANESE} "デスクトップにショートカットを作成"
!endif
!ifdef LANG_KOREAN
  LangString KrDesktop ${LANG_KOREAN} "바탕 화면에 바로 가기 만들기"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrDesktop ${LANG_SIMPCHINESE} "创建桌面快捷方式"
!endif
!ifdef LANG_ENGLISH
  LangString KrAssocText ${LANG_ENGLISH} "Open EPUB, PDF and other books with KurokawaReader"
!endif
!ifdef LANG_ARABIC
  LangString KrAssocText ${LANG_ARABIC} "افتحْ ملفّاتِ EPUB وPDF وسائرَ الكتب بـ KurokawaReader"
!endif
!ifdef LANG_JAPANESE
  LangString KrAssocText ${LANG_JAPANESE} "EPUB・PDF などの本を KurokawaReader で開く"
!endif
!ifdef LANG_KOREAN
  LangString KrAssocText ${LANG_KOREAN} "EPUB, PDF 등 책을 KurokawaReader로 열기"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrAssocText ${LANG_SIMPCHINESE} "用 KurokawaReader 打开 EPUB、PDF 等书籍"
!endif
!ifdef LANG_ENGLISH
  LangString KrRunText ${LANG_ENGLISH} "Open KurokawaReader when done"
!endif
!ifdef LANG_ARABIC
  LangString KrRunText ${LANG_ARABIC} "افتحْ KurokawaReader عند الانتهاء"
!endif
!ifdef LANG_JAPANESE
  LangString KrRunText ${LANG_JAPANESE} "完了したら KurokawaReader を開く"
!endif
!ifdef LANG_KOREAN
  LangString KrRunText ${LANG_KOREAN} "완료되면 KurokawaReader 열기"
!endif
!ifdef LANG_SIMPCHINESE
  LangString KrRunText ${LANG_SIMPCHINESE} "完成后打开 KurokawaReader"
!endif
