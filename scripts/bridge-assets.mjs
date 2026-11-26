#!/usr/bin/env node
// The frozen Electron «bridge» builds' files, carried forward into every release (see scripts/bridge-assets.json).
// Old installed Electron copies look for their update by file name (Tools: /win-x64\.exe$/, /\.dmg$/, /\.AppImage$/;
// the Reader: the same, plus electron-updater's latest.yml / latest-linux.yml). The bridge build is the last Electron
// build: it makes the hand-over and installs the Rust build. So each new release carries those files again, byte for
// byte, checked against the SHA-256 listed in bridge-assets.json.
//
//   node scripts/bridge-assets.mjs <reader|tools>                       shape check; says whether the hashes are filled
//   node scripts/bridge-assets.mjs <app> --list                         tag, then the file names, one per line (--tag, --names)
//   node scripts/bridge-assets.mjs <app> --verify <dir>                 every listed file is in <dir> with its listed SHA-256;
//                                                                       REFUSES (exit 3) while any hash is «TODO»
//   node scripts/bridge-assets.mjs <app> --fill <dir>                   writes the hashes of a real download into the list
//   node scripts/bridge-assets.mjs reader --yml <dir> --version <v> [--date <iso>]
//                                                                       writes latest.yml and latest-linux.yml into <dir>: a «newer»
//                                                                       version (the release's) whose files are the bridge's own
//   --require-filled   with the shape check: exit 3 while any hash is «TODO»
//
// Exit codes: 0 fine, 1 a file missing / wrong, 2 usage or a malformed list, 3 hashes not filled yet.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BRIDGE_ASSETS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = path.join(ROOT, 'scripts', 'bridge-assets.json');
const argv = process.argv.slice(2);
const app = argv.find((a) => a === 'reader' || a === 'tools');
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const die = (code, m) => { console.error(m); process.exit(code); };
if (!app) die(2, 'usage: node scripts/bridge-assets.mjs <reader|tools> [--list | --verify <dir> | --fill <dir> | --yml <dir> --version <v>] [--require-filled]');

let all;
try { all = JSON.parse(fs.readFileSync(LIST, 'utf8')); } catch (e) { die(2, `bridge-assets: cannot read ${path.relative(ROOT, LIST)}: ${e.message}`); }
const entry = all[app];
const prefix = app === 'reader' ? 'KurokawaReader-' : 'KurokawaTools-';
const problems = [];
if (!entry || typeof entry !== 'object') die(2, `bridge-assets: no «${app}» entry`);
if (!/^(tools-)?v\d+\.\d+\.\d+$/.test(String(entry.tag))) problems.push(`tag «${entry.tag}» is not v<x.y.z>${app === 'tools' ? ' with the tools- prefix' : ''}`);
if (entry.tag && !String(entry.tag).endsWith('v' + entry.version)) problems.push(`tag «${entry.tag}» does not end in v${entry.version}`);
const assets = Array.isArray(entry.assets) ? entry.assets : [];
if (!assets.length) problems.push('no assets listed');
const seen = new Set();
for (const a of assets) {
  if (!a || typeof a.name !== 'string' || !a.name.startsWith(prefix + entry.version + '-') || /[\\/\s*?[\]]/.test(a.name)) problems.push(`bad name «${a && a.name}»`);
  else if (seen.has(a.name)) problems.push(`listed twice: ${a.name}`); else seen.add(a.name);
  if (!a || !(a.sha256 === 'TODO' || /^[0-9a-f]{64}$/.test(String(a.sha256)))) problems.push(`${a && a.name}: sha256 is neither «TODO» nor 64 lower-case hex digits`);
}
// The names an old copy looks for (what makes the carry-forward work at all): they must stay in the list.
const need = app === 'reader'
  ? [/-win-x64\.exe$/, /-win-x64-portable\.exe$/, /-mac-universal\.dmg$/, /-linux-x86_64\.AppImage$/]
  : [/-win-x64\.exe$/, /-mac-universal\.dmg$/, /-linux-x86_64\.AppImage$/];
for (const re of need) if (!assets.some((a) => a && re.test(String(a.name)))) problems.push(`no listed file matches ${re}`);
if (problems.length) { for (const p of problems) console.error('bridge-assets: ' + p); die(2, `bridge-assets ${app}: ${problems.length} problem(s)`); }
const unfilled = assets.filter((a) => a.sha256 === 'TODO');
const sha = (f, alg = 'sha256', enc = 'hex') => new Promise((ok, bad) => { const h = crypto.createHash(alg); fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => ok(h.digest(enc))).on('error', bad); });

async function main() {
  if (has('--list') || has('--tag') || has('--names')) {
    if (has('--tag')) console.log(entry.tag); else if (has('--names')) for (const a of assets) console.log(a.name); else { console.log(entry.tag); for (const a of assets) console.log(a.name); }
    return;
  }
  if (has('--verify')) {
    const dir = opt('--verify'); if (!dir || dir.startsWith('--')) die(2, 'bridge-assets: --verify needs the folder the files were downloaded to');
    if (unfilled.length) die(3, `bridge-assets ${app}: REFUSED — ${unfilled.length} of ${assets.length} SHA-256 values in scripts/bridge-assets.json are still «TODO» (${unfilled.map((a) => a.name).join(', ')}). Fill them from a real download (--fill) and commit before releasing.`);
    let bad = 0;
    for (const a of assets) {
      const f = path.join(dir, a.name);
      if (!fs.existsSync(f)) { console.error(`bridge-assets: MISSING ${a.name}`); bad++; continue; }
      const got = await sha(f);
      if (got !== a.sha256) { console.error(`bridge-assets: SHA-256 DIFFERS for ${a.name}: listed ${a.sha256}, got ${got}`); bad++; } else console.log(`verified ${a.name} ${got}`);
    }
    if (bad) die(1, `bridge-assets ${app}: ${bad} file(s) refused — nothing may be released`);
    console.log(`bridge-assets ${app}: ${assets.length} files verified against the list (${entry.tag})`);
    return;
  }
  if (has('--fill')) {
    const dir = opt('--fill'); if (!dir || dir.startsWith('--')) die(2, 'bridge-assets: --fill needs the folder the files were downloaded to');
    for (const a of assets) {
      const f = path.join(dir, a.name);
      if (!fs.existsSync(f)) die(1, `bridge-assets: ${a.name} is not in ${dir}; download it, or delete its line from the list if ${entry.tag} has no such file`);
      const got = await sha(f);
      if (a.sha256 !== 'TODO' && a.sha256 !== got) die(1, `bridge-assets: ${a.name} is already listed with a DIFFERENT hash (${a.sha256}); refusing to overwrite — check which one is the bridge build's`);
      a.sha256 = got; console.log(`${a.name}  ${got}  (${fs.statSync(f).size} bytes)`);
    }
    fs.writeFileSync(LIST, JSON.stringify(all, null, 2) + '\n');
    console.log(`bridge-assets ${app}: hashes written to ${path.relative(ROOT, LIST)}`);
    return;
  }
  if (has('--yml')) {
    if (app !== 'reader') die(2, 'bridge-assets: only the Reader has electron-updater files (Tools\' old copies read file names alone)');
    const dir = opt('--yml'); const v = opt('--version'); const date = opt('--date') || new Date().toISOString();
    if (!dir || dir.startsWith('--') || !/^\d+\.\d+\.\d+$/.test(String(v))) die(2, 'bridge-assets: --yml <dir> --version <x.y.z>');
    if (unfilled.length) die(3, 'bridge-assets reader: REFUSED — hashes not filled; run --verify first');
    // (electron-updater: «version» is what the old copy compares with its own; each file's sha512 is base64 and its size
    // the file's; the files are the bridge build's own — resolved beside the yml, in this release.)
    const one = async (role, name) => {
      const a = assets.find((x) => x.role === role); if (!a) die(1, `bridge-assets: no «${role}» file listed`);
      const f = path.join(dir, a.name); if (!fs.existsSync(f)) die(1, `bridge-assets: ${a.name} is not in ${dir}`);
      const sha512 = await sha(f, 'sha512', 'base64'); const size = fs.statSync(f).size;
      const yml = `version: ${v}\nfiles:\n  - url: ${a.name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${a.name}\nsha512: ${sha512}\nreleaseDate: '${date}'\n`;
      fs.writeFileSync(path.join(dir, name), yml); console.log(`wrote ${name}: version ${v}, file ${a.name} (${size} bytes)`);
    };
    await one('win-installer', 'latest.yml');
    await one('linux-appimage', 'latest-linux.yml');
    return;
  }
  console.log(`bridge-assets ${app}: list is well-formed — ${entry.tag}, ${assets.length} files, ${unfilled.length ? `${unfilled.length} hash(es) still «TODO» (the release workflow refuses until they are filled)` : 'all hashes filled'}`);
  if (has('--require-filled') && unfilled.length) process.exit(3);
}
main().catch((e) => die(1, 'bridge-assets: ' + (e && e.message || e)));
