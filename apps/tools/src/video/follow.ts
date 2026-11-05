// Followed channels and playlists: each looked at now and then (yt-dlp's flat listing), its new videos either
// added on their own — the preferred quality, into the follow's folder — or counted and told; a download archive
// (what was already taken, by site and id) keeps a video from coming twice, however many follows list it.
import { getSettings, updateSettings } from '../settings';
import { getEngine } from '../engine';
import { pageInfo, videoEnabled } from './ytdlp';
import { t } from '../i18n';
import { toast } from '../ui/dom';

export interface Follow { id: string; url: string; title: string; /** Hours between looks. */ every: number; lastAt?: number; /** The ids seen at the last look (the first look only seeds: nothing is downloaded from the past). */ seen: string[]; auto: boolean; dir?: string; /** How many new ones at most per look (the rest wait). */ max: number; newCount?: number; error?: string; checking?: boolean }
const KEY = 'kt.follows'; const ARCHIVE = 'kt.videoArchive';
export const follows = (): Follow[] => { try { const a = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Follow[]; return Array.isArray(a) ? a : []; } catch { return []; } };
export const saveFollows = (a: Follow[]): void => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* none */ } listeners.forEach((f) => f()); };
const listeners = new Set<() => void>(); export const onFollowsChange = (f: () => void): (() => void) => { listeners.add(f); return () => listeners.delete(f); };
/** The download archive: «site:id» of every video added by a follow, or by hand through the video card. */
export const archive = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(ARCHIVE) ?? '[]') as string[]); } catch { return new Set(); } };
export const remember = (keys: string[]): void => { const a = archive(); for (const k of keys) a.add(k); const list = [...a]; try { localStorage.setItem(ARCHIVE, JSON.stringify(list.slice(-5000))); } catch { /* none */ } };
export const archiveKey = (site: string | undefined, id: string | undefined, url: string): string => (site && id ? `${site.toLowerCase()}:${id}` : url);

export function newFollow(url: string, title = ''): Follow { return { id: Math.random().toString(36).slice(2, 10), url, title: title || url, every: 6, seen: [], auto: false, max: 5 }; }
/** One follow looked at: new entries found, added or counted. Returns how many were new. */
export async function check(f: Follow, force = false): Promise<number> {
  if (!videoEnabled()) return 0;
  const all = follows(); const me = all.find((x) => x.id === f.id) ?? f; me.checking = true; me.error = undefined; saveFollows(all);
  try {
    const info = await pageInfo(me.url, true);
    const entries = info.kind === 'playlist' ? info.entries.filter((e) => e.url) : [{ url: info.url, title: info.title, id: info.id }];
    if (info.kind === 'playlist' && info.title && (me.title === me.url || !me.title)) me.title = info.title;
    const keyOf = (e: { id?: string; url: string }) => e.id ?? e.url; const arc = archive();
    const first = !me.lastAt && !force; const seen = new Set(me.seen);
    const fresh = entries.filter((e) => !seen.has(keyOf(e)) && !arc.has(archiveKey(info.kind === 'playlist' ? undefined : info.site, e.id, e.url)));
    me.seen = entries.map(keyOf).slice(0, 500); me.lastAt = Date.now();
    if (first) { me.newCount = 0; saveFollows(all); return 0; }
    let n = 0;
    if (me.auto) {
      const { preferredFormat } = await import('../views/addVideo'); const s = getSettings(); const eng = getEngine();
      for (const e of fresh.slice(0, Math.max(1, me.max))) { try { const pf = preferredFormat(); await eng.add({ source: { url: e.url }, dir: me.dir || s.downloadDir || undefined, video: { ...pf, container: pf.audioOnly ? undefined : s.videoContainer, embedThumb: s.videoEmbedThumb, sponsorblock: s.videoSponsor, title: e.title } }); remember([archiveKey(undefined, e.id, e.url)]); n++; } catch { /* the next */ } }
      me.newCount = Math.max(0, fresh.length - n);
    } else { n = fresh.length; me.newCount = (me.newCount ?? 0) + fresh.length; }
    saveFollows(all); return n;
  } catch (e) { me.error = String((e as Error).message ?? e).slice(0, 200); saveFollows(all); return 0; }
  finally { const again = follows(); const m2 = again.find((x) => x.id === me.id); if (m2) { m2.checking = false; saveFollows(again); } }
}
let ticking = false;
/** The follows that are due looked at, one after another; what was found said once. */
export async function tick(force = false): Promise<void> {
  if (ticking || !videoEnabled()) return; ticking = true;
  try {
    const due = follows().filter((f) => force || !f.lastAt || Date.now() - f.lastAt >= f.every * 3600e3);
    let added = 0, waiting = 0;
    for (const f of due) { const n = await check(f, force); if (f.auto) added += n; else waiting += n; }
    if (added) toast(t('followAdded', { n: String(added) })); if (waiting) toast(t('followNew', { n: String(waiting) }));
  } finally { ticking = false; }
}
export const unfollow = (id: string): void => saveFollows(follows().filter((f) => f.id !== id));
export const setFollow = (id: string, patch: Partial<Follow>): void => { const a = follows(); const f = a.find((x) => x.id === id); if (f) Object.assign(f, patch); saveFollows(a); };
void updateSettings;
