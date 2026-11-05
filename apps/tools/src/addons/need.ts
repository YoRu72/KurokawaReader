// When something needs an add-on that is not installed — a video page without the Video add-on, Play without the
// Player, an archive without Archives, an AniList link without Anime — the download card offers it at once: its
// name, what it is needed for, how much it will download (its packs included), and «Get it» with the progress in
// the same card. Then whatever asked carries on.
import { getCard } from '../ui/getCard';
import { t, getLang } from '../i18n';
import { toast } from '../ui/dom';
import { loadIndex, install, installed, nameOf, type AddonEntry } from '../addons';

const ICON: Record<string, string> = { video: 'film', player: 'play', archives: 'archive', files: 'folder', anime: 'tv', subtitles: 'subtitles', debrid: 'cloud', 'torrent-search': 'search' };

/** True once the add-on is here (it already was, or it was just installed); false when declined. */
export async function needAddon(id: string, why: string, opts: { start?: boolean } = {}): Promise<boolean> {
  if (installed(id)) return true;
  let e: AddonEntry | undefined;
  try { e = (await loadIndex()).addons.find((a) => a.id === id); } catch (er) { toast(String((er as Error).message ?? er), 'error'); return false; }
  if (!e) return false;
  const name = nameOf(e, getLang());
  const { packsToFetch, fetchPacks, cancelPack, packLabel } = await import('../packs');
  let packs: Awaited<ReturnType<typeof packsToFetch>> = [];
  try { packs = await packsToFetch(e.packs ?? []); } catch { /* offline: the add-on's install will say */ }
  const ok = await getCard({
    icon: ICON[e.kind] ?? ICON[id] ?? 'puzzle', title: t('addonNeededTitle', { name }), why,
    steps: [{ label: t('addonNeededStep', { name }) }, ...packs.map((x) => ({ label: packLabel(x.n), size: x.e.size }))],
    async run(progress) {
      if (packs.length) await fetchPacks(packs, (i, d, tt) => progress(i + 1, d, tt));
      progress(0, 0, 0); await install(id); progress(0, 1, 1);
    },
    cancel: cancelPack, start: opts.start,
  });
  if (ok) toast(t('addonInstalledToast', { name }));
  return ok;
}
