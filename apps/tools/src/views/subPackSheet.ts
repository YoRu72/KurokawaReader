// A show's subtitles, from its page (anime and TV): the subtitle pack assigned to it — a folder or an archive —,
// the file each episode gets from it (changed by hand there), the episodes it lacks, and «Find subtitles», whose
// result is saved into the show's own subtitles folder and added to its pack, so it is there when the episode plays.
// The file list and the hand-picked file (with the shift it implies offered for the rest) are the player's too.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, localDigits, countLabel } from '../i18n';
import { getSettings } from '../settings';
import * as PK from '../player/subPacks';
import { matchEpisode, covered, type Want } from '../player/subMatch';

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
/** A file chosen by hand for an episode: kept for it (null: back to automatic), and what it teaches kept for its
 *  source's next episodes (./subPacks correct); a shift learned is said in a toast. True when one was. */
export function pickedByHand(key: string, want: Want, f: PK.PackFile | null): boolean {
  const L = PK.correct(key, want, f); if (!L?.shift) return false;
  toast(t('packLearned', { n: shiftText(L.shift) }), 'info', 7000, { label: t('packForget'), run: () => { PK.forgetCorrections(key); toast(t('packForgot')); } });
  return true;
}
/** A place offered as the show's pack (a file loaded from it, with other episodes beside it): a toast with the action. */
export async function offerPack(key: string | null, src: PK.PackSource, title?: string): Promise<void> {
  if (!key || PK.packOf(key)?.path === src.path) return;
  try { const scan = await PK.scanPack({ ...src, at: 0, on: true }, true); if (covered(scan.files).length < 2) return;
    toast(t('packOffer', { n: localDigits(covered(scan.files).length) }), 'info', 9000, { label: t('packOfferYes'), run: () => { PK.setPack(key, { ...src, at: Date.now(), on: true, title }); toast(t('packSet', { name: baseOf(src.path) })); } }); } catch { /* not readable: nothing offered */ }
}
/** The files the last saveToShow wrote (for its Undo). */
let lastWritten: string[] = [];
/** Files taken away (an Undo of what a search added): through the phone's or the computer's own file jobs. */
async function removeFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { ktPlugin } = await import('../native');
  const d = window.kurokawaTools as unknown as { filesJob?(o: { op: 'delete'; paths: string[] }): Promise<unknown> } | undefined;
  const pl = ktPlugin() as unknown as { filesJob?(o: { op: 'delete'; paths: string[] }): Promise<unknown> } | null;
  await (d?.filesJob ?? pl?.filesJob)?.call(d?.filesJob ? d : pl, { op: 'delete', paths }).catch(() => undefined);
}
/** Subtitle files (an episode's, or a season's) written into the show's own folder and added to its pack. */
export async function saveToShow(key: string, title: string, files: { name: string; bytes: Uint8Array }[], ep?: { season?: number; episode: number }): Promise<string> {
  const { decodeSubtitle } = await import('../player/subs'); const { subEpisode } = await import('../player/subMatch');
  const dir = await PK.showFolder(title); let n = 0; lastWritten = [];
  for (const f of files) {
    if (!/\.(srt|ass|ssa|vtt)$/i.test(f.name)) continue; let name = f.name;
    // (One episode's file whose name does not say that episode: its number put in front, so the pack finds it.)
    if (ep) { const r = subEpisode(name); if (r.episode !== ep.episode || (ep.season !== undefined && r.season !== undefined && r.season !== ep.season)) name = `${title} ${ep.season !== undefined ? `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}` : `- ${String(ep.episode).padStart(2, '0')}`} - ${name}`; }
    lastWritten.push(await PK.writeSubText(dir, name, decodeSubtitle(f.bytes, (await import('../player/prefs')).getPrefs().subCodepage || undefined))); n++;
  }
  if (!n) throw new Error(t('subsPackEmpty', { name: files[0]?.name ?? '' }));
  PK.addToPack(key, { path: dir, kind: 'folder' }, title); return dir;
}

/** A folder on a storage the app has no path for (a content: tree on the phone): its subtitle and font files copied
 *  into the show's own subtitles folder (the phone's bridge), which then is the pack. Null when it cannot. */
async function copyTree(uri: string, title: string): Promise<string | null> {
  const { ktPlugin } = await import('../native'); const pl = ktPlugin() as unknown as { treeCopy?(o: { uri: string; dest: string; pattern: string }): Promise<{ paths: string[] }> } | null;
  if (!pl?.treeCopy) return null;
  try { const dest = `${await PK.showFolder(title)}/${t('packCopiedFolder')}`; const r = await pl.treeCopy({ uri, dest, pattern: '\\.(ass|ssa|srt|vtt|ttf|otf|ttc)$' }); return r.paths?.length ? dest : null; } catch { return null; }
}
/** Where a source is, for the person: a tree's name, else the last part of its path. */
export const sourceName = (s: PK.PackSource): string => s.label || baseOf(s.path.replace(/[\\/]+$/, '')) || s.path;
const onPc = () => document.documentElement.classList.contains('pc');
/** A source added to the show (a phone's tree read live when the phone can, else copied into the show's own folder). */
export async function addSource(key: string, title: string, kind: 'folder' | 'archive', extra?: Partial<PK.SubPack>): Promise<boolean> {
  try {
    const src = await PK.pickPackSource(kind); if (!src) return false;
    if (src.kind === 'tree' && !(await canLiveTree(src.path))) { const got = await copyTree(src.path, title); if (!got) { toast(t('packPhoneFolder'), 'error', 6000); return false; } src.path = got; src.kind = 'folder'; delete src.label; }
    else if (/^content:/.test(src.path) && src.kind !== 'tree') { toast(t('packPhoneFolder'), 'error', 6000); return false; }
    addPlace(key, src, title, extra); toast(t('packSrcAdded', { name: sourceName(src) })); return true;
  } catch (e) { toast(String((e as Error).message ?? e), 'error'); return false; }
}
function addPlace(key: string, src: PK.PackSource, title: string, extra?: Partial<PK.SubPack>): void {
  if (!PK.packOf(key)) PK.setPack(key, { ...src, at: Date.now(), on: true, title, ...extra }); else { PK.addToPack(key, src, title); if (extra) PK.updatePack(key, extra); }
}
/** The phone keeps the tree's grant where the Files code reads it (so it is read live, not copied). */
async function canLiveTree(uri: string): Promise<boolean> { const { ktPlugin } = await import('../native'); const v = ktPlugin() as unknown as { vfsRoots?(): Promise<{ trees?: { uri: string }[] }>; vfsList?: unknown } | null; if (!v?.vfsList || !v.vfsRoots) return false; try { const r = await v.vfsRoots(); return Array.isArray(r?.trees) && r.trees.some((x) => x.uri === uri); } catch { return false; } }
/** The show's sources: each with where it is, how many subtitle files, how many matched to episodes, the unmatched
 *  ones; removable, the later ones movable up; adding a folder (the phone: a folder picked, kept; a computer: picked
 *  or its path typed) or an archive; «Forget corrections». */
export function sourcesBlock(o: { key: string; title: string; wants: Want[]; extra?: Partial<PK.SubPack>; changed(): void }): HTMLElement {
  const box = h('div', { class: 'pack-sources' }); const p = PK.packOf(o.key);
  const list = h('div', { class: 'dest-list pack-src-list' });
  const addRow = h('div', { class: 'row-actions wrap pack-add' },
    h('button', { type: 'button', class: 'btn tonal small pack-pick-folder', onclick: async () => { if (await addSource(o.key, o.title, 'folder', o.extra)) o.changed(); } }, icon('folder'), p ? t('packAddFolder') : t('packFolder')),
    h('button', { type: 'button', class: 'btn tonal small pack-pick-archive', onclick: async () => { if (await addSource(o.key, o.title, 'archive', o.extra)) o.changed(); } }, icon('archive'), p ? t('packAddArchive') : t('packArchive')));
  // (A computer: a folder's path typed or pasted.)
  const typed = onPc() ? (() => {
    const inp = h('input', { type: 'text', class: 'search-input pack-path', dir: 'ltr', placeholder: t('packPathPh'), 'aria-label': t('packPathPh'), spellcheck: false, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } } }) as HTMLInputElement;
    const go = async () => { try { const src = await PK.typedFolder(inp.value); addPlace(o.key, src, o.title, o.extra); toast(t('packSrcAdded', { name: sourceName(src) })); o.changed(); } catch { toast(t('packPathBad'), 'error', 5000); inp.focus(); } };
    return h('div', { class: 'row pack-path-row' }, inp, h('button', { type: 'button', class: 'btn tonal small pack-path-add', onclick: () => void go() }, icon('plus'), t('packPathAdd')));
  })() : null;
  box.append(h('h4', null, t('packSources')), list, addRow, ...(typed ? [typed] : []));
  if (!p) { list.remove(); return box; }
  const srcs = PK.sourcesOf(p);
  const rowOf = (src: PK.PackSource, i: number) => {
    const stat = h('small', { class: 'src pack-src-stat' }, t('loading')); const un = h('div', { class: 'pack-unmatched' });
    const el = h('div', { class: 'dest-row pack-src', dataset: { path: src.path } }, icon(src.kind === 'archive' ? 'archive' : 'folder'),
      h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, sourceName(src)), h('small', { class: 'src', dir: 'ltr' }, src.kind === 'tree' ? t('packTreeKept') : src.path), stat, un),
      i > 0 ? h('button', { type: 'button', class: 'icon-btn pack-src-up', title: t('packSrcUp'), 'aria-label': t('packSrcUp'), onclick: () => { PK.raiseSource(o.key, src.path); o.changed(); } }, icon('arrowUp')) : h('span', { class: 'pack-src-gap', 'aria-hidden': 'true' }),
      h('button', { type: 'button', class: 'icon-btn pack-src-remove', title: t('packSrcRemove'), 'aria-label': t('packSrcRemove'), onclick: () => { PK.removeSource(o.key, src.path); toast(t('packSrcRemoved')); o.changed(); } }, icon('trash')));
    return { el, stat, un };
  };
  const rows = srcs.map(rowOf); list.append(...rows.map((r) => r.el));
  void PK.scanPack(p).then((scan) => {
    const st = PK.sourceStats(p, scan, o.wants, getSettings().subLangs);
    st.forEach((x, i) => { const r = rows[i]; if (!r) return;
      if (x.error) { r.stat.textContent = t('packSrcError', { why: x.error }); r.el.classList.add('bad'); return; }
      r.stat.textContent = t('packSrcStats', { n: localDigits(x.files), m: localDigits(x.matched) });
      if (x.unmatched.length) r.un.append(h('details', { class: 'pack-unmatched-list' }, h('summary', null, t('packUnmatched', { n: countLabel(x.unmatched.length) })), ...x.unmatched.slice(0, 60).map((f) => h('div', { class: 'src', dir: 'auto' }, f.path))));
    });
  }).catch((e) => { rows.forEach((r) => { r.stat.textContent = t('packSrcError', { why: String((e as Error).message ?? e) }); }); });
  if (PK.hasCorrections(p)) box.append(h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn text small pack-forget', onclick: () => { PK.forgetCorrections(o.key); toast(t('packForgot')); o.changed(); } }, icon('undo'), t('packForget'))));
  return box;
}
/** Why a file was picked, in a few words (the list's small text). */
export function reasonText(r: { basis: string; plus: string[]; guess: boolean } | undefined, manual: boolean): string {
  if (manual) return t('packWhyManual'); if (!r) return '';
  const b = r.basis === 'exact' ? t('packWhyExact') : r.basis === 'learned' ? t('packWhyLearned') : r.basis === 'absolute' ? t('packWhyAbsolute') : t('packWhyNumber');
  const more = r.plus.map((x) => (x === 'lang' ? t('packWhyLang') : x === 'group' ? t('packWhyGroup') : x === 'lastGroup' ? t('packWhyLastGroup') : x === 'kind' ? t('packWhyKind') : x === 'span' ? t('packWhySpan') : x === 'variant' ? t('packWhyVariant') : '')).filter(Boolean);
  return [b, ...more, ...(r.guess ? [t('packWhyGuess')] : [])].join(document.documentElement.lang === 'ar' ? '، ' : ', ');
}
export interface PackSheetOptions { key: string; title: string; anilistId?: number; imdbId?: string; /** A series: seasons in the names, a season field in the search. */ series?: boolean; season?: number; /** Episodes per season ('' for a show without seasons), for the missing ones and absolute numbering. */ lengths?: Record<string, number>; /** A film: one file plays, chosen by its title and year (asked here when several fit). */ movie?: boolean; year?: number; onChange?(): void }
/** The «Subtitles» sheet of a show's page. */
export function packSheet(o: PackSheetOptions): void {
  const sh = openSheet(`${t('navSubs')} · ${o.title}`, t('close')); sh.el.classList.add('pack-sheet');
  const box = h('div', { class: 'pack-box' }); sh.body.append(box);
  const changed = () => { o.onChange?.(); void draw(true); };
  const find = () => void import('../subs/findSheet').then(({ findSubsSheet, fetchResult }) => findSubsSheet({ title: o.title, anilistId: o.anilistId, imdbId: o.imdbId, season: o.season, askSeason: o.series, openableOnly: true, showKey: o.key,
    onPick: async (r, query, done, got) => {
      if (!got) toast(t('loading')); const files = got ?? await fetchResult(r, query); const ep = query.animeEpisode ?? query.episode;
      // (What the pack was, for Undo; the files then matched to the episodes — the sheet shows which got one.)
      const before = PK.packOf(o.key); const was = before ? JSON.parse(JSON.stringify(before)) as PK.SubPack : null;
      const dir = await saveToShow(o.key, o.title, ep !== undefined || o.movie ? files.slice(0, o.movie ? 12 : 1) : files, ep !== undefined && !o.movie ? { season: o.series ? query.season : undefined, episode: ep } : undefined);
      if (o.movie) PK.updatePack(o.key, { movie: true });
      // (Undo: the files it wrote taken away, and the pack as it was — unless the pack was changed since, which Undo
      // then leaves as it is.)
      // (What the user can change in a pack — not its bookkeeping, as the episode counts the sheet keeps up to date.)
      const sig = (x: PK.SubPack | null) => JSON.stringify(x ? { path: x.path, kind: x.kind, more: x.more, on: x.on, shift: x.shift, manual: x.manual, filter: x.filter, movie: x.movie } : null);
      const written = [...lastWritten]; const after = sig(PK.packOf(o.key));
      const undo = async () => { await removeFiles(written); if (sig(PK.packOf(o.key)) === after) { PK.setPack(o.key, was); toast(t('undoneMsg')); } else { PK.setPack(o.key, PK.packOf(o.key)); toast(t('packUndoKept'), 'info', 6000); } o.onChange?.(); packSheet(o); };   // (kept: set again as it is, so its files are read anew)
      // (The search's sheet took this one's place: this one opened again, showing which episodes got a file.)
      done(); o.onChange?.(); packSheet(o); toast(t('packAttachedTo', { path: baseOf(dir) }), 'info', 8000, { label: t('undoAct'), run: () => void undo() });
    } }));
  const draw = async (fresh = false) => {
    const p = PK.packOf(o.key); if (p && o.lengths && JSON.stringify(p.lengths ?? {}) !== JSON.stringify(o.lengths)) PK.updatePack(o.key, { lengths: o.lengths });
    const head: HTMLElement[] = []; const eps = h('div', { class: 'dest-list pack-eps' });
    const season = o.series ? o.season : undefined; const count = o.lengths?.[season !== undefined ? String(season) : ''] ?? o.lengths?.[''];
    const wants = p ? (o.movie ? [{ episode: 0 }] : count ? Array.from({ length: count }, (_, i) => PK.wantFor(p, season, i + 1)) : []) : [];
    const srcBox = sourcesBlock({ key: o.key, title: o.title, wants, extra: { lengths: o.lengths, movie: o.movie || undefined }, changed });
    // (Always there: without the Subtitles add-on its sheet says so and offers the add-ons.)
    const btns = h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn tonal small pack-find', onclick: find }, icon('search'), t('subsSearchPack')),
      p ? h('button', { type: 'button', class: 'btn text small pack-remove', onclick: () => { PK.setPack(o.key, null); toast(t('subPackRemoved')); changed(); } }, icon('trash'), t('packRemove')) : null);
    if (!p) { box.replaceChildren(h('h4', null, o.movie ? t('subPackTitleMovie') : t('subPackTitle')), h('p', { class: 'hint' }, o.movie ? t('packNoneMovie') : t('packNone')), srcBox, btns); return; }
    const status = h('small', { class: 'src pack-count' }, t('loading'));
    head.push(h('h4', null, o.movie ? t('subPackTitleMovie') : t('subPackTitle')), h('div', { class: 'dest-row pack-current' }, icon('subtitles'), h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, sourceName(p)), status)),
      h('label', { class: 'row switch-row' }, h('span', null, t('packOn')), h('input', { type: 'checkbox', checked: p.on, onchange: (e: Event) => { PK.updatePack(o.key, { on: (e.target as HTMLInputElement).checked }); o.onChange?.(); } })),
      ...(p.shift ? [h('div', { class: 'row' }, h('span', null, t('packShiftNow', { n: shiftText(p.shift) })), h('button', { type: 'button', class: 'btn text small', onclick: () => { PK.updatePack(o.key, { shift: undefined }); changed(); } }, icon('undo'), t('packShiftClear')))] : []));
    box.replaceChildren(...head, srcBox, btns, h('h4', null, o.movie ? t('packMoviePlays') : t('episodes')), eps);
    if (o.movie) {
      try {
        const scan = await PK.scanPack(p, fresh); const r = PK.movieFileFor(p, scan, o.title, o.year, getSettings().subLangs);
        status.textContent = t('packMovieFiles', { n: scan.files.length });
        const pick = () => chooseFileSheet(scan, { episode: 0 }, r.manual, r.file, (f) => { PK.setManual(o.key, undefined, 0, f); void draw(); });
        eps.replaceChildren(r.file ? h('button', { type: 'button', class: 'dest-row pack-ep pack-movie', onclick: pick }, icon('subtitles'), h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, baseOf(r.file.path)), h('small', { class: 'src' }, r.manual ? t('packByHand') : r.several ? t('packMovieSeveral') : t('packMovieAuto'))), icon('pencil')) : h('p', { class: 'hint' }, t('packNoFile')));
      } catch (e) { status.textContent = t('packUnreadable', { name: String((e as Error).message ?? e) }); }
      return;
    }
    try {
      const scan = await PK.scanPack(p, fresh); const cov = covered(scan.files); const langs = getSettings().subLangs;
      const nums = count ? Array.from({ length: count }, (_, i) => i + 1) : [...new Set(cov.filter((c) => season === undefined || c.season === undefined || c.season === season).map((c) => c.episode))];
      const missing: number[] = [];
      // (Episodes with a file: by number — two sources naming the same episode, one with its season, count once.)
      const one = (season === undefined && new Set(cov.filter((c) => c.season !== undefined).map((c) => c.season)).size <= 1) || season !== undefined;
      const epCount = one ? new Set(cov.filter((c) => season === undefined || c.season === undefined || c.season === season).map((c) => c.episode)).size : cov.length;
      status.textContent = t('packEpisodes', { n: localDigits(epCount) });
      eps.replaceChildren(...nums.map((e) => {
        const want = PK.wantFor(PK.packOf(o.key) ?? p, season, e); const r = PK.fileFor(PK.packOf(o.key) ?? p, scan, want, langs); if (!r.file) missing.push(e);
        return h('button', { type: 'button', class: 'dest-row pack-ep' + (r.file ? '' : ' missing'), dataset: { ep: String(e) }, onclick: () => chooseFileSheet(scan, want, r.manual, r.file, (f) => { pickedByHand(o.key, want, f); void draw(); }) },
          h('span', { class: 'ep-num' }, fmtEp(season, e)), h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, r.file ? baseOf(r.file.path) : t('packNoFile')), r.manual ? h('small', { class: 'src' }, t('packByHand')) : null), icon('pencil'));
      }));
      if (missing.length && count) status.textContent = `${t('packEpisodes', { n: localDigits(epCount) })} · ${t('packMissing', { list: missing.map((x) => localDigits(x)).join(document.documentElement.lang === 'ar' ? '، ' : ', ') })}`;
    } catch (e) { status.textContent = t('packUnreadable', { name: String((e as Error).message ?? e) }); }
  };
  void draw();
}
