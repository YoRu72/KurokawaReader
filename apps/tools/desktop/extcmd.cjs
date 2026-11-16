// A player on this computer (src/player/external; extplayer.cjs runs it, extplayer.rs is the Rust build's twin with
// relaylogic.rs's copy of these rules): the shell's own table of the players it knows and where they usually are,
// and the command line it builds itself from a typed request — the page never names a program nor writes an
// argument. A request is checked first: the address http(s) only, subtitles http(s) or a subtitle file the app saved
// in its own temp folder, no line breaks in a header, languages as codes. Pure (no Electron), so tests run it as is.
'use strict';
const path = require('node:path'); const os = require('node:os');

/** Known players, in the order «Automatic» tries them. `headers`: what goes on its command line — User-Agent and
 *  Referer at most (a cookie or an authorisation on a command line would go to every host the player reaches, and is
 *  readable by other programs: those sources go through the app's relay, which sends them to the source's origin
 *  only); none for PotPlayer, whose switches are not documented well enough. `ipc`: it tells where it is (mpv). */
const PLAYERS = [
  { id: 'mpv', name: 'mpv', headers: 'ua-ref', hls: true, subs: 'url', ipc: true,
    paths: { win32: ['mpv.exe', '%ProgramFiles%\\mpv\\mpv.exe', '%LOCALAPPDATA%\\Programs\\mpv\\mpv.exe', '%USERPROFILE%\\scoop\\apps\\mpv\\current\\mpv.exe'], darwin: ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/Applications/mpv.app/Contents/MacOS/mpv'], linux: ['mpv', '/usr/bin/mpv', '/usr/local/bin/mpv'] } },
  { id: 'vlc', name: 'VLC', headers: 'ua-ref', hls: true, subs: 'path', ipc: false,
    paths: { win32: ['%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe', '%ProgramFiles(x86)%\\VideoLAN\\VLC\\vlc.exe', 'vlc.exe'], darwin: ['/Applications/VLC.app/Contents/MacOS/VLC'], linux: ['vlc', '/usr/bin/vlc'] } },
  { id: 'iina', name: 'IINA', headers: 'ua-ref', hls: true, subs: 'url', ipc: false, paths: { darwin: ['/Applications/IINA.app/Contents/MacOS/iina-cli', '/opt/homebrew/bin/iina', '/usr/local/bin/iina'] } },
  { id: 'mpc-hc', name: 'MPC-HC', headers: 'none', hls: false, subs: 'path', ipc: false, paths: { win32: ['%ProgramFiles%\\MPC-HC\\mpc-hc64.exe', '%ProgramFiles(x86)%\\MPC-HC\\mpc-hc.exe', '%ProgramFiles%\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe'] } },
  { id: 'mpc-be', name: 'MPC-BE', headers: 'none', hls: false, subs: 'path', ipc: false, paths: { win32: ['%ProgramFiles%\\MPC-BE x64\\mpc-be64.exe', '%ProgramFiles(x86)%\\MPC-BE\\mpc-be.exe'] } },
  { id: 'potplayer', name: 'PotPlayer', headers: 'none', hls: true, subs: 'path', ipc: false, paths: { win32: ['%ProgramFiles%\\DAUM\\PotPlayer\\PotPlayerMini64.exe', '%ProgramFiles(x86)%\\DAUM\\PotPlayer\\PotPlayerMini.exe'] } },
];
const byId = (id) => PLAYERS.find((p) => p.id === id);
const SUB_EXT = /\.(srt|ass|ssa|vtt|sub)$/i;
const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) && u.length < 8192;
const clean = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
const noBreak = (s) => typeof s === 'string' && !/[\r\n\0]/.test(s) && s.length < 4096;

/** The request checked; a reason when it is refused. `tempDirs`: where the app saves subtitles for players that read
 *  them only from disk. */
function check(r, tempDirs) {
  if (!r || typeof r !== 'object') return { error: 'request' };
  if (!isHttp(r.target)) return { error: 'target' };
  const subs = [];
  for (const s of Array.isArray(r.subs) ? r.subs.slice(0, 20) : []) {
    const at = String(s && s.at || '');
    if (isHttp(at)) { subs.push({ at, isDefault: !!s.isDefault }); continue; }
    const abs = path.isAbsolute(at) ? path.resolve(at) : '';
    if (abs && SUB_EXT.test(abs) && tempDirs.some((d) => path.dirname(abs) === path.resolve(d))) { subs.push({ at: abs, isDefault: !!s.isDefault }); continue; }
    return { error: 'subtitle' };
  }
  const h = r.headers && typeof r.headers === 'object' ? r.headers : {};
  const headers = {};
  if (h.ua !== undefined) { if (!noBreak(h.ua)) return { error: 'header' }; headers.ua = h.ua; }
  if (h.referer !== undefined) { if (!noBreak(h.referer) || !isHttp(h.referer)) return { error: 'header' }; headers.referer = h.referer; }
  // (Only User-Agent and Referer ever reach a command line; any other header is refused here — the page sends such a
  // source through the relay.)
  if (Array.isArray(h.others) && h.others.length) return { error: 'header' };
  const langs = (a) => (Array.isArray(a) ? a.map(String).filter((x) => /^[a-z]{2,3}$/.test(x)).slice(0, 10) : []);
  const start = Number(r.start);
  return { req: { target: r.target, title: clean(r.title), start: Number.isFinite(start) && start > 0 ? start : 0, subs, headers, slang: langs(r.slang), alang: langs(r.alang) } };
}

const secs = (s) => (s > 0 ? String(Math.round(s * 10) / 10) : '');
const hms = (s) => { const t = Math.floor(s); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
/** The arguments for a known player (`id`) or for the program the user chose with its arguments line (`template`). */
function build(id, q, template) {
  const a = []; const ua = q.headers.ua; const ref = q.headers.referer;
  const def = q.subs.find((s) => s.isDefault) || q.subs[0];
  switch (id) {
    case 'mpv': case 'iina': {
      const o = (x) => (id === 'iina' ? `--mpv-${x.replace(/^--/, '')}` : x);
      if (id === 'iina') a.push('--keep-running');                 // (iina-cli stays until IINA's window is closed)
      if (q.title) a.push(o(`--force-media-title=${q.title}`));
      if (q.start) a.push(o(`--start=${secs(q.start)}`));
      for (const s of q.subs) a.push(o(`--sub-file=${s.at}`));
      if (q.slang.length) a.push(o(`--slang=${q.slang.join(',')}`));
      if (q.alang.length) a.push(o(`--alang=${q.alang.join(',')}`));
      if (ua) a.push(o(`--user-agent=${ua}`));
      if (ref) a.push(o(`--referrer=${ref}`));
      if (id === 'mpv') a.push('--hwdec=auto-safe', '--input-ipc-server=${ipc}', '--idle=no', '--keep-open=no', '--', q.target);
      else a.push(q.target);
      return { args: a, ipc: id === 'mpv' };
    }
    case 'vlc':
      if (q.title) a.push(`--meta-title=${q.title}`);
      if (q.start) a.push(`--start-time=${secs(q.start)}`);
      if (def) a.push(`--sub-file=${def.at}`);
      if (q.slang.length) a.push(`--sub-language=${q.slang.join(',')}`);
      if (q.alang.length) a.push(`--audio-language=${q.alang.join(',')}`);
      if (ua) a.push(`--http-user-agent=${ua}`);
      if (ref) a.push(`--http-referrer=${ref}`);
      a.push('--play-and-exit', '--no-one-instance', q.target);
      return { args: a, ipc: false };
    case 'mpc-hc': case 'mpc-be':
      a.push(q.target, '/play', '/close');
      if (q.start) a.push('/start', String(Math.round(q.start * 1000)));
      for (const s of q.subs) a.push('/sub', s.at);
      return { args: a, ipc: false };
    case 'potplayer':
      a.push(q.target);
      if (q.start) a.push(`/seek=${hms(q.start)}`);
      if (def) a.push(`/sub=${def.at}`);
      return { args: a, ipc: false };
    default: return custom(template || '', q);
  }
}
/** The chosen program's arguments line: split like a shell would, never given to one; each placeholder filled inside
 *  its own argument; an argument whose placeholder is empty left out; with no {url}, the address comes last. */
function custom(line, q) {
  const def = q.subs.find((s) => s.isDefault) || q.subs[0];
  const vals = { url: q.target, title: q.title, start: secs(q.start), startms: q.start ? String(Math.round(q.start * 1000)) : '', sub: def ? def.at : '', ua: q.headers.ua || '', referrer: q.headers.referer || '' };
  let hadUrl = false; const out = [];
  for (const w of splitArgs(line)) {
    let empty = false; let any = false;
    const f = w.replace(/\{(url|title|start|startms|sub|ua|referrer)\}/g, (_m, k) => { any = true; if (k === 'url') hadUrl = true; const v = vals[k]; if (!v) empty = true; return v; });
    if (any && empty) continue;
    // (An argument that is only a placeholder and whose value starts with «-» would be read as an option: left out.)
    if (any && /^\{(url|title|start|startms|sub|ua|referrer)\}$/.test(w) && f.startsWith('-')) continue;
    out.push(f);
  }
  if (!hadUrl) out.push(q.target);
  return { args: out, ipc: false };
}
function splitArgs(line) {
  const out = []; let cur = ''; let qt = null; let has = false; line = String(line || '');
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (qt) { if (c === qt) qt = null; else if (c === '\\' && qt === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { qt = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}
/** What the chosen program's arguments line sends itself: User-Agent and Referer when it places them, else nothing. */
const customHeaders = (line) => (/\{ua\}/.test(line || '') && /\{referrer\}/.test(line || '') ? 'ua-ref' : 'none');
const tempDirs = (extra = []) => [path.join(os.tmpdir(), 'kurokawa-clip'), os.tmpdir(), ...extra];
module.exports = { PLAYERS, byId, check, build, custom, splitArgs, customHeaders, tempDirs, isHttp };
