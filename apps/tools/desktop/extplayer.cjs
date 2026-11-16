// Another program plays the video (src/player/external): which of the known players are on this computer, the one
// chosen started with its arguments (never through a shell: each argument is one item), and how it goes — running
// or ended, and for mpv where it is, by its JSON IPC: the properties observed (time-pos, duration, eof-reached),
// mpv telling each change, nothing polled. The page asks extPlayerStatus while the player runs; the stream it
// plays is released when the program has ended. Closing the app leaves the player playing.
'use strict';
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const net = require('node:net'); const crypto = require('node:crypto');

const procs = new Map(); let seq = 0;
const WIN = process.platform === 'win32';
/** %VAR% filled from the environment (a Windows path); a bare name looked for on the PATH. */
function resolve(p) {
  const x = String(p || '').replace(/%([^%]+)%/g, (_m, k) => process.env[k] ?? process.env[Object.keys(process.env).find((e) => e.toLowerCase() === k.toLowerCase()) ?? ''] ?? '');
  if (!x || x.includes('%')) return null;
  if (path.isAbsolute(x)) return isFile(x) ? x : null;
  if (x.includes('/') || x.includes('\\')) return null;
  const exts = WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) { if (!dir) continue; for (const e of exts) { const f = path.join(dir, x.toLowerCase().endsWith(e) ? x : x + e); if (isFile(f)) return f; } }
  return null;
}
function isFile(f) { try { const st = fs.statSync(f); return st.isFile() || (process.platform === 'darwin' && st.isDirectory() && f.endsWith('.app')); } catch { return false; } }
/** extPlayers({ cands: [{ id, paths }] }) → { found: [{ id, path }] }: the first path of each that is there. */
function find(o) { const found = []; for (const c of (o && o.cands) || []) { for (const p of c.paths || []) { const r = resolve(p); if (r) { found.push({ id: String(c.id), path: r }); break; } } } return { found }; }

/** extPlayerStart({ exe, args, ipc }) → { id }. With ipc, «${ipc}» in an argument becomes the socket mpv listens on. */
function start(o) {
  const exe = resolve(o && o.exe) || String(o && o.exe || ''); if (!exe) throw new Error('no program');
  const ipcPath = o.ipc ? (WIN ? `\\\\.\\pipe\\kt-mpv-${crypto.randomBytes(6).toString('hex')}` : path.join(os.tmpdir(), `kt-mpv-${crypto.randomBytes(6).toString('hex')}.sock`)) : '';
  const args = (o.args || []).map((a) => String(a).split('${ipc}').join(ipcPath));
  const id = String(++seq);
  const st = { id, running: true, code: null, pos: null, dur: null, eof: false, error: '', sock: null, ipcPath, tries: 0, timer: null };
  let child; try { child = spawn(exe, args, { stdio: 'ignore', windowsHide: false, detached: !WIN }); } catch (e) { throw new Error(String(e && e.message || e)); }
  st.child = child; procs.set(id, st);
  child.on('error', (e) => { st.error = String(e && e.message || e); st.running = false; done(st); });
  child.on('exit', (code) => { st.code = code; st.running = false; done(st); });
  if (ipcPath) connect(st);
  return { id };
}
/** mpv's socket appears a moment after it starts: tried again for ten seconds, then left (the end is still seen). */
function connect(st) {
  if (!st.running || st.sock) return;
  const s = net.connect(st.ipcPath); let buf = '';
  s.on('connect', () => { st.sock = s; for (const [i, p] of [[1, 'time-pos'], [2, 'duration'], [3, 'eof-reached']]) s.write(JSON.stringify({ command: ['observe_property', i, p] }) + '\n'); });
  s.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); onLine(st, line); } });
  s.on('error', () => { s.destroy(); if (!st.sock && st.running && ++st.tries < 40) { st.timer = setTimeout(() => connect(st), 250); st.timer.unref?.(); } });
  s.on('close', () => { if (st.sock === s) st.sock = null; });
}
function onLine(st, line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.event === 'property-change') { if (m.name === 'time-pos' && typeof m.data === 'number') st.pos = m.data; else if (m.name === 'duration' && typeof m.data === 'number') st.dur = m.data; else if (m.name === 'eof-reached' && m.data === true) st.eof = true; }
  else if (m.event === 'end-file' && m.reason === 'eof') st.eof = true;
}
function done(st) { clearTimeout(st.timer); try { st.sock?.destroy(); } catch { /* gone */ } st.sock = null; if (st.ipcPath && !WIN) fs.rm(st.ipcPath, { force: true }, () => undefined); }
/** extPlayerStatus({ id }) → { running, code, pos, dur, eof, error }; an unknown id: not running. */
function status(o) { const st = procs.get(String(o && o.id)); if (!st) return { running: false, code: null, pos: null, dur: null, eof: false, error: 'unknown' }; const r = { running: st.running, code: st.code, pos: st.pos, dur: st.dur, eof: st.eof, error: st.error }; if (!st.running) procs.delete(st.id); return r; }
/** extPlayerStop({ id }): the player told to quit (mpv by its socket, else ended). */
function stop(o) { const st = procs.get(String(o && o.id)); if (!st) return { ok: false }; if (st.sock) { try { st.sock.write('{"command":["quit"]}\n'); } catch { /* */ } } else { try { st.child.kill(); } catch { /* gone */ } } return { ok: true }; }
/** The app quitting: sockets let go; the players keep playing. */
function release() { for (const st of procs.values()) { clearTimeout(st.timer); try { st.sock?.destroy(); } catch { /* */ } try { st.child.unref(); } catch { /* */ } } procs.clear(); }
const running = () => [...procs.values()].filter((p) => p.running).length;
module.exports = { find, start, status, stop, release, resolve, running };
