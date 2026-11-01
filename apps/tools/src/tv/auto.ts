// Followed series: every aired episode past the last one fetched is looked for on Torrentio and added in the
// wanted quality (only that episode's file from a season pack); one not out yet in a usable form waits for the
// next check. Checked shortly after the app opens and every hour.
import { toast } from '../ui/dom';
import { t } from '../i18n';
import { getEngine } from '../engine';
import { magnetOf } from '../anime/providers';
import { follows, saveFollow, type Follow } from './library';
import { meta, aired } from './cinemeta';
import { streams, bestOf, tvPrefs } from './torrentio';

let busy = false;
export async function checkFollows(quiet = true): Promise<number> {
  if (busy) return 0; busy = true; let n = 0;
  try {
    for (const f of follows().filter((x) => x.enabled)) {
      let m; try { m = await meta('series', f.id); } catch { continue; }
      let next: Follow = { ...f };
      for (const v of (m.videos ?? []).filter((x) => x.season > 0 && (x.season > f.season || (x.season === f.season && x.episode >= f.episode)) && aired(x))) {
        const rs = await streams('series', `${f.id}:${v.season}:${v.episode}`).catch(() => []);
        const best = bestOf(rs, { ...tvPrefs(), quality: (f.quality || tvPrefs().quality) as '1080' });
        if (!best) break;
        await getEngine().add({ source: best.url ? { url: best.url } : { magnet: magnetOf(best) }, name: best.url ? best.title : undefined, sequential: !!best.url, files: !best.url && best.fileIdx !== undefined ? [best.fileIdx] : undefined, meta: { imdbId: f.id, title: m.name, season: v.season, episode: v.episode, cover: m.poster, provider: best.provider, hash: best.hash, fileIdx: best.fileIdx } });
        n++; toast(t('tvAutoAdded', { title: m.name, s: v.season, e: v.episode }));
        next = { ...next, season: v.season, episode: v.episode + 1 };
      }
      saveFollow({ ...next, at: Date.now() });
    }
  } finally { busy = false; }
  if (!quiet && !n) toast(t('autoNothingNew'));
  return n;
}
let timer = 0;
export function startTvAuto(): void { window.clearInterval(timer); if (!follows().some((f) => f.enabled)) return; setTimeout(() => void checkFollows(), 40000); timer = window.setInterval(() => void checkFollows(), 60 * 60000); }
