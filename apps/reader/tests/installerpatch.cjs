// The Windows installer's one screen (stage R6b): desktop-tauri/src-tauri/installer/onepage.cjs changes a rendered
// Tauri installer script as it should — the screen before Tauri's first page (and outside a conditional block that page
// sits in), Tauri's clicked-through pages given a PRE that skips them (their own PRE called after), KrAfterInstall first
// in .onInstSuccess, the words after MUI_LANGUAGE — and refuses (changing nothing) a script that is not as expected.
// Also: the screen's NSIS files are UTF-8 with a BOM (NSIS reads them so), every word is there in the five languages,
// the file types it can take back are tauri.conf.json's, and tauri.conf.json asks for what the installer needs.
// Plain node: node tests/installerpatch.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const DIR = path.join(__dirname, '..', 'desktop-tauri', 'src-tauri', 'installer');
const { transform, pickSetups } = require(path.join(DIR, 'onepage.cjs'));

// A rendered script laid out as Tauri 2's template lays its own out (the parts the change touches).
const rendered = `\ufeffUnicode true
ManifestDPIAware true
SetCompressor /SOLID "lzma"
!include MUI2.nsh
!include FileFunc.nsh
!include "utils.nsh"
!include "C:\\\\a\\\\hooks.nsh"
!define PRODUCTNAME "KurokawaReader"
!define VERSION "0.71.0"
!define MAINBINARYNAME "KurokawaReader"
!define OUTFILE "nsis-output.exe"
!define INSTALLMODE "currentUser"
Var PassiveMode
Var UpdateMode
Name "\${PRODUCTNAME}"
OutFile "\${OUTFILE}"
!if "\${INSTALLMODE}" == "both"
  Page custom PageInstallMode PageLeaveInstallMode
!endif
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
Page custom PageReinstall PageLeaveReinstall
!ifdef LICENSE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "\${LICENSE}"
!endif
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Arabic"
Function .onInit
FunctionEnd
Section Install
SectionEnd
Function .onInstSuccess
  IfSilent check_r_flag 0
FunctionEnd
`;

const inc = { page: 'C:\\x\\onepage.nsh', lang: 'C:\\x\\onepage-lang.nsh' };
const r = transform(rendered, inc);
const out = r.text.slice(1).split('\n');
assert.equal(r.text.charCodeAt(0), 0xfeff, 'the BOM kept');
const at = (s) => out.findIndex((l) => l === s);
// 1. the screen before the conditional block of Tauri's first page, at the top level
assert.ok(at('Page custom KrOnePage KrOnePageLeave') > 0);
assert.ok(at('Page custom KrOnePage KrOnePageLeave') < at('!if "${INSTALLMODE}" == "both"'), 'the screen first, outside the !if');
assert.equal(at(`!include "${inc.page}"`) + 1, at('Page custom KrOnePage KrOnePageLeave'));
assert.ok(at('Var PassiveMode') < at('Page custom KrOnePage KrOnePageLeave'));
// 2. the clicked-through pages skipped; their own PRE kept, called by the wrapper
assert.deepEqual(r.notes.wrappers, ['WELCOME(SkipIfPassive)', 'LICENSE(SkipIfPassive)', 'DIRECTORY(SkipIfPassive)', 'STARTMENU', 'FINISH(SkipIfPassive)']);
assert.equal(out[at('!insertmacro MUI_PAGE_WELCOME') - 1], '!define MUI_PAGE_CUSTOMFUNCTION_PRE KrPre_1');
assert.equal(out[at('  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"') - 1], '  !define MUI_PAGE_CUSTOMFUNCTION_PRE KrPre_2', 'indented inside !ifdef, kept inside it');
assert.equal(out[at('!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder') - 1], '!define MUI_PAGE_CUSTOMFUNCTION_PRE KrPre_4');
assert.equal(out.filter((l) => /CUSTOMFUNCTION_PRE SkipIfPassive/.test(l)).length, 0, 'no page keeps a PRE of its own beside ours');
assert.ok(out.includes('!insertmacro MUI_PAGE_INSTFILES') && !out.some((l) => /KrPre_\d+$/.test(l) && /INSTFILES/.test(l)));
assert.equal(out.filter((l) => /MUI_UNPAGE_/.test(l)).length, 2, 'the uninstaller\'s pages untouched');
const fn = out.slice(out.indexOf('Function KrPre_1'), out.indexOf('Function KrPre_1') + 4);
assert.deepEqual(fn, ['Function KrPre_1', '  !insertmacro KR_SKIP_IF_ONE_PAGE', '  Call SkipIfPassive', 'FunctionEnd']);
assert.deepEqual(out.slice(out.indexOf('Function KrPre_4'), out.indexOf('Function KrPre_4') + 3), ['Function KrPre_4', '  !insertmacro KR_SKIP_IF_ONE_PAGE', 'FunctionEnd']);
// 3. the choices applied first after a successful install
assert.equal(out[at('Function .onInstSuccess') + 1], '  Call KrAfterInstall');
// 4. the words after the languages
assert.ok(at(`!include "${inc.lang}"`) > at('!insertmacro MUI_LANGUAGE "Arabic"'));
// Refused, nothing changed: already done, or a script unlike Tauri's.
assert.throws(() => transform(r.text, inc), /already/);
assert.throws(() => transform(rendered.replace('Var PassiveMode', 'Var Other'), inc), /PassiveMode/);
assert.throws(() => transform(rendered.replace('Function .onInstSuccess', 'Function .onOther'), inc), /onInstSuccess/);
assert.throws(() => transform(rendered.replace('!insertmacro MUI_PAGE_INSTFILES', ''), inc), /progress/);
assert.throws(() => transform(rendered.replace(/Var PassiveMode\n/, '') + 'Var PassiveMode\n', inc), /after the pages/);
// CRLF scripts stay CRLF.
assert.ok(/\r\n/.test(transform(rendered.replace(/\n/g, '\r\n'), inc).text));

// The NSIS files: UTF-8 with a BOM; every LangString in the five languages; the file types are tauri.conf.json's.
for (const f of ['onepage.nsh', 'onepage-lang.nsh']) assert.deepEqual([...fs.readFileSync(path.join(DIR, f)).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${f}: UTF-8 with a BOM`);
const page = fs.readFileSync(path.join(DIR, 'onepage.nsh'), 'utf8');
const lang = fs.readFileSync(path.join(DIR, 'onepage-lang.nsh'), 'utf8');
const used = [...new Set([...page.matchAll(/\$\((Kr\w+)\)/g)].map((m) => m[1]))].sort();
const defined = {};
for (const m of lang.matchAll(/LangString (Kr\w+) \$\{LANG_(\w+)\} "/g)) (defined[m[1]] ||= []).push(m[2]);
assert.deepEqual(Object.keys(defined).sort(), used, 'LangStrings ≠ the words the screen uses');
for (const [k, ls] of Object.entries(defined)) assert.deepEqual(ls.sort(), ['ARABIC', 'ENGLISH', 'JAPANESE', 'KOREAN', 'SIMPCHINESE'], k);
const conf = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'tauri.conf.json'), 'utf8'));
const unassoc = [...page.matchAll(/!insertmacro KR_UNASSOC "(\w+)" "([^"]+)"/g)].map((m) => [m[1], m[2]]);
assert.deepEqual(unassoc, conf.bundle.fileAssociations.map((a) => [a.ext[0], a.name]), 'the file types taken back ≠ tauri.conf.json\'s');
// tauri.conf.json: per user, the five languages, no language picker, the hooks, WebView2 fetched only when missing.
const n = conf.bundle.windows && conf.bundle.windows.nsis;
assert.ok(n, 'bundle.windows.nsis');
assert.equal(n.installMode, 'currentUser');
assert.deepEqual(n.languages, ['English', 'Arabic', 'Japanese', 'Korean', 'SimpChinese']);
assert.equal(n.displayLanguageSelector, false);
assert.equal(n.installerHooks, './installer/hooks.nsh');
assert.equal(n.compression, 'lzma');
assert.deepEqual(conf.bundle.windows.webviewInstallMode, { type: 'downloadBootstrapper', silent: true });
assert.ok(fs.existsSync(path.join(DIR, 'hooks.nsh')));
const hooks = fs.readFileSync(path.join(DIR, 'hooks.nsh'), 'utf8');
assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL/); assert.ok(!/\$\{PRODUCTNAME\}|\$\{MAINBINARYNAME\}/.test(hooks), 'hooks.nsh needs none of Tauri\'s defines');
assert.ok(!/RMDir[^\n]*APPDATA/i.test(hooks), 'hooks.nsh never removes a data folder');
// The trace (CI's KR_INSTALL_TRACE only): each install and uninstall step noted, nothing done without the variable.
for (const h of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_POSTINSTALL', 'NSIS_HOOK_PREUNINSTALL', 'NSIS_HOOK_POSTUNINSTALL']) assert.match(hooks, new RegExp(`!macro ${h}\\s*\\n\\s*!insertmacro KR_TRACE "`), `${h} traced`);
assert.match(hooks, /ReadEnvStr \$0 KR_INSTALL_TRACE\s*\n\s*\$\{IfNot\} \$\{Errors\}\s*\n\s*\$\{AndIf\} \$0 != ""/, 'the trace only with KR_INSTALL_TRACE');
// (0.62.0.) The Electron copy replaced ONLY when it is safe: its library handed over (the marker) or none at all; kept
// otherwise; /KROLD=keep|replace — the setup program's decision — wins; any other value keeps it.
{
  const dec = /!macro KR_OLD_DECISION([\s\S]*?)!macroend/.exec(hooks); assert.ok(dec, 'the decision macro');
  assert.match(dec[1], /\$\{GetOptions\} \$CMDLINE "\/KROLD=" \$0/); assert.match(dec[1], /\$0 == "replace"\s*\n\s*StrCpy \$KrOld "replace"\s*\n\s*\$\{Else\}\s*\n\s*StrCpy \$KrOld "keep"/);
  assert.match(dec[1], /FileExists\} "\$APPDATA\\KurokawaReader\\handover\\marker\.json"\s*\n\s*StrCpy \$KrOld "replace"/, 'a finished hand-over: replace');
  assert.match(dec[1], /ElseIfNot\} \$\{FileExists\} "\$APPDATA\\KurokawaReader\\IndexedDB\\\*\.\*"\s*\n\s*StrCpy \$KrOld "replace"\s*\n\s*\$\{Else\}\s*\n\s*StrCpy \$KrOld "keep"/, 'no library: replace; else keep');
  const rep = /!macro KR_REPLACE_ELECTRON([\s\S]*?)!macroend/.exec(hooks)[1];
  const at = (re) => rep.search(re);
  assert.ok(at(/!insertmacro KR_OLD_DECISION/) > at(/!insertmacro KR_FIND_ELECTRON/), 'decided after it is found');
  const gate = at(/\$\{AndIf\} \$KrOld == "replace"/);
  for (const step of [/KR_REPOINT_LNK "\$DESKTOP/, /RMDir \/r "\$KrOldDir"/, /DeleteRegKey HKCU "\$\{KR_UNINST\}\\\$KrOldKey"/]) assert.ok(gate > 0 && at(step) > gate, 'only under the replace gate: ' + step);
  assert.ok(/!include FileFunc\.nsh/.test(hooks), 'GetOptions available to the hooks');
}
assert.match(page, /Function KrAfterInstall\s*\n\s*!ifmacrodef KR_TRACE\s*\n\s*!insertmacro KR_TRACE "success"/);
// (Stage R6c.) The setup program's silent switches, /KRDESK=0|1 and /KRASSOC=0|1, read at the top of KrAfterInstall
// — before the one screen's choices are applied, only when the screen was not used, never opening the app — and the
// same names the setup program passes (setup/src-tauri/src/logic.rs, nsis_args).
{
  const fn = page.slice(page.indexOf('Function KrAfterInstall'), page.indexOf('FunctionEnd', page.indexOf('Function KrAfterInstall')));
  const sw = fn.indexOf('${If} $KrGui != 1');
  const apply = fn.indexOf('${If} $KrGui = 1');
  assert.ok(sw > 0 && apply > sw, 'the switches are read before the choices are applied');
  const block = fn.slice(sw, apply);
  for (const s of ['/KRDESK=', '/KRASSOC=']) assert.ok(block.includes('${GetOptions} $CMDLINE "' + s + '" $0'), `${s} read`);
  assert.match(block, /StrCpy \$KrGui 1/); assert.match(block, /StrCpy \$KrRun 0/); assert.ok(!/\bExec\b/.test(block), 'never opens the app');
  assert.match(block, /\$\{If\} \$1 == "0"\s*\n\s*StrCpy \$KrDesk 0/); assert.match(block, /\$\{If\} \$2 == "0"\s*\n\s*StrCpy \$KrAssoc 0/);
  const logic = fs.readFileSync(path.join(DIR, '..', '..', 'setup', 'src-tauri', 'src', 'logic.rs'), 'utf8');
  assert.ok(logic.includes('"/KRDESK={}"') && logic.includes('"/KRASSOC={}"'), 'logic.rs passes the same switches');
}
// The compiled installer copied only over this version's bundle file (installtest.ps1 builds a second version beside
// the first): the one named with the script's version, else the newest alone.
{
  const os = require('node:os');
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-setups-'));
  const a = path.join(t, 'KurokawaReader_0.61.0_x64-setup.exe'); const b = path.join(t, 'KurokawaReader_0.61.1_x64-setup.exe');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b'); fs.utimesSync(a, new Date(2000, 1, 1), new Date(2000, 1, 1));
  assert.deepEqual(pickSetups([a, b], '0.61.1'), [b]);
  assert.deepEqual(pickSetups([a, b], '0.61.0'), [a]);
  assert.deepEqual(pickSetups([a, b], '0.70.0'), [b], 'no name with the version: the newest alone');
  assert.deepEqual(pickSetups([a, b], undefined), [b]);
  fs.rmSync(t, { recursive: true, force: true });
}
console.log('installerpatch: ok');
