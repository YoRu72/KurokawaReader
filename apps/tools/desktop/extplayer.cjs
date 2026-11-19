// A player on this computer (src/player/external): the shell finds the players it knows (extcmd.cjs's table: absolute
// paths, or a bare name on the PATH's absolute folders — never the current folder), keeps the program the user chose
// in its own file dialog (here, in the app's data folder: never in the page's settings, so no backup or import can
// bring a program to run), and starts one only from a typed request it checks and turns into arguments itself (no
// shell; each argument one item). How it goes: running or ended, and for mpv where it is, by its JSON IPC (time-pos,
// duration, eof-reached observed: mpv tells each change). The page asks extPlayerStatus while the program runs.
// Closing the app or reloading the page lets go of the records; the players keep playing.
'use strict';
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const net = require('node:net'); const crypto = require('node:crypto');
const X = require('./extcmd.cjs');

const procs = new Map(); let seq = 0; let storeFile = '';
const WIN = process.platform === 'win32';
const PLAT = process.platform === 'darwin' ? 'darwin' : WIN ? 'win32' : 'linux';
/** Where the chosen program is kept (main.cjs: the app's data folder). */
function init(file) { storeFile = file; }
function store() { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return {}; } }
function save(o) { if (!storeFile) throw new Error('no store'); fs.mkdirSync(path.dirname(storeFile), { recursive: true }); fs.writeFileSync(storeFile, JSON.stringify(o)); }

/** %VAR% from the environment, then: an absolute path that is a file; a bare name on the PATH's absolute folders. */
function resolve(p) {
  let bad = false;
  const x = String(p || '').replace(/%([^%]+)%/g, (_m, k) => { const key = Object.keys(process.env).find((e) => e.toLowerCase() === k.toLowerCase()); if (!key) bad = true; return key ? process.env[key] : ''; });
  if (!x || bad) return null;
  if (path.isAbsolute(x)) return isFile(x) ? path.resolve(x) : null;
  if (x.includes('/') || x.includes('\\')) return null;
  const exts = WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const e of exts) { const f = path.join(dir, x.toLowerCase().endsWith(e) ? x : x + e); if (isFile(f)) return path.resolve(f); }
  }
  return null;
}
function isFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }
const pathOf = (id) => { const p = X.byId(id); if (!p) return null; for (const c of p.paths[PLAT] || []) { const r = resolve(c); if (r) return r; } return null; };
/** extPlayers() → { found: [{ id, name }], chosen: { path, args, there } | null }. */
let swept = false;
function find() {
  if (!swept) { swept = true; sweepSubs(); }
  const found = X.PLAYERS.filter((p) => pathOf(p.id)).map((p) => ({ id: p.id, name: p.name }));
  const s = store(); const chosen = s.path ? { path: s.path, args: s.args || '', there: isFile(s.path) } : null;
  return { found, chosen };
}
/** The program the user picked in the shell's own dialog (main.cjs): kept if it is a file. */
function setChosen(p) {
  let abs = p && path.isAbsolute(p) ? path.resolve(p) : '';
  // (A Mac's dialog gives the application bundle: its program is Contents/MacOS/<CFBundleExecutable>.)
  if (abs && /\.app$/i.test(abs)) abs = bundleProgram(abs) || '';
  // (No shell is ever used, so a .bat or .cmd cannot be run as a player.)
  if (abs && WIN && /\.(bat|cmd)$/i.test(abs)) throw new Error('kt-ext:batch');
  if (!abs || !isFile(abs)) throw new Error('kt-ext:notprogram');
  const s = store(); save({ ...s, path: abs }); return { path: abs };
}
/** A bundle's program: IINA's own command-line door (Contents/MacOS/iina-cli — IINA.app's main program opens a window
 *  and takes no mpv options) when the bundle carries it; else Info.plist's CFBundleExecutable, read from the XML form
 *  or, best-effort, the binary one (bplist00); else the bundle's own name. */
function bundleProgram(app) {
  try {
    const mac = path.join(app, 'Contents', 'MacOS'); const cli = path.join(mac, 'iina-cli'); if (isFile(cli)) return cli;
    let name = ''; let raw = null; try { raw = fs.readFileSync(path.join(app, 'Contents', 'Info.plist')); } catch { raw = null; }
    if (raw) { if (raw.toString('latin1', 0, 8) === 'bplist00') name = bplistString(raw, 'CFBundleExecutable') || ''; else { const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(raw.toString('utf8')); name = m ? m[1].trim() : ''; } }
    if (!name || /[\/\\]|^\.\.?$/.test(name)) name = path.basename(app, '.app');
    const f = path.join(mac, name); return isFile(f) ? f : null;
  } catch { return null; }
}
/** A string value of the top dictionary of a binary property list (Apple's bplist00), or null — only what a bundle's
 *  Info.plist needs: its trailer, the offset table, a dictionary, ASCII and UTF-16 strings; anything else, null. */
function bplistString(buf, key) {
  try {
    if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') return null;
    const t = buf.length - 32; const offSize = buf[t + 6]; const refSize = buf[t + 7];
    const num = Number(buf.readBigUInt64BE(t + 8)); const top = Number(buf.readBigUInt64BE(t + 16)); const table = Number(buf.readBigUInt64BE(t + 24));
    if (!offSize || !refSize || offSize > 8 || refSize > 8 || table + num * offSize > t) return null;
    const uint = (at, n) => { if (at < 0 || at + n > t) throw new Error('bplist'); let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[at + i]; return v; };
    const off = (i) => (i < num ? uint(table + i * offSize, offSize) : -1);
    const len = (at) => { const lo = buf[at] & 0xf; if (lo !== 0xf) return [lo, at + 1]; const m = buf[at + 1]; if ((m & 0xf0) !== 0x10 || (m & 0xf) > 3) return [-1, 0]; const n = 1 << (m & 0xf); return [uint(at + 2, n), at + 2 + n]; };
    const str = (i) => {
      const at = off(i); if (at < 8 || at >= t) return null; const ty = buf[at] >> 4; const [n, s] = len(at); if (n < 0) return null;
      if (ty === 5 && s + n <= t) return buf.toString('latin1', s, s + n);
      if (ty === 6 && s + 2 * n <= t) { const b = Buffer.from(buf.subarray(s, s + 2 * n)); b.swap16(); return b.toString('utf16le'); }
      return null;
    };
    const at = off(top); if (at < 8 || at >= t || buf[at] >> 4 !== 0xd) return null;
    const [n, s] = len(at); if (n < 0) return null;
    for (let k = 0; k < n; k++) if (str(uint(s + k * refSize, refSize)) === key) return str(uint(s + (n + k) * refSize, refSize));
    return null;
  } catch { return null; }
}
/** The subtitle copies saved for players that read only files (kt-sub-*), an hour old or more: removed. */
function sweepSubs() { for (const d of X.tempDirs()) { let names = []; try { names = fs.readdirSync(d); } catch { continue; } for (const n of names) { if (!/^kt-sub-[\w.-]+\.(srt|ass|ssa|vtt)$/.test(n)) continue; const f = path.join(d, n); try { if (Date.now() - fs.statSync(f).mtimeMs > 3600e3) fs.rmSync(f, { force: true }); } catch { /* */ } } } }
/** One subtitle copy removed once its player has ended (only a kt-sub-* file in the temp folders). */
function dropSub(o) { const f = String(o && o.path || ''); const abs = path.isAbsolute(f) ? path.resolve(f) : ''; if (!abs || !/^kt-sub-[\w.-]+\.(srt|ass|ssa|vtt)$/.test(path.basename(abs)) || !X.tempDirs().some((d) => path.dirname(abs) === path.resolve(d))) return { ok: false }; try { fs.rmSync(abs, { force: true }); } catch { /* */ } return { ok: true }; }
/** The chosen program's arguments line (typed by the user in Settings; kept here with it, never in the settings). */
function setArgs(o) { const s = store(); save({ ...s, args: String(o && o.args || '').slice(0, 2000) }); return { ok: true }; }
function forget() { save({}); return { ok: true }; }

/** extPlayerStart({ player, target, title, start, subs, headers, slang, alang }) → { id, reports }. */
function start(o) {
  const player = String(o && o.player || '');
  let exe; let template = '';
  if (player === 'chosen') { const s = store(); exe = s.path && isFile(s.path) ? s.path : null; template = s.args || ''; }
  else exe = X.byId(player) ? pathOf(player) : null;
  if (!exe) throw new Error('not installed');
  const c = X.check(o, X.tempDirs()); if (c.error) throw new Error(`refused: ${c.error}`);
  const { args, ipc } = X.build(player === 'chosen' ? 'custom' : player, c.req, template);
  const ipcPath = ipc ? (WIN ? `\\\\.\\pipe\\kt-mpv-${crypto.randomBytes(6).toString('hex')}` : path.join(os.tmpdir(), `kt-mpv-${crypto.randomBytes(6).toString('hex')}.sock`)) : '';
  // (The socket's path goes into mpv's --input-ipc-server only, never into a title or an address.)
  const argv = args.map((a) => (ipc && a === '--input-ipc-server=${ipc}' ? `--input-ipc-server=${ipcPath}` : a));
  const id = String(++seq);
  const st = { id, running: true, code: null, pos: null, dur: null, eof: false, error: '', sock: null, ipcPath, tries: 0, timer: null };
  let child; try { child = spawn(exe, argv, { stdio: 'ignore', windowsHide: false, detached: !WIN, shell: false }); } catch (e) { throw new Error(String(e && e.message || e)); }
  st.child = child; procs.set(id, st);
  child.on('error', (e) => { st.error = String(e && e.message || e); st.running = false; done(st); });
  child.on('exit', (code) => { st.code = code; st.running = false; done(st); });
  if (ipcPath) connect(st);
  return { id, reports: ipc };
}
function connect(st) {
  if (!st.running || st.sock) return;
  const s = net.connect(st.ipcPath); let buf = '';
  s.on('connect', () => { st.sock = s; for (const [i, p] of [[1, 'time-pos'], [2, 'duration'], [3, 'eof-reached']]) s.write(JSON.stringify({ command: ['observe_property', i, p] }) + '\n'); });
  s.on('data', (d) => { buf += d; if (buf.length > 1 << 20) buf = ''; let n; while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); onLine(st, line); } });
  s.on('error', () => { s.destroy(); if (!st.sock && st.running && ++st.tries < 40) { st.timer = setTimeout(() => connect(st), 250); st.timer.unref?.(); } });
  s.on('close', () => { if (st.sock === s) st.sock = null; });
}
function onLine(st, line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.event === 'property-change') { if (m.name === 'time-pos' && typeof m.data === 'number') st.pos = m.data; else if (m.name === 'duration' && typeof m.data === 'number') st.dur = m.data; else if (m.name === 'eof-reached' && m.data === true) st.eof = true; }
  else if (m.event === 'end-file' && m.reason === 'eof') st.eof = true;
}
function done(st) { clearTimeout(st.timer); try { st.sock?.destroy(); } catch { /* gone */ } st.sock = null; st.ended = Date.now(); if (st.ipcPath && !WIN) fs.rm(st.ipcPath, { force: true }, () => undefined); }
/** extPlayerStatus({ id }) → { running, code, pos, dur, eof, error }; the record dropped once it is seen ended. */
function status(o) { const st = procs.get(String(o && o.id)); if (!st) return { running: false, code: null, pos: null, dur: null, eof: false, error: 'unknown' }; const r = { running: st.running, code: st.code, pos: st.pos, dur: st.dur, eof: st.eof, error: st.error }; if (!st.running) procs.delete(st.id); return r; }
function stop(o) { const st = procs.get(String(o && o.id)); if (!st) return { ok: false }; if (st.sock) { try { st.sock.write('{"command":["quit"]}\n'); } catch { /* */ } } else { try { st.child.kill(); } catch { /* gone */ } } return { ok: true }; }
/** The app quitting, or the page reloaded (main.cjs): sockets and records let go; the players keep playing. */
function release() { for (const st of procs.values()) { clearTimeout(st.timer); try { st.sock?.destroy(); } catch { /* */ } try { st.child.unref(); } catch { /* */ } } procs.clear(); }
const running = () => [...procs.values()].filter((p) => p.running).length;
module.exports = { init, find, setChosen, dropSub, sweepSubs, bundleProgram, bplistString, setArgs, forget, start, status, stop, release, resolve, running };
