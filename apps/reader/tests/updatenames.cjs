// The Rust (Tauri) build's release files (stage R6b), named alike in the three places that pick them —
// desktop-tauri/src-tauri/src/updatelogic.rs (the Tauri app's updater), desktop/rustswitch.cjs (the Electron app's
// switch) and src/updateCore.ts (the page's update sheet) —; the Electron switch's choices (a release of this
// version or newer, the Tauri file for this system, beta only on the beta channel, the checksum it must have); the
// Electron build's own patterns — Windows, and the Mac's and Linux's «first .dmg / .AppImage» — never taking a Tauri
// file; the switch OFF by default, and its hand-over gate (desktop/handover.cjs prepare: the page's
// beforeInstall() must say true and a fresh hand-over be on the disk) there and packaged. Plain node: node tests/updatenames.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const RS = require(path.join(ROOT, 'desktop', 'rustswitch.cjs'));
const logic = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'src-tauri', 'src', 'updatelogic.rs'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'src', 'updateCore.ts'), 'utf8');

// The names: Rust's format strings, the page's tails, the switch's.
for (const lit of ['"windows-{}-setup.exe"', '"windows-{}-portable.zip"', '"macos-universal.DMG"', '"linux-{}.appimage"', '"linux-{}.deb"', '"{}-{}-SHA256SUMS.txt"']) assert.ok(logic.includes(lit), `updatelogic.rs: ${lit}`);
assert.match(logic, /pub const APP: &str = "KurokawaReader";/);
const tails = JSON.parse(/export const RUST_TAILS = (\[[^\]]*\]);/.exec(core)[1].replace(/'/g, '"'));
assert.deepEqual(tails, ['windows-x64-setup.exe', 'windows-x64-portable.zip', 'macos-universal.DMG', 'linux-x64.appimage', 'linux-x64.deb', 'SHA256SUMS.txt']);
const v = '0.71.0';
assert.equal(RS.rustAssetName(v, 'win32', 'x64'), `KurokawaReader-${v}-${tails[0]}`);
assert.equal(RS.rustAssetName(v, 'darwin', 'arm64'), `KurokawaReader-${v}-${tails[2]}`);
assert.equal(RS.rustAssetName(v, 'linux', 'x64'), `KurokawaReader-${v}-${tails[3]}`);
assert.equal(RS.sumsName(v), `KurokawaReader-${v}-${tails[5]}`);
// (The Electron build's patterns — src/updates.ts suitableAsset, frozen in every Electron copy out there: Windows
// /win-x64.*\.exe$/, a Mac the first /\.dmg$/, Linux the first /\.AppImage$/ — never take a Tauri file, in whatever
// order a release lists them; read from updates.ts itself, so a change there shows here.)
const pageSrc = fs.readFileSync(path.join(ROOT, 'src', 'updates.ts'), 'utf8');
for (const re of ['/\\.dmg$/', '/\\.AppImage$/', '/win-x64.*\\.exe$/']) assert.ok(pageSrc.includes(re), `updates.ts still picks by ${re}`);
const electronPick = (names, os) => { const a = names.map((name) => ({ name })); return os === 'darwin' ? a.find((x) => /\.dmg$/.test(x.name)) : os === 'linux' ? a.find((x) => /\.AppImage$/.test(x.name)) : a.find((x) => /win-x64.*\.exe$/.test(x.name) && /portable/.test(x.name) === false); };
for (const t of tails) for (const re of [/win-x64.*\.exe$/, /\.dmg$/, /\.AppImage$/]) assert.ok(!re.test(`KurokawaReader-${v}-${t}`), `${t} ~ ${re}`);
for (const a of ['arm64', 'x64']) assert.ok(!/\.dmg$/.test(`KurokawaReader-${v}-macos-${a}.DMG`));
// (The Rust build's files FIRST in the list: an Electron copy still takes its own.)
const mixed = [...tails.map((t) => `KurokawaReader-${v}-${t}`), `KurokawaReader-${v}-win-x64.exe`, `KurokawaReader-${v}-mac-universal.dmg`, `KurokawaReader-${v}-linux-x86_64.AppImage`];
assert.equal(electronPick(mixed, 'darwin').name, `KurokawaReader-${v}-mac-universal.dmg`);
assert.equal(electronPick(mixed, 'linux').name, `KurokawaReader-${v}-linux-x86_64.AppImage`);
assert.equal(electronPick(mixed, 'win32').name, `KurokawaReader-${v}-win-x64.exe`);
// (Stage R6c.) The designed setup program, published beside them as KurokawaReader-<v>-windows-x64.exe (the download
// people take; setup/INTEGRATION.md), is never chosen by any updater: not by an Electron copy's pattern, not by the
// tails of this build's (the updater keeps the plain NSIS «-setup.exe»), not by the switch — whatever the order.
{
  const setupProgram = `KurokawaReader-${v}-windows-x64.exe`;
  for (const re of [/win-x64.*\.exe$/, /\.dmg$/, /\.AppImage$/]) assert.ok(!re.test(setupProgram), `${setupProgram} ~ ${re}`);
  for (const t of tails) assert.ok(!setupProgram.endsWith(t), `${setupProgram} ends with ${t}`);
  assert.equal(electronPick([setupProgram, ...mixed], 'win32').name, `KurokawaReader-${v}-win-x64.exe`);
  const both = [{ tag_name: `v${v}`, html_url: '', draft: false, prerelease: false, assets: [setupProgram, `KurokawaReader-${v}-windows-x64-setup.exe`, `KurokawaReader-${v}-SHA256SUMS.txt`].map((name) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/v${v}/${name}`, size: 9 })) }];
  assert.equal(RS.pickRust(both, '0.70.0', 'win32', 'x64').asset.name, `KurokawaReader-${v}-windows-x64-setup.exe`, 'the switch takes the plain installer');
  const ci = fs.readFileSync(path.join(ROOT, '..', '..', '.github', 'workflows', 'tauri-check-reader.yml'), 'utf8');
  assert.ok(ci.includes('KurokawaReader-$v-windows-x64.exe'), 'the CI build names the setup program so');
}
// (The installer gate of the page — /\.(exe|dmg|AppImage|deb|zip)$/i — lets the Tauri build's own files through.)
for (const t of tails.slice(0, 5)) assert.ok(/\.(exe|dmg|AppImage|deb|zip)$/i.test(t), t);

// The switch's choice.
const asset = (tag, name, extra = {}) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`, size: 9, ...extra });
const rel = (tag, names, o = {}) => ({ tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, draft: false, prerelease: false, ...o, assets: names.map((n) => asset(tag, n)) });
const list = [
  rel('v0.70.0', ['KurokawaReader-0.70.0-win-x64.exe', 'latest.yml']),
  rel('v0.71.0', ['KurokawaReader-0.71.0-win-x64.exe', 'KurokawaReader-0.71.0-windows-x64-setup.exe', 'KurokawaReader-0.71.0-SHA256SUMS.txt', 'KurokawaReader-0.71.0-linux-x64.appimage', 'KurokawaReader-0.71.0-macos-universal.DMG']),
  rel('v0.72.0-beta.1', ['KurokawaReader-0.72.0-beta.1-windows-x64-setup.exe'], { prerelease: true }),
  rel('tools-v9.0.0', ['KurokawaTools-9.0.0-windows-x64-setup.exe'], { prerelease: true }),
  rel('v0.99.0', ['KurokawaReader-0.99.0-windows-x64-setup.exe'], { draft: true }),
];
const p = RS.pickRust(list, '0.71.0', 'win32', 'x64');
assert.equal(p.version, '0.71.0', 'the same version is offered (the bridge build of the release that carries the Tauri one)');
assert.equal(p.asset.name, 'KurokawaReader-0.71.0-windows-x64-setup.exe');
assert.equal(p.sums.name, 'KurokawaReader-0.71.0-SHA256SUMS.txt');
assert.equal(RS.pickRust(list, '0.70.0', 'win32', 'x64', { beta: true }).version, '0.72.0-beta.1');
assert.equal(RS.pickRust(list, '0.72.0', 'win32', 'x64'), null, 'nothing older');
assert.equal(RS.pickRust(list.slice(0, 1), '0.60.0', 'win32', 'x64'), null, 'an Electron-only release is no switch');
assert.equal(RS.pickRust(list, '0.70.0', 'linux', 'x64').asset.name, 'KurokawaReader-0.71.0-linux-x64.appimage');
assert.equal(RS.pickRust(list, '0.70.0', 'darwin', 'arm64').asset.name, 'KurokawaReader-0.71.0-macos-universal.DMG');
assert.equal(RS.pickRust([rel('v0.80.0-rc.1', ['KurokawaReader-0.80.0-rc.1-windows-x64-setup.exe'])], '0.70.0', 'win32', 'x64'), null, 'a «-» version only on the beta channel');
// The checksum.
const h = 'ab'.repeat(32), g = 'cd'.repeat(32);
const sums = RS.parseSums(`${h}  KurokawaReader-0.71.0-windows-x64-setup.exe\r\n${g} *dist/KurokawaReader-0.71.0-linux-x64.appimage\n# note\n`);
assert.equal(sums.get('KurokawaReader-0.71.0-windows-x64-setup.exe'), h); assert.equal(sums.get('KurokawaReader-0.71.0-linux-x64.appimage'), g);
assert.deepEqual(RS.expectedSha(`sha256:${h}`, null), { sha: h });
assert.deepEqual(RS.expectedSha(null, h.toUpperCase()), { sha: h });
assert.deepEqual(RS.expectedSha(`sha256:${h}`, g), { error: 'checksum' });
assert.deepEqual(RS.expectedSha(null, null), { error: 'nochecksum' });
assert.equal(RS.cmpVersion('1.0.0-beta.2', '1.0.0'), -1); assert.ok(RS.cmpVersion('0.10.0', '0.9.9') > 0);

// The switch: OFF by default; its hand-over gate there, by its name, and packaged with the app.
const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
assert.match(main, /^const RUST_SWITCH = false;$/m, 'RUST_SWITCH is off until the switch-over');
assert.match(main, /await handover\.prepare\(/); assert.match(main, /const handover = require\('\.\/handover\.cjs'\);/);
const ho = require(path.join(ROOT, 'desktop', 'handover.cjs'));
assert.equal(typeof ho.prepare, 'function');
const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build.files;
for (const f of ['rustswitch.cjs', 'handover.cjs']) assert.ok(files.includes(f), `${f} packaged`);
assert.match(main, /handover\.prepare\(\{ app, webContents: e\.sender \}\)/, 'the page that asked makes the hand-over');
assert.match(main, /if \(!h \|\| h\.ok !== true\) throw/, 'nothing installed unless it said ok');
assert.equal((main.match(/require\('\.\/handover\.cjs'\)/g) || []).length, 1, 'handover.cjs required once');
(async () => {
  // The gate (desktop/handover.cjs prepare), with a stand-in for the page: it runs beforeInstall() and is ok ONLY when
  // the page said true AND a hand-over marked since is on the disk.
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-gate-'));
  const app = { getPath: () => tmp };
  const page = (answer, make) => ({ isDestroyed: () => false, executeJavaScript: async (code) => {
    assert.match(code, /__KR_HANDOVER__\.beforeInstall\(\)/);
    if (make) { const w = new ho.Writer(tmp, { free: 1e12 }); await w.begin(1); await w.write('handover/local.json', '{}'); await w.verify([{ rel: 'handover/local.json', size: 2 }]); await w.finish({ counts: { books: 3 } }); }
    if (answer instanceof Error) throw answer;
    return answer;
  } });
  assert.equal((await ho.prepare({ app })).ok, false, 'no window: no switch');
  assert.equal((await ho.prepare({ app, webContents: { isDestroyed: () => true } })).ok, false, 'a window gone: no switch');
  assert.equal((await ho.prepare({ app, webContents: page('missing') })).ok, false, 'a page without the hand-over: no switch');
  assert.equal((await ho.prepare({ app, webContents: page(false) })).ok, false, 'the page said no (it told the reader why): no switch');
  assert.equal((await ho.prepare({ app, webContents: page(new Error('reloaded')) })).ok, false, 'the page went away: no switch');
  assert.equal((await ho.prepare({ app, webContents: page(true) })).ok, false, 'said yes but nothing on the disk: no switch');
  const ok = await ho.prepare({ app, webContents: page(true, true) });
  assert.equal(ok.ok, true, 'said yes with a fresh hand-over: the switch goes on'); assert.equal(ok.dir, path.join(tmp, 'handover')); assert.equal(ok.counts.books, 3);
  // (A hand-over made before this call does not count: the one the page just made must be there.)
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'handover', 'marker.json'), 'utf8')); st.createdAt -= 3_600_000; fs.writeFileSync(path.join(tmp, 'handover', 'marker.json'), JSON.stringify(st));
  assert.equal((await ho.prepare({ app, webContents: page(true) })).ok, false, 'an old hand-over only: no switch');
  fs.rmSync(tmp, { recursive: true, force: true });
  // (No placeholder left: the page's side is R6a's — makeHandover / restoreHandover, the first-run screen's offer.)
  const pageHo = fs.readFileSync(path.join(ROOT, 'src', 'handover.ts'), 'utf8');
  assert.ok(!/PLACEHOLDER|export async function restore\(/.test(pageHo) && /export async function makeHandover\(/.test(pageHo));
  assert.ok(!/PLACEHOLDER/.test(fs.readFileSync(path.join(ROOT, 'desktop', 'handover.cjs'), 'utf8')));
  console.log('updatenames: ok');
})().catch((e) => { console.error(e); process.exit(1); });
