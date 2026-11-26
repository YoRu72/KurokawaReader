// node tests/handover-fixture.cjs — the Rust build reads a made-up hand-over folder as the last Electron («bridge») build left
// it (no network, no browser, no Electron). The folder is COMMITTED: tests/data/handover-bridge/, made once by that build's own
// frozen Writer (tests/support/make-handover-fixture.cjs), so what is read here is what a bridge build wrote, not what today's
// code would write. Checked here, in Node: the marker (app, kind, format the Rust build reads, every listed file there with its
// size and SHA-256, nothing unlisted), every path safe (the Rust build's rule), the page's stores and the files they point at;
// the download engine's files and the ids that were moving and, with rustc on the PATH, the Rust build's OWN code (core/kt-core/src/handoverlogic.rs, std only) reading the same folder: its test
// `a_folder_from_the_last_electron_build` finds it by the pointer and by Electron's appData, takes it picked by hand, checks the
// marker's files and sizes. A damaged copy of the folder must make that Rust test fail (the test is not empty). The frozen
// Writer is run again into a temp folder and must still write the same files with the same hashes (the fixture is what it writes).
// KT_REQUIRE_RUSTC=1: no rustc is a failure, not a skip.
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process'); const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..'); const FIX = path.join(__dirname, 'data', 'handover-bridge');
const RS = path.join(ROOT, 'core', 'kt-core', 'src', 'handoverlogic.rs'); const NAME = 'Kurokawa Tools'; const APP = 'KurokawaTools';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'k-handoverfx-'));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; return !!c; };
const rs = fs.readFileSync(RS, 'utf8');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name)).split(path.sep).join('/')]));
/** The Rust build's rule for a path inside the hand-over (handoverlogic.rs safe_rel): plain ASCII names joined by «/». */
const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 300 && rel.split('/').every((s) => s && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s));
/** A copy of the committed fixture in TMP with the pointer's word put right. */
function copy(name) {
  const dest = path.join(TMP, name); fs.cpSync(FIX, dest, { recursive: true });
  const pf = path.join(dest, 'tauri-data', 'handover-from.json'); const ptr = JSON.parse(fs.readFileSync(pf, 'utf8'));
  ptr.dir = ptr.dir.replace('@FIXTURE@', dest.split(path.sep).join('/')); fs.writeFileSync(pf, JSON.stringify(ptr));
  return dest;
}
const handoverDir = (root) => path.join(root, 'appdata', NAME, 'handover');

// The constants the Rust build reads the folder by.
const konst = (n) => new RegExp(`pub const ${n}: &str = "([^"]*)";`).exec(rs)[1];
ok('the Rust build looks for the folder «handover», the marker «marker.json», the pointer «handover-from.json»', konst('DIR') === 'handover' && konst('MARKER') === 'marker.json' && konst('POINTER') === 'handover-from.json');
ok('the Rust build reads format ' + /pub const FORMAT: u64 = (\d+);/.exec(rs)[1] + ' and Electron\'s data folder «' + NAME + '»', /pub const FORMAT: u64 = 1;/.test(rs) && new RegExp(`ELECTRON_NAMES: \\[&str; 2\\] = \\["${NAME}"`).test(rs));

const root = copy('node'); const dir = handoverDir(root);
const marker = JSON.parse(fs.readFileSync(path.join(dir, 'marker.json'), 'utf8'));
ok('the marker: app, kind, a format the Rust build reads, from the bridge build', marker.app === APP && marker.kind === 'handover' && marker.format === 1 && marker.from && marker.from.shell === 'electron' && typeof marker.id === 'string' && marker.id.length > 8 && marker.createdAt > 1.7e12, marker);
const listed = marker.files.map((f) => f.rel);
ok('every path in the marker is one the Rust build may read', listed.length >= 8 && listed.every(safeRel), listed.filter((r) => !safeRel(r)));
ok('every listed file is there, of the size and SHA-256 the marker says', marker.files.every((f) => { const p = path.join(dir, ...f.rel.split('/')); return fs.existsSync(p) && fs.statSync(p).size === f.size && sha(p) === f.sha256; }));
const onDisk = walk(dir).filter((r) => r !== 'marker.json').sort();
ok('nothing unlisted is in the folder, and the marker\'s total is the files\'', JSON.stringify(onDisk) === JSON.stringify([...listed].sort()) && marker.bytes === marker.files.reduce((a, f) => a + f.size, 0), { onDisk, listed });
const pointer = JSON.parse(fs.readFileSync(path.join(root, 'tauri-data', 'handover-from.json'), 'utf8'));
ok('the pointer in the Rust build\'s data folder names this folder and this hand-over', pointer.kind === 'handover-pointer' && pointer.app === APP && pointer.id === marker.id && path.resolve(pointer.dir) === path.resolve(dir) && fs.existsSync(path.join(pointer.dir, 'marker.json')), pointer);
const json = (rel) => JSON.parse(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
const lines = (rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const files = json('handover/files.json');
ok('the page\'s file index points only at files the folder has', Array.isArray(files) && files.length > 0 && files.every((f) => listed.includes(f.rel) && f.size === fs.statSync(path.join(dir, ...f.rel.split('/'))).size && typeof f.key === 'string'), files);
ok('the page\'s stores are readable (records, keys)', lines('handover/meta.jsonl').length >= 1 && Object.keys(json('handover/local.json')).length >= 1);
const engine = [...rs.matchAll(/\("(engine\/[a-z0-9.\-]+)", "[a-z0-9.\-]+"\)/g)].map((m) => m[1]); const moving = /ENGINE_MOVING: &str = "([^"]+)"/.exec(rs)[1];
const inEngine = listed.filter((r) => r.startsWith('engine/'));
ok('the download engine\'s files are the ones the Rust build puts in place (and the ids that were moving)', engine.length === 6 && inEngine.length >= 3 && inEngine.every((r) => engine.includes(r) || r === moving), { engine, inEngine });
ok('the moving ids are a JSON list; the session names a download the notes know', Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, ...moving.split('/')), 'utf8'))) && Object.keys(json('engine/tasks.json')).every((gid) => fs.readFileSync(path.join(dir, 'engine', 'aria2.session'), 'utf8').includes(gid)));
const shell = listed.filter((r) => r.startsWith('shell/')); ok('the shell\'s own files came along (icon, window state)', shell.includes('shell/custom-icon.png') && shell.includes('shell/window-state.json'), shell);

// The Rust build's own code on the same folder.
const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
if (rustc.status !== 0) { ok('rustc on the PATH (set KT_REQUIRE_RUSTC=1 to make it required)', !process.env.KT_REQUIRE_RUSTC); console.log('skip: no rustc — the Rust half of this test did not run'); }
else {
  const bin = path.join(TMP, 'handoverlogic-test' + (process.platform === 'win32' ? '.exe' : ''));
  const b = spawnSync('rustc', ['--edition', '2021', '--test', RS, '-o', bin], { encoding: 'utf8' });
  if (!ok('handoverlogic.rs compiles as a test (std only)', b.status === 0, (b.stderr || '').slice(-600))) { /* nothing to run */ }
  else {
    const run = (fx) => spawnSync(bin, ['a_folder_from_the_last_electron_build', '--nocapture'], { encoding: 'utf8', env: { ...process.env, KR_HANDOVER_FIXTURE: fx } });
    let r = run(root); ok('the Rust build finds, picks and reads the bridge build\'s folder', r.status === 0 && /1 passed/.test(r.stdout), (r.stdout + r.stderr).slice(-700));
    // A damaged copy must fail (the test is not empty): a file cut short; a marker missing.
    const cut = copy('cut');
    const victim = marker.files.find((f) => f.size > 1).rel; fs.writeFileSync(path.join(handoverDir(cut), ...victim.split('/')), 'x');
    r = run(cut); ok('the Rust build refuses a copy with a file cut short', r.status !== 0 && /size|left|right/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(-300));
    const nomark = copy('nomark'); fs.rmSync(path.join(handoverDir(nomark), 'marker.json')); r = run(nomark); ok('the Rust build finds nothing without the marker (no marker, no hand-over)', r.status !== 0, (r.stdout + r.stderr).slice(-300));
    const extra = copy('extra'); fs.writeFileSync(path.join(handoverDir(extra), 'unlisted.bin'), 'zz'); r = run(extra); ok('the Rust build notices a file the marker does not list', r.status !== 0, (r.stdout + r.stderr).slice(-300));
  }
}

// The frozen Writer still writes what the fixture holds.
{
  const out = path.join(TMP, 'regen'); const g = spawnSync(process.execPath, [path.join(__dirname, 'support', 'make-handover-fixture.cjs'), out], { encoding: 'utf8' });
  ok('the frozen Writer runs and makes the fixture again', g.status === 0, g.stderr);
  if (g.status === 0) {
    const m2 = JSON.parse(fs.readFileSync(path.join(out, 'appdata', NAME, 'handover', 'marker.json'), 'utf8'));
    const key = (m) => JSON.stringify(m.files.map((f) => [f.rel, f.size, f.sha256]));
    ok('…with the same files, sizes and SHA-256 as the committed folder', key(m2) === key(marker), { regenerated: m2.files.length, committed: marker.files.length });
    ok('…and the same marker fields', m2.app === marker.app && m2.format === marker.format && JSON.stringify(m2.counts) === JSON.stringify(marker.counts) && m2.from.shell === marker.from.shell);
  }
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'handover-fixture: all ok');
process.exit(fails ? 1 : 0);
