// What a settings backup, an import or the hand-over between the computer's two builds may bring in: never a program
// to run nor its arguments. The player on this computer and its arguments line live in the shell's own data folder
// (desktop/extplayer.cjs, extplayer.rs), chosen there through its own dialog; the page's settings only say «ask»,
// «the app's own player» or «the outside way» for each kind of video. Older or hand-made settings that name a program
// or carry arguments (`extCustom`, a player's id or «custom» as a default) are cleaned on the way in.
const WAYS = new Set(['ask', 'app', 'out']);
/** `value` of storage key `key` made safe to write (unchanged for any other key, or when it is not JSON). */
export function safeStored(key: string, value: string): string {
  if (key !== 'kt.settings') return value;
  let s: Record<string, unknown>; try { s = JSON.parse(value) as Record<string, unknown>; } catch { return value; }
  if (!s || typeof s !== 'object') return value;
  delete s.extCustom; delete s.extArgs; delete s.extProgram;
  if (typeof s.extPcPlayer === 'string' && !/^(auto|chosen|mpv|vlc|iina|mpc-hc|mpc-be|potplayer)$/.test(s.extPcPlayer)) delete s.extPcPlayer;
  const ep = s.extPlayers as Record<string, Record<string, unknown>> | undefined;
  if (ep && typeof ep === 'object') {
    const out: Record<string, Record<string, string>> = {};
    for (const side of ['android', 'desktop']) { const m = ep[side]; if (!m || typeof m !== 'object') continue; out[side] = {}; for (const kind of ['torrent', 'online', 'http', 'local']) { const v = m[kind]; if (typeof v === 'string') out[side][kind] = WAYS.has(v) ? v : 'ask'; } }
    s.extPlayers = out;
  }
  return JSON.stringify(s);
}
