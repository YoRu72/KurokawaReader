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
function find() {
  const found = X.PLAYERS.filter((p) => pathOf(p.id)).map((p) => ({ id: p.id, name: p.name }));
  const s = store(); const chosen = s.path ? { path: s.path, args: s.args || '', there: isFile(s.path) } : null;
  return { found, chosen };
}
/** The program the user picked in the shell's own dialog (main.cjs): kept if it is a file. */
function setChosen(p) { const abs = p && path.isAbsolute(p) ? path.resolve(p) : ''; if (!abs || !isFile(abs)) throw new Error('not a program'); const s = store(); save({ ...s, path: abs }); return { path: abs }; }
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
  const argv = args.map((a) => (ipc ? a.split('${ipc}').join(ipcPath) : a));
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
module.exports = { init, find, setChosen, setArgs, forget, start, status, stop, release, resolve, running };
