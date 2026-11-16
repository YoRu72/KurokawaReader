// Another app plays the video (VLC, mpv, MX Player, Just Player on a phone; mpv, VLC, MPC-HC/BE, PotPlayer, IINA or
// a command of one's own on a computer): the plain part, with no page and no shell, so tests run it as it is.
//   · the players each platform knows, what each takes (headers, subtitles, a start, a title) and what it tells back;
//   · the plan for a source: handed over as it is (a file, a plain link, the app's own torrent stream), or through
//     the app's local relay (loopback, a random port, a token for this one playback) when the source needs request
//     headers the player cannot send itself, and for subtitles a phone's player cannot otherwise read;
//   · the phone's intent (the documented extras of each app) and the computer's command line (no shell is ever
//     used: every argument is one item, a placeholder filled inside its own item only);
//   · what came back (a position, a length, «played to the end») turned into «watched» or not.

export type Platform = 'android' | 'win' | 'mac' | 'linux';
/** Where a video comes from, for the default player of each («per service» in Settings → Player). */
export type Service = 'torrent' | 'online' | 'http' | 'local';
export const SERVICES: Service[] = ['torrent', 'online', 'http', 'local'];
export type Dialect = 'vlc' | 'mx' | 'mpv' | 'just' | 'any';

export interface ExtSub { url?: string; path?: string; name: string; lang?: string; isDefault?: boolean; headers?: Record<string, string> }
export interface ExtSource {
  /** What the in-app player would open: a remote address, the app's stream on 127.0.0.1, or a local file's address. */
  url: string; name: string; localPath?: string; headers?: Record<string, string>; hls?: boolean;
  subs?: ExtSub[]; /** seconds */ start?: number; alang?: string[]; slang?: string[];
}
export interface PlayerDef {
  id: string; name: string; platforms: Platform[];
  /** Phone: the app's packages (the first one installed is used) and how its extras are written. */
  pkgs?: string[]; dialect?: Dialect;
  /** Computer: where the program usually is (a bare name is looked for on the PATH; %VAR% is the environment's). */
  paths?: Partial<Record<Exclude<Platform, 'android'>, string[]>>;
  /** Request headers it sends itself: all of them, only User-Agent and Referer, or none. */
  headers: 'all' | 'ua-ref' | 'none';
  hls: boolean; /** subtitles by address (url), only as a file on disk (path), or not at all */ subs: 'url' | 'path' | 'none';
  start: boolean; title: boolean; langs: boolean; /** it tells where it stopped */ reports: boolean;
}

export const PLAYERS: PlayerDef[] = [
  // ---- phone (each one's documented intent extras: VLC's «Intent API», MX Player's «API», mpv-android's and Just Player's)
  { id: 'vlc-android', name: 'VLC', platforms: ['android'], pkgs: ['org.videolan.vlc'], dialect: 'vlc', headers: 'none', hls: true, subs: 'url', start: true, title: true, langs: false, reports: true },
  { id: 'mpv-android', name: 'mpv', platforms: ['android'], pkgs: ['is.xyz.mpv'], dialect: 'mpv', headers: 'none', hls: true, subs: 'url', start: true, title: true, langs: false, reports: true },
  { id: 'mx', name: 'MX Player', platforms: ['android'], pkgs: ['com.mxtech.videoplayer.pro', 'com.mxtech.videoplayer.ad'], dialect: 'mx', headers: 'none', hls: true, subs: 'url', start: true, title: true, langs: false, reports: true },
  { id: 'just', name: 'Just Player', platforms: ['android'], pkgs: ['com.brouken.player'], dialect: 'just', headers: 'none', hls: true, subs: 'url', start: true, title: true, langs: false, reports: true },
  { id: 'any', name: '', platforms: ['android'], dialect: 'any', headers: 'none', hls: true, subs: 'none', start: false, title: true, langs: false, reports: false },
  // ---- computer
  { id: 'mpv', name: 'mpv', platforms: ['win', 'mac', 'linux'], headers: 'all', hls: true, subs: 'url', start: true, title: true, langs: true, reports: true,
    paths: { win: ['mpv.exe', '%ProgramFiles%\\mpv\\mpv.exe', '%LOCALAPPDATA%\\Programs\\mpv\\mpv.exe', '%USERPROFILE%\\scoop\\apps\\mpv\\current\\mpv.exe'], mac: ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/Applications/mpv.app/Contents/MacOS/mpv'], linux: ['mpv', '/usr/bin/mpv', '/usr/local/bin/mpv'] } },
  { id: 'vlc', name: 'VLC', platforms: ['win', 'mac', 'linux'], headers: 'ua-ref', hls: true, subs: 'path', start: true, title: true, langs: true, reports: false,
    paths: { win: ['%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe', '%ProgramFiles(x86)%\\VideoLAN\\VLC\\vlc.exe', 'vlc.exe'], mac: ['/Applications/VLC.app/Contents/MacOS/VLC'], linux: ['vlc', '/usr/bin/vlc'] } },
  { id: 'mpc-hc', name: 'MPC-HC', platforms: ['win'], headers: 'none', hls: false, subs: 'path', start: true, title: false, langs: false, reports: false,
    paths: { win: ['%ProgramFiles%\\MPC-HC\\mpc-hc64.exe', '%ProgramFiles(x86)%\\MPC-HC\\mpc-hc.exe', '%ProgramFiles%\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe'] } },
  { id: 'mpc-be', name: 'MPC-BE', platforms: ['win'], headers: 'none', hls: false, subs: 'path', start: true, title: false, langs: false, reports: false,
    paths: { win: ['%ProgramFiles%\\MPC-BE x64\\mpc-be64.exe', '%ProgramFiles(x86)%\\MPC-BE\\mpc-be.exe'] } },
  { id: 'potplayer', name: 'PotPlayer', platforms: ['win'], headers: 'ua-ref', hls: true, subs: 'path', start: true, title: false, langs: false, reports: false,
    paths: { win: ['%ProgramFiles%\\DAUM\\PotPlayer\\PotPlayerMini64.exe', '%ProgramFiles(x86)%\\DAUM\\PotPlayer\\PotPlayerMini.exe'] } },
  { id: 'iina', name: 'IINA', platforms: ['mac'], headers: 'all', hls: true, subs: 'url', start: true, title: true, langs: true, reports: false,
    paths: { mac: ['/Applications/IINA.app/Contents/MacOS/iina-cli', '/opt/homebrew/bin/iina', '/usr/local/bin/iina'] } },
  { id: 'custom', name: '', platforms: ['win', 'mac', 'linux'], headers: 'ua-ref', hls: true, subs: 'path', start: true, title: true, langs: false, reports: false },
];
export const playerById = (id: string): PlayerDef | undefined => PLAYERS.find((p) => p.id === id);
export const playersFor = (plat: Platform): PlayerDef[] => PLAYERS.filter((p) => p.platforms.includes(plat));

/** Which service a video belongs to. */
export function serviceOf(o: { taskKind?: string; localPath?: string; headers?: Record<string, string>; online?: boolean }): Service {
  if (o.taskKind === 'torrent') return 'torrent';
  if (o.localPath) return 'local';
  if (o.online || (o.headers && Object.keys(o.headers).length)) return 'online';
  return 'http';
}

const lower = (h?: Record<string, string>) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
const isLoopback = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(u);

export type How = 'direct' | 'relay' | 'path' | 'temp' | 'drop';
export interface Plan { main: How; /** the headers go on the command line (mpv, IINA; VLC and PotPlayer for UA/Referer) */ headerArgs: boolean; subs: How[]; relay: boolean; problem?: 'hls' | 'headers' }
/** How a source reaches a player. Plain sources go as they are; headers the player cannot send, and (on a phone)
 *  subtitles, go through the relay; a computer player that reads subtitles only from disk gets them saved first. */
export function plan(src: ExtSource, p: PlayerDef, plat: Platform): Plan {
  const hd = lower(src.headers); const keys = Object.keys(hd).filter((k) => k !== 'range');
  const onlyUaRef = keys.every((k) => k === 'user-agent' || k === 'referer');
  let main: How; let headerArgs = false; let problem: Plan['problem'];
  if (src.localPath) main = plat === 'android' ? 'path' : 'path';
  else if (!keys.length || isLoopback(src.url)) main = 'direct';
  else if (plat !== 'android' && (p.headers === 'all' || (p.headers === 'ua-ref' && onlyUaRef))) { main = 'direct'; headerArgs = true; }
  else main = 'relay';
  if (src.hls && !p.hls && !src.localPath) problem = 'hls';
  const subs = (src.subs ?? []).map((s): How => {
    if (p.subs === 'none') return 'drop';
    if (plat === 'android') return 'relay';                       // (a phone's player reads none of the app's files, nor a site's headers)
    if (p.subs === 'path') return s.path ? 'path' : 'temp';
    if (s.path) return 'path';
    return s.headers && Object.keys(s.headers).length ? 'relay' : 'direct';
  });
  return { main, headerArgs, subs, relay: main === 'relay' || subs.includes('relay'), problem };
}

/** The source as it is handed over, after the relay was opened and subtitles saved: addresses or paths only. */
export interface Ready { target: string; isPath: boolean; title: string; start?: number; subs: { at: string; name: string; isDefault?: boolean }[]; headers?: Record<string, string>; alang?: string[]; slang?: string[] }

/* ---------- the phone: an ACTION_VIEW intent with each app's extras ---------- */
export type Extra = { k: string; t: 's' | 'i' | 'l' | 'b' | 'sa' | 'ua'; v: string | number | boolean | string[] };
export interface AndroidIntent { pkg?: string; chooser: boolean; data: string; path?: string; mime: string; title: string; extras: Extra[]; result: boolean }
export function androidIntent(p: PlayerDef, r: Ready, pkg?: string): AndroidIntent {
  const ms = r.start && r.start > 0 ? Math.round(r.start * 1000) : 0;
  const subs = r.subs.map((s) => s.at); const names = r.subs.map((s) => s.name); const on = r.subs.filter((s) => s.isDefault).map((s) => s.at);
  const ex: Extra[] = [{ k: 'title', t: 's', v: r.title }];
  const mime = /\.m3u8(\?|$)/i.test(r.target) ? 'application/x-mpegURL' : 'video/*';
  switch (p.dialect) {
    case 'vlc': // (VLC: position is a long in ms; one subtitle by its location; it answers extra_position / extra_duration)
      if (ms) ex.push({ k: 'position', t: 'l', v: ms }, { k: 'from_start', t: 'b', v: false });
      if (subs[0]) ex.push({ k: 'subtitles_location', t: 's', v: (on[0] ?? subs[0]) });
      break;
    case 'mx': case 'just': // (MX Player's API, which Just Player follows: int ms, Uri[] subtitles with names, the result asked for)
      if (ms) ex.push({ k: 'position', t: 'i', v: ms });
      if (subs.length) ex.push({ k: 'subs', t: 'ua', v: subs }, { k: 'subs.name', t: 'sa', v: names }, { k: 'subs.enable', t: 'ua', v: on.length ? on : [subs[0]] });
      ex.push({ k: 'return_result', t: 'b', v: true });
      break;
    case 'mpv': // (mpv-android: subs / subs.enable as Uri[], position as int ms; it returns position and duration)
      if (ms) ex.push({ k: 'position', t: 'i', v: ms });
      if (subs.length) ex.push({ k: 'subs', t: 'ua', v: subs }, { k: 'subs.enable', t: 'ua', v: on.length ? on : [subs[0]] });
      break;
    default: break;
  }
  return { pkg: p.dialect === 'any' ? undefined : pkg ?? p.pkgs?.[0], chooser: p.dialect === 'any', data: r.isPath ? '' : r.target, path: r.isPath ? r.target : undefined, mime, title: r.title, extras: ex, result: p.dialect !== 'any' };
}
/** What a phone's player answered: seconds, and whether it played to the end. */
export function androidResult(p: PlayerDef, extras: Record<string, unknown> | null | undefined): { pos?: number; dur?: number; ended: boolean } {
  const e = extras ?? {}; const num = (k: string) => { const n = Number(e[k]); return Number.isFinite(n) && n >= 0 && e[k] !== null && e[k] !== undefined && e[k] !== '' ? n / 1000 : undefined; };
  if (p.dialect === 'vlc') return { pos: num('extra_position'), dur: num('extra_duration'), ended: false };
  if (p.dialect === 'any') return { ended: false };
  return { pos: num('position'), dur: num('duration'), ended: e.end_by === 'playback_completion' };
}

/* ---------- the computer: a program and its arguments ---------- */
export interface Command { exe: string; args: string[]; /** mpv's JSON IPC: the shell puts its socket's path for ${ipc} */ ipc: boolean }
const secs = (s?: number) => (s && s > 0 ? String(Math.round(s * 10) / 10) : '');
const hms = (s: number) => { const t = Math.floor(s); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
export function desktopCommand(p: PlayerDef, r: Ready, exe: string, custom?: string): Command {
  const hd = lower(r.headers); const ua = hd['user-agent']; const ref = hd.referer; const others = Object.entries(r.headers ?? {}).filter(([k]) => !/^(user-agent|referer|range)$/i.test(k));
  const a: string[] = [];
  switch (p.id) {
    case 'mpv': case 'iina': {
      const o = (x: string) => (p.id === 'iina' ? `--mpv-${x.replace(/^--/, '')}` : x);
      if (p.id === 'iina') a.push('-w');                                   // (iina-cli waits until IINA is closed, so the end is seen)
      if (r.title) a.push(o(`--force-media-title=${r.title}`));
      if (r.start && r.start > 0) a.push(o(`--start=${secs(r.start)}`));
      for (const s of r.subs) a.push(o(`--sub-file=${s.at}`));
      const def = r.subs.findIndex((s) => s.isDefault); if (r.subs.length && def < 0) a.push(o('--sid=auto'));
      if (r.slang?.length) a.push(o(`--slang=${r.slang.join(',')}`));
      if (r.alang?.length) a.push(o(`--alang=${r.alang.join(',')}`));
      if (ua) a.push(o(`--user-agent=${ua}`));
      if (ref) a.push(o(`--referrer=${ref}`));
      for (const [k, v] of others) a.push(o(`--http-header-fields-append=${k}: ${v}`));
      if (p.id === 'mpv') a.push('--hwdec=auto-safe', '--input-ipc-server=${ipc}', '--idle=no', '--keep-open=no');
      a.push('--', r.target);
      return { exe, args: p.id === 'iina' ? a.filter((x) => x !== '--') : a, ipc: p.id === 'mpv' };
    }
    case 'vlc':
      if (r.title) a.push(`--meta-title=${r.title}`);
      if (r.start && r.start > 0) a.push(`--start-time=${secs(r.start)}`);
      if (r.subs[0]) a.push(`--sub-file=${(r.subs.find((s) => s.isDefault) ?? r.subs[0]).at}`);
      if (r.slang?.length) a.push(`--sub-language=${r.slang.join(',')}`);
      if (r.alang?.length) a.push(`--audio-language=${r.alang.join(',')}`);
      if (ua) a.push(`--http-user-agent=${ua}`);
      if (ref) a.push(`--http-referrer=${ref}`);
      a.push('--play-and-exit', '--no-one-instance', r.target);
      return { exe, args: a, ipc: false };
    case 'mpc-hc': case 'mpc-be':
      a.push(r.target, '/play', '/close');
      if (r.start && r.start > 0) a.push('/start', String(Math.round(r.start * 1000)));
      for (const s of r.subs) a.push('/sub', s.at);
      return { exe, args: a, ipc: false };
    case 'potplayer':
      a.push(r.target);
      if (r.start && r.start > 0) a.push(`/seek=${hms(r.start)}`);
      if (r.subs[0]) a.push(`/sub=${(r.subs.find((s) => s.isDefault) ?? r.subs[0]).at}`);
      if (ua) a.push(`/user_agent=${ua}`);
      if (ref) a.push(`/referer=${ref}`);
      return { exe, args: a, ipc: false };
    case 'custom': return customCommand(custom ?? '', r);
    default: return { exe, args: [r.target], ipc: false };
  }
}

/** A command of one's own: split like a shell would (quotes, backslash escapes), never given to one; each
 *  placeholder — {url} {title} {start} {startms} {sub} {ua} {referrer} {ipc} — filled inside its own argument. An
 *  argument whose placeholder has nothing to fill (no subtitle, no start) is left out, so «--sub-file={sub}» goes
 *  with no subtitle; with no {url} anywhere, the address comes last. */
export function customCommand(line: string, r: Ready): Command {
  const words = splitArgs(line); if (!words.length) return { exe: '', args: [], ipc: false };
  const hd = lower(r.headers); const def = r.subs.find((s) => s.isDefault) ?? r.subs[0];
  const vals: Record<string, string> = { url: r.target, title: r.title, start: secs(r.start), startms: r.start && r.start > 0 ? String(Math.round(r.start * 1000)) : '', sub: def?.at ?? '', ua: hd['user-agent'] ?? '', referrer: hd.referer ?? '', ipc: '${ipc}' };
  let hadUrl = false; let ipc = false; const out: string[] = [];
  for (const w of words.slice(1)) {
    let empty = false; let any = false;
    const filled = w.replace(/\{(url|title|start|startms|sub|ua|referrer|ipc)\}/g, (_m, k: string) => { any = true; if (k === 'url') hadUrl = true; if (k === 'ipc') ipc = true; const v = vals[k]; if (!v) empty = true; return v; });
    if (any && empty) continue; out.push(filled);
  }
  if (!hadUrl) out.push(r.target);
  return { exe: words[0], args: out, ipc };
}
export function splitArgs(line: string): string[] {
  const out: string[] = []; let cur = ''; let q: '"' | "'" | null = null; let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** «Watched»: played to the end, or past the share set in the player's preferences (90 % unless changed). */
export function isWatched(o: { pos?: number; dur?: number; ended?: boolean }, at = 90): boolean {
  if (o.ended) return true; if (!o.pos || !o.dur || o.dur <= 0) return false; return (o.pos / o.dur) * 100 >= at;
}
