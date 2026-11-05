// The Files add-on's bigger sheets (the second batch from Solid Explorer and ZArchiver): the search with its filters
// (kind, size, when changed, this folder only), the archive maker with its options (format, how hard, a password,
// the sources removed after), the recycle bin (what was deleted, put back or emptied, the old emptied by itself),
// renaming many at once by a pattern, properties told whole (checksums, a photo's EXIF, a recording's tags, an
// app's name and version), the text editor and the picture viewer.
import { h, icon, iconButton, toast, openSheet, pickButton } from '../ui/dom';
import { t, formatBytes, formatDate, localDigits, countItems } from '../i18n';
import { ktPlugin } from '../native';
import type { Entry } from './files';

type Plug = {
  filesSearch(o: { path: string; q: string; hidden?: boolean }): Promise<{ entries: Entry[] }>;
  filesTrash(o: { paths: string[] }): Promise<{ moved: string[]; failed: string[] }>; filesTrashList(): Promise<{ items: TrashItem[] }>; filesTrashRestore(o: { slot: string }): Promise<{ path: string }>; filesTrashEmpty(o: { slots?: string[]; olderThanDays?: number }): Promise<{ n: number }>;
  filesRename(o: { path: string; name: string }): Promise<{ ok: boolean; path: string }>;
  filesMeta(o: { path: string }): Promise<{ exif?: Record<string, string | number>; media?: Record<string, string>; apk?: Record<string, string | number> }>;
  hashFile(o: { path: string }): Promise<{ md5: string; sha1: string; sha256: string; size: number }>;
  filesHead(o: { path: string; max?: number }): Promise<{ text: string; size: number }>; filesWrite(o: { path: string; text: string }): Promise<{ size: number }>;
  filesWallpaper(o: { path: string }): Promise<void>; shareFile(o: { path: string; title: string }): Promise<void>; openWith(o: { path: string; mime: string; title: string }): Promise<void>;
};
export interface TrashItem { slot: string; name: string; from: string; at: number; dir: boolean; size: number; path: string; exists: boolean }
const plug = (): Plug => ktPlugin() as unknown as Plug;
const baseOf = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p;
const TRASH_DAYS = 30;

/* ---------- the search: a name, and Solid Explorer's filters ---------- */
const SIZES: [string, string, number, number][] = [['any', 'filesSizeAny', 0, Infinity], ['empty', 'filesSizeEmpty', 0, 0], ['tiny', 'filesSizeTiny', 1, 10 << 10], ['small', 'filesSizeSmall', 10 << 10, 1 << 20], ['medium', 'filesSizeMedium', 1 << 20, 10 << 20], ['big', 'filesSizeBig', 10 << 20, 100 << 20], ['large', 'filesSizeLarge', 100 << 20, 1 << 30], ['huge', 'filesSizeHuge', 1 << 30, Infinity]];
const DATES: [string, string][] = [['any', 'filesDateAny'], ['today', 'today'], ['yesterday', 'yesterday'], ['week', 'filesDateWeek'], ['lastWeek', 'filesDateLastWeek'], ['month', 'filesDateMonth'], ['lastMonth', 'filesDateLastMonth'], ['year', 'filesDateYear'], ['lastYear', 'filesDateLastYear']];
const KIND_RE: Record<string, RegExp | null> = { any: null, image: /^(jpe?g|png|gif|webp|bmp|heic|avif|svg)$/, audio: /^(mp3|m4a|flac|ogg|opus|wav|aac|wma)$/, video: /^(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv|3gp)$/, doc: /^(pdf|epub|mobi|azw3?|docx?|xlsx?|pptx?|txt|md|rtf|odt|cbz|cbr)$/, archive: /^(zip|7z|rar|tar|gz|tgz|xz|bz2|zst|lz4|iso|001)$/, apk: /^(apk|apks|xapk|apkm)$/ };
function dateWindow(key: string): [number, number] {
  const now = new Date(); const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); const today = day(now); const D = 86400000;
  const weekStart = today - ((now.getDay() + 6) % 7) * D; const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  switch (key) {
    case 'today': return [today, Infinity]; case 'yesterday': return [today - D, today]; case 'week': return [weekStart, Infinity]; case 'lastWeek': return [weekStart - 7 * D, weekStart];
    case 'month': return [monthStart, Infinity]; case 'lastMonth': return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), monthStart];
    case 'year': return [yearStart, Infinity]; case 'lastYear': return [new Date(now.getFullYear() - 1, 0, 1).getTime(), yearStart]; default: return [0, Infinity];
  }
}
const HISTORY = 'kt.files.searches';
const history = (): string[] => { try { return JSON.parse(localStorage.getItem(HISTORY) ?? '[]') as string[]; } catch { return []; } };
/** The search sheet: results from the folder (or the whole storage), each opened or shown in its folder. */
export function searchSheet(here: string, storageRoot: string, hidden: boolean, open: (e: Entry) => void, goTo: (dir: string) => void): void {
  const sh = openSheet(t('search'), t('close')); sh.el.classList.add('files-search-sheet');
  const q = h('input', { type: 'search', placeholder: t('filesSearchName'), dir: 'auto', autofocus: true }) as HTMLInputElement;
  let kind = 'any', size = 'any', date = 'any', hereOnly = true;
  const kindBtn = pickButton(t('filesKind'), Object.keys(KIND_RE).map((k): [string, string] => [k, t(({ any: 'filesKindAll', image: 'filesKindImages', audio: 'filesKindMusic', video: 'filesKindVideo', doc: 'filesKindDocs', archive: 'filesKindArchives', apk: 'filesKindApps' } as Record<string, string>)[k] as 'filesKindAll')]), 'any', (v) => { kind = v; void run(); }, t('close'));
  const sizeBtn = pickButton(t('fileSize'), SIZES.map(([k, l]): [string, string] => [k, t(l as 'filesSizeAny')]), 'any', (v) => { size = v; void run(); }, t('close'));
  const dateBtn = pickButton(t('fileDate'), DATES.map(([k, l]): [string, string] => [k, t(l as 'filesDateAny')]), 'any', (v) => { date = v; void run(); }, t('close'));
  const hereBox = h('input', { type: 'checkbox', checked: true, onchange: () => { hereOnly = hereBox.checked; void run(); } }) as HTMLInputElement;
  const list = h('div', { class: 'files-list list files-results' }); const status = h('p', { class: 'hint' }); const hist = h('div', { class: 'chip-row' });
  const drawHist = () => hist.replaceChildren(...history().slice(0, 8).map((x) => h('button', { type: 'button', class: 'chip small', onclick: () => { q.value = x; void run(); } }, x)));
  drawHist();
  sh.body.append(q, h('div', { class: 'chip-row files-filters' }, kindBtn, sizeBtn, dateBtn), h('label', { class: 'check-row' }, hereBox, h('span', null, t('filesSearchHereOnly'))), hist, status, list);
  let seq = 0;
  const run = async () => {
    const text = q.value.trim(); const my = ++seq; if (!text && kind === 'any' && size === 'any' && date === 'any') { list.replaceChildren(); status.textContent = ''; return; }
    status.textContent = t('loading'); list.replaceChildren();
    try {
      const r = await plug().filesSearch({ path: hereOnly ? here : storageRoot, q: text, hidden }); if (my !== seq) return;
      const re = KIND_RE[kind]; const [lo, hi] = SIZES.find(([k]) => k === size)!.slice(2) as [number, number]; const [from, to] = dateWindow(date);
      const got = r.entries.filter((e) => (!re || (!e.dir && re.test(e.ext ?? ''))) && (size === 'any' || (!e.dir && e.size >= lo && e.size <= hi)) && (date === 'any' || (e.mtime >= from && e.mtime < to)));
      if (text) { const hs = history().filter((x) => x !== text); hs.unshift(text); try { localStorage.setItem(HISTORY, JSON.stringify(hs.slice(0, 20))); } catch { /* none */ } drawHist(); }
      status.textContent = got.length ? `${countItems(got.length)}${r.entries.length >= 400 ? ' · ' + t('filesSearchCapped') : ''}` : t('filesNothingMatches');
      list.replaceChildren(...got.slice(0, 400).map((e) => h('div', { class: 'files-row', role: 'button', tabindex: '0', onclick: () => { sh.close(); open(e); } },
        h('span', { class: 'files-ic' }, icon(e.dir ? 'folder' : 'file')), h('span', { class: 'grow files-main' }, h('span', { class: 'files-name', dir: 'auto' }, e.name), h('small', { class: 'src', dir: 'ltr' }, `${e.dir ? '' : formatBytes(e.size) + ' · '}${e.path.slice(0, e.path.length - e.name.length - 1)}`)),
        iconButton('folder', t('filesShowInFolder'), (ev) => { ev.stopPropagation(); sh.close(); goTo(e.path.slice(0, e.path.length - e.name.length - 1)); }))));
    } catch (err) { status.textContent = String((err as Error).message ?? err); }
  };
  let timer = 0; q.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => void run(), 350); });
  setTimeout(() => q.focus(), 60);
}

/* ---------- the archive maker: a name, the format, how hard, a password, the sources removed after ---------- */
export async function makeArchiveSheet(paths: string[], dir: string, started: (id: string, label: string, done: Promise<unknown>, cancel: () => void) => void, refresh: () => void): Promise<void> {
  const { createZip, makeFormats, cancelArchive, splitSizes } = await import('../archives');
  const sh = openSheet(t('filesCompress'), t('cancel'));
  const stem = paths.length === 1 ? baseOf(paths[0]).replace(/\.[^.]+$/, '') : baseOf(dir) || 'archive';
  const formats = makeFormats() as string[]; let format = formats[0]; let level = 6;
  const name = h('input', { type: 'text', value: stem, dir: 'auto' }) as HTMLInputElement;
  const fmtBtn = pickButton(t('filesFormat'), formats.map((f): [string, string] => [f, f.toUpperCase()]), format, (v) => { format = v; }, t('close'));
  const lvlBtn = pickButton(t('filesLevel'), [['0', t('filesLevelStore')], ['1', t('filesLevelFastest')], ['3', t('filesLevelFast')], ['6', t('filesLevelNormal')], ['8', t('filesLevelMax')], ['9', t('filesLevelUltra')]], '6', (v) => { level = Number(v); }, t('close'));
  const pw = h('input', { type: 'password', placeholder: t('filesPasswordOptional'), autocomplete: 'off' }) as HTMLInputElement; const del = h('input', { type: 'checkbox' }) as HTMLInputElement;
  let splitMb = 0; const splitLabel = (mb: number) => (mb === 0 ? t('filesSplitNone') : mb >= 1024 ? `${localDigits(mb / 1024)} GB` : `${localDigits(mb)} MB`);
  const splitBtn = pickButton(t('filesSplit'), splitSizes.map((mb): [string, string] => [String(mb), splitLabel(mb)]), '0', (v) => { splitMb = Number(v); }, t('close'));
  const comment = h('input', { type: 'text', placeholder: t('filesCommentOptional'), dir: 'auto' }) as HTMLInputElement;
  sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), name), h('div', { class: 'chip-row files-filters' }, fmtBtn, lvlBtn, splitBtn), h('label', { class: 'field' }, h('span', null, t('password')), pw), h('p', { class: 'hint' }, t('filesPasswordHint')), h('label', { class: 'field' }, h('span', null, t('filesComment')), comment), h('label', { class: 'check-row' }, del, h('span', null, t('filesDeleteSources'))), h('p', { class: 'hint' }, t('filesCompressHint', { n: localDigits(paths.length) })), h('p', { class: 'hint' }, t('filesSplitHint')));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => {
    const n = (name.value.trim() || stem).replace(/\.(zip|7z|tar|tar\.gz|tgz|tar\.xz)$/i, ''); const out = `${dir}/${n}.${format}`; sh.close();
    const done = createZip(out, paths, undefined, { format: format as never, level, password: pw.value || undefined, deleteAfter: del.checked, comment: (format === 'zip' && comment.value.trim()) || undefined, splitMb });
    const id = `mk-${Date.now()}`; started(id, t('filesZipping', { name: `${n}.${format}` }), done, () => void cancelArchive(id));
    void done.then(() => { refresh(); toast(t('filesZipped', { name: `${n}.${format}` })); }, (err) => toast(String((err as Error).message ?? err), 'error'));
  } }, icon('archive'), t('filesCompress')));
}

/* ---------- the recycle bin ---------- */
/** Deleting: into the bin (a storage's hidden folder) unless the setting says for good. */
export const trashOn = (): boolean => localStorage.getItem('kt.files.trash') !== 'off';
export const setTrashOn = (on: boolean): void => { try { localStorage.setItem('kt.files.trash', on ? 'on' : 'off'); } catch { /* none */ } };
export async function toTrash(paths: string[]): Promise<{ moved: string[]; failed: string[] }> { return plug().filesTrash({ paths }); }
/** The old emptied by itself: once a day, what is past thirty days. */
export async function pruneTrash(): Promise<void> {
  const last = Number(localStorage.getItem('kt.files.trashPruned') ?? 0); if (Date.now() - last < 86400000) return;
  try { localStorage.setItem('kt.files.trashPruned', String(Date.now())); } catch { /* none */ }
  try { await plug().filesTrashEmpty({ olderThanDays: TRASH_DAYS }); } catch { /* none */ }
}
export function trashSheet(refresh: () => void): void {
  const sh = openSheet(t('filesTrash'), t('close')); const list = h('div', { class: 'dest-list' }); const status = h('p', { class: 'hint' }, t('loading'));
  sh.body.append(h('p', { class: 'hint' }, t('filesTrashHint', { days: localDigits(TRASH_DAYS) })), status, list);
  const load = async () => {
    try {
      const r = await plug().filesTrashList(); status.textContent = r.items.length ? countItems(r.items.length) : t('filesTrashEmptyMsg');
      list.replaceChildren(...r.items.map((it) => h('div', { class: 'dest-row files-trash-row' }, icon(it.dir ? 'folder' : 'file'), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, it.name), h('small', { class: 'src', dir: 'ltr' }, `${it.size ? formatBytes(it.size) + ' · ' : ''}${formatDate(it.at)} · ${it.from.slice(0, it.from.length - it.name.length - 1)}`)),
        iconButton('undo', t('filesRestore'), async () => { try { await plug().filesTrashRestore({ slot: it.slot }); toast(t('filesRestored', { name: it.name })); refresh(); void load(); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } }),
        iconButton('trash', t('filesDeleteForever'), async () => { try { await plug().filesTrashEmpty({ slots: [it.slot] }); void load(); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } }))));
      sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', disabled: !r.items.length, onclick: async () => { try { await plug().filesTrashEmpty({}); toast(t('filesTrashEmptied')); void load(); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } } }, icon('trash'), t('filesEmptyTrash')));
    } catch (err) { status.textContent = String((err as Error).message ?? err); }
  };
  void load();
}

/* ---------- renaming many at once ---------- */
const pad = (n: number, w: number) => String(n).padStart(w, '0');
/** The new name of `e` by the pattern: {name} {ext} {name.ext} {size} {date} {time} {now} {n} (with {n:3} for zeros), then find → replace. */
export function patternName(e: Entry, pattern: string, i: number, start: number, find: string, replace: string): string {
  const dot = e.name.lastIndexOf('.'); const stem = e.dir || dot <= 0 ? e.name : e.name.slice(0, dot); const ext = e.dir || dot <= 0 ? '' : e.name.slice(dot + 1);
  const d = new Date(e.mtime); const now = new Date(); const ymd = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1, 2)}-${pad(x.getDate(), 2)}`; const hm = (x: Date) => `${pad(x.getHours(), 2)}${pad(x.getMinutes(), 2)}`;
  let out = pattern.replace(/\{n(?::(\d))?\}/g, (_, w) => pad(start + i, Number(w ?? 1))).replace(/\{name\.ext\}/g, e.name).replace(/\{name\}/g, stem).replace(/\{ext\}/g, ext).replace(/\{size\}/g, formatBytes(e.size).replace(/\s/g, '')).replace(/\{date\}/g, ymd(d)).replace(/\{time\}/g, hm(d)).replace(/\{now\}/g, ymd(now));
  if (find) out = out.split(find).join(replace);
  if (!e.dir && ext && !/\.[^.]+$/.test(out) && !pattern.includes('{ext}') && !pattern.includes('{name.ext}')) out += `.${ext}`;
  return out.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim();
}
export function batchRenameSheet(items: Entry[], refresh: () => void): void {
  const sh = openSheet(t('filesBatchRename'), t('cancel'));
  const pattern = h('input', { type: 'text', value: '{name}', dir: 'ltr' }) as HTMLInputElement; const start = h('input', { type: 'number', value: '1', min: '0', style: { width: '80px' } }) as HTMLInputElement;
  const find = h('input', { type: 'text', placeholder: t('filesFind'), dir: 'auto' }) as HTMLInputElement; const repl = h('input', { type: 'text', placeholder: t('filesReplaceWith'), dir: 'auto' }) as HTMLInputElement;
  const preview = h('div', { class: 'files-preview' });
  const vars = h('div', { class: 'chip-row' }, ...['{name}', '{ext}', '{name.ext}', '{n}', '{n:3}', '{size}', '{date}', '{time}', '{now}'].map((v) => h('button', { type: 'button', class: 'chip small', onclick: () => { pattern.value += v; draw(); } }, v)));
  const names = (): string[] => items.map((e, i) => patternName(e, pattern.value, i, Number(start.value) || 0, find.value, repl.value));
  const draw = () => { const ns = names(); const dup = new Set(ns.filter((n, i) => ns.indexOf(n) !== i)); preview.replaceChildren(...items.slice(0, 40).map((e, i) => h('div', { class: 'files-preview-row' + (dup.has(ns[i]) ? ' bad' : ''), dir: 'auto' }, h('small', { class: 'src' }, e.name), h('span', null, ns[i])))); go.disabled = dup.size > 0 || ns.some((n) => !n); };
  const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => { const ns = names(); sh.close(); let ok = 0; for (let i = 0; i < items.length; i++) { if (ns[i] === items[i].name) continue; try { await plug().filesRename({ path: items[i].path, name: ns[i] }); ok++; } catch { /* next */ } } toast(t('filesRenamedN', { n: localDigits(ok) })); refresh(); } }, icon('pen'), t('rename')) as HTMLButtonElement;
  for (const el of [pattern, start, find, repl]) el.addEventListener('input', draw);
  sh.body.append(h('label', { class: 'field' }, h('span', null, t('filesPattern')), pattern), vars, h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, h('span', { class: 'label' }, t('filesStartAt')), start), h('div', { class: 'row', style: { gap: '8px' } }, find, repl), h('p', { class: 'hint' }, countItems(items.length)), preview);
  sh.actions.append(go); draw();
}

/* ---------- properties, told whole ---------- */
export async function richProperties(rows: HTMLElement, e: Entry, line: (k: string, v: string) => HTMLElement): Promise<void> {
  const pl = plug(); if (e.dir) return;
  try {
    const m = await pl.filesMeta({ path: e.path });
    if (m.exif) { const x = m.exif; const parts = [x.make && x.model ? `${x.make} ${x.model}` : x.model ?? x.make, x.width && x.height ? `${x.width}×${x.height}` : '', x.aperture ? `ƒ/${x.aperture}` : '', x.exposure ? `${Number(x.exposure) < 1 ? `1/${Math.round(1 / Number(x.exposure))}` : x.exposure} s` : '', x.iso ? `ISO ${x.iso}` : '', x.focal ? `${x.focal} mm` : '', x.taken ? String(x.taken) : ''].filter(Boolean).join(' · '); if (parts) rows.append(line(t('filesPhoto'), parts)); if (x.lat !== undefined) rows.append(h('div', { class: 'files-prop' }, h('small', { class: 'src' }, t('filesPlace')), h('a', { href: `https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lon}#map=15/${x.lat}/${x.lon}`, target: '_blank', rel: 'noopener', dir: 'ltr' }, `${Number(x.lat).toFixed(5)}, ${Number(x.lon).toFixed(5)}`))); }
    if (m.media) { const x = m.media; const dur = x.duration ? `${Math.floor(Number(x.duration) / 60000)}:${pad(Math.floor((Number(x.duration) % 60000) / 1000), 2)}` : ''; const parts = [x.title, x.artist, x.album, x.year, dur, x.width && x.height ? `${x.width}×${x.height}` : '', x.bitrate ? `${Math.round(Number(x.bitrate) / 1000)} kb/s` : ''].filter(Boolean).join(' · '); if (parts) rows.append(line(t('filesMedia'), parts)); }
    if (m.apk) { const x = m.apk; rows.append(line(t('filesApp'), [x.label, x.package, x.version ? `v${x.version}` : '', x.installedVersion ? t('filesInstalledVersion', { v: String(x.installedVersion) }) : t('filesNotInstalled'), `SDK ${x.minSdk}–${x.targetSdk}`].filter(Boolean).join(' · '))); }
  } catch { /* none */ }
  const sums = h('div', { class: 'files-prop' }, h('small', { class: 'src' }, t('filesChecksums')), h('button', { type: 'button', class: 'btn small tonal', onclick: async () => { sums.replaceChildren(h('small', { class: 'src' }, t('filesChecksums')), h('span', null, '…')); try { const r = await pl.hashFile({ path: e.path }); sums.replaceChildren(h('small', { class: 'src' }, t('filesChecksums')), ...(['md5', 'sha1', 'sha256'] as const).map((k) => h('div', { class: 'files-sum' }, h('small', { class: 'src' }, k.toUpperCase()), h('code', { dir: 'ltr' }, r[k]), iconButton('copy', t('copied'), () => { void navigator.clipboard?.writeText(r[k]); toast(t('copied')); })))); } catch (err) { sums.append(h('span', null, String((err as Error).message ?? err))); } } }, icon('shield'), t('filesCompute')));
  rows.append(sums);
}

/* ---------- the text editor ---------- */
export async function editorSheet(e: Entry, refresh: () => void): Promise<void> {
  const pl = plug(); const sh = openSheet(e.name, t('close')); sh.el.classList.add('files-editor');
  const ta = h('textarea', { class: 'files-ta', dir: 'auto', spellcheck: 'false' }) as HTMLTextAreaElement; let original = '';
  const findBox = h('input', { type: 'search', placeholder: t('filesFind'), hidden: true, dir: 'auto' }) as HTMLInputElement;
  const status = h('small', { class: 'src files-ed-status' });
  const save = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: async () => { try { await pl.filesWrite({ path: e.path, text: ta.value }); original = ta.value; save.disabled = true; toast(t('filesSaved')); refresh(); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } } }, icon('check'), t('save')) as HTMLButtonElement;
  const wrapBtn = iconButton('scroll', t('filesWrap'), () => { ta.classList.toggle('nowrap'); }); const monoBtn = iconButton('type', t('filesMono'), () => { ta.classList.toggle('mono'); });
  const findBtn = iconButton('search', t('filesFind'), () => { findBox.hidden = !findBox.hidden; if (!findBox.hidden) findBox.focus(); });
  findBox.addEventListener('keydown', (ev) => { if (ev.key !== 'Enter') return; const q = findBox.value; if (!q) return; const from = ta.selectionEnd; let i = ta.value.indexOf(q, from); if (i < 0) i = ta.value.indexOf(q); if (i >= 0) { ta.focus(); ta.setSelectionRange(i, i + q.length); } });
  ta.addEventListener('input', () => { save.disabled = ta.value === original; status.textContent = `${localDigits(ta.value.length)} ${t('filesChars')}`; });
  sh.body.append(h('div', { class: 'row files-ed-tools' }, findBtn, wrapBtn, monoBtn, status), findBox, ta);
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void pl.openWith({ path: e.path, mime: 'text/plain', title: e.name }) }, icon('external'), t('openWith')), save);
  try { const r = await pl.filesHead({ path: e.path, max: 2_000_000 }); original = r.text; ta.value = r.text; status.textContent = `${localDigits(r.text.length)} ${t('filesChars')}${r.size > 2_000_000 ? ' · ' + t('filesTooBigToEdit') : ''}`; if (r.size > 2_000_000) ta.readOnly = true; } catch (err) { ta.value = String((err as Error).message ?? err); ta.readOnly = true; }
}

/* ---------- the picture viewer: pinch to zoom, swipe between the folder's pictures ---------- */
export async function imageViewer(items: Entry[], index: number, urlOf: (p: string) => Promise<string | null>, onDelete: (e: Entry) => void): Promise<void> {
  const pl = plug(); let i = index; const sh = openSheet(items[i].name, t('close')); sh.el.classList.add('files-viewer');
  const img = h('img', { class: 'files-viewer-img', alt: '', draggable: 'false' }) as HTMLImageElement; const stage = h('div', { class: 'files-viewer-stage' }, img); const counter = h('small', { class: 'src' });
  let scale = 1, tx = 0, ty = 0; const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const title = sh.el.querySelector('.sheet-head h3') as HTMLElement | null;
  const show = async () => { const e = items[i]; if (title) title.textContent = e.name; counter.textContent = `${localDigits(i + 1)} / ${localDigits(items.length)}`; scale = 1; tx = ty = 0; apply(); img.src = (await urlOf(e.path)) ?? ''; };
  // (Pointers: one drags when zoomed or swipes to the next picture; two pinch.)
  const pts = new Map<number, { x: number; y: number }>(); let startDist = 0, startScale = 1, sx = 0, sy = 0, stx = 0, sty = 0;
  stage.addEventListener('pointerdown', (ev) => { stage.setPointerCapture(ev.pointerId); pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; startDist = Math.hypot(a.x - b.x, a.y - b.y); startScale = scale; } else { sx = ev.clientX; sy = ev.clientY; stx = tx; sty = ty; } });
  stage.addEventListener('pointermove', (ev) => { if (!pts.has(ev.pointerId)) return; pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; scale = Math.max(1, Math.min(6, startScale * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, startDist))); apply(); } else if (scale > 1) { tx = stx + (ev.clientX - sx); ty = sty + (ev.clientY - sy); apply(); } });
  const up = (ev: PointerEvent) => { if (!pts.has(ev.pointerId)) return; pts.delete(ev.pointerId); if (pts.size === 0 && scale === 1) { const dx = ev.clientX - sx; if (Math.abs(dx) > 60) { i = (i + (dx < 0 ? 1 : -1) + items.length) % items.length; void show(); } } };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('dblclick', () => { scale = scale > 1 ? 1 : 2.5; tx = ty = 0; apply(); });
  sh.body.append(stage, h('div', { class: 'row files-viewer-bar' }, iconButton('chevronLeft', t('previous'), () => { i = (i - 1 + items.length) % items.length; void show(); }), counter, iconButton('chevronRight', t('next'), () => { i = (i + 1) % items.length; void show(); })));
  sh.actions.append(
    h('button', { type: 'button', class: 'btn tonal small', onclick: () => void pl.shareFile({ path: items[i].path, title: items[i].name }) }, icon('share'), t('share')),
    h('button', { type: 'button', class: 'btn tonal small', onclick: () => void pl.filesWallpaper({ path: items[i].path }).then(() => toast(t('filesWallpaperSet'))).catch((err) => toast(String((err as Error).message ?? err), 'error')) }, icon('images'), t('filesSetWallpaper')),
    h('button', { type: 'button', class: 'btn tonal small', onclick: () => void pl.openWith({ path: items[i].path, mime: 'image/*', title: items[i].name }) }, icon('external'), t('openWith')),
    h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const e = items[i]; sh.close(); onDelete(e); } }, icon('trash'), t('delete')));
  await show();
}

/* ---------- the storage analyzer ---------- */
type Report = { total: number; files: number; largest: Entry[]; old: Entry[]; screenshots: Entry[]; screenshotsSize: number; screenshotsCount: number; temp: Entry[]; tempSize: number; tempCount: number; apks: Entry[]; duplicates: { size: number; files: Entry[] }[]; duplicatesSize: number; kinds: { kind: string; size: number; count: number }[]; folders: { path: string; size: number; count: number }[] };
type APlug = Plug & { filesAnalyze(o: { path: string }): Promise<Report>; filesAnalyzeStop(): Promise<void>; addListener(ev: string, fn: (d: { id: string; status: string; files?: number; name?: string }) => void): Promise<{ remove(): void }> };
const KIND_LABEL: Record<string, string> = { image: 'filesKindImages', audio: 'filesKindMusic', video: 'filesKindVideo', doc: 'filesKindDocs', archive: 'filesKindArchives', apk: 'filesKindApps', other: 'filesKindOther' };
export async function analyzerSheet(root: { name: string; path: string; total?: number; free?: number }, open: (e: Entry) => void, goTo: (dir: string) => void, del: (paths: string[]) => void): Promise<void> {
  const pl = plug() as APlug; const sh = openSheet(t('filesAnalyzer'), t('close')); sh.el.classList.add('files-analyzer');
  const status = h('p', { class: 'hint', dir: 'auto' }, t('filesAnalyzing', { name: root.name })); const body = h('div'); sh.body.append(status, body);
  const sub = await pl.addListener('files', (d) => { if (d.id === 'analyze' && d.status === 'progress') status.textContent = `${t('filesAnalyzing', { name: root.name })} · ${countItems(d.files ?? 0)} · ${d.name ?? ''}`; });
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void pl.filesAnalyzeStop() }, t('cancel')));
  let rep: Report;
  try { rep = await pl.filesAnalyze({ path: root.path }); } catch (err) { status.textContent = String((err as Error).message ?? err); sub.remove(); return; }
  sub.remove(); sh.actions.replaceChildren();
  const used = root.total && root.free !== undefined ? root.total - root.free : rep.total;
  status.replaceChildren(h('b', null, `${formatBytes(rep.total)} · ${countItems(rep.files)}`), h('br'), h('small', { class: 'src' }, root.total ? t('filesFreeOf', { free: formatBytes(root.free ?? 0), total: formatBytes(root.total) }) + ` · ${t('filesUsed')} ${formatBytes(used)}` : ''));
  // the tabs
  const tabs: [string, string, () => HTMLElement][] = [
    ['kinds', t('filesByKind'), () => h('div', { class: 'files-kinds-bars' }, ...rep.kinds.sort((a, b) => b.size - a.size).map((k) => h('div', { class: 'files-kind-row' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', null, t((KIND_LABEL[k.kind] ?? 'filesKindOther') as 'filesKindOther')), h('small', { class: 'src' }, `${formatBytes(k.size)} · ${countItems(k.count)}`)), h('div', { class: 'files-usage-bar' }, h('i', { style: { width: `${rep.total ? Math.round((k.size / rep.total) * 100) : 0}%` } })))))],
    ['folders', t('filesBiggestFolders'), () => h('div', { class: 'dest-list' }, ...rep.folders.map((f) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); goTo(f.path); } }, icon('folder'), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, baseOf(f.path) || f.path), h('small', { class: 'src', dir: 'ltr' }, f.path)), h('small', { class: 'src' }, `${formatBytes(f.size)} · ${countItems(f.count)}`))))],
    ['largest', t('filesLargestFiles'), () => fileList(rep.largest)],
    ['dups', `${t('filesDuplicates')} · ${formatBytes(rep.duplicatesSize)}`, () => h('div', null, h('p', { class: 'hint' }, t('filesDuplicatesHint')), ...rep.duplicates.map((g) => h('div', { class: 'files-dup-group' }, h('small', { class: 'src' }, `${formatBytes(g.size)} × ${localDigits(g.files.length)}`), fileList(g.files, g.files.slice(1).map((x) => x.path)))))],
    ['old', t('filesOldFiles'), () => fileList(rep.old)],
    ['shots', `${t('filesScreenshots')} · ${formatBytes(rep.screenshotsSize)}`, () => fileList(rep.screenshots)],
    ['temp', `${t('filesLeftovers')} · ${formatBytes(rep.tempSize)}`, () => fileList(rep.temp)],
    ['apks', t('filesKindApps'), () => fileList(rep.apks)],
  ];
  function fileList(items: Entry[], preselect: string[] = []): HTMLElement {
    const picked = new Set(preselect); const bar = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', margin: '6px 0' } });
    const drawBar = () => bar.replaceChildren(h('button', { type: 'button', class: 'chip small', onclick: () => { for (const e of items) picked.add(e.path); redraw(); } }, t('filesSelectAll')), h('button', { type: 'button', class: 'chip small', onclick: () => { picked.clear(); redraw(); } }, t('filesNone')), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn small primary danger', disabled: !picked.size, onclick: () => { sh.close(); del([...picked]); } }, icon('trash'), `${t('delete')} (${localDigits(picked.size)})`));
    const list = h('div', { class: 'dest-list' });
    const redraw = () => { drawBar(); list.replaceChildren(...items.map((e) => h('label', { class: 'dest-row' + (picked.has(e.path) ? ' on' : '') }, h('input', { type: 'checkbox', checked: picked.has(e.path), onchange: (ev: Event) => { if ((ev.target as HTMLInputElement).checked) picked.add(e.path); else picked.delete(e.path); redraw(); } }), h('span', { class: 'grow files-main', onclick: (ev: Event) => { ev.preventDefault(); sh.close(); open(e); } }, h('span', { class: 'name', dir: 'auto' }, e.name), h('small', { class: 'src', dir: 'ltr' }, `${formatBytes(e.size)} · ${formatDate(e.mtime)} · ${e.path.slice(0, e.path.length - e.name.length - 1)}`))))); if (!items.length) list.append(h('p', { class: 'hint' }, t('filesNothingHere'))); };
    redraw(); return h('div', null, bar, list);
  }
  const chips = h('div', { class: 'chip-row files-an-tabs' }); const pane = h('div');
  let cur = 'kinds';
  const drawTabs = () => { chips.replaceChildren(...tabs.map(([k, label]) => h('button', { type: 'button', class: 'chip small' + (cur === k ? ' on' : ''), onclick: () => { cur = k; drawTabs(); pane.replaceChildren(tabs.find(([x]) => x === k)![2]()); } }, label))); };
  drawTabs(); pane.replaceChildren(tabs[0][2]()); body.append(chips, pane);
}

/** An archive's facts for the properties sheet: the format, how many files, the size inside, how far squeezed. */
export async function archiveProperties(rows: HTMLElement, e: Entry, line: (k: string, v: string) => HTMLElement): Promise<void> {
  if (e.dir || !/\.(zip|7z|rar|tar|gz|tgz|xz|bz2|cbz|001)$/i.test(e.name)) return;
  try { const { listArchive } = await import('../archives'); const info = await listArchive(e.path); const files = info.entries.filter((x) => !x.dir).length; const ratio = info.total > 0 && e.size > 0 ? Math.round((e.size / info.total) * 100) : 0; rows.append(line(t('filesArchive'), [info.format.toUpperCase(), countItems(files), info.total > 0 ? `${formatBytes(info.total)} ${t('filesInside')}` : '', ratio ? t('packedTo', { pct: localDigits(ratio) }) : '', info.encrypted ? t('encrypted') : ''].filter(Boolean).join(' · '))); } catch { /* not readable */ }
}
