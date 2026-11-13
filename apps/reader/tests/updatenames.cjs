// The Rust (Tauri) build's release files (stage R6b), named alike in the three places that pick them —
// desktop-tauri/src-tauri/src/updatelogic.rs (the Tauri app's updater), desktop/rustswitch.cjs (the Electron app's
// switch) and src/updateCore.ts (the page's update sheet) —; the Electron switch's choices (a release of this
// version or newer, the Tauri file for this system, beta only on the beta channel, the checksum it must have); the
// Electron build's own Windows pattern never taking a Tauri file; the switch OFF by default, its hand-over placeholder
// there and packaged. Plain node: node tests/updatenames.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const RS = require(path.join(ROOT, 'desktop', 'rustswitch.cjs'));
const logic = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'src-tauri', 'src', 'updatelogic.rs'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'src', 'updateCore.ts'), 'utf8');

// The names: Rust's format strings, the page's tails, the switch's.
for (const lit of ['"windows-{}-setup.exe"', '"windows-{}-portable.zip"', '"macos-universal.dmg"', '"linux-{}.AppImage"', '"linux-{}.deb"', '"{}-{}-SHA256SUMS.txt"']) assert.ok(logic.includes(lit), `updatelogic.rs: ${lit}`);
assert.match(logic, /pub const APP: &str = "KurokawaReader";/);
const tails = JSON.parse(/export const RUST_TAILS = (\[[^\]]*\]);/.exec(core)[1].replace(/'/g, '"'));
assert.deepEqual(tails, ['windows-x64-setup.exe', 'windows-x64-portable.zip', 'macos-universal.dmg', 'linux-x64.AppImage', 'linux-x64.deb', 'SHA256SUMS.txt']);
const v = '0.71.0';
assert.equal(RS.rustAssetName(v, 'win32', 'x64'), `KurokawaReader-${v}-${tails[0]}`);
assert.equal(RS.rustAssetName(v, 'darwin', 'arm64'), `KurokawaReader-${v}-${tails[2]}`);
assert.equal(RS.rustAssetName(v, 'linux', 'x64'), `KurokawaReader-${v}-${tails[3]}`);
assert.equal(RS.sumsName(v), `KurokawaReader-${v}-${tails[5]}`);
// (The Electron build's Windows pattern — src/updates.ts suitableAsset, in every Electron copy out there — never
// takes the Tauri installer or its portable zip.)
for (const t of tails) assert.ok(!(/win-x64.*\.exe$/.test(`KurokawaReader-${v}-${t}`)), t);

// The switch's choice.
const asset = (tag, name, extra = {}) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`, size: 9, ...extra });
const rel = (tag, names, o = {}) => ({ tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, draft: false, prerelease: false, ...o, assets: names.map((n) => asset(tag, n)) });
const list = [
  rel('v0.70.0', ['KurokawaReader-0.70.0-win-x64.exe', 'latest.yml']),
  rel('v0.71.0', ['KurokawaReader-0.71.0-win-x64.exe', 'KurokawaReader-0.71.0-windows-x64-setup.exe', 'KurokawaReader-0.71.0-SHA256SUMS.txt', 'KurokawaReader-0.71.0-linux-x64.AppImage', 'KurokawaReader-0.71.0-macos-universal.dmg']),
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
assert.equal(RS.pickRust(list, '0.70.0', 'linux', 'x64').asset.name, 'KurokawaReader-0.71.0-linux-x64.AppImage');
assert.equal(RS.pickRust(list, '0.70.0', 'darwin', 'arm64').asset.name, 'KurokawaReader-0.71.0-macos-universal.dmg');
assert.equal(RS.pickRust([rel('v0.80.0-rc.1', ['KurokawaReader-0.80.0-rc.1-windows-x64-setup.exe'])], '0.70.0', 'win32', 'x64'), null, 'a «-» version only on the beta channel');
// The checksum.
const h = 'ab'.repeat(32), g = 'cd'.repeat(32);
const sums = RS.parseSums(`${h}  KurokawaReader-0.71.0-windows-x64-setup.exe\r\n${g} *dist/KurokawaReader-0.71.0-linux-x64.AppImage\n# note\n`);
assert.equal(sums.get('KurokawaReader-0.71.0-windows-x64-setup.exe'), h); assert.equal(sums.get('KurokawaReader-0.71.0-linux-x64.AppImage'), g);
assert.deepEqual(RS.expectedSha(`sha256:${h}`, null), { sha: h });
assert.deepEqual(RS.expectedSha(null, h.toUpperCase()), { sha: h });
assert.deepEqual(RS.expectedSha(`sha256:${h}`, g), { error: 'checksum' });
assert.deepEqual(RS.expectedSha(null, null), { error: 'nochecksum' });
assert.equal(RS.cmpVersion('1.0.0-beta.2', '1.0.0'), -1); assert.ok(RS.cmpVersion('0.10.0', '0.9.9') > 0);

// The switch: OFF by default; its hand-over hook there, by its name, and packaged with the app.
const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
assert.match(main, /^const RUST_SWITCH = false;$/m, 'RUST_SWITCH is off until the switch-over');
assert.match(main, /await handover\.prepare\(/); assert.match(main, /const handover = require\('\.\/handover\.cjs'\);/);
const ho = require(path.join(ROOT, 'desktop', 'handover.cjs'));
assert.equal(typeof ho.prepare, 'function');
const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build.files;
for (const f of ['rustswitch.cjs', 'handover.cjs']) assert.ok(files.includes(f), `${f} packaged`);
(async () => {
  assert.equal((await ho.prepare({})).ok, true, 'the placeholder lets the switch go on');
  const { restore } = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(ROOT, 'src', 'handover.ts'), 'utf8').replace(/export interface[^\n]*\n/, '').replace(/: Promise<HandoverResult>/, '')));
  assert.deepEqual(await restore(), { ok: false, none: true }, 'the page\'s placeholder finds nothing');
  console.log('updatenames: ok');
})().catch((e) => { console.error(e); process.exit(1); });
