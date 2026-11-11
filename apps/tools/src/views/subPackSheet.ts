// A show's subtitles, from its page (anime and TV): the subtitle pack assigned to it — a folder or an archive —,
// the file each episode gets from it (changed by hand there), the episodes it lacks, and «Find subtitles», whose
// result is saved into the show's own subtitles folder and added to its pack, so it is there when the episode plays.
// The file list and the hand-picked file (with the shift it implies offered for the rest) are the player's too.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getSettings } from '../settings';
import * as PK from '../player/subPacks';
import { matchEpisode, covered, impliedShift, type Want } from '../player/subMatch';

const fmtEp = (season: number | undefined, e: number) => (season !== undefined ? `S${localDigits(String(season).padStart(2, '0'))}E${localDigits(String(e).padStart(2, '0'))}` : localDigits(e));
const shiftText = (n: number) => `${n > 0 ? '+' : '−'}${localDigits(Math.abs(n))}`;
const baseOf = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Every subtitle file of the pack, the ones matching this episode first, a filter when there are many; tapping one
 *  hands it back, «Back to automatic» hands back null. */
export function chooseFileSheet(scan: PK.PackScan, want: Want, manual: boolean, current: PK.PackFile | undefined, onPick: (f: PK.PackFile | null) => void): void {
  const sh = openSheet(t('packChoose'), t('close'), { stack: true }); sh.el.classList.add('pack-files');
  const match = new Set(matchEpisode(scan.files, want).concat(matchEpisode(scan.files, { episode: want.episode, season: want.season })));
  const sorted = [...scan.files].sort((a, b) => Number(match.has(b)) - Number(match.has(a)) || a.path.localeCompare(b.path, undefined, { numeric: true }));
  const list = h('div', { class: 'dest-list' }); const q = h('input', { type: 'search', class: 'search-input', dir: 'auto', placeholder: t('packFilter'), oninput: () => draw() }) as HTMLInputElement;
  const row = (f: PK.PackFile) => h('button', { type: 'button', class: 'dest-row pack-file' + (f === current ? ' on' : ''), onclick: () => { sh.close(); onPick(f); } }, icon(match.has(f) ? 'subtitles' : 'file'), h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, baseOf(f.path)), f.path.includes('/') ? h('small', { class: 'src', dir: 'auto' }, f.path.replace(/\/[^/]*$/, '')) : null), f.episode !== undefined && !f.batch ? h('span', { class: 'chip small' + (match.has(f) ? ' on' : '') }, fmtEp(f.season, f.episode)) : null);
  const draw = () => {
    const w = q.value.trim().toLowerCase(); const shown = sorted.filter((f) => !w || f.path.toLowerCase().includes(w)).slice(0, 400);
    const m = shown.filter((f) => match.has(f)), o = shown.filter((f) => !match.has(f));
    list.replaceChildren(...(m.length ? [h('h4', null, t('packMatching')), ...m.map(row)] : []), ...(o.length ? [h('h4', null, t('packOthers')), ...o.map(row)] : []), ...(shown.length ? [] : [h('p', { class: 'empty small' }, t('noResults'))]));
  };
  sh.body.append(...(manual ? [h('button', { type: 'button', class: 'dest-row primary pack-auto', onclick: () => { sh.close(); onPick(null); } }, icon('undo'), h('span', { class: 'grow' }, t('packAuto')))] : []), ...(scan.files.length > 12 ? [q] : []), list);
  draw();
}
/** A file chosen by hand for an episode: kept for it (null: back to automatic); the shift it implies offered for the
 *  show's other episodes, once, in a toast. */
export function pickedByHand(key: string, want: Want, f: PK.PackFile | null): boolean {
  PK.setManual(key, want.season, want.episode, f); if (!f) return false;
  const p = PK.packOf(key); const d = impliedShift(f, want);
  if (d !== null && d !== (p?.shift ?? 0)) toast(t('packShiftAsk', { n: shiftText(d) }), 'info', 8000, { label: t('packShiftYes'), run: () => { PK.updatePack(key, { shift: d }); toast(t('packShiftSet', { n: shiftText(d) })); } });
  return d !== null && d !== (p?.shift ?? 0);
}
/** A place offered as the show's pack (a file loaded from it, with other episodes beside it): a toast with the action. */
export async function offerPack(key: string | null, src: PK.PackSource, title?: string): Promise<void> {
  if (!key || PK.packOf(key)?.path === src.path) return;
  try { const scan = await PK.scanPack({ ...src, at: 0, on: true }, true); if (covered(scan.files).length < 2) return;
    toast(t('packOffer', { n: localDigits(covered(scan.files).length) }), 'info', 9000, { label: t('packOfferYes'), run: () => { PK.setPack(key, { ...src, at: Date.now(), on: true, title }); toast(t('packSet', { name: baseOf(src.path) })); } }); } catch { /* not readable: nothing offered */ }
}
/** Subtitle files (an episode's, or a season's) written into the show's own folder and added to its pack. */
export async function saveToShow(key: string, title: string, files: { name: string; bytes: Uint8Array }[], ep?: { season?: number; episode: number }): Promise<string> {
  const { decodeSubtitle } = await import('../player/subs'); const { subEpisode } = await import('../player/subMatch');
  const dir = await PK.showFolder(title); let n = 0;
  for (const f of files) {
    if (!/\.(srt|ass|ssa|vtt)$/i.test(f.name)) continue; let name = f.name;
    // (One episode's file whose name does not say that episode: its number put in front, so the pack finds it.)
    if (ep) { const r = subEpisode(name); if (r.episode !== ep.episode || (ep.season !== undefined && r.season !== undefined && r.season !== ep.season)) name = `${title} ${ep.season !== undefined ? `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}` : `- ${String(ep.episode).padStart(2, '0')}`} - ${name}`; }
    await PK.writeSubText(dir, name, decodeSubtitle(f.bytes, (await import('../player/prefs')).getPrefs().subCodepage || undefined)); n++;
  }
  if (!n) throw new Error(t('subsPackEmpty', { name: files[0]?.name ?? '' }));
  PK.addToPack(key, { path: dir, kind: 'folder' }, title); return dir;
}

export interface PackSheetOptions { key: string; title: string; anilistId?: number; imdbId?: string; /** A series: seasons in the names, a season field in the search. */ series?: boolean; season?: number; /** Episodes per season ('' for a show without seasons), for the missing ones and absolute numbering. */ lengths?: Record<string, number>; onChange?(): void }
/** The «Subtitles» sheet of a show's page. */
export function packSheet(o: PackSheetOptions): void {
  const sh = openSheet(`${t('navSubs')} · ${o.title}`, t('close')); sh.el.classList.add('pack-sheet');
  const box = h('div', { class: 'pack-box' }); sh.body.append(box);
  const changed = () => { o.onChange?.(); void draw(true); };
  const assign = async (kind: 'folder' | 'archive') => { try { const src = await PK.pickPackSource(kind); if (!src) return; if (/^content:/.test(src.path)) { toast(t('packPhoneFolder'), 'error', 6000); return; } PK.setPack(o.key, { ...src, at: Date.now(), on: true, title: o.title, lengths: o.lengths }); toast(t('packSet', { name: baseOf(src.path) })); changed(); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } };
  const find = () => void import('../subs/findSheet').then(({ findSubsSheet }) => findSubsSheet({ title: o.title, anilistId: o.anilistId, imdbId: o.imdbId, season: o.season, askSeason: o.series, openableOnly: true,
    onPick: async (r, query, done) => {
      const { resolveLink } = await import('../subs/search'); const { request } = await import('../http'); const { unpackSubtitle } = await import('../player/subPack');
      toast(t('loading')); const { url, name } = await resolveLink(r, query); const res = await request(url, { binary: true }); if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const bytes = Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0)); const ep = query.animeEpisode ?? query.episode;
      const files = await unpackSubtitle(name ?? `${r.title}.${r.archive ?? 'srt'}`, bytes, ep);
      const dir = await saveToShow(o.key, o.title, ep !== undefined ? files.slice(0, 1) : files, ep !== undefined ? { season: o.series ? query.season : undefined, episode: ep } : undefined);
      done(); toast(t('savedTo', { path: dir })); changed();
    } }));
  const draw = async (fresh = false) => {
    const p = PK.packOf(o.key); if (p && o.lengths && JSON.stringify(p.lengths ?? {}) !== JSON.stringify(o.lengths)) PK.updatePack(o.key, { lengths: o.lengths });
    const head: HTMLElement[] = []; const eps = h('div', { class: 'dest-list pack-eps' });
    const btns = h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn tonal small pack-pick-folder', onclick: () => void assign('folder') }, icon('folder'), t('packFolder')), h('button', { type: 'button', class: 'btn tonal small pack-pick-archive', onclick: () => void assign('archive') }, icon('archive'), t('packArchive')),
      p ? h('button', { type: 'button', class: 'btn text small pack-remove', onclick: () => { PK.setPack(o.key, null); toast(t('subPackRemoved')); changed(); } }, icon('trash'), t('packRemove')) : null);
    const findBtn = getSettings().addons.includes('subtitles') ? h('button', { type: 'button', class: 'btn primary small pack-find', onclick: find }, icon('search'), t('subsFind')) : null;
    if (!p) { box.replaceChildren(h('h4', null, t('subPackTitle')), h('p', { class: 'hint' }, t('packNone')), btns, ...(findBtn ? [h('div', { class: 'row-actions' }, findBtn)] : [])); return; }
    const status = h('small', { class: 'src pack-count' }, t('loading'));
    head.push(h('h4', null, t('subPackTitle')), h('div', { class: 'dest-row pack-current' }, icon(p.kind === 'folder' ? 'folder' : 'archive'), h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'ltr' }, baseOf(p.path)), h('small', { class: 'src', dir: 'ltr' }, [p.path, ...(p.more ?? []).map((m) => m.path)].join(' · ')), status)),
      h('label', { class: 'row switch-row' }, h('span', null, t('packOn')), h('input', { type: 'checkbox', checked: p.on, onchange: (e: Event) => { PK.updatePack(o.key, { on: (e.target as HTMLInputElement).checked }); o.onChange?.(); } })),
      ...(p.shift ? [h('div', { class: 'row' }, h('span', null, t('packShiftNow', { n: shiftText(p.shift) })), h('button', { type: 'button', class: 'btn text small', onclick: () => { PK.updatePack(o.key, { shift: undefined }); changed(); } }, icon('undo'), t('packShiftClear')))] : []));
    box.replaceChildren(...head, btns, ...(findBtn ? [h('div', { class: 'row-actions' }, findBtn)] : []), h('h4', null, t('episodes')), eps);
    try {
      const scan = await PK.scanPack(p, fresh); const cov = covered(scan.files); const langs = getSettings().subLangs;
      const season = o.series ? o.season : undefined; const count = o.lengths?.[season !== undefined ? String(season) : ''] ?? o.lengths?.[''];
      const nums = count ? Array.from({ length: count }, (_, i) => i + 1) : [...new Set(cov.filter((c) => season === undefined || c.season === undefined || c.season === season).map((c) => c.episode))];
      const missing: number[] = [];
      status.textContent = t('packEpisodes', { n: localDigits(cov.length) });
      eps.replaceChildren(...nums.map((e) => {
        const want = PK.wantFor(PK.packOf(o.key) ?? p, season, e); const r = PK.fileFor(PK.packOf(o.key) ?? p, scan, want, langs); if (!r.file) missing.push(e);
        return h('button', { type: 'button', class: 'dest-row pack-ep' + (r.file ? '' : ' missing'), dataset: { ep: String(e) }, onclick: () => chooseFileSheet(scan, want, r.manual, r.file, (f) => { pickedByHand(o.key, want, f); void draw(); }) },
          h('span', { class: 'ep-num' }, fmtEp(season, e)), h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, r.file ? baseOf(r.file.path) : t('packNoFile')), r.manual ? h('small', { class: 'src' }, t('packByHand')) : null), icon('pencil'));
      }));
      if (missing.length && count) status.textContent = `${t('packEpisodes', { n: localDigits(cov.length) })} · ${t('packMissing', { list: missing.map((x) => localDigits(x)).join(document.documentElement.lang === 'ar' ? '، ' : ', ') })}`;
    } catch (e) { status.textContent = t('packUnreadable', { name: String((e as Error).message ?? e) }); }
  };
  void draw();
}
