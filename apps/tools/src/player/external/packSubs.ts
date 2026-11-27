// The show's subtitle pack handed to another player along with the video: this episode's pick first (marked to show),
// its other candidates (other languages, other groups) and the best file of the episodes just before and after as
// further choices, for players whose launch takes a list (the phone's intent: subs / subs.name / subs.enable and
// subtitles_location; mpv: one --sub-file each). A folder's file goes by its path (the phone's loopback address, a
// computer's saved copy — run.ts's usual way); a file inside an archive or a phone's granted tree is read here: on a
// computer an in-page address the hand-over saves as a copy, on a phone a copy written into the show's own subtitles
// folder (a hidden «.kt-player» there — a place another app may read; the app's own folders are never shared).
// The pack's fonts folder goes to mpv when the fonts are in a folder. Loaded only for the outside way.
import type { Task } from '../../engine/types';
import { getSettings } from '../../settings';

type Meta = Task['meta'];
export interface PackHand { subs: { url: string; name: string; lang?: string; isDefault?: boolean }[]; fontsDir?: string; key: string; season?: number; episode: number; picked?: string }
const LAST = 'kt.tmp.extPackSub';

/** The pack's subtitles for the episode the meta names; null when the show has no pack (or it is off) or no file fits. */
export async function packForExternal(meta: Meta | undefined, name: string, platform: 'android' | 'desktop'): Promise<PackHand | null> {
  const PK = await import('../subPacks'); const { parseFilename } = await import('../../anime/anitomy'); const { langOfName } = await import('../subMatch');
  const parsed = parseFilename(name); const key = PK.showKey(meta ?? { title: parsed.title }); const p = PK.packOf(key);
  const episode = meta?.episode ?? parsed.episode; const season = meta?.season ?? parsed.season;
  if (!key || !p?.on || (episode === undefined && !p.movie)) return null;
  let scan: import('../subPacks').PackScan; try { scan = await PK.scanPack(p); } catch { return null; }
  const langs = getSettings().subLangs;
  const pick = p.movie ? PK.movieFileFor(p, scan, meta?.title ?? p.title ?? '', undefined, langs) : PK.fileFor(p, scan, PK.wantFor(p, season, episode!), langs, { videoName: name, titles: meta?.title ? [meta.title] : undefined });
  if (!pick.file) return null;
  const files: import('../subPacks').PackFile[] = [pick.file, ...pick.cands.filter((c) => c !== pick.file).slice(0, 3)];
  if (!p.movie) for (const e of [episode! - 1, episode! + 1, episode! + 2]) { if (e < 1) continue; const r = PK.fileFor(p, scan, PK.wantFor(p, season, e), langs, { videoName: name }); if (r.file && !files.includes(r.file)) files.push(r.file); }
  const out: PackHand['subs'] = [];
  for (const f of files.slice(0, 8)) {
    const base = f.path.split('/').pop() ?? f.path; let url = '';
    try {
      if (f.src.kind === 'folder') url = f.ref;
      else { const b = await PK.readPackFile(f); if (!b) continue; url = platform === 'android' ? await phoneCopy(meta?.title ?? p.title ?? parsed.title ?? 'Show', base, b) : URL.createObjectURL(new Blob([b as BlobPart], { type: 'text/plain' })); }
    } catch { continue; }
    if (url) out.push({ url, name: base, lang: langOfName(f.path), isDefault: f === pick.file });
  }
  if (!out.length) return null;
  const fontDir = scan.fonts.find((x) => x.src.kind === 'folder')?.ref.replace(/[\\/][^\\/]*$/, '');
  return { subs: out, fontsDir: platform === 'desktop' ? fontDir : undefined, key, season, episode: episode ?? 0, picked: out[0]?.name };
}
async function phoneCopy(title: string, name: string, bytes: Uint8Array): Promise<string> {
  const PK = await import('../subPacks'); const { decodeSubtitle } = await import('../subs');
  const dir = `${await PK.showFolder(title)}/.kt-player`;
  const { ktPlugin } = await import('../../native'); await (ktPlugin() as unknown as { filesMkdir?(o: { path: string }): Promise<unknown> } | null)?.filesMkdir?.({ path: dir }).catch(() => undefined);
  return PK.writeSubText(dir, name, decodeSubtitle(bytes));
}
/** What went along last (for «Wrong subtitle?» once back). */
export function noteHanded(h: PackHand): void { try { localStorage.setItem(LAST, JSON.stringify({ key: h.key, season: h.season, episode: h.episode, name: h.picked, at: Date.now() })); } catch { /* full */ } }
export function lastHanded(): { key: string; season?: number; episode: number; name?: string; at: number } | null {
  try { const x = JSON.parse(localStorage.getItem(LAST) ?? 'null'); return x && Date.now() - x.at < 12 * 3600e3 ? x : null; } catch { return null; }
}
/** The pack's chooser for an episode (a hand pick counts as a correction); `done` after the choice. */
export async function chooseForEpisode(key: string, season: number | undefined, episode: number, done?: (name: string | null) => void): Promise<boolean> {
  const PK = await import('../subPacks'); const p = PK.packOf(key); if (!p) return false;
  let scan: import('../subPacks').PackScan; try { scan = await PK.scanPack(p); } catch { return false; }
  const want = PK.wantFor(p, season, episode); const r = PK.fileFor(p, scan, want, getSettings().subLangs);
  const { chooseFileSheet, pickedByHand } = await import('../../views/subPackSheet');
  chooseFileSheet(scan, want, r.manual, r.file, (f) => { pickedByHand(key, want, f); done?.(f ? f.path.split('/').pop() ?? f.path : null); });
  return true;
}
