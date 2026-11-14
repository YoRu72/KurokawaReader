// The Rust (Tauri) build's release files (stage P8), as kt-core's updatelogic.rs names them, against the Electron Tools
// build's own picking — src/installer.ts suitableAsset and desktop/main.cjs kt:checkUpdate, frozen in every Electron
// copy out there: Windows /win-x64\.exe$/ (not «portable»), a Mac the first /\.dmg$/, Linux the first /\.AppImage$/
// (case-sensitive) —: no Electron copy can ever take a Tauri file, in whatever order a release lists its files, and
// the Tauri build's names are the ones written down in desktop-tauri/PORTING.md. The patterns are read from the two
// files themselves, so a change there shows here. Plain node: node tests/updatenames.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const logic = fs.readFileSync(path.join(ROOT, 'core', 'kt-core', 'src', 'updatelogic.rs'), 'utf8');
const installer = fs.readFileSync(path.join(ROOT, 'src', 'installer.ts'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
const porting = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'PORTING.md'), 'utf8');

// The names: Rust's format strings and product name.
for (const lit of ['"windows-{}-setup.exe"', '"windows-{}-portable.zip"', '"macos-universal.DMG"', '"linux-{}.appimage"', '"linux-{}.deb"', '"{}-{}-SHA256SUMS.txt"']) assert.ok(logic.includes(lit), `updatelogic.rs: ${lit}`);
assert.match(logic, /pub const APP: &str = "KurokawaTools";/);
assert.match(logic, /strip_prefix\("tools-v"\)/, 'Tools\' tags');
const v = '0.17.0';
const tails = ['windows-x64-setup.exe', 'windows-x64-portable.zip', 'windows-arm64-setup.exe', 'macos-universal.DMG', 'macos-arm64.DMG', 'macos-x64.DMG', 'linux-x64.appimage', 'linux-arm64.appimage', 'linux-x64.deb', 'SHA256SUMS.txt'];
const rust = tails.map((t) => `KurokawaTools-${v}-${t}`);
// (Written down for P9's release job.)
for (const t of ['windows-x64-setup.exe', 'windows-x64-portable.zip', 'macos-universal.DMG', 'linux-x64.appimage', 'linux-x64.deb', 'SHA256SUMS.txt']) assert.ok(porting.includes(`KurokawaTools-<v>-${t}`), `PORTING.md names KurokawaTools-<v>-${t}`);

// The Electron build's patterns, read from its files.
for (const re of ['/\\.dmg$/', '/\\.AppImage$/', '/win-x64\\.exe$/']) assert.ok(installer.includes(re), `installer.ts still picks by ${re}`);
assert.ok(main.includes("/win-x64\\.exe$/ : process.platform === 'darwin' ? /\\.dmg$/ : /\\.AppImage$/"), 'main.cjs kt:checkUpdate still picks so');
assert.ok(main.includes("!/portable/.test(a.name)"), 'main.cjs leaves the portable out');
const page = (names, os) => { const a = names.map((name) => ({ name })); return os === 'darwin' ? a.find((x) => /\.dmg$/.test(x.name)) : os === 'linux' ? a.find((x) => /\.AppImage$/.test(x.name)) : a.find((x) => /win-x64\.exe$/.test(x.name)); };
const shell = (names, os) => { const want = os === 'win32' ? /win-x64\.exe$/ : os === 'darwin' ? /\.dmg$/ : /\.AppImage$/; return names.map((name) => ({ name })).find((a) => want.test(a.name) && !/portable/.test(a.name)); };
for (const n of rust) for (const re of [/win-x64\.exe$/, /\.dmg$/, /\.AppImage$/]) assert.ok(!re.test(n), `${n} ~ ${re}`);
// (The Rust build's files FIRST in the list: an Electron copy still takes its own; and none when only Rust's are there.)
const electron = [`KurokawaTools-${v}-win-x64.exe`, `KurokawaTools-${v}-win-x64-portable.exe`, `KurokawaTools-${v}-mac-universal.dmg`, `KurokawaTools-${v}-linux-x86_64.AppImage`];
for (const pick of [page, shell]) {
  assert.equal(pick([...rust, ...electron], 'win32').name, `KurokawaTools-${v}-win-x64.exe`);
  assert.equal(pick([...rust, ...electron], 'darwin').name, `KurokawaTools-${v}-mac-universal.dmg`);
  assert.equal(pick([...rust, ...electron], 'linux').name, `KurokawaTools-${v}-linux-x86_64.AppImage`);
  for (const os of ['win32', 'darwin', 'linux']) assert.equal(pick(rust, os), undefined, `${os}: nothing of the Rust build's taken`);
}
// (The Rust build's own name pattern for each system — what its updater looks for — never matches an Electron file.)
for (const e of electron) assert.ok(!tails.some((t) => e.endsWith(t)), e);
// (Stage P9: the Electron bridge build's switch picks the same names — desktop/rustswitch.cjs —, from Tools' own tags
// only, GitHub's pre-release mark (on every Tools release) not read; never a Reader release, never an Electron file.)
const RS = require(path.join(ROOT, 'desktop', 'rustswitch.cjs'));
assert.equal(RS.rustAssetName(v, 'win32', 'x64'), `KurokawaTools-${v}-windows-x64-setup.exe`);
assert.equal(RS.rustAssetName(v, 'darwin', 'arm64'), `KurokawaTools-${v}-macos-universal.DMG`);
assert.equal(RS.rustAssetName(v, 'linux', 'x64'), `KurokawaTools-${v}-linux-x64.appimage`);
assert.equal(RS.sumsName(v), `KurokawaTools-${v}-SHA256SUMS.txt`);
for (const os of ['win32', 'darwin', 'linux']) assert.ok(rust.includes(RS.rustAssetName(v, os, 'x64')), `${os}: the switch's file is one of the release's`);
const relOf = (tag, names, pre = true) => ({ tag_name: tag, prerelease: pre, draft: false, html_url: 'page', assets: names.map((name) => ({ name, browser_download_url: 'u/' + name, size: 9, digest: 'sha256:' + 'b'.repeat(64) })) });
const rels = [relOf('v0.99.0', [`KurokawaReader-0.99.0-windows-x64-setup.exe`]), relOf(`tools-v${v}`, [...electron, ...rust]), relOf('tools-v0.18.0-beta.1', [...rust.map((n) => n.replace(v, '0.18.0-beta.1'))])];
assert.equal(RS.pickRust(rels, '0.16.32', 'win32', 'x64').asset.name, `KurokawaTools-${v}-windows-x64-setup.exe`, 'a pre-release-marked Tools release is taken');
assert.equal(RS.pickRust(rels, '0.16.32', 'win32', 'x64').sums.name, `KurokawaTools-${v}-SHA256SUMS.txt`);
assert.equal(RS.pickRust(rels, '0.16.32', 'win32', 'x64', { beta: true }).version, '0.18.0-beta.1', 'beta: a version with «-»');
assert.equal(RS.pickRust(rels, '0.17.1', 'linux', 'x64'), null, 'nothing older than the copy');
assert.equal(RS.pickRust([relOf(`tools-v${v}`, electron)], '0.16.32', 'win32', 'x64'), null, 'a release without the Tauri build: no switch');
console.log(`updatenames: ok (${rust.length} Tauri names, none taken by the Electron build's ${2} pickers)`);
