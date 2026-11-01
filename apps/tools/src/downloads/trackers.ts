// Public trackers for torrents (the engine adds them to every public torrent, never to a private one): the list
// kept fresh from ngosang's trackerslist — the trackers that answer, checked daily —, read here once a day and
// handed to the phone's engine, which keeps a list of its own until then. More trackers, peers sooner: a magnet's
// details come in seconds instead of minutes.
import { request } from '../http';
import { getSettings } from '../settings';
import { ktPlugin } from '../native';

const KEY = 'kt.trackers'; const DAY = 86400000;
const URL_BEST = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
export const parseTrackers = (text: string): string[] => [...new Set(text.split(/\s+/).map((x) => x.trim()).filter((x) => /^(udp|https?|wss?):\/\/[^\s/]+(:\d+)?\/\S*$/i.test(x)))].slice(0, 60);
function cached(): { at: number; list: string[] } | null { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } }
/** At the start (the phone): the list handed over, refreshed first when a day old. */
export async function startTrackers(): Promise<void> {
  const p = ktPlugin(); if (!p) return;
  let c = cached();
  if (!c || Date.now() - c.at > DAY) {
    try { const r = await request(URL_BEST); if (r.status === 200) { const list = parseTrackers(r.body); if (list.length >= 5) { c = { at: Date.now(), list }; try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* full */ } } } } catch { /* offline: the last list, or the engine's own */ }
  }
  const on = getSettings().torrent.addTrackers !== false;
  await p.configure({ addTrackers: on, ...(c?.list.length ? { trackers: c.list } : {}) } as never).catch(() => undefined);
}
