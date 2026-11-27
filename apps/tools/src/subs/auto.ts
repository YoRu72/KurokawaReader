// «Find subtitles automatically» (off until the user turns it on): when an episode opens with no subtitle of its own
// in the user's languages and none from the show's pack, the installed subtitle sources (whatever add-ons of kind
// `subtitle-source` are installed, less those switched off for this) are asked in the background, the results ranked
// as the player's search ranks them (./search rankForEpisode: this episode, the languages in the user's order, the
// video's group, the kind) and the best applied only when it is confident: this very episode, not a partial one, in
// one of the user's languages (unless «Only my languages» is off) — a season's archive goes through the pack matcher
// (../player/subMatch rankFiles) and counts only when that is no guess. Two close ones of the same language: their
// cue spans against the video's length decide. The language order is honoured: a later language only when no earlier
// one has a confident match. On a phone, «Wi-Fi only» (on unless turned off) waits for a connection that is not
// metered. Loaded only when the switch is on.
import { getSettings } from '../settings';
import { getPrefs } from '../player/prefs';
import { nativePlatform } from '../native';
import type { SubQuery, SubResult, RankedSub } from './search';

/** The score a result must reach (this episode, 100, and a language on the list, 20 or more). */
export const AUTO_FLOOR = 120;
export const autoOn = (): boolean => !!getPrefs().autoSubs && getSettings().addons.includes('subtitles');
/** A phone on a metered (or mobile) connection with «Wi-Fi only» on: not now. */
export async function networkAllows(): Promise<boolean> {
  if (nativePlatform() !== 'android' || getSettings().subAutoWifi === false) return true;
  const { metered } = await import('../liveUpdates'); const c = (navigator as unknown as { connection?: { type?: string } }).connection;
  return !metered() && c?.type !== 'cellular';
}
export interface AutoFile { name: string; bytes: Uint8Array }
export interface AutoResult { applied?: { r: SubResult; file: AutoFile; files: AutoFile[] }; cands: RankedSub[]; errors: string[]; sources: number; query?: SubQuery }
export interface AutoAsk { title: string; anilistId?: number; imdbId?: string; season?: number; episode?: number; videoName?: string; duration?: number; stop: () => boolean }

/** One background search for the episode; never throws (errors are in the result). */
export async function autoFind(o: AutoAsk): Promise<AutoResult> {
  const out: AutoResult = { cands: [], errors: [], sources: 0 };
  try {
    const S = await import('./search'); const { lookup, enrich } = await import('./lookup');
    const off = new Set(getSettings().subAutoOff ?? []); const only = (a: { id: string }) => !off.has(a.id);
    const srcs = (await S.subtitleSources()).filter(only); out.sources = srcs.length; if (!srcs.length || o.stop()) return out;
    const cards = o.anilistId ? await lookup(`anilist:${o.anilistId}`) : o.imdbId ? await lookup(o.imdbId) : await lookup(o.title); if (!cards.length || o.stop()) return out;
    const c = await enrich(cards[0]); if (o.stop()) return out;
    const langs = getSettings().subLangs; const query = S.queryFor(c, o.season, o.episode, langs); out.query = query;
    const found = await S.searchSubtitles(query, (a, res) => { if (res instanceof Error) out.errors.push(`${a.name}: ${res.message.replace(/^[^:]*:\s*/, '')}`); }, only);
    if (o.stop()) return out;
    out.cands = await S.rankForEpisode(found, { langs, episode: o.episode, season: o.season, videoName: o.videoName });
    out.applied = await choose(out.cands, query, o, langs);
  } catch (e) { out.errors.push(String((e as Error)?.message ?? e)); }
  return out;
}
const langOf = (x: RankedSub, M: typeof import('../player/subMatch')) => x.r.language ?? M.langOfName(x.r.title);
async function choose(cands: RankedSub[], query: SubQuery, o: AutoAsk, langs: string[]): Promise<AutoResult['applied']> {
  const M = await import('../player/subMatch'); const { fetchResult } = await import('./findSheet');
  const mine = getSettings().subAutoOnly !== false;
  const li = (x: RankedSub) => { const l = langOf(x, M); const i = l ? langs.indexOf(l) : -1; return i < 0 ? (mine ? -1 : langs.length) : i; };
  // (Each language in the user's order; the next only when this one has nothing confident.)
  const order = [...new Set(cands.map(li).filter((i) => i >= 0))].sort((a, b) => a - b);
  for (const L of order) {
    const sure = cands.filter((x) => li(x) === L && !x.pack && !x.r.partial && (o.episode === undefined || (x.r.episode ?? M.subEpisode(`${x.r.title}.srt`).episode) === o.episode) && x.score >= AUTO_FLOOR - (L >= langs.length ? 60 : 0));
    if (sure.length) {
      const close = sure.filter((x) => x.score >= sure[0].score - 5).slice(0, 2); let best: AutoResult['applied'];
      for (const x of close) {
        if (o.stop()) return undefined;
        let files: AutoFile[]; try { files = await fetchResult(x.r, query); } catch { continue; } if (!files.length) continue;
        const f = files[0];
        if (close.length > 1 && o.duration) { const sp = M.cueSpan(new TextDecoder().decode(f.bytes)); const bad = sp && (sp.last - o.duration > Math.max(120, o.duration * 0.1) || sp.last < o.duration * 0.6); if (bad) { best ??= undefined; continue; } }
        best = { r: x.r, file: f, files }; break;
      }
      if (best) return best;
    }
    // (A season's archive in this language: its files matched like a pack's; only a match that is no guess.)
    if (o.episode !== undefined) for (const x of cands.filter((y) => li(y) === L && y.pack).slice(0, 2)) {
      if (o.stop()) return undefined;
      let files: AutoFile[]; try { files = await fetchResult(x.r, query); } catch { continue; }
      const ranked = M.rankFiles(files.map((f) => ({ path: f.name })), { episode: o.episode, season: o.season, langs, videoName: o.videoName });
      const top = ranked[0]; if (top && !top.guess) { const f = files.find((g) => g.name === top.file.path)!; return { r: x.r, file: f, files }; }
    }
  }
  return undefined;
}
