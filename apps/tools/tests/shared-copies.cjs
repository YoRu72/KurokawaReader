// The files kept the same in both apps (each app builds on its own): a change to one has to go to the other.
const fs = require('node:fs'); const path = require('node:path');
const A = path.join(__dirname, '..', '..'); const pairs = [['tools/desktop/appicon.cjs', 'reader/desktop/appicon.cjs'], ['tools/src/ui/iconCrop.ts', 'reader/src/ui/iconCrop.ts'], ['tools/src/ui/brandIcon.ts', 'reader/src/ui/brandIcon.ts'], ['tools/src/ui/titlebar.ts', 'reader/src/ui/titlebar.ts'], ['tools/desktop/titlebar.cjs', 'reader/desktop/titlebar.cjs'], ['tools/src/ui/winbar.ts', 'reader/src/ui/winbar.ts'], ['tools/tests/titlebar.cjs', 'reader/tests/titlebar.cjs']];
const bad = pairs.filter(([a, b]) => !fs.existsSync(path.join(A, b)) || fs.readFileSync(path.join(A, a), 'utf8') !== fs.readFileSync(path.join(A, b), 'utf8'));
if (bad.length) { console.error('not the same in both apps:', bad.map((x) => x.join(' / ')).join(', ')); process.exit(1); }
// Adapted copies (Tools' stage P8): the PC updater's decisions — kt-core's updatelogic.rs is the Reader's with Tools'
// names (product, tags, error codes); every function both have, apart from the two that read the tags, must stay the
// same once the names are set aside.
const fnBodies = (src) => { const out = {}; const lines = src.split('\n'); for (let i = 0; i < lines.length; i++) { const m = /^(?:pub )?fn (\w+)/.exec(lines[i]); if (!m) continue; let j = i; while (j < lines.length && lines[j] !== '}') j++; out[m[1]] = lines.slice(i, j + 1).join('\n'); } return out; };
const norm = (x) => x.replace(/KurokawaReader|KurokawaTools/g, 'APP').replace(/k[rt]-update:/g, 'X-update:').replace(/K[RT]_UPDATE_FEED/g, 'X_UPDATE_FEED');
const tl = fnBodies(fs.readFileSync(path.join(A, 'tools/core/kt-core/src/updatelogic.rs'), 'utf8')); const rl = fnBodies(fs.readFileSync(path.join(A, 'reader/desktop-tauri/src-tauri/src/updatelogic.rs'), 'utf8'));
const own = ['version_of_tag', 'pick_update']; const common = Object.keys(rl).filter((k) => !own.includes(k));
const drift = common.filter((k) => !tl[k] || norm(tl[k]) !== norm(rl[k]));
if (drift.length || common.length < 20) { console.error('updatelogic.rs: Tools\' copy drifted from the Reader\'s in', drift.join(', ') || `(only ${common.length} functions found)`); process.exit(1); }
console.log(`shared files the same in both apps (${pairs.length}); updatelogic.rs's ${common.length} shared functions the same apart from the names`);
