// The Files add-on: the device's folders as a file manager shows them (Solid Explorer's shape, ZArchiver's speed):
// the storages (the app's folder, the phone, SD cards, USB drives) with their free space, breadcrumbs, a list or a
// grid, sorted by name / date / size / type with folders first, filtered by kind (images, music, video, documents,
// archives, apps), hidden files, a search within the folder; files opened in the app (the player, the archives, the
// installer) or by any app (Open with…, Open as a kind); a selection (held) copied, cut, pasted, deleted, renamed,
// shared, zipped, with properties; the operations as jobs with their progress and a question when a name is taken;
// what other apps share to «Save to device» saved where you choose.
import { h, icon, iconButton, toast, openSheet, pickSheet, onLongPress } from '../ui/dom';
import { t, formatBytes, formatDate, localDigits, countFiles, countItems, countFolders } from '../i18n';
import { ktPlugin, listen, nativePlatform } from '../native';
import { navigate } from '../router';
import { kindOfFile } from './taskFiles';

export interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number; ext?: string; hidden?: boolean; count?: number }
interface Root { kind: string; path: string; name: string; readable: boolean; free?: number; total?: number; appFolder?: string }
type JobEvent = { id: string; status: 'progress' | 'conflict' | 'done' | 'cancelled' | 'failed'; done?: number; total?: number; files?: number; ofFiles?: number; name?: string; from?: string; to?: string; size?: number; existingSize?: number; mtime?: number; existingMtime?: number; dir?: boolean; failed?: string[]; message?: string };
type Plug = {
  filesList(o: { path: string; counts?: boolean; hidden?: boolean }): Promise<{ exists: boolean; entries: Entry[]; truncated?: boolean }>;
  filesRoots(): Promise<{ allFiles: boolean; roots: Root[] }>;
  filesStat(o: { path: string; id?: string }): Promise<Entry & { exists: boolean; files?: number; folders?: number; mime?: string; readable: boolean; writable: boolean }>;
  filesThumb(o: { path: string; px: number }): Promise<{ url: string | null }>;
  filesMkdir(o: { path: string }): Promise<{ ok: boolean; path: string }>;
  filesRename(o: { path: string; name: string }): Promise<{ ok: boolean; path: string }>;
  filesSearch(o: { path: string; q: string; hidden?: boolean }): Promise<{ entries: Entry[] }>;
  filesHead(o: { path: string; max?: number }): Promise<{ text: string; size: number }>;
  filesJob(o: { id?: string; op: 'copy' | 'move' | 'delete'; paths: string[]; dest?: string; conflict?: string }): Promise<{ id: string }>;
  filesCancel(o: { id: string }): Promise<void>; filesAnswer(o: { id: string; answer: string }): Promise<void>;
  filesAccess(o: { ask?: boolean }): Promise<{ all: boolean }>; filesCollection(o: { kind: string; limit?: number }): Promise<{ entries: Entry[] }>;
  sharedPending(): Promise<{ items: { uri: string; name: string; size: number; mime: string }[] }>; sharedSave(o: { dir: string; clear?: boolean }): Promise<{ saved: string[]; failed: string[]; dir: string }>; sharedClear(): Promise<void>;
  openChooser(o: { path: string; mime?: string; title: string }): Promise<void>; openWith(o: { path: string; mime: string; title: string }): Promise<void>; shareFile(o: { path: string; title: string }): Promise<void>;
  defaultDir(): Promise<{ dir: string }>;
};
type Desk = { listDir?(p: string): Promise<{ entries: Entry[] }>; openPath?(p: string): Promise<unknown>; homeDir?(): Promise<string> };
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Partial<Plug> | null; return p?.filesList ? (p as Plug) : null; };
const desk = (): Desk | null => (window.kurokawaTools as unknown as Desk | undefined) ?? null;
export const canBrowseFiles = (): boolean => !!(plug() || desk()?.listDir);

/* ---------- what is kept: the view, the sort, hidden files, the last folder, the clipboard ---------- */
type Prefs = { view: 'list' | 'grid'; sort: 'name' | 'date' | 'size' | 'type'; desc: boolean; hidden: boolean; last?: string; kind: string };
const PREFS = 'kt.files.prefs';
const prefs: Prefs = { view: 'grid', sort: 'name', desc: false, hidden: false, kind: 'all', ...(() => { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>; } catch { return {}; } })() };
const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* none */ } };
let clipboard: { op: 'copy' | 'move'; paths: string[] } | null = null;

const KINDS: [string, string, RegExp | null][] = [['all', 'filesKindAll', null], ['image', 'filesKindImages', /^(jpe?g|png|gif|webp|bmp|heic|avif|svg)$/], ['audio', 'filesKindMusic', /^(mp3|m4a|flac|ogg|opus|wav|aac|wma)$/], ['video', 'filesKindVideo', /^(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv|3gp)$/], ['doc', 'filesKindDocs', /^(pdf|epub|mobi|azw3?|docx?|xlsx?|pptx?|txt|md|rtf|odt|cbz|cbr)$/], ['archive', 'filesKindArchives', /^(zip|7z|rar|tar|gz|tgz|xz|bz2|zst|lz4|iso|001)$/], ['apk', 'filesKindApps', /^(apk|apks|xapk|apkm)$/]];
const ICON: Record<string, string> = { video: 'film', audio: 'music', ebook: 'books', image: 'images', sub: 'subtitles', archive: 'archive', doc: 'file', other: 'file' };
const MIMES: [string, string, string][] = [['image/*', 'filesAsImage', 'images'], ['audio/*', 'filesAsMusic', 'music'], ['video/*', 'filesAsVideo', 'film'], ['text/plain', 'filesAsText', 'type'], ['application/pdf', 'filesAsDocument', 'file'], ['application/zip', 'filesAsArchive', 'archive'], ['*/*', 'filesAsAny', 'apps']];
const mimeOf = (p: string): string => { const k = kindOfFile(p); if (/\.(txt|nfo|md|srt|ass|vtt|json|xml|log|csv|ini|cfg)$/i.test(p)) return 'text/plain'; if (/\.pdf$/i.test(p)) return 'application/pdf'; if (/\.apk$/i.test(p)) return 'application/vnd.android.package-archive'; return ({ video: 'video/*', audio: 'audio/*', image: 'image/*', ebook: 'application/epub+zip', archive: 'application/zip' } as Record<string, string>)[k] ?? '*/*'; };
const parentOf = (p: string): string => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const baseOf = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p;

/* ---------- the listing ---------- */
async function listDir(path: string): Promise<{ exists: boolean; entries: Entry[]; truncated?: boolean }> {
  const p = plug(); if (p) return p.filesList({ path, counts: true, hidden: prefs.hidden });
  const d = desk(); if (d?.listDir) { const r = await d.listDir(path); return { exists: true, entries: (r.entries ?? []).filter((e) => prefs.hidden || !e.name.startsWith('.')).map((e) => ({ ...e, ext: e.dir ? undefined : (e.name.split('.').pop() ?? '').toLowerCase() })) }; }
  return { exists: false, entries: [] };
}
function sortEntries(list: Entry[]): Entry[] {
  const col = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const by = (a: Entry, b: Entry): number => prefs.sort === 'date' ? (a.mtime - b.mtime) || col.compare(a.name, b.name) : prefs.sort === 'size' ? (a.size - b.size) || col.compare(a.name, b.name) : prefs.sort === 'type' ? col.compare(a.ext ?? '', b.ext ?? '') || col.compare(a.name, b.name) : col.compare(a.name, b.name);
  return list.sort((a, b) => Number(b.dir) - Number(a.dir) || (prefs.desc ? -by(a, b) : by(a, b)));
}
const kindRe = (): RegExp | null => KINDS.find(([k]) => k === prefs.kind)?.[2] ?? null;

/* ---------- the view ---------- */
const COLLECTIONS: [string, string, string][] = [['recent', 'filesRecent', 'history'], ['image', 'filesKindImages', 'images'], ['audio', 'filesKindMusic', 'music'], ['video', 'filesKindVideo', 'film'], ['doc', 'filesKindDocs', 'file'], ['archive', 'filesKindArchives', 'archive'], ['apk', 'filesKindApps', 'apps']];
const BOOKMARKS = 'kt.files.bookmarks';
const bookmarks = (): { name: string; path: string }[] => { try { return JSON.parse(localStorage.getItem(BOOKMARKS) ?? '[]') as { name: string; path: string }[]; } catch { return []; } };
const saveBookmarks = (b: { name: string; path: string }[]) => { try { localStorage.setItem(BOOKMARKS, JSON.stringify(b)); } catch { /* none */ } };
/** The day a file belongs to, for the section headers: today, yesterday, else its date. */
const dayOf = (ms: number): string => { const d = new Date(ms); const now = new Date(); const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); if (same(d, now)) return t('today'); const y = new Date(now); y.setDate(y.getDate() - 1); if (same(d, y)) return t('yesterday'); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); };

export function filesView(route: { p?: string; save?: string; c?: string }): HTMLElement {
  const body = h('div', { class: 'files-body' });
  const crumbs = h('div', { class: 'files-crumbs', dir: 'ltr' }); const rootsRow = h('div', { class: 'chip-row files-roots' }); const kindRow = h('div', { class: 'chip-row files-kinds' });
  const listEl = h('div', { class: 'files-list' }); const status = h('p', { class: 'hint files-status' }); const jobsEl = h('div', { class: 'files-jobs' });
  const search = h('input', { type: 'search', class: 'files-search', placeholder: t('filesSearchHere'), hidden: true, oninput: () => { query = search.value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
  const selBar = h('div', { class: 'files-selbar', hidden: true });
  const pasteBtn = iconButton('copy', t('filesPaste'), () => void paste()); pasteBtn.hidden = !clipboard;
  const titleEl = h('span', { class: 'files-title', dir: 'auto' }, t('navFiles')); const subEl = h('small', { class: 'files-sub' });
  const fab = h('button', { type: 'button', class: 'fab files-fab', 'aria-label': t('newFolder'), onclick: () => fabSheet() }, icon('plus'));
  const root = h('div', { class: 'view files-view' },
    h('header', { class: 'topbar' }, iconButton('menu', t('filesDrawer'), () => drawer()), h('div', { class: 'title files-head' }, titleEl, subEl), h('div', { class: 'topbar-actions' },
      iconButton('search', t('search'), () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; query = ''; draw(); } }),
      pasteBtn,
      iconButton(prefs.view === 'grid' ? 'list' : 'grid', t('filesView'), () => { prefs.view = prefs.view === 'grid' ? 'list' : 'grid'; savePrefs(); navigate(`/files?p=${encodeURIComponent(at)}`, true); }),
      iconButton('sort', t('sortBy'), () => sortSheet()),
      iconButton('more', t('more'), () => moreSheet()))),
    search, rootsRow, crumbs, kindRow, body, selBar, fab) as HTMLElement & { dispose?: () => void };
  body.append(listEl, status, jobsEl);
  let at = route.p ?? (route.c ? '' : prefs.last ?? ''); let collection: string | null = route.c ?? null; let entries: Entry[] = []; let query = ''; let selecting = false; const picked = new Set<string>(); let roots: Root[] = []; let allFiles = true; let gone = false;
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { const el = e.target as HTMLElement; io.unobserve(el); const p = el.dataset.thumb; if (p) void thumbInto(el, p); } }, { rootMargin: '300px 0px' });
  const thumbInto = async (el: HTMLElement, path: string) => { const pl = plug(); if (!pl) return; try { const r = await pl.filesThumb({ path, px: prefs.view === 'grid' ? 240 : 96 }); if (r.url && el.isConnected) { el.replaceChildren(h('img', { src: r.url, alt: '', loading: 'lazy' })); el.classList.add('has-img'); } } catch { /* the icon stays */ } };

  // ---- the storages and the way here
  const loadRoots = async () => {
    const pl = plug();
    if (pl) { try { const r = await pl.filesRoots(); roots = r.roots; allFiles = r.allFiles; } catch { roots = []; } }
    else { const d = desk(); const home = d?.homeDir ? await d.homeDir().catch(() => '') : ''; roots = home ? [{ kind: 'phone', path: home, name: t('filesHome'), readable: true }] : []; }
    rootsRow.replaceChildren(...roots.map((r) => h('button', { type: 'button', class: 'chip' + (at === r.path || at.startsWith(r.path + '/') ? ' on' : ''), onclick: () => { if (!r.readable) { void askAccess(); return; } go(r.path); } },
      icon(r.kind === 'app' ? 'download' : r.kind === 'sd' ? 'storage' : r.kind === 'usb' ? 'storage' : 'storage'), h('span', null, r.name), r.free !== undefined ? h('small', { class: 'src' }, ` ${formatBytes(r.free)}`) : null)));
    if (!at) { at = roots[0]?.path ?? ''; }
  };
  const askAccess = async () => { const pl = plug(); if (!pl) return; const sh = openSheet(t('filesAccessTitle'), t('close')); sh.body.append(h('p', { class: 'hint' }, t('filesAccessHint'))); sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); void pl.filesAccess({ ask: true }); } }, icon('key'), t('filesAccessAllow'))); };
  const drawCrumbs = () => {
    if (collection) { const c = COLLECTIONS.find(([k]) => k === collection); crumbs.replaceChildren(h('button', { type: 'button', class: 'crumb', onclick: () => drawer() }, t((c?.[1] ?? 'filesRecent') as 'filesRecent'))); titleEl.textContent = t((c?.[1] ?? 'filesRecent') as 'filesRecent'); return; }
    titleEl.textContent = at === (roots.find((x) => x.path === at)?.path) ? (roots.find((x) => x.path === at)?.name ?? baseOf(at)) : baseOf(at) || t('navFiles');
    const r = roots.find((x) => at === x.path || at.startsWith(x.path + '/')); const base = r?.path ?? '/'; const rest = at.slice(base.length).split('/').filter(Boolean);
    const parts: HTMLElement[] = [h('button', { type: 'button', class: 'crumb', onclick: () => go(base) }, r?.name ?? '/')];
    let acc = base; for (const seg of rest) { acc += `/${seg}`; const p = acc; parts.push(h('span', { class: 'crumb-sep' }, '›'), h('button', { type: 'button', class: 'crumb', onclick: () => go(p) }, seg)); }
    crumbs.replaceChildren(...parts); crumbs.scrollLeft = crumbs.scrollWidth;
  };
  const drawKinds = () => kindRow.replaceChildren(...KINDS.map(([k, label]) => h('button', { type: 'button', class: 'chip small' + (prefs.kind === k ? ' on' : ''), onclick: () => { prefs.kind = k; savePrefs(); drawKinds(); draw(); } }, t(label as 'filesKindAll'))));

  // ---- the folder
  const go = (path: string) => { if (gone) return; collection = null; at = path.replace(/\/+$/, '') || '/'; prefs.last = at; savePrefs(); picked.clear(); selecting = false; search.value = ''; query = ''; search.hidden = true; navigate(`/files?p=${encodeURIComponent(at)}`, true); void load(); };
  const openCollection = (kind: string) => { if (gone) return; collection = kind; picked.clear(); selecting = false; query = ''; search.hidden = true; navigate(`/files?c=${kind}`, true); void load(); };
  const load = async () => {
    drawCrumbs(); listEl.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner small' }))); status.textContent = ''; fab.hidden = !!collection;
    try {
      if (collection) { const pl = plug(); const r = pl ? await pl.filesCollection({ kind: collection, limit: 600 }) : { entries: [] }; if (gone) return; entries = r.entries; }
      else { const r = await listDir(at); if (gone) return; entries = r.entries; if (!r.exists) { status.textContent = t('folderNotFound'); } if (r.truncated) toast(t('filesTruncated'), 'info'); }
    }
    catch (e) { entries = []; status.textContent = String((e as Error).message ?? e); }
    draw(); drawSel();
  };
  const shown = (): Entry[] => { const re = kindRe(); const list = entries.filter((e) => (!re || e.dir || re.test(e.ext ?? '')) && (!query || e.name.toLowerCase().includes(query))); return collection ? list.sort((a, b) => b.mtime - a.mtime) : sortEntries(list); };
  const draw = () => {
    const list = shown(); listEl.className = `files-list ${prefs.view}`;
    if (!list.length) { subEl.textContent = ''; listEl.replaceChildren(h('p', { class: 'empty small' }, query ? t('filesNothingMatches') : t('folderEmpty'))); return; }
    const frag = document.createDocumentFragment(); let lastDay = '';
    const byDay = !!collection || prefs.sort === 'date';
    for (const e of list) { if (byDay && !e.dir) { const day = dayOf(e.mtime); if (day !== lastDay) { lastDay = day; frag.append(h('div', { class: 'files-section' }, day)); } } frag.append(row(e)); }
    listEl.replaceChildren(frag);
    const dirs = list.filter((e) => e.dir).length; const files = list.length - dirs;
    subEl.textContent = [dirs ? countFolders(dirs) : '', files ? countFiles(files) : ''].filter(Boolean).join(', '); status.textContent = '';
  };
  const row = (e: Entry): HTMLElement => {
    const k = e.dir ? 'folder' : kindOfFile(e.name); const thumbable = !e.dir && (k === 'image' || k === 'video' || /\.apk$/i.test(e.name));
    const ic = h('span', { class: 'files-ic' + (thumbable ? ' thumb' : ''), 'data-thumb': thumbable && plug() ? e.path : undefined }, icon(e.dir ? 'folder' : ICON[k] ?? 'file'));
    const meta = e.dir ? (e.count !== undefined && e.count >= 0 ? countItems(e.count) : '') : collection ? `${formatBytes(e.size)} · ${baseOf(parentOf(e.path))}` : `${formatBytes(e.size)} · ${formatDate(e.mtime)}`;
    const el = h('div', { class: 'files-row' + (picked.has(e.path) ? ' picked' : '') + (e.hidden ? ' hidden-file' : ''), role: 'button', tabindex: '0', onclick: () => { if (selecting) { toggle(e); return; } void open(e); } },
      ic, h('span', { class: 'grow files-main' }, h('span', { class: 'files-name', dir: 'auto' }, e.name), h('small', { class: 'src' }, meta)),
      selecting ? h('span', { class: 'files-check' }, icon(picked.has(e.path) ? 'check' : 'circle')) : iconButton('more', t('more'), (ev) => { ev.stopPropagation(); itemSheet(e); }));
    onLongPress(el, () => { if (!selecting) { selecting = true; } toggle(e); });
    if (thumbable && plug()) io.observe(ic);
    return el;
  };

  // ---- the selection
  const toggle = (e: Entry) => { if (picked.has(e.path)) picked.delete(e.path); else picked.add(e.path); if (!picked.size) selecting = false; draw(); drawSel(); };
  const drawSel = () => {
    selBar.hidden = !selecting; if (!selecting) { root.classList.remove('selecting'); return; } root.classList.add('selecting');
    const n = picked.size; const one = n === 1 ? entries.find((e) => e.path === [...picked][0]) : undefined;
    selBar.replaceChildren(
      h('span', { class: 'files-selcount' }, countItems(n)),
      iconButton('check', t('filesSelectAll'), () => { for (const e of shown()) picked.add(e.path); draw(); drawSel(); }),
      iconButton('copy', t('filesCopy'), () => { clipboard = { op: 'copy', paths: [...picked] }; pasteBtn.hidden = false; toast(t('filesCopied', { n: localDigits(n) })); leaveSel(); }),
      iconButton('scissors', t('filesCut'), () => { clipboard = { op: 'move', paths: [...picked] }; pasteBtn.hidden = false; toast(t('filesCutDone', { n: localDigits(n) })); leaveSel(); }),
      iconButton('trash', t('delete'), () => void confirmDelete([...picked])),
      ...(one ? [iconButton('pen', t('rename'), () => renameSheet(one))] : []),
      iconButton('share', t('share'), () => void shareMany([...picked])),
      iconButton('more', t('more'), () => selectionSheet()),
      iconButton('close', t('close'), leaveSel));
  };
  const leaveSel = () => { selecting = false; picked.clear(); draw(); drawSel(); };

  // ---- opening
  const open = async (e: Entry) => {
    if (e.dir) { go(e.path); return; }
    const k = kindOfFile(e.name); const pl = plug();
    try {
      if (k === 'video' || k === 'audio') { const { openPlayer } = await import('./player'); const { localFileUrl } = await import('../player/files'); const u = await localFileUrl(e.path); if (u) { await openPlayer(u, e.name, { localPath: e.path }); return; } }
      if (/\.(apk|apks|xapk|apkm)$/i.test(e.name)) { const m = await import('./apk'); if (m.canInstallApps()) { await m.installSheet(e.path); return; } }
      if (k === 'archive' || /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|cbz|001)$/i.test(e.name)) { const { browseArchive } = await import('./archiveBrowse'); void browseArchive(e.path); return; }
      if (/\.(txt|nfo|md|log|json|xml|srt|ass|vtt|csv|ini|cfg)$/i.test(e.name) && e.size < 2_000_000 && pl) { await quickLook(e); return; }
      if (pl) { await pl.openChooser({ path: e.path, mime: mimeOf(e.name), title: e.name }); return; }
      const d = desk(); if (d?.openPath) { await d.openPath(e.path); return; }
    } catch (err) { toast(String((err as Error).message ?? err), 'error'); }
  };
  const quickLook = async (e: Entry) => {
    const pl = plug()!; const sh = openSheet(e.name, t('close')); sh.el.classList.add('files-look');
    const pre = h('pre', { class: 'files-text', dir: 'auto' }, '…'); sh.body.append(pre);
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void pl.openWith({ path: e.path, mime: 'text/plain', title: e.name }) }, icon('external'), t('openWith')));
    try { const r = await pl.filesHead({ path: e.path, max: 300000 }); pre.textContent = r.text + (r.size > 300000 ? `\n…` : ''); } catch (err) { pre.textContent = String((err as Error).message ?? err); }
  };
  const openAs = (e: Entry) => pickSheet(t('filesOpenAs'), MIMES.map(([m, l, ic]): [string, string, string] => [m, t(l as 'filesAsAny'), ic]), mimeOf(e.name), (m) => void plug()?.openWith({ path: e.path, mime: m, title: e.name }), t('close'));

  // ---- the drawer: storages (with their used space), bookmarks, collections — Solid Explorer's, as a sheet from the side
  const drawer = () => {
    const sh = openSheet(t('navFiles'), t('close')); sh.el.classList.add('files-drawer');
    const section = (label: string, ...kids: (HTMLElement | null)[]) => h('div', { class: 'files-drawer-section' }, h('small', { class: 'src files-drawer-label' }, label), ...kids);
    const item = (ic: string, name: string, sub: string | HTMLElement | null, fn: () => void, extra?: HTMLElement) => h('button', { type: 'button', class: 'dest-row files-drawer-row', onclick: () => { sh.close(); fn(); } }, h('span', { class: 'files-drawer-ic' }, icon(ic)), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, name), sub ? (typeof sub === 'string' ? h('small', { class: 'src', dir: 'ltr' }, sub) : sub) : null), extra ?? null);
    const storage = (r: Root) => { const used = r.total && r.free !== undefined ? Math.round(((r.total - r.free) / r.total) * 100) : null; return item(r.kind === 'app' ? 'download' : 'storage', r.name, used === null ? r.path : h('span', { class: 'files-usage' }, h('span', { class: 'files-usage-bar' }, h('i', { style: { width: `${used}%` } })), h('small', { class: 'src' }, t('filesFreeOf', { free: formatBytes(r.free!), total: formatBytes(r.total!) }))), () => { if (!r.readable) { void askAccess(); return; } go(r.path); }); };
    const bm = bookmarks();
    sh.body.append(section(t('filesStorages'), ...roots.map(storage)));
    if (bm.length) sh.body.append(section(t('filesBookmarks'), ...bm.map((b) => item('bookmark', b.name, b.path, () => go(b.path), iconButton('close', t('delete'), (ev) => { ev.stopPropagation(); saveBookmarks(bookmarks().filter((x) => x.path !== b.path)); sh.close(); drawer(); })))));
    if (plug()) sh.body.append(section(t('filesCollections'), ...COLLECTIONS.map(([k, label, ic]) => item(ic, t(label as 'filesRecent'), null, () => openCollection(k)))));
  };
  const fabSheet = () => {
    const sh = openSheet(t('create'), t('close'));
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' }, act('folderPlus', t('newFolder'), () => newFolderSheet()), ...(clipboard ? [act('copy', t('filesPaste'), () => void paste())] : []), act('bookmarkAdd', t('filesBookmarkHere'), () => { const b = bookmarks(); if (!b.some((x) => x.path === at)) { b.push({ name: baseOf(at) || at, path: at }); saveBookmarks(b); } toast(t('filesBookmarked')); }), ...(plug() ? [act('upload', t('filesSavedShared'), () => void saveSharedSheet())] : [])));
  };

  // ---- sheets: an item's, the selection's, sort, more, rename, new folder, properties, delete
  const itemSheet = (e: Entry) => {
    const pl = plug(); const sh = openSheet(e.name, t('close'));
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('p', { class: 'src', dir: 'ltr' }, e.path), h('div', { class: 'dest-list' },
      act('external', t('open'), () => void open(e)),
      ...(pl && !e.dir ? [act('apps', t('openWith'), () => void pl.openWith({ path: e.path, mime: mimeOf(e.name), title: e.name })), act('type', t('filesOpenAs'), () => openAs(e))] : []),
      ...(pl ? [act('share', t('share'), () => void pl.shareFile({ path: e.path, title: e.name }))] : []),
      act('copy', t('filesCopy'), () => { clipboard = { op: 'copy', paths: [e.path] }; pasteBtn.hidden = false; toast(t('filesCopied', { n: '1' })); }),
      act('scissors', t('filesCut'), () => { clipboard = { op: 'move', paths: [e.path] }; pasteBtn.hidden = false; toast(t('filesCutDone', { n: '1' })); }),
      act('pen', t('rename'), () => renameSheet(e)),
      ...(!e.dir && /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|001)$/i.test(e.name) ? [act('archive', t('extractHere'), () => void extractHere(e)), act('archive', t('extractTo'), () => void import('./extract').then((m) => m.extractSheet(e.path)))] : []),
      act('archive', t('filesZip'), () => void zipSheet([e.path])),
      act('check', t('filesSelect'), () => { selecting = true; picked.add(e.path); draw(); drawSel(); }),
      act('info', t('properties'), () => void propertiesSheet(e)),
      act('trash', t('delete'), () => void confirmDelete([e.path]))));
  };
  const selectionSheet = () => {
    const sh = openSheet(countItems(picked.size), t('close')); const paths = [...picked];
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' }, act('archive', t('filesZip'), () => void zipSheet(paths)), act('check', t('filesInvert'), () => { const all = shown(); for (const e of all) { if (picked.has(e.path)) picked.delete(e.path); else picked.add(e.path); } draw(); drawSel(); }), act('info', t('properties'), () => { const one = entries.find((e) => e.path === paths[0]); if (one) void propertiesSheet(one); })));
  };
  const sortSheet = () => {
    const sh = openSheet(t('sortBy'), t('close'));
    const opt = (key: Prefs['sort'], label: string) => h('button', { type: 'button', class: 'dest-row' + (prefs.sort === key ? ' on' : ''), onclick: () => { if (prefs.sort === key) prefs.desc = !prefs.desc; else { prefs.sort = key; prefs.desc = false; } savePrefs(); sh.close(); draw(); } }, icon(prefs.sort === key ? (prefs.desc ? 'arrowDown' : 'arrowUp') : 'circle'), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' }, opt('name', t('sortName')), opt('date', t('sortDate')), opt('size', t('sortSize')), opt('type', t('sortType'))), h('p', { class: 'hint' }, t('filesSortHint')));
  };
  const moreSheet = () => {
    const sh = openSheet(t('navFiles'), t('close'));
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' },
      act('folderPlus', t('newFolder'), () => newFolderSheet()),
      act('check', t('filesSelectAll'), () => { selecting = true; for (const e of shown()) picked.add(e.path); draw(); drawSel(); }),
      act(prefs.hidden ? 'eye' : 'eye', prefs.hidden ? t('filesHideHidden') : t('filesShowHidden'), () => { prefs.hidden = !prefs.hidden; savePrefs(); void load(); }),
      act('refresh', t('refresh'), () => void load()),
      act('info', t('properties'), () => void propertiesSheet({ name: baseOf(at), path: at, dir: true, size: 0, mtime: 0 })),
      ...(plug() ? [act('upload', t('filesSavedShared'), () => void saveSharedSheet())] : []),
      ...(plug() && !allFiles ? [act('key', t('filesAccessAllow'), () => void askAccess())] : [])));
  };
  const renameSheet = (e: Entry) => {
    const pl = plug(); if (!pl) return; const sh = openSheet(t('rename'), t('cancel')); const inp = h('input', { type: 'text', value: e.name, dir: 'auto' }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim(); if (!name || name === e.name) { sh.close(); return; } try { await pl.filesRename({ path: e.path, name }); sh.close(); leaveSel(); void load(); } catch (err) { toast(String((err as Error).message ?? err) === 'exists' ? t('filesNameTaken') : String((err as Error).message ?? err), 'error'); } } }, icon('check'), t('rename')));
    setTimeout(() => { inp.focus(); const dot = e.dir ? -1 : e.name.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : e.name.length); }, 50);
  };
  const newFolderSheet = () => {
    const pl = plug(); if (!pl) return; const sh = openSheet(t('newFolder'), t('cancel')); const inp = h('input', { type: 'text', dir: 'auto', placeholder: t('folderNamePlaceholder') }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim(); if (!name) return; try { const r = await pl.filesMkdir({ path: `${at}/${name}` }); if (!r.ok) throw new Error(t('filesCannotMake')); sh.close(); void load(); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } } }, icon('check'), t('create')));
    setTimeout(() => inp.focus(), 50);
  };
  const propertiesSheet = async (e: Entry) => {
    const pl = plug(); const sh = openSheet(t('properties'), t('close')); const rows = h('div', { class: 'files-props' });
    const line = (k: string, v: string) => h('div', { class: 'files-prop' }, h('small', { class: 'src' }, k), h('span', { dir: 'auto' }, v));
    rows.append(line(t('fileName'), e.name), line(t('folderPath'), e.path));
    sh.body.append(rows);
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal small', onclick: () => { void navigator.clipboard?.writeText(e.path); toast(t('copied')); } }, icon('copy'), t('filesCopyPath')));
    if (!pl) { rows.append(line(t('fileSize'), e.dir ? '' : formatBytes(e.size)), line(t('fileDate'), formatDate(e.mtime))); return; }
    const sizeLine = line(t('fileSize'), '…'); rows.append(sizeLine);
    try {
      const s = await pl.filesStat({ path: e.path, id: 'props' });
      sizeLine.lastElementChild!.textContent = e.dir || s.dir ? `${formatBytes(s.size)} · ${countFiles(s.files ?? 0)} · ${countFolders(s.folders ?? 0)}` : formatBytes(s.size);
      rows.append(line(t('fileDate'), formatDate(s.mtime)), ...(s.mime ? [line(t('filesKind'), s.mime)] : []), line(t('filesAccess'), [s.readable ? t('filesReadable') : '', s.writable ? t('filesWritable') : t('filesReadOnly')].filter(Boolean).join(' · ')));
    } catch (err) { sizeLine.lastElementChild!.textContent = String((err as Error).message ?? err); }
  };
  const confirmDelete = async (paths: string[]) => {
    const pl = plug(); if (!pl) return; const sh = openSheet(t('delete'), t('cancel'));
    sh.body.append(h('p', null, t('filesDeleteAsk', { n: localDigits(paths.length) })), h('p', { class: 'hint' }, paths.slice(0, 5).map(baseOf).join(' · ') + (paths.length > 5 ? ' …' : '')));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary danger', onclick: () => { sh.close(); leaveSel(); void startJob('delete', paths); } }, icon('trash'), t('delete')));
  };
  const shareMany = async (paths: string[]) => { const pl = plug(); if (!pl) return; if (paths.length === 1) { await pl.shareFile({ path: paths[0], title: baseOf(paths[0]) }).catch(() => undefined); return; } const { shareFiles } = await import('../ui/shareMany'); await shareFiles(paths); };
  const extractHere = async (e: Entry) => { const { extractArchiveJob } = await import('../archives'); const job = extractArchiveJob({ path: e.path, dest: parentOf(e.path), replace: 'ask' as never }); watchArchiveJob(job.id, job.done, e.name); };
  const watchArchiveJob = (id: string, done: Promise<unknown>, name: string) => { const el = jobRow(id, t('filesExtracting', { name }), () => void import('../archives').then((m) => m.cancelArchive(id))); done.then(() => { el.remove(); void load(); toast(t('filesExtracted', { name })); }, (err) => { el.remove(); toast(String((err as Error).message ?? err), 'error'); }); };
  const zipSheet = async (paths: string[]) => {
    const { createZip } = await import('../archives'); const sh = openSheet(t('filesZip'), t('cancel'));
    const stem = paths.length === 1 ? baseOf(paths[0]).replace(/\.[^.]+$/, '') : baseOf(at) || 'archive';
    const inp = h('input', { type: 'text', value: `${stem}.zip`, dir: 'auto' }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp), h('p', { class: 'hint' }, t('filesZipHint', { n: localDigits(paths.length) })));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim() || `${stem}.zip`; sh.close(); leaveSel(); const out = `${at}/${name.endsWith('.zip') ? name : name + '.zip'}`; const el = jobRow('zip', t('filesZipping', { name }), () => undefined); try { await createZip(out, paths, (p) => { const b = el.querySelector('.files-job-bar i') as HTMLElement | null; if (b && p.total) b.style.width = `${Math.round((p.done / p.total) * 100)}%`; }); el.remove(); void load(); toast(t('filesZipped', { name })); } catch (err) { el.remove(); toast(String((err as Error).message ?? err), 'error'); } } }, icon('archive'), t('filesZip')));
  };

  // ---- the jobs: copy / move / delete, with their progress, cancel and the question when a name is taken
  const jobRow = (id: string, label: string, cancel: () => void): HTMLElement => {
    const el = h('div', { class: 'files-job', 'data-id': id }, h('div', { class: 'grow' }, h('span', { class: 'files-job-label', dir: 'auto' }, label), h('div', { class: 'files-job-bar' }, h('i')), h('small', { class: 'src files-job-meta' })), iconButton('close', t('cancel'), cancel));
    jobsEl.append(el); return el;
  };
  const startJob = async (op: 'copy' | 'move' | 'delete', paths: string[], dest?: string) => {
    const pl = plug(); if (!pl) return; const id = `fj-${Date.now()}`;
    const label = op === 'delete' ? t('filesDeleting', { n: localDigits(paths.length) }) : op === 'move' ? t('filesMoving', { n: localDigits(paths.length) }) : t('filesCopying', { n: localDigits(paths.length) });
    jobRow(id, label, () => void pl.filesCancel({ id }));
    try { await pl.filesJob({ id, op, paths, dest, conflict: 'ask' }); } catch (err) { jobsEl.querySelector(`[data-id="${id}"]`)?.remove(); toast(String((err as Error).message ?? err), 'error'); }
  };
  const paste = async () => { if (!clipboard) return; const c = clipboard; clipboard = null; pasteBtn.hidden = true; await startJob(c.op, c.paths, at); };
  const onJob = (ev: JobEvent) => {
    const el = jobsEl.querySelector(`[data-id="${ev.id}"]`) as HTMLElement | null;
    if (ev.status === 'progress') { if (!el) return; const b = el.querySelector('.files-job-bar i') as HTMLElement; const pct = ev.total ? Math.round(((ev.done ?? 0) / ev.total) * 100) : 0; b.style.width = `${pct}%`; (el.querySelector('.files-job-meta') as HTMLElement).textContent = `${ev.name ?? ''} · ${formatBytes(ev.done ?? 0)}${ev.total ? ` / ${formatBytes(ev.total)}` : ''} · ${localDigits(ev.files ?? 0)}/${localDigits(ev.ofFiles ?? 0)}`; return; }
    if (ev.status === 'conflict') { conflictSheet(ev); return; }
    el?.remove(); void load();
    if (ev.status === 'done') { if (ev.failed?.length) toast(t('filesSomeFailed', { n: localDigits(ev.failed.length), why: ev.failed[0] }), 'error', 5000); else toast(t('filesDone')); }
    else if (ev.status === 'failed') toast(ev.message ?? t('filesFailed'), 'error');
  };
  const conflictSheet = (ev: JobEvent) => {
    const pl = plug()!; const sh = openSheet(t('filesNameTakenTitle'), t('cancel'));
    const name = baseOf(ev.to ?? ''); const all = h('input', { type: 'checkbox' }) as HTMLInputElement;
    sh.body.append(h('p', { dir: 'auto' }, t('filesNameTakenAsk', { name })),
      h('div', { class: 'files-compare' }, h('div', null, h('small', { class: 'src' }, t('filesIncoming')), h('span', null, ev.dir ? t('filesAFolder') : `${formatBytes(ev.size ?? 0)} · ${formatDate(ev.mtime)}`)), h('div', null, h('small', { class: 'src' }, t('filesExisting')), h('span', null, `${formatBytes(ev.existingSize ?? 0)} · ${formatDate(ev.existingMtime)}`))),
      h('label', { class: 'check-row' }, all, h('span', null, t('filesSameForRest'))));
    let answered = false;
    const answer = (a: string) => { answered = true; sh.close(); void pl.filesAnswer({ id: ev.id, answer: a + (all.checked ? 'All' : '') }); };
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => answer('skip') }, t('skip')), h('button', { type: 'button', class: 'btn tonal', onclick: () => answer('keep') }, t('keepBoth')), h('button', { type: 'button', class: 'btn primary', onclick: () => answer('replace') }, t('replace')));
    sh.el.addEventListener('transitionend', () => { if (!sh.el.isConnected && !answered) void pl.filesCancel({ id: ev.id }); }, { once: true });
  };

  // ---- what other apps shared to «Save to device»
  const saveSharedSheet = async () => {
    const pl = plug(); if (!pl) return; const r = await pl.sharedPending().catch(() => ({ items: [] }));
    const sh = openSheet(t('filesSaveToDevice'), t('close'));
    if (!r.items.length) { sh.body.append(h('p', { class: 'hint' }, t('filesNothingShared'))); return; }
    sh.body.append(h('div', { class: 'dest-list' }, ...r.items.map((it) => h('div', { class: 'dest-row' }, icon(ICON[kindOfFile(it.name)] ?? 'file'), h('span', { class: 'name', dir: 'auto' }, it.name), h('small', { class: 'src' }, it.size >= 0 ? formatBytes(it.size) : '')))), h('p', { class: 'hint', dir: 'ltr' }, at));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); void pl.sharedClear(); } }, t('filesDiscard')), h('button', { type: 'button', class: 'btn primary', onclick: async () => { sh.close(); const el = jobRow('shared', t('filesSaving', { n: localDigits(r.items.length) }), () => undefined); try { const res = await pl.sharedSave({ dir: at }); el.remove(); void load(); toast(res.failed.length ? t('filesSomeFailed', { n: localDigits(res.failed.length), why: res.failed[0] }) : t('filesSavedN', { n: localDigits(res.saved.length) }), res.failed.length ? 'error' : 'info'); } catch (err) { el.remove(); toast(String((err as Error).message ?? err), 'error'); } } }, icon('download'), t('filesSaveHere')));
  };

  // ---- start
  let sub: { remove(): void } | null = null;
  const pl = plug(); if (pl) void listen<JobEvent>(pl as never, 'files', onJob).then((s) => { sub = s as { remove(): void }; });
  void (async () => { await loadRoots(); drawKinds(); if (!at && !collection) { status.textContent = t('filesNoStorage'); return; } await load(); if (route.save) void saveSharedSheet(); })();
  root.dispose = () => { gone = true; io.disconnect(); sub?.remove(); };
  return root;
}
