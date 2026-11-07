// The files of a batch, before anything is downloaded (Seanime's analyzer, Senpwai's planner, Hayase's picker):
// the torrent's list read first, each file's episode found in its name, extras (openings and endings without
// credits, previews, menus, samples) told apart — the wanted episodes ticked, the rest left out — then changed by
// hand as you like, and only those downloaded.
import { h, icon, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { getEngine, isVideo } from '../engine';
import type { TaskSource, TorrentInfo } from '../engine/types';
import { parseFilename } from '../anime/anitomy';

export interface FileGuess { index: number; path: string; size: number; episode?: number; season?: number; video: boolean; extra: boolean; sub: boolean }
const EXTRA = /(^|[\s_.\-[(/])(nc(op|ed)\d*|creditless|op\d*|ed\d*|pv\d*|cm\d*|menu\d*|preview|trailer|teaser|sample|extras?|bonus|specials?|sp\d+|ova|oad|recap|scans?|featurettes?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|interviews?)(?=[\s_.\-\])/]|$)/i;
const HARD_EXTRA = /(^|[\s_.\-[(/])(nc(op|ed)\d*|creditless|pv\d*|cm\d*|menu\d*|preview|trailer|teaser|sample|featurettes?)(?=[\s_.\-\])/]|$)/i;
const SUB = /\.(ass|ssa|srt|vtt|sup|idx|sub)$/i;
/** Each file of a torrent: its episode (and season) from its name, whether it is a video, a subtitle or an extra. */
export function guess(info: TorrentInfo): FileGuess[] {
  return info.files.map((f) => {
    const name = f.path.split('/').pop() ?? f.path; const stem = name.replace(/\.[^.]+$/, ''); const p = parseFilename(name);
    // (A folder called «Extras» or «Specials», or a name like «NCOP1»: an extra — unless the name is clearly an
    // episode of the show and only the folder says otherwise, as «Season 1/Show - 03.mkv» under «Bonus».)
    const extra = HARD_EXTRA.test(stem) || (EXTRA.test(stem) && p.episode === undefined) || (EXTRA.test(f.path.slice(0, f.path.length - name.length)) && p.episode === undefined);
    let season = p.season; if (season === undefined) { const m = /(?:^|\/)(?:season|s)[ ._-]?(\d{1,2})(?:\/|$)/i.exec(f.path); if (m) season = Number(m[1]); }
    return { index: f.index, path: f.path, size: f.size, episode: p.episode, season, video: isVideo(f.path), extra, sub: SUB.test(f.path) };
  });
}
/** The files to keep for some episodes (a video of each, its subtitles beside it); none of them → null. */
export function filesFor(fs: FileGuess[], episodes: number[], season?: number): number[] | null {
  const want = new Set(episodes);
  const vids = fs.filter((f) => f.video && !f.extra && f.episode !== undefined && want.has(f.episode) && (season === undefined || f.season === undefined || f.season === season));
  if (!vids.length) return null;
  const stems = vids.map((f) => (f.path.split('/').pop() ?? f.path).replace(/\.[^.]+$/, '').toLowerCase());
  const subs = fs.filter((f) => f.sub && stems.some((s) => (f.path.split('/').pop() ?? '').toLowerCase().startsWith(s)));
  return [...vids, ...subs].map((f) => f.index);
}
/** The episodes' files, else (no episodes asked, or none found) everything but the extra videos. */
export function defaultPick(fs: FileGuess[], episodes: number[] = [], season?: number): number[] {
  const mains = fs.filter((f) => !(f.video && f.extra));
  return (episodes.length ? filesFor(fs, episodes, season) : null) ?? (mains.length ? mains : fs).map((f) => f.index);
}
/** The torrent's file list (its details fetched — up to a minute for a magnet). */
export async function torrentFiles(source: TaskSource): Promise<FileGuess[] | null> {
  const eng = getEngine(); if (!eng.torrentInfo || !(source.magnet || source.torrent)) return null;
  try { return guess(await eng.torrentInfo(source)); } catch { return null; }
}
/** Without asking: the episodes' files of a batch, when they can be told (null: download the whole). */
export async function smartFiles(source: TaskSource, episodes: number[], season?: number): Promise<number[] | null> {
  const fs = await torrentFiles(source); if (!fs || fs.length <= 1) return null;
  const r = filesFor(fs, episodes, season); return r && r.length < fs.length ? r : null;
}

/** The list with its quick choices (this episode, episodes only, all, none, a range), shared by the picker and
 *  the Add sheet; `changed` hears the ticked files. */
export function fileChooser(fs: FileGuess[], chosen: Set<number>, changed: () => void, episodes: number[] = [], season?: number): HTMLElement {
  const list = h('div', { class: 'file-rows' }); const tools = h('div', { class: 'chip-row wrap pick-tools' }); const total = h('p', { class: 'models-total' });
  // (Every file at once: ticked, unticked — partly ticked when some are.)
  const master = h('input', { type: 'checkbox', 'aria-label': t('pickAll'), onchange: () => set(() => master.checked) }) as HTMLInputElement;
  const masterRow = h('label', { class: 'check-row pick-master' }, master, h('b', { class: 'grow' }, t('pickAll')), h('small', { class: 'src' }, formatBytes(fs.reduce((n, f) => n + f.size, 0))));
  // (The release's own folder, shared by every file, is not repeated under each name.)
  const top = fs[0]?.path.includes('/') ? fs[0].path.slice(0, fs[0].path.indexOf('/') + 1) : '';
  const root = top && fs.every((f) => f.path.startsWith(top)) ? top.length : 0;
  const folderOf = (f: FileGuess) => { const d = f.path.slice(root); return d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ''; };
  const draw = () => {
    const order = [...fs].sort((a, b) => Number(b.video && !b.extra) - Number(a.video && !a.extra) || (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 1e9) - (b.episode ?? 1e9) || a.path.localeCompare(b.path, undefined, { numeric: true }));
    list.replaceChildren(...order.map((f) => {
      const tags = [f.season !== undefined && f.episode !== undefined ? `S${localDigits(f.season)} · ${t('episodeN', { n: localDigits(f.episode) })}` : f.episode !== undefined ? t('episodeN', { n: localDigits(f.episode) }) : '', f.extra ? t('pickExtra') : '', f.sub ? t('pickSub') : '', folderOf(f)].filter(Boolean).join(' · ');
      return h('label', { class: 'check-row file-row pick-row' + (chosen.has(f.index) ? ' on' : '') + (f.extra ? ' extra' : '') },
        h('input', { type: 'checkbox', checked: chosen.has(f.index), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(f.index); else chosen.delete(f.index); draw(); changed(); } }),
        h('span', { class: 'grow' }, h('span', { class: 'pick-name', dir: 'auto' }, f.path.split('/').pop()), tags ? h('small', { class: 'src', dir: 'auto' }, tags) : null),
        h('small', { class: 'src pick-size' }, formatBytes(f.size)));
    }));
    master.checked = chosen.size === fs.length; master.indeterminate = chosen.size > 0 && chosen.size < fs.length;
    const sel = fs.filter((f) => chosen.has(f.index)); total.textContent = `${t('selectedFiles', { n: localDigits(sel.length), total: localDigits(fs.length) })} · ${formatBytes(sel.reduce((n, f) => n + f.size, 0))}`;
  };
  const set = (pick: (f: FileGuess) => boolean) => { chosen.clear(); for (const f of fs) if (pick(f)) chosen.add(f.index); draw(); changed(); };
  const eps = [...new Set(fs.filter((f) => f.video && !f.extra && f.episode !== undefined).map((f) => f.episode!))].sort((a, b) => a - b);
  const chip = (label: string, fn: () => void) => h('button', { type: 'button', class: 'chip small', onclick: fn }, label);
  const mine = episodes.length ? filesFor(fs, episodes, season) : null;
  const num = (v: number) => h('input', { type: 'number', inputmode: 'numeric', min: String(eps[0]), max: String(eps[eps.length - 1]), value: String(v), class: 'num-small' }) as HTMLInputElement;
  const a = num(eps[0] ?? 1), b = num(eps[eps.length - 1] ?? 1);
  tools.append(
    ...(mine ? [chip(episodes.length === 1 ? t('pickThisEp', { n: localDigits(episodes[0]) }) : t('pickTheseEps'), () => set((f) => mine.includes(f.index)))] : []),
    ...(eps.length ? [chip(t('pickEpisodes'), () => set((f) => (f.video && !f.extra) || f.sub))] : []),
    chip(t('pickNone'), () => set(() => false)));
  const range = eps.length > 2 ? h('div', { class: 'pick-range' }, h('span', null, t('fromEpisode')), a, h('span', null, t('toEpisode')), b,
    h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const lo = Math.min(Number(a.value), Number(b.value)), hi = Math.max(Number(a.value), Number(b.value)); const r = filesFor(fs, eps.filter((e) => e >= lo && e <= hi), season) ?? []; set((f) => r.includes(f.index)); } }, t('pickRange'))) : null;
  draw();
  return h('div', { class: 'file-chooser' }, tools, range, masterRow, list, total);
}

/** The picker: what to download of a torrent — the files' indexes, «all» (one file, or no list to read), or null
 *  when cancelled. */
export async function pickFiles(source: TaskSource, title: string, episodes: number[] = [], season?: number): Promise<number[] | 'all' | null> {
  // (The list asked for at once; a torrent of one file — known within a moment — goes straight in, no sheet.)
  const files = torrentFiles(source); let early: FileGuess[] | null | undefined;
  await Promise.race([files.then((x) => { early = x; }), new Promise((r) => setTimeout(r, 400))]);
  if (early && early.length <= 1) return 'all';
  return new Promise((resolve) => {
    const sh = openSheet(title, t('close')); sh.el.classList.add('pick-files'); let done = false;
    const finish = (v: number[] | 'all' | null) => { if (done) return; done = true; obs.disconnect(); sh.close(); resolve(v); };
    const obs = new MutationObserver(() => { if (!sh.el.isConnected && !done) { done = true; obs.disconnect(); resolve(null); } }); obs.observe(document.body, { childList: true, subtree: true });
    const box = h('div', null, h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('fetchingMetadata')}`));
    // (While its list is fetched — a magnet with few peers can take a while —, the whole torrent can be started.)
    let action: () => void = () => finish('all');
    const go = h('button', { type: 'button', class: 'btn primary', onclick: () => action() }, icon('download'), h('span', null, t('pickWhole'))) as HTMLButtonElement;
    sh.body.append(h('p', { class: 'hint' }, t('pickHint')), box); sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => finish(null) }, t('cancel')), go);
    void files.then((fs) => {
      if (done) return;
      if (!fs) { box.replaceChildren(h('p', { class: 'empty small' }, t('pickNoList'))); return; }
      if (fs.length <= 1) { finish('all'); return; }
      const chosen = new Set(defaultPick(fs, episodes, season));
      const sync = () => { go.disabled = !chosen.size; go.lastChild!.textContent = chosen.size === fs.length ? t('pickWhole') : t('pickDownloadN', { n: localDigits(chosen.size) }); };
      box.replaceChildren(fileChooser(fs, chosen, sync, episodes, season)); sync();
      action = () => finish(chosen.size === fs.length ? 'all' : [...chosen].sort((x, y) => x - y));
    });
  });
}
