#!/usr/bin/env node
// node scripts/bridge-assets.test.mjs — scripts/bridge-assets.mjs on a made-up list and made-up files in a temp folder
// (BRIDGE_ASSETS_ROOT): the list's own shape; --verify refusing while a hash is «TODO», a missing file and a changed
// file; --fill then --verify passing; --yml writing the two electron-updater files (a NEWER version over the bridge's own
// files, sha512 in base64, the file's size). No network, no repository files touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra ?? ''))); if (!cond) fails++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-bridge-'));
const dl = path.join(root, 'dl'); fs.mkdirSync(dl); fs.mkdirSync(path.join(root, 'scripts'));
const run = (...args) => { const x = spawnSync(process.execPath, [path.join(HERE, 'bridge-assets.mjs'), ...args], { env: { ...process.env, BRIDGE_ASSETS_ROOT: root }, encoding: 'utf8' }); return { code: x.status, out: (x.stdout || '') + (x.stderr || '') }; };
const A = (n, role) => ({ name: n, role, sha256: 'TODO' });
const list = { reader: { tag: 'v0.5.0', version: '0.5.0', assets: [A('KurokawaReader-0.5.0-win-x64.exe', 'win-installer'), A('KurokawaReader-0.5.0-win-x64-portable.exe', 'win-portable'), A('KurokawaReader-0.5.0-mac-universal.dmg', 'mac-dmg'), A('KurokawaReader-0.5.0-linux-x86_64.AppImage', 'linux-appimage')] },
  tools: { tag: 'tools-v0.3.0', version: '0.3.0', assets: [A('KurokawaTools-0.3.0-win-x64.exe', 'win-installer'), A('KurokawaTools-0.3.0-mac-universal.dmg', 'mac-dmg'), A('KurokawaTools-0.3.0-linux-x86_64.AppImage', 'linux-appimage')] } };
const LIST = path.join(root, 'scripts', 'bridge-assets.json');
const save = () => fs.writeFileSync(LIST, JSON.stringify(list, null, 2));
save();
for (const a of list.reader.assets) fs.writeFileSync(path.join(dl, a.name), 'bridge ' + a.name);

let x = run('reader');
ok('shape check passes and says the hashes are TODO', x.code === 0 && /still «TODO»/.test(x.out), x);
x = run('reader', '--require-filled'); ok('--require-filled refuses while TODO (exit 3)', x.code === 3, x);
x = run('reader', '--tag'); ok('--tag prints the tag', x.out.trim() === 'v0.5.0', x);
x = run('reader', '--names'); ok('--names prints every name', x.out.trim().split('\n').length === 4, x);
x = run('reader', '--verify', dl); ok('--verify REFUSES while a hash is TODO (exit 3), whatever is in the folder', x.code === 3 && /REFUSED/.test(x.out), x);
x = run('reader', '--yml', dl, '--version', '0.6.0'); ok('--yml refuses while TODO', x.code === 3, x);
x = run('reader', '--fill', dl); ok('--fill writes the hashes', x.code === 0 && JSON.parse(fs.readFileSync(LIST, 'utf8')).reader.assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)), x);
Object.assign(list, JSON.parse(fs.readFileSync(LIST, 'utf8')));
x = run('reader', '--verify', dl); ok('--verify passes on the same files', x.code === 0 && /4 files verified/.test(x.out), x);
fs.writeFileSync(path.join(dl, 'KurokawaReader-0.5.0-mac-universal.dmg'), 'changed');
x = run('reader', '--verify', dl); ok('--verify refuses a changed file (exit 1)', x.code === 1 && /DIFFERS/.test(x.out), x);
fs.writeFileSync(path.join(dl, 'KurokawaReader-0.5.0-mac-universal.dmg'), 'bridge KurokawaReader-0.5.0-mac-universal.dmg');
fs.rmSync(path.join(dl, 'KurokawaReader-0.5.0-linux-x86_64.AppImage'));
x = run('reader', '--verify', dl); ok('--verify refuses a missing file (exit 1)', x.code === 1 && /MISSING/.test(x.out), x);
fs.writeFileSync(path.join(dl, 'KurokawaReader-0.5.0-linux-x86_64.AppImage'), 'bridge KurokawaReader-0.5.0-linux-x86_64.AppImage');
x = run('reader', '--fill', dl); ok('--fill does not overwrite a different hash silently', x.code === 0, x);
fs.writeFileSync(path.join(dl, 'KurokawaReader-0.5.0-win-x64.exe'), 'another build');
x = run('reader', '--fill', dl); ok('--fill refuses to replace a listed hash with another', x.code === 1 && /DIFFERENT/.test(x.out), x);
fs.writeFileSync(path.join(dl, 'KurokawaReader-0.5.0-win-x64.exe'), 'bridge KurokawaReader-0.5.0-win-x64.exe');
x = run('reader', '--yml', dl, '--version', '0.6.0', '--date', '2026-01-02T03:04:05.000Z');
const yml = fs.existsSync(path.join(dl, 'latest.yml')) ? fs.readFileSync(path.join(dl, 'latest.yml'), 'utf8') : '';
const body = 'bridge KurokawaReader-0.5.0-win-x64.exe';
const want = `version: 0.6.0\nfiles:\n  - url: KurokawaReader-0.5.0-win-x64.exe\n    sha512: ${crypto.createHash('sha512').update(body).digest('base64')}\n    size: ${body.length}\npath: KurokawaReader-0.5.0-win-x64.exe\nsha512: ${crypto.createHash('sha512').update(body).digest('base64')}\nreleaseDate: '2026-01-02T03:04:05.000Z'\n`;
ok('latest.yml: the new version over the bridge installer, its sha512 (base64) and size', x.code === 0 && yml === want, { x, yml });
const yl = fs.existsSync(path.join(dl, 'latest-linux.yml')) ? fs.readFileSync(path.join(dl, 'latest-linux.yml'), 'utf8') : '';
ok('latest-linux.yml: the AppImage', /^version: 0\.6\.0\n/.test(yl) && /path: KurokawaReader-0\.5\.0-linux-x86_64\.AppImage\n/.test(yl), yl);
x = run('tools', '--yml', dl, '--version', '0.6.0'); ok('Tools has no yml (its old copies read names only)', x.code === 2, x);
// a malformed list
list.reader.assets[0].name = 'Other-0.5.0-win-x64.exe'; save();
x = run('reader'); ok('a wrongly named file is a malformed list (exit 2)', x.code === 2, x);
list.reader.assets[0].name = 'KurokawaReader-0.5.0-win-x64.exe'; list.reader.assets.pop(); save();
x = run('reader'); ok('a list without the AppImage is malformed (the name old copies look for)', x.code === 2 && /AppImage/.test(x.out), x);
fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'bridge-assets: all ok');
process.exit(fails ? 1 : 0);
