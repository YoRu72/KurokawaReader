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
// (Stage P9: the hand-over's adapted copies — the Reader's, Tools' names. kt-core's handoverlogic.rs: every function
// both have the same once the names are set aside; desktop/handover.cjs: the Writer's methods (all but shellFiles,
// Tools' own) and its helpers; desktop/rustswitch.cjs: every function but pickRust, which reads Tools' tags.)
const normH = (x) => x.replace(/KurokawaReader|KurokawaTools|Kurokawa Tools/g, 'APP').replace(/app\.kurokawa\.(reader|tools)/g, 'ID').replace(/kurokawa-(reader|tools)-desktop/g, 'APPDIR').replace(/K[RT]_HANDOVER_FROM/g, 'X_HANDOVER_FROM').replace(/\bthe reader\b|\bthe person\b/g, 'WHO').replace(/marker = \{ app: (APP|'APP'),/g, 'marker = { app: A,').replace(/JSON\.stringify\(\{ app: (APP|'APP'),/g, 'JSON.stringify({ app: A,');
const th = fnBodies(fs.readFileSync(path.join(A, 'tools/core/kt-core/src/handoverlogic.rs'), 'utf8')); const rh = fnBodies(fs.readFileSync(path.join(A, 'reader/desktop-tauri/src-tauri/src/handoverlogic.rs'), 'utf8'));
const hcommon = Object.keys(rh).filter((k) => k !== 'tmp' && !['rel_paths', 'where_to_look', 'picked_and_deleted', 'electron_folders'].includes(k));
const hdrift = hcommon.filter((k) => !th[k] || normH(th[k]) !== normH(rh[k]));
if (hdrift.length || hcommon.length < 7) { console.error('handoverlogic.rs: Tools\' copy drifted from the Reader\'s in', hdrift.join(', ') || `(only ${hcommon.length} functions found)`); process.exit(1); }
// (A JS file's top-level functions and a class's methods: from their first line to the line that closes them.)
const jsBodies = (src) => { const out = {}; const lines = src.split('\n'); for (let i = 0; i < lines.length; i++) { const m = /^(?:async )?function (\w+)|^ {2}(?:async )?(\w+)\([^)]*\) \{$/.exec(lines[i]); if (!m) continue; const ind = m[1] ? '' : '  '; let j = i; while (j < lines.length && lines[j] !== `${ind}}`) j++; out[m[1] || `#${m[2]}`] = lines.slice(i, j + 1).join('\n'); } return out; };
const tw = jsBodies(fs.readFileSync(path.join(A, 'tools/desktop/handover.cjs'), 'utf8')); const rw = jsBodies(fs.readFileSync(path.join(A, 'reader/desktop/handover.cjs'), 'utf8'));
const wcommon = ['safeRel', 'tauriDataDir', 'freeBytes', 'dirSize', 'flush', 'flushDir', 'writeAtomic', 'sha256File', 'status', '#begin', '#write', '#read', '#verify', '#finish'];
const wdrift = wcommon.filter((k) => !tw[k] || !rw[k] || normH(tw[k]) !== normH(rw[k]));
if (wdrift.length) { console.error('desktop/handover.cjs: Tools\' Writer drifted from the Reader\'s in', wdrift.join(', ')); process.exit(1); }
const ts2 = jsBodies(fs.readFileSync(path.join(A, 'tools/desktop/rustswitch.cjs'), 'utf8')); const rs2 = jsBodies(fs.readFileSync(path.join(A, 'reader/desktop/rustswitch.cjs'), 'utf8'));
const scommon = Object.keys(rs2).filter((k) => k !== 'pickRust');
const sdrift = scommon.filter((k) => !ts2[k] || normH(ts2[k]) !== normH(rs2[k]));
if (sdrift.length || scommon.length < 4) { console.error('desktop/rustswitch.cjs: Tools\' copy drifted from the Reader\'s in', sdrift.join(', ') || `(only ${scommon.length} functions found)`); process.exit(1); }
console.log(`hand-over copies the same as the Reader's apart from the names: handoverlogic.rs ${hcommon.length}, handover.cjs ${wcommon.length}, rustswitch.cjs ${scommon.length} functions`);
// (Stage P9: the designed setup program — Tools' desktop-tauri/setup is the Reader's with Tools' names, words and
// data rule: its page's script, styles and frame the same once the names are set aside, its words the same keys in the
// same five languages, every Rust function the same but main.rs's electron_data (Tools' data rule).)
{
  const normS = (x) => normH(x).replace(/APPSetup|APP Setup/g, 'APP_SETUP').replace(/kurokawa(reader|tools)-setup/g, 'APP_SETUP').replace(/K[RT]_SETUP_APP_EXE/g, 'X').replace(/k[rt]-inner-setup\.exe/g, 'INNER').replace(/APP-setup-|APP-\{\}-installer/g, (m) => m.replace('APP', 'A')).replace(/"تثبيت (KurokawaReader|أدوات كروكاوا|APP)"/g, 'T').replace(/apps\/(reader|tools)\/package\.json/g, 'PKG').replace(/^\/\/.*$|^\/\*[\s\S]*?\*\/|^ *#.*$/gm, '');
  const S = (app, f) => fs.readFileSync(path.join(A, app, 'desktop-tauri', 'setup', f), 'utf8');
  const bad = [];
  for (const f of ['ui/setup.js', 'ui/setup.css', 'ui/index.html', 'src-tauri/tauri.conf.json']) if (normS(S('tools', f)) !== normS(S('reader', f))) bad.push(f);
  global.window = {}; eval(S('reader', 'ui/words.js')); const rw = window.SETUP_WORDS; global.window = {}; eval(S('tools', 'ui/words.js')); const tw = window.SETUP_WORDS;
  for (const l of Object.keys(rw)) if (!tw[l] || Object.keys(tw[l]).sort().join() !== Object.keys(rw[l]).sort().join()) bad.push(`ui/words.js (${l})`);
  if (JSON.stringify(Object.keys(tw)) !== JSON.stringify(Object.keys(rw))) bad.push('ui/words.js (languages)');
  for (const [f, own] of [['src-tauri/src/logic.rs', []], ['src-tauri/src/main.rs', ['electron_data']]]) {
    const tb = fnBodies(S('tools', f)); const rb = fnBodies(S('reader', f));
    for (const k of Object.keys(rb)) if (!own.includes(k) && (!tb[k] || normS(tb[k]) !== normS(rb[k]))) bad.push(`${f} ${k}`);
  }
  if (bad.length) { console.error('desktop-tauri/setup: Tools\' copy drifted from the Reader\'s in', bad.join(', ')); process.exit(1); }
  console.log('the setup program: Tools\' copy the same as the Reader\'s apart from the names, words and data rule');
}
console.log(`shared files the same in both apps (${pairs.length}); updatelogic.rs's ${common.length} shared functions the same apart from the names`);
