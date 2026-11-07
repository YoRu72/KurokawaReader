// A torrent's files, as a file manager shows them (Flud's Files tab): its folders to walk into and out of, each
// file with its progress and a box — ticked to download it, cleared to leave it out — and a folder's box for all it
// holds; a search, Finished / Not finished, the kinds of file it holds (videos, ebooks, subtitles…), All / None /
// Invert for what is shown; a star for the file wanted first. The choice is sent once you stop changing it, and a
// finished torrent given more files goes on downloading.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { isVideo } from '../engine';
import type { Engine, Task, TaskFile } from '../engine/types';
import { localPathOf } from '../engine/localPath';

export type FileKind = 'video' | 'audio' | 'ebook' | 'image' | 'sub' | 'archive' | 'doc' | 'other';
const KINDS: [FileKind, RegExp][] = [
  ['audio', /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|alac|ape|mka)$/i],
  ['ebook', /\.(epub|mobi|azw3?|fb2|cbz|cbr|cb7|djvu|kfx)$/i],
  ['image', /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|hif|tiff?|svg|ico|wbmp|jfif|apng)$/i],
  ['sub', /\.(ass|ssa|srt|vtt|sup|idx|sub)$/i],
  ['archive', /\.(zip|rar|7z|tar|gz|bz2|xz|zst|iso|r\d\d)$/i],
  ['doc', /\.(pdf|txt|nfo|docx?|md|html?|rtf)$/i],
];
export const kindOfFile = (p: string): FileKind => (isVideo(p) ? 'video' : KINDS.find(([, re]) => re.test(p))?.[0] ?? 'other');
const KIND_ICON: Record<FileKind, string> = { video: 'film', audio: 'music', ebook: 'books', image: 'images', sub: 'subtitles', archive: 'archive', doc: 'file', other: 'file' };
const KIND_LABEL: Record<FileKind, 'kindVideos' | 'kindAudio' | 'kindEbooks' | 'kindImages' | 'kindSubs' | 'kindArchives' | 'kindDocs' | 'kindOther'> = { video: 'kindVideos', audio: 'kindAudio', ebook: 'kindEbooks', image: 'kindImages', sub: 'kindSubs', archive: 'kindArchives', doc: 'kindDocs', other: 'kindOther' };

type Prio = 0 | 1 | 2;
interface Folder { name: string; path: string; dirs: Map<string, Folder>; files: TaskFile[] }

/** The folder tree of a torrent's files (the release's own top folder, shared by all, left out). */
export function treeOf(files: TaskFile[]): { root: Folder; strip: number } {
  const first = files[0]?.path ?? ''; const top = first.includes('/') ? first.slice(0, first.indexOf('/') + 1) : '';
  const strip = top && files.length > 1 && files.every((f) => f.path.startsWith(top)) ? top.length : 0;
  const root: Folder = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.slice(strip).split('/'); parts.pop(); let at = root;
    for (const p of parts) { let d = at.dirs.get(p); if (!d) { d = { name: p, path: at.path ? `${at.path}/${p}` : p, dirs: new Map(), files: [] }; at.dirs.set(p, d); } at = d; }
    at.files.push(f);
  }
  return { root, strip };
}
const allIn = (d: Folder): TaskFile[] => [...d.files, ...[...d.dirs.values()].flatMap(allIn)];

export interface FilesCard { el: HTMLElement; update(x: Task): void }
export function filesCard(task: Task, eng: Engine, opts: { open: boolean; onToggle(open: boolean): void; play(index: number): void; browse?(path: string): void }): FilesCard {
  let x = task; let at = ''; let query = ''; let state: 'all' | 'done' | 'todo' = 'all'; let kind: FileKind | '' = '';
  // (Choices made here and not yet confirmed by the engine win over what it reports in the meantime.)
  const mine = new Map<number, Prio>(); let sendTimer = 0;
  const prio = (f: TaskFile): Prio => mine.get(f.index) ?? f.priority;
  const send = () => {
    clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => {
      if (!eng.setFiles) return; const p = x.files.map((f) => prio(f));
      if (!p.some((v) => v > 0)) { toast(t('pickNoneChosen'), 'error'); return; }
      void eng.setFiles(x.id, p).then(() => { setTimeout(() => { for (const f of x.files) if (mine.get(f.index) === f.priority) mine.delete(f.index); }, 2500); }).catch((e: unknown) => toast(String((e as Error).message ?? e), 'error'));
    }, 450);
  };
  const setMany = (fs: TaskFile[], v: (f: TaskFile) => Prio) => { for (const f of fs) mine.set(f.index, v(f)); draw(); send(); };

  const search = h('input', { type: 'search', class: 'kt-files-search', placeholder: t('filesSearch'), oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
  const states = h('div', { class: 'chip-row kt-files-states' });
  const kinds = h('div', { class: 'chip-row kt-files-kinds' });
  const bulk = h('div', { class: 'chip-row kt-files-bulk' });
  const crumbs = h('div', { class: 'kt-files-crumbs' });
  const list = h('div', { class: 'file-rows kt-files-list' });
  const total = h('p', { class: 'models-total' });
  const summary = h('small', { class: 'src' });
  const el = h('details', { class: 'card kt-files', open: opts.open, ontoggle: (e: Event) => opts.onToggle((e.target as HTMLDetailsElement).open) },
    h('summary', null, h('h3', null, t('filesTitle')), summary),
    h('div', { class: 'kt-files-tools' }, search, states, kinds, bulk), crumbs, list, total);

  const chip = (label: string, on: boolean, fn: () => void, ic?: string) => h('button', { type: 'button', class: 'chip small' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, ic ? icon(ic) : null, label);
  const box = (on: boolean | 'mixed', fn: (v: boolean) => void, label: string) => {
    const b = h('input', { type: 'checkbox', class: 'kt-file-box', checked: on === true, 'aria-label': label, disabled: !eng.setFiles, onclick: (e: Event) => e.stopPropagation(), onchange: (e: Event) => fn((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
    b.indeterminate = on === 'mixed'; return b;
  };
  const pct = (done: number, size: number) => (size ? Math.min(100, (done / size) * 100) : 0);
  const bar = (p: number) => h('span', { class: 'kt-file-bar' }, h('span', { style: `width:${p.toFixed(1)}%` }));
  const localOf = (f: TaskFile) => localPathOf(x, f.index);
  const finished = (f: TaskFile) => f.size > 0 && f.done >= f.size;

  const fileRow = (f: TaskFile, strip: number, showDir: boolean) => {
    const p = prio(f); const name = f.path.split('/').pop() ?? f.path; const k = kindOfFile(f.path);
    const dir = showDir ? f.path.slice(strip, f.path.length - name.length).replace(/\/$/, '') : '';
    const status = finished(f) ? t('fileFinished') : p === 0 ? t('fileSkipped') : `${Math.floor(pct(f.done, f.size))}%`;
    const playable = k === 'video' && p > 0 && (!!eng.streamUrl || finished(f));
    return h('div', { class: 'file-row kt-file' + (p === 0 ? ' off' : '') + (p === 2 ? ' high' : '') },
      h('span', { class: 'kt-file-ic' }, icon(KIND_ICON[k])),
      h('span', { class: 'grow kt-file-main' },
        h('span', { class: 'kt-file-name', dir: 'auto' }, name),
        bar(pct(f.done, f.size)),
        h('small', { class: 'src', dir: 'auto' }, `${formatBytes(f.done)} / ${formatBytes(f.size)} · ${status}${dir ? ` · ${dir}` : ''}`)),
      playable ? iconButton('play', t('play'), () => opts.play(f.index)) : null,
      k !== 'video' && k !== 'archive' && finished(f) && eng.open ? iconButton('external', t('open'), () => void eng.open!(x.id, f.index).catch((er: unknown) => toast(String((er as Error).message ?? er), 'error'))) : null,
      k === 'archive' && finished(f) && opts.browse && localOf(f) ? iconButton('folder', t('archiveBrowse'), () => opts.browse!(localOf(f)!)) : null,
      eng.setFiles && p > 0 && !finished(f) ? iconButton('star', p === 2 ? t('fileNormalAgain') : t('fileFirst'), () => setMany([f], () => (p === 2 ? 1 : 2)), { pressed: p === 2 }) : null,
      // (A file with something on the disk, in a torrent of several: deleted by itself, the rest kept.)
      eng.setFiles && f.done > 0 && x.files.length > 1 && localOf(f) ? iconButton('trash', t('fileDelete'), () => askDelete(f, name)) : null,
      box(p > 0, (v) => setMany([f], () => (v ? 1 : 0)), name));
  };
  const askDelete = (f: TaskFile, name: string) => {
    const c = openSheet(t('fileDelete'), t('close'), { stack: true }); c.body.append(h('p', { dir: 'auto' }, t('fileDeleteAsk', { name })));
    c.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => c.close() }, t('cancel')), h('button', { type: 'button', class: 'btn primary danger', onclick: async () => {
      c.close(); mine.set(f.index, 0); draw();
      try { const { deleteTaskFile } = await import('../downloads/deleteFile'); await deleteTaskFile(x, f.index); toast(t('fileDeleted', { name })); } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
    } }, icon('trash'), t('epDeleteYes')));
  };
  const folderRow = (d: Folder) => {
    const fs = allIn(d); const on = fs.filter((f) => prio(f) > 0).length; const size = fs.reduce((n, f) => n + f.size, 0); const done = fs.reduce((n, f) => n + f.done, 0);
    return h('div', { class: 'file-row kt-file kt-folder' + (on ? '' : ' off'), role: 'button', tabindex: '0', onclick: () => { at = d.path; draw(); }, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { at = d.path; draw(); } } },
      h('span', { class: 'kt-file-ic' }, icon('folder')),
      h('span', { class: 'grow kt-file-main' }, h('span', { class: 'kt-file-name', dir: 'auto' }, d.name), bar(pct(done, size)),
        h('small', { class: 'src' }, `${t('selectedFiles', { n: localDigits(on), total: localDigits(fs.length) })} · ${formatBytes(size)}`)),
      box(on === 0 ? false : on === fs.length ? true : 'mixed', (v) => setMany(fs, () => (v ? 1 : 0)), d.name));
  };

  function draw() {
    const { root, strip } = treeOf(x.files);
    let here = root; if (at) for (const p of at.split('/')) { const d = here.dirs.get(p); if (!d) { at = ''; here = root; break; } here = d; }
    const flat = !!query || state !== 'all' || !!kind; // (a search or a filter: every match, wherever it is)
    const pass = (f: TaskFile) => (!query || f.path.toLowerCase().includes(query)) && (state === 'all' || (state === 'done') === finished(f)) && (!kind || kindOfFile(f.path) === kind);
    const shown = flat ? x.files.filter(pass) : allIn(here);
    // The filters
    const present = [...new Set(x.files.map((f) => kindOfFile(f.path)))];
    states.replaceChildren(chip(t('filterAll'), state === 'all', () => { state = 'all'; draw(); }), chip(t('fileFinished'), state === 'done', () => { state = 'done'; draw(); }), chip(t('fileNotFinished'), state === 'todo', () => { state = 'todo'; draw(); }));
    kinds.hidden = present.length < 2; kinds.replaceChildren(...present.map((k) => chip(t(KIND_LABEL[k]), kind === k, () => { kind = kind === k ? '' : k; draw(); }, KIND_ICON[k])));
    bulk.hidden = !eng.setFiles;
    bulk.replaceChildren(chip(t('filesAll'), false, () => setMany(shown, () => 1)), chip(t('filesNone'), false, () => setMany(shown, () => 0)), chip(t('pickInvert'), false, () => setMany(shown, (f) => (prio(f) > 0 ? 0 : 1))));
    // Where in the tree
    crumbs.hidden = flat || !root.dirs.size;
    if (!crumbs.hidden) {
      const parts = at ? at.split('/') : [];
      crumbs.replaceChildren(h('button', { type: 'button', class: 'chip small', onclick: () => { at = ''; draw(); } }, icon('folder'), x.name || t('filesTitle')),
        ...parts.map((p, i) => [h('span', { class: 'kt-crumb-sep' }, '›'), h('button', { type: 'button', class: 'chip small', onclick: () => { at = parts.slice(0, i + 1).join('/'); draw(); } }, p)]).flat());
    }
    const rows: HTMLElement[] = [];
    if (flat) rows.push(...shown.map((f) => fileRow(f, strip, true)));
    else {
      if (at) rows.push(h('div', { class: 'file-row kt-file kt-folder up', role: 'button', tabindex: '0', onclick: () => { at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''; draw(); } }, h('span', { class: 'kt-file-ic' }, icon('up')), h('span', { class: 'grow kt-file-name' }, '..')));
      rows.push(...[...here.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(folderRow));
      rows.push(...[...here.files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })).map((f) => fileRow(f, strip, false)));
    }
    if (!rows.length) rows.push(h('p', { class: 'empty small' }, t('filesNoMatch')));
    list.replaceChildren(...rows);
    const sel = x.files.filter((f) => prio(f) > 0);
    const line = `${t('selectedFiles', { n: localDigits(sel.length), total: localDigits(x.files.length) })} · ${formatBytes(sel.reduce((n, f) => n + f.size, 0))}`;
    total.textContent = line; summary.textContent = line;
  }
  draw();
  return { el, update(n) { const changed = n.name !== x.name || n.files.length !== x.files.length || n.files.some((f, i) => f.done !== x.files[i]?.done || f.priority !== x.files[i]?.priority); x = n; if (changed) draw(); } };
}
