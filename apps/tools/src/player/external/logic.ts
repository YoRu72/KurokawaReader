// Another app plays the video — the plain part, with no page and no shell, so tests run it as it is.
// The person sees two ways only: the app's own player, and one outside way — «Another app» on a phone (the phone's
// own list of apps), «A player on this PC» on a computer (the first known player found, one of them, or a program
// the person picked). What the app knows of players stays inside:
//   · on a phone, one intent carries the union of the documented extras of VLC, MX Player, mpv-android and Just
//     Player (title, start, subtitles, the result asked for), and whichever known answer comes back is read;
//   · on a computer, the shell holds the table of players and builds their arguments (desktop/extcmd.cjs and its
//     Rust twin); here only what each can take, to plan the hand-over: headers on its own command line or through
//     the app's relay, subtitles by address or saved to a file, whether it tells where it stopped.

export type Platform = 'android' | 'win' | 'mac' | 'linux';
/** Where a video comes from, for the default way of each («per kind of video» in Settings → Player). */
export type Service = 'torrent' | 'online' | 'http' | 'local';
export const SERVICES: Service[] = ['torrent', 'online', 'http', 'local'];
/** A default: ask, the app's own player, or the outside way. (Older values — a player's id — count as outside.) */
export type Way = 'ask' | 'app' | 'out';
export const wayOf = (v: string | undefined): Way => (v === 'app' ? 'app' : v === 'ask' || !v ? 'ask' : 'out');

export interface ExtSub { url?: string; path?: string; name: string; lang?: string; isDefault?: boolean; headers?: Record<string, string> }
export interface ExtSource {
  /** What the in-app player would open: a remote address, the app's stream on 127.0.0.1, or a local file's address. */
  url: string; name: string; localPath?: string; headers?: Record<string, string>; hls?: boolean;
  subs?: ExtSub[]; /** seconds */ start?: number; alang?: string[]; slang?: string[];
}
/** What a computer's player can take (desktop/extcmd.cjs's table; the chosen program by its arguments line). */
export interface Caps { id: string; name: string; /** what may go on its command line: User-Agent and Referer, or nothing */ headers: 'ua-ref' | 'none'; hls: boolean; subs: 'url' | 'path'; reports: boolean }
export const PC_PLAYERS: Caps[] = [
  { id: 'mpv', name: 'mpv', headers: 'ua-ref', hls: true, subs: 'url', reports: true },
  { id: 'vlc', name: 'VLC', headers: 'ua-ref', hls: true, subs: 'path', reports: false },
  { id: 'iina', name: 'IINA', headers: 'ua-ref', hls: true, subs: 'url', reports: false },
  { id: 'mpc-hc', name: 'MPC-HC', headers: 'none', hls: false, subs: 'path', reports: false },
  { id: 'mpc-be', name: 'MPC-BE', headers: 'none', hls: false, subs: 'path', reports: false },
  // (PotPlayer's header switches are not documented well enough to rely on: the relay.)
  { id: 'potplayer', name: 'PotPlayer', headers: 'none', hls: true, subs: 'path', reports: false },
];
export const pcCaps = (id: string): Caps | undefined => PC_PLAYERS.find((p) => p.id === id);
/** The program the person picked: User-Agent and Referer only when its arguments line places both, else the relay. */
export function chosenCaps(args: string, name: string): Caps { return { id: 'chosen', name, headers: /\{ua\}/.test(args) && /\{referrer\}/.test(args) ? 'ua-ref' : 'none', hls: true, subs: 'path', reports: false }; }
/** «Automatic»: the first known player found, in the shell's order. */
export function autoPick(found: { id: string }[]): Caps | undefined { for (const p of PC_PLAYERS) if (found.some((f) => f.id === p.id)) return p; return undefined; }

/** Which kind of source a video is. */
export function serviceOf(o: { taskKind?: string; localPath?: string; headers?: Record<string, string>; online?: boolean }): Service {
  if (o.taskKind === 'torrent') return 'torrent';
  if (o.localPath) return 'local';
  if (o.online || (o.headers && Object.keys(o.headers).length)) return 'online';
  return 'http';
}

const lower = (h?: Record<string, string>) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
export const isLoopback = (u: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(u);
export const isHttp = (u: string | undefined): boolean => !!u && /^https?:\/\//i.test(u);

export type How = 'direct' | 'relay' | 'path' | 'temp' | 'drop';
export interface Plan { main: How; /** the headers go on the program's command line */ headerArgs: boolean; subs: How[]; relay: boolean; problem?: 'hls' }
/** How a source reaches the player.
 *  Phone: a file by its path (FileProvider), a plain or loopback address as it is, anything with headers through the
 *  relay; a site's subtitles through the relay, the app's own (loopback) as they are.
 *  Computer: a file, or the app's own loopback address (a torrent), through a relay session of its own; the app's own
 *  loopback subtitles saved as a copy; headers on the command line
 *  where the player takes them, else the relay; a player that does not tell where it stopped always reads through the
 *  relay, so the app sees when it has stopped reading (some hand the address to an instance already open and exit). */
export function plan(src: ExtSource, plat: Platform, caps?: Caps): Plan {
  const hd = lower(src.headers); const keys = Object.keys(hd).filter((k) => k !== 'range');
  const onlyUaRef = keys.every((k) => k === 'user-agent' || k === 'referer');
  if (plat === 'android') {
    const main: How = src.localPath ? 'path' : !keys.length || isLoopback(src.url) ? 'direct' : 'relay';
    const subs = (src.subs ?? []).map((s): How => (s.path ? (/^\/data\//.test(s.path) ? 'drop' : 'direct') : isLoopback(s.url ?? '') ? 'direct' : isHttp(s.url) ? 'relay' : 'drop'));
    return { main, headerArgs: false, subs, relay: main === 'relay' || subs.includes('relay') };
  }
  const c = caps ?? PC_PLAYERS[0];
  let main: How; let headerArgs = false;
  // (Only User-Agent and Referer ever go on a command line: a cookie or an authorisation there would reach every host
  // the player opens, and other programs can read it. Anything else goes through the relay, to the source's origin only.
  // A file on this computer, and any address of the app's own server on 127.0.0.1 — a torrent being watched —, go
  // through a relay session of their own: the run's own token never leaves the app.)
  if (src.localPath || isLoopback(src.url)) main = 'relay';
  else if (!c.reports) main = 'relay';
  else if (!keys.length) main = 'direct';
  else if (c.headers === 'ua-ref' && onlyUaRef) { main = 'direct'; headerArgs = true; }
  else main = 'relay';
  const subs = (src.subs ?? []).map((s): How => {
    // (The app's own subtitles on 127.0.0.1 are read here and saved as a copy: their address carries the run's token.)
    if (c.subs === 'path' || s.path || isLoopback(s.url ?? '')) return 'temp';
    return s.headers && Object.keys(s.headers).length && !isLoopback(s.url ?? '') ? 'relay' : 'direct';
  });
  return { main, headerArgs, subs, relay: main === 'relay' || subs.includes('relay'), problem: src.hls && !c.hls ? 'hls' : undefined };
}

/* ---------- the phone: one intent, the union of the known players' extras ---------- */
export type Extra = { k: string; t: 's' | 'i' | 'l' | 'b' | 'sa' | 'ua'; v: string | number | boolean | string[] };
export interface AndroidIntent { data: string; path?: string; mime: string; title: string; extras: Extra[] }
export interface Ready { target: string; isPath: boolean; title: string; start?: number; subs: { at: string; name: string; isDefault?: boolean }[] }
/** VLC («Intent API»), MX Player («API»), mpv-android and Just Player (which follows MX's): title; position as int ms
 *  (MX, mpv, Just; VLC reads an int too); from_start false; subtitles as Uri[] with names and the one to show, and
 *  VLC's single subtitles_location; return_result. Headers never ride along: a source that needs them comes through
 *  the relay. */
export function androidIntent(r: Ready): AndroidIntent {
  const ms = r.start && r.start > 0 ? Math.round(r.start * 1000) : 0;
  const subs = r.subs.map((s) => s.at); const on = r.subs.filter((s) => s.isDefault).map((s) => s.at);
  const ex: Extra[] = [{ k: 'title', t: 's', v: r.title }, { k: 'return_result', t: 'b', v: true }];
  if (ms) ex.push({ k: 'position', t: 'i', v: ms }, { k: 'from_start', t: 'b', v: false });
  if (subs.length) ex.push({ k: 'subs', t: 'ua', v: subs }, { k: 'subs.name', t: 'sa', v: r.subs.map((s) => s.name) }, { k: 'subs.enable', t: 'ua', v: on.length ? on : [subs[0]] }, { k: 'subtitles_location', t: 's', v: on[0] ?? subs[0] });
  return { data: r.isPath ? '' : r.target, path: r.isPath ? r.target : undefined, mime: /\.m3u8(\?|$)/i.test(r.target) ? 'application/x-mpegURL' : 'video/*', title: r.title, extras: ex };
}
const RESULT_OK = -1;
/** Whatever known answer came back: VLC's extra_position / extra_duration; MX's and Just Player's position /
 *  duration / end_by; mpv-android's position / duration — and mpv-android's plain «OK» with nothing when it played to
 *  the end. Seconds. `told` false: nothing known came back. */
export function androidResult(res: { code?: number; action?: string; extras?: Record<string, unknown> | null } | null | undefined): { pos?: number; dur?: number; ended: boolean; told: boolean } {
  const e = res?.extras ?? {}; const num = (k: string) => { const v = e[k]; return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v / 1000 : undefined; };
  if (num('extra_position') !== undefined || num('extra_duration') !== undefined) return { pos: num('extra_position'), dur: num('extra_duration'), ended: false, told: true };
  if (num('position') !== undefined || num('duration') !== undefined || typeof e.end_by === 'string') return { pos: num('position'), dur: num('duration'), ended: e.end_by === 'playback_completion', told: true };
  if (res?.code === RESULT_OK && /^is\.xyz\.mpv\b/.test(res.action ?? '')) return { ended: true, told: true };
  return { ended: false, told: false };
}

/** «Watched»: played to the end, or past the share set in the player's preferences (90 % unless changed). */
export function isWatched(o: { pos?: number; dur?: number; ended?: boolean }, at = 90): boolean {
  if (o.ended) return true; if (!o.pos || !o.dur || o.dur <= 0) return false; return (o.pos / o.dur) * 100 >= at;
}
