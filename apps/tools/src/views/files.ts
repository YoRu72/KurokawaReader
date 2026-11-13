// The Files add-on: the device's folders as a file manager shows them (Solid Explorer's shape, ZArchiver's speed):
// the storages (the app's folder, the phone, SD cards, USB drives) with their free space, breadcrumbs, a list or a
// grid, sorted by name / date / size / type with folders first, filtered by kind (images, music, video, documents,
// archives, apps), hidden files, a search within the folder; files opened in the app (the player, the archives, the
// installer) or by any app (Open with…, Open as a kind); a selection (held) copied, cut, pasted, deleted, renamed,
// shared, zipped, with properties; the operations as jobs with their progress and a question when a name is taken;
// what other apps share to «Save to device» saved where you choose.
import { sideDrawer, swipeToOpen } from '../ui/sideSwipe';
import { swipeable } from '../ui/swipe';
import { pullToRefresh } from '../ui/gestures';
import { h, icon, iconButton, toast, openSheet, pickSheet, onLongPress } from '../ui/dom';
import { t, formatBytes, formatDate, formatDateShort, localDigits, countFiles, countItems, countFolders } from '../i18n';
import { ktPlugin, listen, nativePlatform } from '../native';
import { navigate, previousPath, cameFrom } from '../router';
import { onBack as onBackStep } from '../ui/backstack';
import { kindOfFile } from './taskFiles';
import { isArc, arcPath, parseArc, arcName, looksArchive } from './filesArc';
import { isApps, appsPath, parseApps, appsAvailable } from './filesApps';
import { splitExt, nameParts, joinMeta, readablePath, placeName } from './filesNames';
type AppEntry = Entry & { pkg?: string; sub?: string; special?: 'data' | 'obb' | 'media' };

export interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number; ext?: string; hidden?: boolean; count?: number }
interface Root { kind: string; path: string; name: string; readable: boolean; free?: number; total?: number; appFolder?: string }
type JobEvent = { id: string; status: 'progress' | 'conflict' | 'done' | 'cancelled' | 'failed'; done?: number; total?: number; files?: number; ofFiles?: number; name?: string; from?: string; to?: string; size?: number; existingSize?: number; mtime?: number; existingMtime?: number; dir?: boolean; failed?: string[]; message?: string; /** A move's: the files left where they were (skipped, failed, cancelled), and the chosen paths still there. */ left?: number; remaining?: string[]; skipped?: number };
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
/** Copy, move and delete as jobs: the phone's (a computer's Files lists and opens, but has no jobs yet). */
const canJobs = (): boolean => !!plug();

/* ---------- what is kept: the view, the sort, hidden files, the last folder, the clipboard ---------- */
export type Prefs = { view: 'list' | 'grid'; sort: 'name' | 'date' | 'size' | 'type'; desc: boolean; hidden: boolean; last?: string; kind: string; /** Two panes side by side on a wide screen. */ dual?: boolean; lastB?: string;
  /** The folder the page opens on (empty: the last one when `rememberLast`, else the first storage). */ home?: string; rememberLast?: boolean; counts?: boolean; thumbs?: boolean; density?: 'comfortable' | 'compact'; confirmDelete?: boolean; keepOn?: boolean; eink?: boolean; backUp?: boolean };
const PREFS = 'kt.files.prefs';
export const prefs: Prefs = { view: 'grid', sort: 'name', desc: false, hidden: false, kind: 'all', ...(() => { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>; } catch { return {}; } })() };
export const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* none */ } };
// (One clipboard for the page — both panes —: a copy stays on it until replaced or cleared; a cut until its move has gone
// through — what was left behind stays cut. `busy`: the move under way, while it runs nothing more is pasted from it.)
let clipboard: { op: 'copy' | 'move'; paths: string[]; busy?: string } | null = null;
const clipWatch = new Set<() => void>();
/** Where each folder was scrolled to, kept while the app runs: coming back to a folder (Back, a breadcrumb) finds it there. */
const scrollMemo = new Map<string, number>();
/** The pane last touched (two side by side): the one Back walks up. */
let activePane: object | null = null;
/** The hidden folders an archive's entries are taken out to before they are moved in (by the move job's id). */
const stagings = new Map<string, string>();
const STAGE = '.kurokawa-extract-';
const setClip = (c: typeof clipboard) => { clipboard = c; for (const f of clipWatch) f(); };
/** `dest` is one of `paths` or lies inside one — a folder pasted into itself (whole names compared, letter case aside:
 *  the phone's storage ignores it; /a/b and /a/bc are strangers). */
export const intoItself = (paths: string[], dest: string): boolean => { const d = dest.replace(/\/+$/, '').toLowerCase() + '/'; return paths.some((p) => d.startsWith(p.replace(/\/+$/, '').toLowerCase() + '/')); };
// (The jobs under way and the pane that asked for each: only that pane answers a job's questions and shows its row; a
// pane gone — the page moved on — leaves its jobs to the next pane that hears of them.)
type JobRec = { owner: object | null; label: string; cancel: () => void; ended?: boolean };
const liveJobs = new Map<string, JobRec>();

import { isRemote, isVirtual, parseRemote, connections, connectionSheet, connectionMenu, scanSheet, rplug, vplug, vfs, vfsRoots, kindIcon, describe, canShareFolder, folderShareSheet, type Conn, type VRoots } from './filesRemote';
const KINDS: [string, string, RegExp | null][] = [['all', 'filesKindAll', null], ['image', 'filesKindImages', /^(jpe?g|png|gif|webp|bmp|heic|heif|hif|avif|svg|tiff?|ico|wbmp|jfif|apng)$/], ['audio', 'filesKindMusic', /^(mp3|m4a|flac|ogg|opus|wav|aac|wma)$/], ['video', 'filesKindVideo', /^(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv|3gp)$/], ['doc', 'filesKindDocs', /^(pdf|epub|mobi|azw3?|docx?|xlsx?|pptx?|txt|md|rtf|odt|cbz|cbr)$/], ['archive', 'filesKindArchives', /^(zip|7z|rar|tar|gz|tgz|xz|bz2|zst|lz4|iso|001)$/], ['apk', 'filesKindApps', /^(apk|apks|xapk|apkm)$/]];
const ICON: Record<string, string> = { video: 'film', audio: 'music', ebook: 'books', image: 'images', sub: 'subtitles', archive: 'archive', doc: 'file', other: 'file', locked: 'lock' };
const MIMES: [string, string, string][] = [['image/*', 'filesAsImage', 'images'], ['audio/*', 'filesAsMusic', 'music'], ['video/*', 'filesAsVideo', 'film'], ['text/plain', 'filesAsText', 'type'], ['application/pdf', 'filesAsDocument', 'file'], ['application/zip', 'filesAsArchive', 'archive'], ['*/*', 'filesAsAny', 'apps']];
const mimeOf = (p: string): string => { const k = kindOfFile(p); if (/\.(txt|nfo|md|srt|ass|vtt|json|xml|log|csv|ini|cfg)$/i.test(p)) return 'text/plain'; if (/\.pdf$/i.test(p)) return 'application/pdf'; if (/\.apk$/i.test(p)) return 'application/vnd.android.package-archive'; return ({ video: 'video/*', audio: 'audio/*', image: 'image/*', ebook: 'application/epub+zip', archive: 'application/zip' } as Record<string, string>)[k] ?? '*/*'; };
// (A place under a scheme — «apps://com.x», «remote://id» — has the scheme's root above it, «apps://»; trimming the
// last part as a folder would leave «apps:/», which became «apps:», a place that lists nothing.)
const parentOf = (p: string): string => { const top = /^([a-z]+:\/\/)[^/]*\/?$/.exec(p); if (top) return top[1]; return p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'; };
/** «apps:» and «apps:/» (left by an older version) mended to «apps://». */
const mendScheme = (p: string): string => p.replace(/^([a-z]+):\/?$/, '$1://');
const baseOf = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p;
/** A row's second line with each part isolated — «4 B» and a date stay whole in the Arabic page (no «2025/03/B · 094»). */
const metaNodes = (meta: string): (Node | string)[] => meta ? meta.split(' · ').flatMap((x, i) => (i ? [' · ', h('bdi', null, x)] : [h('bdi', null, x)])) : [];
/** A file's name in a row: cut in its middle when too long, the extension always in sight («HOREMAJO_03_KARAO…D (1).zip»),
 *  isolated in its own direction so an English name's brackets do not jump about in the Arabic page (and the reverse). */
export function nameEl(name: string, dir = false, cls = 'files-name'): HTMLElement {
  const np = nameParts(name, dir);
  return h('bdi', { class: `${cls} mid`, dir: np.dir, title: name }, h('span', { class: 'mid-head' }, np.head), h('span', { class: 'mid-tail' }, np.tail));
}

/* ---------- the listing ---------- */
async function askArcPassword(wrong: boolean): Promise<string | null> {
  return new Promise((res) => { const sh = openSheet(t('passwordNeeded'), t('cancel'), { onClose: () => res(null) }); const pw = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off' }) as HTMLInputElement; sh.body.append(h('p', { class: 'hint' }, wrong ? t('wrongPassword') : t('passwordNeeded')), h('label', { class: 'field' }, h('span', null, t('password')), pw)); sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { const v = pw.value; sh.close(); res(v || null); } }, t('ok'))); setTimeout(() => pw.focus(), 50); });
}
async function listDir(path: string): Promise<{ exists: boolean; entries: Entry[]; truncated?: boolean }> {
  if (isArc(path)) { const { arcList } = await import('./filesArc'); return arcList(path, askArcPassword); }
  if (isApps(path)) { const { appsList } = await import('./filesApps'); return appsList(path); }
  if (isVirtual(path)) { const r = await vfs.list(path); return { exists: r.exists, entries: r.entries.filter((e) => prefs.hidden || !e.name.startsWith('.')) }; }
  const p = plug(); if (p) return p.filesList({ path, counts: prefs.counts !== false, hidden: prefs.hidden });
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

/** A pane of the Files page: its own place, selection and history. Standing alone it writes where it is into the
 *  address; embedded (two panes) it keeps quiet and tells the other pane through `peer`. */
export type Pane = HTMLElement & { dispose?: () => void; pathNow: () => string; dropIn: (op: 'copy' | 'move', paths: string[]) => Promise<void>; reload: () => void };
type PaneOpts = { embedded?: boolean; side?: 'a' | 'b'; peer?: () => Pane | null };
/** Two panes when the reader asked and the screen is wide enough, else one. */
export function filesView(route: { p?: string; save?: string; c?: string }): HTMLElement {
  const wide = () => window.matchMedia('(min-width: 840px)').matches;
  if (!prefs.dual || !wide() || route.save || route.c) return filesPane(route);
  let a: Pane | null = null, b: Pane | null = null;
  a = filesPane(route, { embedded: true, side: 'a', peer: () => b });
  b = filesPane({ p: prefs.lastB ?? route.p }, { embedded: true, side: 'b', peer: () => a });
  const root = h('div', { class: 'view files-dual' }, a, b) as HTMLElement & { dispose?: () => void };
  const mq = window.matchMedia('(min-width: 840px)'); const onChange = () => { if (!mq.matches) { b?.dispose?.(); b?.remove(); root.classList.add('one'); } };
  mq.addEventListener('change', onChange);
  root.dispose = () => { mq.removeEventListener('change', onChange); a?.dispose?.(); b?.dispose?.(); };
  return root;
}
export function filesPane(route: { p?: string; save?: string; c?: string }, po: PaneOpts = {}): Pane {
  const body = h('div', { class: 'files-body' });
  const crumbs = h('div', { class: 'files-crumbs', dir: 'ltr' }); const rootsRow = h('div', { class: 'chip-row files-roots' }); const kindRow = h('div', { class: 'chip-row files-kinds' });
  const listEl = h('div', { class: 'files-list' }); const status = h('p', { class: 'hint files-status' }); const jobsEl = h('div', { class: 'files-jobs' });
  const search = h('input', { type: 'search', class: 'files-search', placeholder: t('filesSearchHere'), hidden: true, oninput: () => { query = search.value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
  const selBar = h('div', { class: 'files-selbar', hidden: true });
  // (What is on the clipboard, while it is: how many — or the one's name —, copied or to be moved, Paste here and Cancel.)
  const clipBar = h('div', { class: 'files-clipbar', role: 'toolbar', 'aria-label': t('filesClipboard'), hidden: true });
  const backBtn = iconButton('back', t('back'), () => { backStep(); }); backBtn.classList.add('files-back'); backBtn.hidden = true;
  const titleEl = h('span', { class: 'files-title' }, t('navFiles')); const subEl = h('small', { class: 'files-sub' });
  /** The title, a long name cut in its middle so its end (the extension) stays in sight. */
  const setTitle = (text: string, isDir = true) => { const np = nameParts(text, isDir); titleEl.setAttribute('dir', np.dir); titleEl.title = text; titleEl.replaceChildren(h('span', { class: 'mid-head' }, np.head), h('span', { class: 'mid-tail' }, np.tail)); };
  const fab = h('button', { type: 'button', class: 'fab files-fab', 'aria-label': t('newFolder'), onclick: () => fabSheet() }, icon('plus'));
  const root = h('div', { class: 'view files-view' },
    h('header', { class: 'topbar' }, iconButton('menu', t('filesDrawer'), () => drawer()), backBtn, h('div', { class: 'title files-head' }, titleEl, subEl), h('div', { class: 'topbar-actions' },
      iconButton('search', t('search'), () => { if (plug() && !collection) { void import('./filesMore').then((m) => m.searchSheet(at, roots.find((x) => at === x.path || at.startsWith(x.path + '/'))?.path ?? at, prefs.hidden, (e) => void open(e), (d) => go(d))); return; } search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; query = ''; draw(); } }),
      iconButton('filter', t('filesFilterHere'), () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; query = ''; draw(); } }),
      iconButton(prefs.view === 'grid' ? 'list' : 'grid', t('filesView'), () => { prefs.view = prefs.view === 'grid' ? 'list' : 'grid'; savePrefs(); if (po.embedded) { draw(); po.peer?.()?.reload(); } else navigate(`/files?p=${encodeURIComponent(at)}`, true); }),
      iconButton('sort', t('sortBy'), () => sortSheet()),
      iconButton('more', t('more'), () => moreSheet()))),
    clipBar, search, rootsRow, crumbs, kindRow, body, selBar, fab) as HTMLElement & { dispose?: () => void };
  body.append(listEl, status, jobsEl);
  let at = mendScheme(route.p ?? (route.c ? '' : (prefs.rememberLast === false ? prefs.home ?? '' : (po.side === 'b' ? prefs.lastB : prefs.last) ?? prefs.home ?? ''))); let remotes: Conn[] = [];
  let vroots: VRoots = { shell: null, trees: [], shizuku: false };
  const remoteNow = (): Conn | null => (isRemote(at) ? remotes.find((c) => c.id === parseRemote(at).id) ?? null : null); void remoteNow; let collection: string | null = route.c ?? null; let entries: Entry[] = []; let query = ''; let selecting = false; const picked = new Set<string>(); let roots: Root[] = []; let allFiles = true; let gone = false;
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { const el = e.target as HTMLElement; io.unobserve(el); const p = el.dataset.thumb; if (p) void thumbInto(el, p); } }, { rootMargin: '300px 0px' });
  const thumbInto = async (el: HTMLElement, path: string) => { const pl = plug(); if (!pl) return; try { const px = prefs.view === 'grid' ? 240 : 96; const r = isArc(path) ? { url: await (await import('./filesArc')).arcThumb(path, px) } : isApps(path) ? { url: await (await import('./filesApps')).appIcon(parseApps(path).pkg) } : await pl.filesThumb({ path, px }); if (r.url && el.isConnected) { el.replaceChildren(h('img', { src: r.url, alt: '', loading: 'lazy' })); el.classList.add('has-img'); } } catch { /* the icon stays */ } };

  // ---- the storages and the way here
  const loadRoots = async () => {
    const pl = plug();
    if (pl) { try { const r = await pl.filesRoots(); roots = r.roots.map((x) => (x.kind === 'phone' ? { ...x, name: t('filesInternalStorage') } : x)); allFiles = r.allFiles; } catch { roots = []; } }
    else { const d = desk(); const home = d?.homeDir ? await d.homeDir().catch(() => '') : ''; roots = home ? [{ kind: 'phone', path: home, name: t('filesHome'), readable: true }] : []; }
    rootsRow.replaceChildren(...roots.filter((r) => r.kind !== 'remote' && r.kind !== 'saf' && r.kind !== 'root').map((r) => h('button', { type: 'button', class: 'chip' + (at === r.path || at.startsWith(r.path + '/') ? ' on' : ''), onclick: () => { if (!r.readable) { void askAccess(); return; } go(r.path); } },
      icon(r.kind === 'app' ? 'download' : r.kind === 'sd' ? 'storage' : r.kind === 'usb' ? 'storage' : 'storage'), h('span', null, r.name), r.free !== undefined ? h('small', { class: 'src' }, ` ${formatBytes(r.free)}`) : null)));
    remotes = await connections(); for (const c of remotes) roots.push({ kind: 'remote', path: `remote://${c.id}`, name: c.name, readable: true });
    vroots = await vfsRoots(); if (vroots.shell) roots.push({ kind: 'root', path: 'root://', name: t('filesRootStorage'), readable: true }); for (const tr of vroots.trees) roots.push({ kind: 'saf', path: `saf://${tr.id}`, name: tr.name, readable: true });
    if (!at) { at = roots[0]?.path ?? ''; }
  };
  // (An archive that wants a password: asked here, the Files browser's own sheet; the right one is remembered by the archives module.)
  const openInArc = async (e: Entry, m: typeof import('./filesArc')) => {
    const k = kindOfFile(e.name);
    if (k === 'image') { const fm = await import('./filesMore'); const pics = m.arcPictures(parseArc(e.path).archive); const here = shown().filter((x) => !x.dir && kindOfFile(x.name) === 'image'); const list = here.length ? here : pics; await fm.imageViewer(list, Math.max(0, list.findIndex((x) => x.path === e.path)), async (p) => (await m.arcUrl(p)) ?? (await (await import('../player/files')).localFileUrl(await m.arcFetch(p))), () => undefined, { readOnly: true }); return; }
    if (k === 'video' || k === 'audio') { const u = await m.arcUrl(e.path); if (u) { const { openPlayer } = await import('./player'); await openPlayer(u, e.name); return; } }
    const busy = toast(t('archiveOpening', { name: e.name })); void busy;
    try { const local = await m.arcFetch(e.path); await open({ ...e, path: local }); } catch (err) { toast(String((err as Error).message ?? err), 'error', 5000); }
  };
  const askAccess = async () => { const pl = plug(); if (!pl) return; const sh = openSheet(t('filesAccessTitle'), t('close')); sh.body.append(h('p', { class: 'hint' }, t('filesAccessHint'))); sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); void pl.filesAccess({ ask: true }); } }, icon('key'), t('filesAccessAllow'))); };
  const drawCrumbs = () => {
    backBtn.hidden = !collection && !upOf(at);
    if (collection) { crumbs.hidden = true; const c = COLLECTIONS.find(([k]) => k === collection); crumbs.replaceChildren(h('button', { type: 'button', class: 'crumb', onclick: () => drawer() }, t((c?.[1] ?? 'filesRecent') as 'filesRecent'))); titleEl.textContent = t((c?.[1] ?? 'filesRecent') as 'filesRecent'); titleEl.removeAttribute('dir'); return; }
    // (Inside an archive: the folder there, or the archive's own name at its top — decoded, never «%2Fstorage%2F…».)
    const rootHere = roots.find((x) => x.path === at); if (rootHere) setTitle(rootHere.name); else if (isApps(at) && at === 'apps://') setTitle(t('appsTitle')); else setTitle(placeName(at) || t('navFiles'), !isArc(at) || !!parseArc(at).inner);
    const r = roots.find((x) => at === x.path || at.startsWith(x.path + '/')); const base = r?.path ?? (isApps(at) ? 'apps://' : isArc(at) ? arcPath(parseArc(at).archive) : isRemote(at) ? `remote://${parseRemote(at).id}` : at.startsWith('saf://') ? at.replace(/^(saf:\/\/[^/]*).*$/, '$1') : at.startsWith('root://') ? 'root://' : '/'); const rest = at.slice(base.length).split('/').filter(Boolean);
    const parts: HTMLElement[] = [...(isArc(at) ? [h('button', { type: 'button', class: 'crumb', 'aria-label': placeName(parentOf(parseArc(at).archive)), title: parentOf(parseArc(at).archive), onclick: () => go(parentOf(parseArc(at).archive)) }, icon('archive')), h('span', { class: 'crumb-sep' }, '›')] : []), h('button', { type: 'button', class: 'crumb', onclick: () => go(base) }, h('bdi', null, isApps(at) ? t('appsTitle') : isArc(at) ? arcName(at) : (r?.name ?? '/')))];
    let acc = base; for (const seg of rest) { acc += `/${seg}`; const p = acc; parts.push(h('span', { class: 'crumb-sep' }, '›'), h('button', { type: 'button', class: 'crumb', onclick: () => go(p) }, h('bdi', null, seg))); }
    crumbs.replaceChildren(...parts); crumbs.scrollLeft = crumbs.scrollWidth;
    // (At a place's own top the path would only say the title again: left out until there is a way back to show.)
    crumbs.hidden = parts.length === 1 && !rest.length && !isArc(at);
  };
  const drawKinds = () => kindRow.replaceChildren(...KINDS.map(([k, label]) => h('button', { type: 'button', class: 'chip small' + (prefs.kind === k ? ' on' : ''), onclick: () => { prefs.kind = k; savePrefs(); drawKinds(); draw(); } }, t(label as 'filesKindAll'))));

  // ---- the folder
  // (Each folder a step in the history — the browser's Back and Forward, a mouse's side buttons walk the folders —;
  // the way up by Back steps back through that history when the folder above is the step before, else takes its place.)
  const scrollNow = (): number => Math.max(window.scrollY, body.scrollTop);
  let movedOn = false; // (this page has gone elsewhere: its scroll was kept then, not again when it is taken down)
  const keepScroll = () => { if (movedOn) return; const k = collection ? `c:${collection}` : at; if (k && shownAt === k) scrollMemo.set(k, scrollNow()); };
  const go = (path: string, how: 'push' | 'replace' | 'back' = 'push') => { if (gone) return; keepScroll(); collection = null; path = mendScheme(path); const was = at; at = /^[a-z]+:\/\/$/.test(path) ? path : path.replace(/\/+$/, '') || '/'; if (po.side === 'b') prefs.lastB = at; else prefs.last = at; savePrefs(); picked.clear(); selecting = false; search.value = ''; query = ''; search.hidden = true; if (!po.embedded) { movedOn = true; if (how === 'back') history.back(); else navigate(`/files?p=${encodeURIComponent(at)}`, how === 'replace' || was === at); } void load(); };
  const openCollection = (kind: string) => { if (gone) return; keepScroll(); collection = kind; picked.clear(); selecting = false; query = ''; search.hidden = true; if (!po.embedded) { movedOn = true; navigate(`/files?c=${kind}`); } void load(); };
  /** The place above `p`: the folder up; inside an archive the folder up there, and from its top the folder that holds
   *  the archive; null at a storage's top (the top of Files). */
  const upOf = (p: string): string | null => {
    if (!p) return null;
    if (isArc(p)) { const { archive, inner } = parseArc(p); return inner ? arcPath(archive, inner.split('/').slice(0, -1).join('/')) : parentOf(archive); }
    if (roots.some((r) => r.path === p) || /^[a-z]+:\/\/$/.test(p) || p === '/') return null;
    const up = parentOf(p); return up && up !== p ? up : null;
  };
  /** Up one place, by Back: through the history when the place above is the step before (so Forward still works). */
  const goUp = (to: string) => { const url = `/files?p=${encodeURIComponent(mendScheme(to))}`; go(to, !po.embedded && previousPath() === url ? 'back' : 'replace'); };
  /** One step of Back inside Files: what is open first (the selection, the filter), then up a folder — out of an archive to
   *  the folder that holds it — to the top of Files; false there (Files is left for where the reader came from). */
  const backStep = (): boolean => {
    if (gone || !root.isConnected) return false;
    if (selecting) { leaveSel(); return true; }
    if (!search.hidden) { search.value = ''; query = ''; search.hidden = true; draw(); return true; }
    if (collection) { const back = prefs.last && !prefs.last.startsWith('c:') ? prefs.last : roots[0]?.path; if (back) { goUp(back); return true; } return false; }
    const up = upOf(at); if (up) { goUp(up); return true; }
    return false;
  };
  // (Only the latest listing asked for draws: a slow folder answering after the reader went on is dropped. Another place
  // asked: the rows of the last one let go at once — nothing chosen, selected all or deleted, from a folder no longer shown.)
  let loadSeq = 0; let shownAt: string | null = null;
  const load = async () => {
    const my = ++loadSeq; const want = collection ? `c:${collection}` : at; const stale = () => gone || my !== loadSeq;
    if (want !== shownAt) { entries = []; picked.clear(); selecting = false; shownAt = want; }
    drawCrumbs(); void checkWritable(); drawPaste(); listEl.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner small' }))); status.textContent = ''; fab.hidden = !!collection || isArc(at);
    let got: Entry[] = []; let note = '';
    try {
      if (collection) { const pl = plug(); const r = pl ? await pl.filesCollection({ kind: collection, limit: 600 }) : { entries: [] }; if (stale()) return; got = r.entries; }
      else { const r = await listDir(at); if (stale()) return; const hid = (await import('./filesMore')).hiddenPaths(); if (stale()) return; got = (hid.length ? r.entries.filter((e) => !hid.includes(e.path)) : r.entries).filter((e) => !e.name.startsWith(STAGE)); if (!r.exists) note = t('folderNotFound'); if (r.truncated) toast(t('filesTruncated'), 'info'); }
    }
    catch (e) { if (stale()) return; got = []; note = String((e as Error).message ?? e); }
    entries = got; for (const x of [...picked]) if (!got.some((e) => e.path === x)) picked.delete(x); if (!picked.size) selecting = false;
    // (Back to a folder seen before: where it was scrolled to.)
    const y = scrollMemo.get(want) ?? 0; draw(y); drawSel(); status.textContent = note;
    if (y) requestAnimationFrame(() => { if (stale()) return; window.scrollTo(0, y); body.scrollTop = y; });
  };
  const shown = (): Entry[] => { const re = kindRe(); const list = entries.filter((e) => (!re || e.dir || re.test(e.ext ?? '')) && (!query || e.name.toLowerCase().includes(query))); return collection ? list.sort((a, b) => b.mtime - a.mtime) : sortEntries(list); };
  let moreIo: IntersectionObserver | null = null;
  const draw = (minPx = 0) => {
    const list = shown(); listEl.className = `files-list ${prefs.view}${prefs.density === 'compact' ? ' compact' : ''}`; root.classList.toggle('eink', !!prefs.eink);
    if (!list.length) { subEl.textContent = ''; listEl.replaceChildren(h('p', { class: 'empty small' }, query ? t('filesNothingMatches') : t('folderEmpty'))); return; }
    // (Big folders drawn in slices: the first screenfuls at once, the rest as the list is scrolled towards — a folder of
    // twenty thousand entries opens as fast as one of twenty.)
    const byDay = !!collection || prefs.sort === 'date'; let lastDay = ''; let drawn = 0; const CHUNK = 160;
    const slice = (): DocumentFragment => { const frag = document.createDocumentFragment(); const end = Math.min(list.length, drawn + CHUNK); for (; drawn < end; drawn++) { const e = list[drawn]; if (byDay && !e.dir) { const day = dayOf(e.mtime); if (day !== lastDay) { lastDay = day; frag.append(h('div', { class: 'files-section' }, day)); } } frag.append(row(e)); } return frag; };
    moreIo?.disconnect(); listEl.replaceChildren(slice());
    // (A scroll to come back to: drawn down to it first.)
    while (minPx && drawn < list.length && listEl.offsetHeight < minPx + window.innerHeight) listEl.append(slice());
    if (drawn < list.length) { const sentinel = h('div', { class: 'files-more-sentinel' }); listEl.append(sentinel); moreIo = new IntersectionObserver((es) => { if (!es.some((x) => x.isIntersecting)) return; sentinel.before(slice()); if (drawn >= list.length) { moreIo?.disconnect(); moreIo = null; sentinel.remove(); } }, { root: null, rootMargin: '1200px 0px' }); moreIo.observe(sentinel); }
    const dirs = list.filter((e) => e.dir).length; const files = list.length - dirs;
    subEl.textContent = [dirs ? countFolders(dirs) : '', files ? countFiles(files) : ''].filter(Boolean).join(', '); status.textContent = '';
  };
  const row = (e: Entry): HTMLElement => {
    const k = e.dir ? 'folder' : /\.kurokawa$/i.test(e.name) ? 'locked' : kindOfFile(e.name); const thumbable = !e.dir && (k === 'image' || k === 'video' || /\.apk$/i.test(e.name));
    const ae = e as AppEntry; const appIc = !!ae.pkg && isApps(e.path) && e.dir;
    const ic = h('span', { class: 'files-ic' + ((thumbable && (!isVirtual(e.path) || isArc(e.path)) || appIc) && prefs.thumbs !== false ? ' thumb' : ''), 'data-thumb': (thumbable && plug() && (!isVirtual(e.path) || isArc(e.path))) || appIc ? e.path : undefined }, icon(e.dir ? (ae.special ? 'folder' : appIc ? 'apps' : 'folder') : ICON[k] ?? 'file'));
    // (The second line: only what is known — an archive's entry without a date shows its size alone, never «10 MB ·».)
    const when = e.mtime > 0 ? (prefs.view === 'grid' ? formatDateShort(e.mtime) : formatDate(e.mtime)) : '';
    const meta = ae.sub ? joinMeta([ae.sub, ae.pkg && e.dir && !ae.special ? formatBytes(e.size) : '']) : e.dir ? joinMeta([e.count !== undefined && e.count >= 0 ? countItems(e.count) : '', isArc(e.path) ? when : '']) : collection ? joinMeta([formatBytes(e.size), baseOf(parentOf(e.path))]) : joinMeta([e.size >= 0 ? formatBytes(e.size) : '', when]);
    const el = h('div', { class: 'files-row' + (picked.has(e.path) ? ' picked' : '') + (e.hidden ? ' hidden-file' : ''), role: 'button', tabindex: '0', onclick: () => { if (selecting) { toggle(e); return; } void open(e); } },
      ic, h('span', { class: 'grow files-main' }, nameEl(e.name, e.dir), h('small', { class: 'src' }, ...metaNodes(meta))),
      selecting ? h('span', { class: 'files-check' }, icon(picked.has(e.path) ? 'check' : 'circle')) : iconButton('more', t('more'), (ev) => { ev.stopPropagation(); itemSheet(e, ev); }));
    // (A computer's right-click: the item's menu at the pointer; a long press — or a right-click while choosing —: choosing.)
    onLongPress(el, (ev) => { if (ev.type === 'contextmenu' && !selecting && document.documentElement.classList.contains('pc')) { itemSheet(e, ev); return; } if (!selecting) { selecting = true; } toggle(e); });
    if (((thumbable && plug() && (!isVirtual(e.path) || isArc(e.path))) || appIc) && prefs.thumbs !== false) io.observe(ic);
    // (A phone: a row swiped back toward the reading's start is deleted (asked first, as always) — the other way
    // is the drawer's.)
    if (!po.embedded && !ae.special && !isApps(e.path) && !isVirtual(e.path) && plug()) {
      const del = { label: t('delete'), icon: 'trash', run: () => void confirmDelete([e.path]) }; const back = () => (getComputedStyle(document.documentElement).direction === 'rtl' ? { right: del } : { left: del });
      swipeable(el, back, icon, () => !selecting && !collection);
    }
    if (po.embedded) { el.draggable = true; el.addEventListener('dragstart', (ev) => { const ps = picked.has(e.path) ? [...picked] : [e.path]; ev.dataTransfer?.setData('text/kt-paths', JSON.stringify(ps)); ev.dataTransfer?.setData('text/plain', ps.join('\n')); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove'; }); }
    return el;
  };

  // ---- the selection
  const toggle = (e: Entry) => { if (picked.has(e.path)) picked.delete(e.path); else picked.add(e.path); if (!picked.size) selecting = false; draw(); drawSel(); };
  const drawSel = () => {
    selBar.hidden = !selecting; if (!selecting) { root.classList.remove('selecting'); return; } root.classList.add('selecting');
    const n = picked.size; const one = n === 1 ? entries.find((e) => e.path === [...picked][0]) : undefined;
    // (Inside an archive only what reads: copy (taken out on Paste), share, take out; cut shown greyed with its reason.)
    if (isArc(at)) {
      const cut = iconButton('scissors', t('arcNoCut')); cut.disabled = true; cut.classList.add('files-off');
      selBar.replaceChildren(h('span', { class: 'files-selcount' }, countItems(n)),
        iconButton('check', t('filesSelectAll'), () => { for (const e of shown()) picked.add(e.path); draw(); drawSel(); }),
        ...(canJobs() ? [iconButton('copy', t('filesCopy'), () => { copyPicked('copy'); }), cut, iconButton('archive', t('extractHere'), () => { const ps = [...picked]; leaveSel(); void extractEntries(ps, parentOf(parseArc(at).archive)); })] : []),
        ...(plug() ? [iconButton('share', t('share'), () => { const ps = [...picked]; leaveSel(); void shareArc(ps); })] : []),
        iconButton('close', t('close'), leaveSel));
      return;
    }
    selBar.replaceChildren(
      h('span', { class: 'files-selcount' }, countItems(n)),
      iconButton('check', t('filesSelectAll'), () => { for (const e of shown()) picked.add(e.path); draw(); drawSel(); }),
      ...(canJobs() ? [iconButton('copy', t('filesCopy'), () => copyPicked('copy')), iconButton('scissors', t('filesCut'), () => copyPicked('move'))] : []),
      ...(plug() && !isVirtual(at) ? [iconButton('lock', t('vaultLock'), () => { const ps = [...picked]; leaveSel(); void import('./filesMore').then((m) => { if (!m.canVault()) { toast(t('vaultUnavailable'), 'error'); return; } m.vaultSheet(!ps.every((x) => /\.kurokawa$/i.test(x)), ps, jobRow, () => void load()); }); })] : []),
      ...(po.peer?.() ? [iconButton('swap', t('filesToOtherPane'), () => { const ps = [...picked]; leaveSel(); pickSheet(t('filesToOtherPane'), [['copy', t('filesCopy'), 'copy'], ['move', t('filesMove'), 'scissors']], 'copy', (op) => void po.peer!()!.dropIn(op as 'copy' | 'move', ps), t('cancel')); })] : []),
      iconButton('trash', t('delete'), () => void confirmDelete([...picked])),
      ...(one ? [iconButton('pen', t('rename'), () => renameSheet(one))] : []),
      iconButton('share', t('share'), () => void shareMany([...picked])),
      iconButton('more', t('more'), () => selectionSheet()),
      iconButton('close', t('close'), leaveSel));
  };
  const leaveSel = () => { selecting = false; picked.clear(); draw(); drawSel(); };
  /** The chosen put on the clipboard — a cut inside an archive is a copy (an archive is not changed from here). */
  const copyPicked = (op: 'copy' | 'move', paths = [...picked]) => {
    if (!paths.length) return; const fromArc = paths.some(isArc); const o = fromArc ? 'copy' : op;
    setClip({ op: o, paths }); if (fromArc && op === 'move') toast(t('arcCutAsCopy')); if (selecting) leaveSel(); // (the clipboard bar says the rest)
  };

  // ---- opening
  const open = async (e: Entry) => {
    const ae = e as AppEntry;
    if (ae.special) { const m = await import('./filesApps'); const to = m.resolveSpecial(ae, vroots.trees, vroots.shell); if (to) { go(to); return; } if (vplug()) { try { await vplug()!.vfsGrant({ start: ae.special === 'obb' ? 'Android/obb' : 'Android/data' }); await loadRoots(); const again = m.resolveSpecial(ae, vroots.trees, vroots.shell); if (again) go(again); } catch { /* declined */ } } else toast(t('appsNeedsGrant'), 'error'); return; }
    if (e.dir) { go(e.path); return; }
    if (isArc(e.path)) { const m = await import('./filesArc'); await openInArc(e, m); return; }
    if (isVirtual(e.path)) {
      const jid = `rf-${Date.now()}`; const el = jobRow(jid, t('remoteFetching', { name: e.name }), () => void vfs.cancel(jid));
      try { const r = await vfs.fetch(e.path, jid); el.remove(); await open({ ...e, path: r.path }); } catch (err) { el.remove(); toast(friendlyVfs(String((err as Error).message ?? err)), 'error'); }
      return;
    }
    const k = kindOfFile(e.name); const pl = plug();
    if (pl && /\.kurokawa$/i.test(e.name)) { const m = await import('./filesMore'); if (m.canVault()) { await m.openLocked(e, open); return; } }
    try {
      if (k === 'video' || k === 'audio') { const { openPlayer } = await import('./player'); const { localFileUrl } = await import('../player/files'); const u = await localFileUrl(e.path); if (u) { await openPlayer(u, e.name, { localPath: e.path }); return; } }
      // (An installed app's own APKs — its base and its parts — are there to look into, not to install again.)
      if (/\.apk$/i.test(e.name) && at.startsWith('apps://')) { go(arcPath(e.path)); return; }
      if (/\.(apk|apks|xapk|apkm)$/i.test(e.name)) { const m = await import('./apk'); if (m.canInstallApps()) { await m.installSheet(e.path); return; } }
      if (looksArchive(e.name) && !/\.epub$/i.test(e.name)) { go(arcPath(e.path)); return; }
      if (/\.(srt|ass|ssa|vtt|sub)$/i.test(e.name) && e.size < 4_000_000) { const { workshopSheet } = await import('../subs/workshop'); const vid = shown().find((x) => !x.dir && kindOfFile(x.name) === 'video' && x.name.replace(/\.[^.]+$/, '').startsWith(e.name.replace(/\.[^.]+$/, '').replace(/\.[a-z]{2,3}$/i, ''))); await workshopSheet(e.path, vid?.path); return; }
      if (/\.(txt|nfo|md|log|json|xml|srt|ass|vtt|csv|ini|cfg|yml|yaml|html?|css|js|ts|py|sh|java|kt|c|h|cpp)$/i.test(e.name) && e.size < 4_000_000 && pl) { const m = await import('./filesMore'); await m.editorSheet(e, () => void load()); return; }
      if (k === 'image' && pl) { const m = await import('./filesMore'); const { localFileUrl } = await import('../player/files'); const pics = shown().filter((x) => !x.dir && (kindOfFile(x.name) === 'image' || kindOfFile(x.name) === 'video')); await m.imageViewer(pics, Math.max(0, pics.findIndex((x) => x.path === e.path)), localFileUrl, (x) => void confirmDelete([x.path])); return; }
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

  // ---- the drawer: storages (with their used space), bookmarks, collections — Solid Explorer's, from the side
  const drawer = () => {
    const sh = openSheet(t('navFiles'), t('close')); sh.el.classList.add('files-drawer'); sideDrawer(sh.el, sh.close);
    const section = (label: string, ...kids: (HTMLElement | null)[]) => h('div', { class: 'files-drawer-section' }, h('small', { class: 'src files-drawer-label' }, label), ...kids);
    const item = (ic: string, name: string, sub: string | HTMLElement | null, fn: () => void, extra?: HTMLElement) => h('button', { type: 'button', class: 'dest-row files-drawer-row', onclick: () => { sh.close(); fn(); } }, h('span', { class: 'files-drawer-ic' }, icon(ic)), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, name), sub ? (typeof sub === 'string' ? h('small', { class: 'src', dir: 'ltr' }, sub) : sub) : null), extra ?? null);
    const storage = (r: Root) => { const used = r.total && r.free !== undefined ? Math.round(((r.total - r.free) / r.total) * 100) : null; return item(r.kind === 'app' ? 'download' : 'storage', r.name, used === null ? r.path : h('span', { class: 'files-usage' }, h('span', { class: 'files-usage-bar' }, h('i', { style: { width: `${used}%` } })), h('small', { class: 'src' }, t('filesFreeOf', { free: formatBytes(r.free!), total: formatBytes(r.total!) }))), () => { if (!r.readable) { void askAccess(); return; } go(r.path); }); };
    const bm = bookmarks();
    sh.body.append(section(t('filesStorages'), ...roots.map(storage), ...(plug() ? [item('chart', t('filesAnalyzer'), t('filesAnalyzerHint'), () => pickSheet(t('filesAnalyzer'), roots.filter((r) => r.readable).map((r): [string, string, string] => [r.path, r.name, 'storage']), roots[0]?.path ?? '', (path) => { const r = roots.find((x) => x.path === path)!; void import('./filesMore').then((m) => m.analyzerSheet(r, (e) => void open(e), (d) => go(d), (paths) => void confirmDelete(paths))); }, t('close')))] : [])));
    // Recent files (Solid Explorer's way): the latest few right in the drawer, each opened by a tap; «all» opens the collection.
    if (plug()) { const recentSec = section(t('filesRecentMenu'), h('div', { class: 'center small' }, h('div', { class: 'spinner small' }))); sh.body.append(recentSec); void plug()!.filesCollection({ kind: 'recent', limit: 6 }).then((r) => { if (!recentSec.isConnected) return; const rows = (r.entries ?? []).slice(0, 6).map((e) => item(ICON[kindOfFile(e.name)] ?? 'file', e.name, parentOf(e.path).split('/').pop() || parentOf(e.path), () => void open(e))); recentSec.replaceChildren(h('small', { class: 'src files-drawer-label' }, t('filesRecentMenu')), ...rows, item('history', t('filesRecent'), null, () => openCollection('recent'))); }).catch(() => recentSec.remove()); }
    // Bookmarks: opened by a tap; the kebab edits (a name, pinned to the home screen, moved up, removed).
    const bmMenu = (b: { name: string; path: string }) => {
      const m = openSheet(b.name, t('close')); const row = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { m.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
      m.body.append(h('div', { class: 'dest-list' },
        row('pen', t('rename'), () => { const r = openSheet(t('rename'), t('cancel')); const inp = h('input', { type: 'text', value: b.name, dir: 'auto' }) as HTMLInputElement; r.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp)); r.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { const name = inp.value.trim() || b.name; saveBookmarks(bookmarks().map((x) => (x.path === b.path ? { ...x, name } : x))); r.close(); sh.close(); drawer(); } }, icon('check'), t('rename'))); setTimeout(() => inp.focus(), 50); }),
        ...(plug() ? [row('pin', t('filesPinHome'), () => void pinHome(b.path, b.name))] : []),
        row('up', t('filesMoveUp'), () => { const a = bookmarks(); const i = a.findIndex((x) => x.path === b.path); if (i > 0) { [a[i - 1], a[i]] = [a[i], a[i - 1]]; saveBookmarks(a); } sh.close(); drawer(); }),
        row('trash', t('delete'), () => { saveBookmarks(bookmarks().filter((x) => x.path !== b.path)); sh.close(); drawer(); })));
    };
    if (bm.length) sh.body.append(section(t('filesBookmarks'), ...bm.map((b) => item('bookmark', b.name, readablePath(b.path), () => go(b.path), iconButton('more', t('more'), (ev) => { ev.stopPropagation(); bmMenu(b); })))));
    if (rplug()) {
      const redo = () => { sh.close(); void loadRoots().then(() => drawer()); };
      sh.body.append(section(t('remoteNetwork'), ...remotes.map((c) => item(kindIcon(c.kind), c.name, describe(c), () => go(`remote://${c.id}`), iconButton('more', t('more'), (ev) => { ev.stopPropagation(); connectionMenu(c, () => void loadRoots()); }))),
        item('plus', t('remoteAdd'), null, () => connectionSheet(null, redo)), item('search', t('remoteScan'), t('remoteScanHint'), () => scanSheet(redo))));
    }
    if (vplug()) {
      const redo = () => { sh.close(); void loadRoots().then(() => drawer()); };
      sh.body.append(section(t('filesSystem'),
        ...(vroots.shell ? [item('terminal', t('filesRootStorage'), vroots.shell === 'root' ? t('filesViaRoot') : t('filesViaShizuku'), () => go('root://'))] : [item('terminal', t('filesRootStorage'), vroots.shizuku ? t('filesShizukuAsk') : t('filesNoRoot'), () => { if (vroots.shizuku) void vplug()!.vfsShizukuAsk().then(() => setTimeout(redo, 1500)); else toast(t('filesNoRootHint'), 'info', 5000); })]),
        ...vroots.trees.map((tr) => item('folder', tr.name, t('filesGrantedTree'), () => go(`saf://${tr.id}`), iconButton('close', t('filesForgetTree'), (ev) => { ev.stopPropagation(); void vplug()!.vfsForgetTree({ id: tr.id }).then(redo); }))),
        item('key', t('filesGrantAndroidData'), t('filesGrantHint'), () => void vplug()!.vfsGrant({ start: 'Android/data' }).then(redo).catch(() => undefined)),
        item('folderPlus', t('filesGrantAny'), null, () => void vplug()!.vfsGrant({}).then(redo).catch(() => undefined))));
    }
    if (appsAvailable()) sh.body.append(section(t('appsTitle'), item('apps', t('appsTitle'), t('appsHint'), () => go('apps://'))));
    if (plug()) sh.body.append(section(t('filesCollections'), ...COLLECTIONS.map(([k, label, ic]) => item(ic, t(label as 'filesRecent'), null, () => openCollection(k)))), section('', item('trash', t('filesTrash'), null, () => void import('./filesMore').then((m) => m.trashSheet(() => void load())))));
  };
  /** chmod / chown / a symbolic link on a root:// entry, and the mounts (remounted read-write or back). */
  const rootOpsSheet = (e: Entry) => {
    const v = vplug(); if (!v) return; const real = e.path.replace(/^root:\/\//, '/'); const sh = openSheet(e.name, t('close'));
    const cur = h('pre', { class: 'files-text', dir: 'ltr' }, '…'); void v.vfsRootOp({ what: 'stat', path: real }).then((r) => { cur.textContent = (r.out ?? '').trim(); }, (err) => { cur.textContent = String((err as Error).message ?? err); });
    const mode = h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', placeholder: '0644', maxlength: '4' }) as HTMLInputElement; const owner = h('input', { type: 'text', dir: 'ltr', placeholder: 'root:root', autocapitalize: 'off' }) as HTMLInputElement; const link = h('input', { type: 'text', dir: 'ltr', placeholder: '/sdcard/link-name', autocapitalize: 'off' }) as HTMLInputElement;
    const run = async (what: string, path: string, arg: string) => { try { await v.vfsRootOp({ what, path, arg }); toast(t('done')); void load(); sh.close(); } catch (err) { toast(String((err as Error).message ?? err), 'error', 5000); } };
    sh.body.append(h('p', { class: 'src', dir: 'ltr' }, real), cur,
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, 'chmod'), mode), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void run('chmod', real, mode.value.trim()) }, t('apply'))),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, 'chown'), owner), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void run('chown', real, owner.value.trim()) }, t('apply'))),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, t('filesSymlinkAt')), link), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void run('link', link.value.trim(), real) }, t('create'))));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => mountsSheet() }, icon('storage'), t('filesMounts')));
  };
  const mountsSheet = () => {
    const v = vplug(); if (!v) return; const sh = openSheet(t('filesMounts'), t('close')); const list = h('div', { class: 'dest-list' }); sh.body.append(h('p', { class: 'hint' }, t('filesMountsHint')), list);
    const draw = () => void v.vfsRootOp({ what: 'mounts' }).then((r) => list.replaceChildren(...(r.mounts ?? []).map((m) => h('div', { class: 'dest-row' }, icon('storage'), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'ltr' }, m.point), h('small', { class: 'src', dir: 'ltr' }, `${m.device} · ${m.type} · ${m.ro ? 'ro' : 'rw'}`)), h('button', { type: 'button', class: 'btn text small', onclick: () => void v.vfsRootOp({ what: 'remount', path: m.point, arg: m.ro ? 'rw' : 'ro' }).then(draw, (err) => toast(String((err as Error).message ?? err), 'error')) }, m.ro ? 'rw' : 'ro')))), (err) => list.replaceChildren(h('p', { class: 'empty small' }, String((err as Error).message ?? err))));
    draw();
  };
  const friendlyVfs = (m: string): string => (m === 'noRoot' ? t('filesNoRootHint') : m === 'noAccess' ? t('filesNoAccess') : m === 'readOnly' ? t('arcReadOnly') : m);
  /** The folder on the home screen (Android 8+): the launcher asks the reader to confirm. */
  const pinHome = async (path: string, name: string) => {
    const pl = plug() as unknown as { filesShortcut?(o: { path: string; name: string }): Promise<{ ok: boolean }> } | null;
    if (!pl?.filesShortcut) { toast(t('filesPinUnsupported'), 'error'); return; }
    try { const r = await pl.filesShortcut({ path, name }); if (!r.ok) toast(t('filesPinUnsupported'), 'error'); } catch { toast(t('filesPinUnsupported'), 'error'); }
  };
  const fabSheet = () => {
    const sh = openSheet(t('create'), t('close'));
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' }, act('folderPlus', t('newFolder'), () => newFolderSheet()), ...(canPaste() ? [act('copy', t('filesPaste'), () => void paste())] : []), ...(clipboard && !clipboard.busy ? [act('close', t('filesClipClear'), () => setClip(null))] : []), act('bookmarkAdd', t('filesBookmarkHere'), () => { const b = bookmarks(); if (!b.some((x) => x.path === at)) { b.push({ name: placeName(at) || at, path: at }); saveBookmarks(b); } toast(t('filesBookmarked')); }), ...(plug() ? [act('upload', t('filesSavedShared'), () => void saveSharedSheet())] : [])));
  };

  // ---- sheets: an item's, the selection's, sort, more, rename, new folder, properties, delete
  const itemSheet = (e: Entry, at?: Event) => {
    if ((e as AppEntry).pkg && isApps(e.path) && e.dir && !(e as AppEntry).special) { void import('./filesApps').then((m) => m.appSheet((e as AppEntry).pkg!, e.name, { go, pickDir: async () => { try { const { ktPlugin } = await import('../native'); return (await ktPlugin()?.pickDir())?.dir ?? null; } catch { return null; } }, defaultDir: `${roots.find((r) => r.kind === 'app')?.path ?? '/storage/emulated/0/Download/Kurokawa'}/Apps` })); return; }
    if (isArc(e.path)) { arcItemSheet(e, at); return; }
    const pl = isVirtual(e.path) ? null : plug(); const sh = openSheet(e.name, t('close'), { at });
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('p', { class: 'src', dir: 'ltr' }, readablePath(e.path)), h('div', { class: 'dest-list' },
      act('external', t('open'), () => void open(e)),
      ...(pl && !e.dir ? [act('apps', t('openWith'), () => void pl.openWith({ path: e.path, mime: mimeOf(e.name), title: e.name })), act('type', t('filesOpenAs'), () => openAs(e))] : []),
      ...(pl ? [act('share', t('share'), () => void pl.shareFile({ path: e.path, title: e.name }))] : []),
      ...(canJobs() ? [act('copy', t('filesCopy'), () => copyPicked('copy', [e.path])), act('scissors', t('filesCut'), () => copyPicked('move', [e.path]))] : []),
      act('pen', t('rename'), () => renameSheet(e)),
      ...(pl ? [act('lock', /\.kurokawa$/i.test(e.name) ? t('vaultUnlock') : t('vaultLock'), () => void import('./filesMore').then((m) => { if (!m.canVault()) { toast(t('vaultUnavailable'), 'error'); return; } m.vaultSheet(!/\.kurokawa$/i.test(e.name), [e.path], jobRow, () => void load()); }))] : []),
      ...(e.path.startsWith('root://') ? [act('terminal', t('filesPermissions'), () => rootOpsSheet(e))] : []),
      ...(pl && e.dir ? [act('eyeOff', t('filesHideFolder'), () => void import('./filesMore').then((m) => { m.hidePath(e.path); toast(t('filesHiddenNow')); void load(); })), act('images', t('filesNomedia'), () => void import('./filesMore').then((m) => m.toggleNomedia(e.path)).then((on) => toast(on ? t('filesNomediaOn') : t('filesNomediaOff'))).catch((err) => toast(String((err as Error).message ?? err), 'error')))] : []),
      ...(!e.dir && !isVirtual(e.path) && looksArchive(e.name) ? [act('folder', /\.(apk|apks|xapk|apkm)$/i.test(e.name) ? t('apkBrowse') : t('filesOpenAsArchive'), () => { sh.close(); go(arcPath(e.path)); })] : []),
      ...(pl && !e.dir && /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|001)$/i.test(e.name) ? [act('archive', t('extractHere'), () => void extractHere(e)), act('archive', t('extractTo'), () => void import('./extract').then((m) => m.extractSheet(e.path)))] : []),
      ...(pl ? [act('archive', t('filesCompress'), () => void compress([e.path]))] : []),
      act('check', t('filesSelect'), () => { selecting = true; picked.add(e.path); draw(); drawSel(); }),
      act('info', t('properties'), () => void propertiesSheet(e)),
      act('trash', t('delete'), () => void confirmDelete([e.path]))));
  };
  /** An entry inside an archive: what reads it — open, open with, share, copy (taken out on Paste), take out here or
   *  elsewhere, properties —; what would change the archive left out, and why said once. */
  const arcItemSheet = (e: Entry, ev?: Event) => {
    const pl = plug(); const sh = openSheet(e.name, t('close'), { at: ev });
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    const off = (ic: string, label: string, why: string) => h('div', { class: 'dest-row files-off', 'aria-disabled': 'true' }, icon(ic), h('span', { class: 'grow files-main' }, h('span', { class: 'name' }, label), h('small', { class: 'src' }, why)));
    const holder = parentOf(parseArc(e.path).archive);
    sh.body.append(h('p', { class: 'src', dir: 'auto' }, readablePath(e.path)), h('div', { class: 'dest-list' },
      act('external', t('open'), () => void open(e)),
      ...(pl && !e.dir ? [act('apps', t('openWith'), () => void viaCache(e, (p) => pl.openWith({ path: p, mime: mimeOf(e.name), title: e.name }))), act('share', t('share'), () => void shareArc([e.path]))] : []),
      ...(canJobs() ? [act('copy', t('filesCopy'), () => copyPicked('copy', [e.path])), off('scissors', t('filesCut'), t('arcNoCut')),
        act('archive', t('extractHere'), () => void extractEntries([e.path], holder)), act('folder', t('extractTo'), () => void extractTo([e.path]))] : []),
      act('check', t('filesSelect'), () => { selecting = true; picked.add(e.path); draw(); drawSel(); }),
      act('info', t('properties'), () => void propertiesSheet(e))),
      h('p', { class: 'hint' }, t('arcReadOnly')));
  };
  const selectionSheet = () => {
    const sh = openSheet(countItems(picked.size), t('close')); const paths = [...picked];
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' }, act('archive', t('filesCompress'), () => void compress(paths)), act('pen', t('filesBatchRename'), () => void import('./filesMore').then((m) => m.batchRenameSheet(entries.filter((e) => picked.has(e.path)), () => { leaveSel(); void load(); }))), act('check', t('filesInvert'), () => { const all = shown(); for (const e of all) { if (picked.has(e.path)) picked.delete(e.path); else picked.add(e.path); } draw(); drawSel(); }), act('info', t('properties'), () => { const one = entries.find((e) => e.path === paths[0]); if (one) void propertiesSheet(one); })));
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
      ...(isArc(at) || collection ? [] : [act('folderPlus', t('newFolder'), () => newFolderSheet())]),
      act('check', t('filesSelectAll'), () => { selecting = true; for (const e of shown()) picked.add(e.path); draw(); drawSel(); }),
      act(prefs.hidden ? 'eye' : 'eye', prefs.hidden ? t('filesHideHidden') : t('filesShowHidden'), () => { prefs.hidden = !prefs.hidden; savePrefs(); void load(); }),
      act('refresh', t('refresh'), () => void load()),
      ...(plug() ? [act('trash', t('filesTrashSetting'), () => void import('./filesMore').then((m) => { m.setTrashOn(!m.trashOn()); toast(m.trashOn() ? t('filesTrashOn') : t('filesTrashOff')); }))] : []),
      ...(window.matchMedia('(min-width: 840px)').matches ? [act('columns', prefs.dual ? t('filesOnePane') : t('filesTwoPanes'), () => { prefs.dual = !prefs.dual; savePrefs(); navigate(`/files?p=${encodeURIComponent(at)}&t=${Date.now()}`, true); })] : []),
      act('settings', t('filesSettings'), () => void import('./filesMore').then((m) => m.filesSettingsSheet(at, () => { void loadRoots(); void load(); }))),
      act('eyeOff', t('filesHiddenFolders'), () => void import('./filesMore').then((m) => m.hiddenSheet((p) => go(p), () => void load()))),
      ...(canShareFolder() && !isVirtual(at) ? [act('wifi', t('fshareTitle'), () => void folderShareSheet(at, baseOf(at) || at))] : []),
      ...(plug() && !isVirtual(at) ? [act('pin', t('filesPinHome'), () => void pinHome(at, baseOf(at) || at))] : []),
      ...(plug() ? [act('key', t('archiveForgetPw'), () => void import('../archives').then((a) => { a.forgetPasswords(); a.setRememberPasswords(false); toast(t('done')); }))] : []),
      act('info', t('properties'), () => void propertiesSheet({ name: placeName(at), path: at, dir: true, size: 0, mtime: 0 })),
      ...(plug() ? [act('upload', t('filesSavedShared'), () => void saveSharedSheet())] : []),
      ...(plug() && !allFiles ? [act('key', t('filesAccessAllow'), () => void askAccess())] : [])));
  };
  const renameSheet = (e: Entry) => {
    const pl = plug(); if (!pl) return; if (isArc(e.path)) { toast(t('arcReadOnly'), 'info'); return; } const sh = openSheet(t('rename'), t('cancel')); const inp = h('input', { type: 'text', value: e.name, dir: 'auto' }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim(); if (!name || name === e.name) { sh.close(); return; } try { if (isVirtual(e.path)) { await vfs.rename(e.path, name); } else { const r = await pl.filesRename({ path: e.path, name }); if (r && r.ok === false) throw new Error(t('filesFailed')); } sh.close(); leaveSel(); void load(); } catch (err) { toast(String((err as Error).message ?? err) === 'exists' ? t('filesNameTaken') : String((err as Error).message ?? err), 'error'); } } }, icon('check'), t('rename')));
    setTimeout(() => { inp.focus(); inp.setSelectionRange(0, splitExt(e.name, e.dir)[0].length); }, 50);
  };
  const newFolderSheet = () => {
    const pl = plug(); if (!pl) return; if (isArc(at)) { toast(t('arcReadOnly'), 'info'); return; } const sh = openSheet(t('newFolder'), t('cancel')); const inp = h('input', { type: 'text', dir: 'auto', placeholder: t('folderNamePlaceholder') }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim(); if (!name) return; try { if (isVirtual(at)) { await vfs.mkdir(at, name); } else { const r = await pl.filesMkdir({ path: `${at}/${name}` }); if (!r.ok) throw new Error(t('filesCannotMake')); } sh.close(); void load(); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } } }, icon('check'), t('create')));
    setTimeout(() => inp.focus(), 50);
  };
  const propertiesSheet = async (e: Entry) => {
    const pl = plug(); const sh = openSheet(t('properties'), t('close')); const rows = h('div', { class: 'files-props' });
    const line = (k: string, v: string) => h('div', { class: 'files-prop' }, h('small', { class: 'src' }, k), h('span', { dir: 'auto' }, v));
    rows.append(line(t('fileName'), e.name), line(t('folderPath'), readablePath(e.path)));
    sh.body.append(rows);
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal small', onclick: () => { void navigator.clipboard?.writeText(readablePath(e.path)); toast(t('copied')); } }, icon('copy'), t('filesCopyPath')));
    // (Inside an archive: what the archive says of it — the phone is not asked about a file that is not on it.)
    if (isArc(e.path)) { rows.append(...(e.dir ? [line(t('fileSize'), joinMeta([formatBytes(e.size), e.count !== undefined ? countFiles(e.count) : '']))] : [line(t('fileSize'), e.size >= 0 ? formatBytes(e.size) : '—')]), ...(e.mtime > 0 ? [line(t('fileDate'), formatDate(e.mtime))] : []), line(t('filesAccess'), t('filesReadOnly'))); return; }
    if (!pl) { rows.append(line(t('fileSize'), e.dir ? '' : formatBytes(e.size)), line(t('fileDate'), formatDate(e.mtime))); return; }
    const sizeLine = line(t('fileSize'), '…'); rows.append(sizeLine);
    try {
      const s = await pl.filesStat({ path: e.path, id: 'props' });
      sizeLine.lastElementChild!.textContent = e.dir || s.dir ? `${formatBytes(s.size)} · ${countFiles(s.files ?? 0)} · ${countFolders(s.folders ?? 0)}` : formatBytes(s.size);
      rows.append(line(t('fileDate'), formatDate(s.mtime)), ...(s.mime ? [line(t('filesKind'), s.mime)] : []), line(t('filesAccess'), [s.readable ? t('filesReadable') : '', s.writable ? t('filesWritable') : t('filesReadOnly')].filter(Boolean).join(' · ')));
      const m = await import('./filesMore'); await m.richProperties(rows, e, line); await m.archiveProperties(rows, e, line);
    } catch (err) { sizeLine.lastElementChild!.textContent = String((err as Error).message ?? err); }
  };
  const confirmDelete = async (paths: string[]) => {
    const pl = plug(); if (!pl) return; if (paths.some(isArc)) { toast(t('arcReadOnly'), 'info'); return; }
    if (prefs.confirmDelete === false) { const m0 = await import('./filesMore'); if (m0.trashOn() && !paths.some((p) => p.includes('/.kurokawa-trash/') || isVirtual(p))) { leaveSel(); try { trashed(await m0.toTrash(paths)); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } return; } }
    const sh = openSheet(t('delete'), t('cancel'));
    sh.body.append(h('p', null, t('filesDeleteAsk', { n: localDigits(paths.length) })), h('p', { class: 'hint', dir: 'auto' }, paths.slice(0, 5).map(baseOf).join(' · ') + (paths.length > 5 ? ' …' : '')));
    const m = await import('./filesMore'); const toBin = m.trashOn() && !paths.some((p) => p.includes('/.kurokawa-trash/') || isVirtual(p));
    sh.body.append(h('p', { class: 'hint' }, toBin ? t('filesDeleteToTrash') : t('filesDeleteForeverHint')));
    // (With the recycle bin on, a second way: gone from the phone at once, the bin passed by.)
    if (toBin) sh.actions.append(h('button', { type: 'button', class: 'btn tonal danger', onclick: () => { sh.close(); leaveSel(); void startJob('delete', paths); } }, icon('trash'), t('filesDeleteForever')));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary danger', onclick: async () => { sh.close(); leaveSel(); if (!toBin) { void startJob('delete', paths); return; } try { trashed(await m.toTrash(paths)); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } } }, icon('trash'), t('delete')));
  };
  // (What the recycle bin could not take — a storage where the bin cannot be made — is not left as if deleted: the
  // reader is asked whether to delete it for good.)
  const trashed = (r: { moved: string[]; failed: string[]; failedPaths?: string[] }) => {
    void load(); const left = r.failedPaths ?? [];
    if (!left.length) { if (r.failed.length) toast(t('filesSomeFailed', { n: localDigits(r.failed.length), why: r.failed[0] }), 'error'); else toast(t('filesMovedToTrash', { n: localDigits(r.moved.length) })); return; }
    const sh = openSheet(t('delete'), t('cancel')); sh.body.append(h('p', null, t('filesTrashFailedAsk', { n: localDigits(left.length), why: r.failed[0] ?? '' })), h('p', { class: 'hint', dir: 'auto' }, left.slice(0, 5).map(baseOf).join(' · ') + (left.length > 5 ? ' …' : '')));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary danger', onclick: () => { sh.close(); void startJob('delete', left); } }, icon('trash'), t('filesDeleteForever')));
  };
  const shareMany = async (paths: string[]) => { const pl = plug(); if (!pl) return; if (paths.length === 1) { await pl.shareFile({ path: paths[0], title: baseOf(paths[0]) }).catch(() => undefined); return; } const { shareFiles } = await import('../ui/shareMany'); await shareFiles(paths); };
  const extractHere = async (e: Entry) => { const { extractArchiveJob } = await import('../archives'); const job = extractArchiveJob({ path: e.path, dest: parentOf(e.path), replace: 'ask' as never }); watchArchiveJob(job.id, job.done, e.name); };
  const watchArchiveJob = (id: string, done: Promise<unknown>, name: string) => { const el = jobRow(id, t('filesExtracting', { name }), () => void import('../archives').then((m) => m.cancelArchive(id))); done.then(() => { el.remove(); void load(); toast(t('filesExtracted', { name })); }, (err) => { el.remove(); toast(String((err as Error).message ?? err), 'error'); }); };
  const compress = async (paths: string[]) => { const m = await import('./filesMore'); leaveSel(); await m.makeArchiveSheet(paths, at, (id, label, done, cancel) => { const el = jobRow(id, label, cancel); void done.then(() => el.remove(), () => el.remove()); }, () => void load()); };
  const zipSheet = async (paths: string[]) => {
    const { createZip } = await import('../archives'); const sh = openSheet(t('filesZip'), t('cancel'));
    const stem = paths.length === 1 ? baseOf(paths[0]).replace(/\.[^.]+$/, '') : baseOf(at) || 'archive';
    const inp = h('input', { type: 'text', value: `${stem}.zip`, dir: 'auto' }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp), h('p', { class: 'hint' }, t('filesZipHint', { n: localDigits(paths.length) })));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim() || `${stem}.zip`; sh.close(); leaveSel(); const out = `${at}/${name.endsWith('.zip') ? name : name + '.zip'}`; const el = jobRow('zip', t('filesZipping', { name }), () => undefined); try { await createZip(out, paths, (p) => { const b = el.querySelector('.files-job-bar i') as HTMLElement | null; if (b && p.total) b.style.width = `${Math.round((p.done / p.total) * 100)}%`; }); el.remove(); void load(); toast(t('filesZipped', { name })); } catch (err) { el.remove(); toast(String((err as Error).message ?? err), 'error'); } } }, icon('archive'), t('filesZip')));
  };

  // ---- the jobs: copy / move / delete, with their progress, cancel and the question when a name is taken
  const me = {};
  const jobRow = (id: string, label: string, cancel: () => void): HTMLElement => {
    const el = h('div', { class: 'files-job', 'data-id': id }, h('div', { class: 'grow' }, h('span', { class: 'files-job-label', dir: 'auto' }, label), h('div', { class: 'files-job-bar' }, h('i')), h('small', { class: 'src files-job-meta' })), iconButton('close', t('cancel'), cancel));
    jobsEl.append(el); return el;
  };
  /** A job of this pane's: its row here, and it known as this pane's (the other pane only reads its folder again at the end). */
  const ownRow = (id: string, label: string, cancel: () => void) => { liveJobs.set(id, { owner: me, label, cancel }); return jobRow(id, label, cancel); };
  /** True when the job was started (its events will come). */
  const startJob = async (op: 'copy' | 'move' | 'delete', paths: string[], dest?: string, id = `fj-${Date.now()}`, label0?: string): Promise<boolean> => {
    const pl = plug(); if (!pl) return false;
    // (An archive's entries: taken out, as a copy — an archive is not changed from here, so never deleted or moved out of.)
    if (paths.length && paths.every(isArc)) { if (op === 'delete' || !dest) { toast(t('arcReadOnly'), 'error'); return false; } if (isArc(dest)) { toast(t('arcNoPaste'), 'error'); return false; } void extractEntries(paths, dest); return false; }
    if (dest && isArc(dest)) { toast(t('arcNoPaste'), 'error'); return false; }
    const srcV = paths.some(isVirtual), dstV = !!dest && isVirtual(dest);
    if (op === 'delete' && srcV) { const dirs = paths.filter((p) => entries.find((e) => e.path === p)?.dir); try { await vfs.delete(paths, dirs); toast(t('filesDeleted', { n: localDigits(paths.length) })); void load(); } catch (err) { toast(friendlyVfs(String((err as Error).message ?? err)), 'error'); } return false; }
    if ((srcV || dstV) && op !== 'delete') {
      if (srcV && dstV) { toast(t('remoteNoBetween'), 'error'); return false; }
      const label = srcV ? t('remoteDownloading', { n: localDigits(paths.length) }) : t('remoteUploading', { n: localDigits(paths.length) });
      ownRow(id, label, () => void vfs.cancel(id));
      try { await vfs.job(id, srcV ? 'down' : 'up', paths, dest!, op === 'move'); return true; } catch (err) { liveJobs.delete(id); jobsEl.querySelector(`[data-id="${id}"]`)?.remove(); toast(friendlyVfs(String((err as Error).message ?? err)), 'error'); return false; }
    }
    const label = label0 ?? (op === 'delete' ? t('filesDeleting', { n: localDigits(paths.length) }) : op === 'move' ? t('filesMoving', { n: localDigits(paths.length) }) : t('filesCopying', { n: localDigits(paths.length) }));
    ownRow(id, label, () => void pl.filesCancel({ id }));
    try { await pl.filesJob({ id, op, paths, dest, conflict: 'ask' }); return true; } catch (err) { liveJobs.delete(id); jobsEl.querySelector(`[data-id="${id}"]`)?.remove(); toast(String((err as Error).message ?? err), 'error'); return false; }
  };
  /** Why the clipboard cannot be pasted here (said on the bar, its Paste greyed), or null when it can. */
  const pasteBlock = (): string | null => {
    const c = clipboard; if (!c) return null;
    if (c.busy) return t('filesPasteBusy');
    if (!at || collection || isApps(at)) return t('filesPasteNoFolder');
    if (isArc(at)) return t('arcNoPaste');
    if (writable === false) return t('filesPasteReadOnly');
    if (intoItself(c.paths, at)) return t('filesIntoItself');
    if (c.op === 'move' && c.paths.every((p) => parentOf(p) === at)) return t('filesPasteSameFolder');
    if (c.paths.some(isVirtual) && !c.paths.every(isArc) && isVirtual(at)) return t('remoteNoBetween');
    return null;
  };
  const canPaste = (): boolean => !!clipboard && canJobs() && !pasteBlock();
  // (Whether this folder takes new files: asked of the phone once per folder — its own facts, not its contents.)
  let writable: boolean | null = null;
  const checkWritable = async () => {
    writable = null; const pl = plug(); const here = at; if (!pl || !here || collection || isVirtual(here) || isApps(here)) return;
    try { const st = await pl.filesStat({ path: here, shallow: true } as never); if (here === at && !gone) { writable = st && st.writable === false ? false : true; drawClip(); } } catch { /* unknown: Paste tries */ }
  };
  /** The clipboard bar: what is on it (the one's name, or how many), copied or to be moved, Paste here and Cancel. */
  const drawClip = () => {
    const c = clipboard; const show = !!c && canJobs(); clipBar.hidden = !show; if (c) clipBar.dataset.op = c.op; root.classList.toggle('has-clip', show);
    if (!c || !show) { clipBar.replaceChildren(); return; }
    const why = pasteBlock(); const one = c.paths.length === 1; const fromArc = c.paths.every(isArc);
    const what = one ? nameEl(baseOf(c.paths[0]), false, 'files-clip-name') : h('b', { class: 'files-clip-name' }, t('filesClipCount', { n: localDigits(c.paths.length) }));
    const how = c.busy ? t('filesPasteBusy') : fromArc ? t('filesClipExtract') : c.op === 'copy' ? t('filesClipCopy') : t('filesClipMove');
    const pasteB = h('button', { type: 'button', class: 'btn filled small files-clip-paste', title: why ?? t('filesPaste'), onclick: () => void paste() }, icon('paste'), h('span', null, t('filesPaste'))) as HTMLButtonElement;
    pasteB.disabled = !!why;
    clipBar.replaceChildren(h('span', { class: 'files-clip-ic' }, icon(c.op === 'move' ? 'scissors' : 'copy')),
      h('span', { class: 'files-clip-text' }, what, h('small', { class: 'files-clip-why' + (why ? ' blocked' : '') }, why ?? how)),
      pasteB, iconButton('close', t('filesClipClear'), () => { if (!clipboard?.busy) setClip(null); }));
  };
  clipWatch.add(drawClip);
  const drawPaste = drawClip;
  // (A copy stays on the clipboard, to paste again elsewhere; a cut is marked busy while its move runs, and what the move
  // left behind stays cut. Entries of an archive are taken out, never moved.)
  const paste = async () => {
    const c = clipboard; if (!c || !canJobs()) return;
    const why = pasteBlock(); if (why) { toast(why, 'error'); return; }
    if (c.paths.every(isArc)) { await extractEntries(c.paths, at); return; }
    if (c.op === 'copy') { await startJob('copy', c.paths, at); return; }
    const id = `fj-${Date.now()}`; setClip({ ...c, busy: id });
    if (!(await startJob('move', c.paths, at, id)) && clipboard?.busy === id) setClip({ op: 'move', paths: c.paths });
  };
  /** An archive's entries taken out into `dest` as a paste does: unpacked (with progress) to a hidden folder there, then
   *  moved in by a job of the phone's — the same question when a name is taken, Cancel, the summary —, the hidden
   *  folder removed at the end, whatever happened. */
  const extractEntries = async (paths: string[], dest: string): Promise<void> => {
    const pl = plug(); if (!pl || !paths.length) return; const m = await import('./filesArc'); const a = await import('../archives');
    const id = `fx-${Date.now()}`; const stage = `${dest.replace(/\/+$/, '')}/${STAGE}${id}`; let stopped = false; let jobId = '';
    const label = paths.length === 1 ? t('filesExtracting', { name: baseOf(paths[0]) }) : t('filesExtractingN', { n: localDigits(paths.length) });
    const el = jobRow(id, label, () => { stopped = true; if (jobId) void a.cancelArchive(jobId); });
    const dropStage = () => void pl.filesJob({ id: `fq-${Date.now()}`, op: 'delete', paths: [stage] }).catch(() => undefined);
    try {
      const job = m.arcExtract(paths, stage, (pr) => { const b = el.querySelector('.files-job-bar i') as HTMLElement | null; if (b && pr.total) b.style.width = `${Math.round((pr.done / pr.total) * 100)}%`; (el.querySelector('.files-job-meta') as HTMLElement).textContent = `${baseOf(pr.file || '')} · ${formatBytes(pr.done)}${pr.total ? ` / ${formatBytes(pr.total)}` : ''}`; });
      jobId = job.id; await job.done;
    } catch (err) { el.remove(); dropStage(); if (!stopped && !/stopped|cancel/i.test(String((err as Error).message ?? err))) toast(String((err as Error).message ?? err), 'error', 5000); else toast(t('filesCancelled')); return; }
    el.remove(); if (stopped) { dropStage(); toast(t('filesCancelled')); return; }
    const moveId = `fj-${Date.now()}`; stagings.set(moveId, stage);
    if (!(await startJob('move', paths.map((p) => `${stage}/${parseArc(p).inner}`), dest, moveId, t('filesExtractingN', { n: localDigits(paths.length) })))) { stagings.delete(moveId); dropStage(); }
  };
  const extractTo = async (paths: string[]) => {
    let d: string | null = null;
    try { if (window.kurokawaTools?.pickDir) d = await window.kurokawaTools.pickDir(); else d = (await ktPlugin()?.pickDir())?.dir ?? null; } catch { d = null; }
    if (d) await extractEntries(paths, d);
  };
  /** A file inside an archive taken out to the cache, then `fn` given its path there (open with, share). */
  const viaCache = async (e: Entry, fn: (p: string) => Promise<unknown>) => { try { const m = await import('./filesArc'); toast(t('archiveOpening', { name: e.name })); await fn(await m.arcFetch(e.path)); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } };
  const shareArc = async (paths: string[]) => {
    const files = paths.filter((p) => !entries.find((x) => x.path === p)?.dir); if (!files.length) { toast(t('arcShareFiles'), 'info'); return; }
    try { const m = await import('./filesArc'); toast(t('archiveOpening', { name: files.length === 1 ? baseOf(files[0]) : t('filesClipCount', { n: localDigits(files.length) }) })); const local: string[] = []; for (const p of files) local.push(await m.arcFetch(p)); await shareMany(local); } catch (err) { toast(String((err as Error).message ?? err), 'error'); }
  };
  const ends = (ev: JobEvent) => ev.status === 'done' || ev.status === 'cancelled' || ev.status === 'failed';
  const onJob = (ev: JobEvent) => {
    const rec = liveJobs.get(ev.id);
    if (rec && rec.owner !== me) {
      if (rec.owner || rec.ended) { if (ends(ev)) void load(); return; }
      rec.owner = me; if (!jobsEl.querySelector(`[data-id="${ev.id}"]`)) jobRow(ev.id, rec.label, rec.cancel);
    }
    const el = jobsEl.querySelector(`[data-id="${ev.id}"]`) as HTMLElement | null;
    // (Another part's job — none of this pane's —: its end only reads the folder again.)
    if (!el && !rec) { if (ends(ev)) void load(); return; }
    if (ev.status === 'progress') { if (!el) return; const b = el.querySelector('.files-job-bar i') as HTMLElement; const pct = ev.total ? Math.round(((ev.done ?? 0) / ev.total) * 100) : 0; b.style.width = `${pct}%`; (el.querySelector('.files-job-meta') as HTMLElement).textContent = `${ev.name ?? ''} · ${formatBytes(ev.done ?? 0)}${ev.total ? ` / ${formatBytes(ev.total)}` : ''} · ${localDigits(ev.files ?? 0)}/${localDigits(ev.ofFiles ?? 0)}`; return; }
    if (ev.status === 'conflict') { conflictSheet(ev); return; }
    el?.remove(); void load();
    if (rec) { rec.ended = true; setTimeout(() => liveJobs.delete(ev.id), 2000); }
    // (An archive's entries moved in from their hidden folder: the folder goes, whatever happened.)
    const stage = stagings.get(ev.id); if (stage) { stagings.delete(ev.id); void plug()?.filesJob({ id: `fq-${Date.now()}`, op: 'delete', paths: [stage] }).catch(() => undefined); }
    const c = clipboard; if (c?.busy === ev.id) { const rest = ev.remaining ?? (ev.status === 'done' && !ev.failed?.length ? [] : c.paths); setClip(rest.length ? { op: 'move', paths: rest } : null); }
    if (ev.status === 'done') { if (ev.failed?.length) summarySheet(ev); else if (ev.left) toast(t('filesLeftInPlace', { n: localDigits(ev.left) }), 'info', 5000); else if (ev.skipped) toast(t('filesDoneSkipped', { n: localDigits(ev.skipped) })); else toast(t('filesDone')); }
    else if (ev.status === 'cancelled') { if (ev.failed?.length) summarySheet(ev); else toast(ev.left ? t('filesCancelledLeft', { n: localDigits(ev.left) }) : t('filesCancelled')); }
    else if (ev.status === 'failed') toast(ev.message ?? t('filesFailed'), 'error');
  };
  /** The end of a job where some items failed: the others went through; what failed, and why, listed. */
  const summarySheet = (ev: JobEvent) => {
    const failed = ev.failed ?? []; const sh = openSheet(t('filesSummaryTitle'), t('close'));
    sh.body.append(h('p', null, joinMeta([t('filesSummaryDone', { n: localDigits(Math.max(0, (ev.files ?? 0) - (ev.skipped ?? 0))) }), ev.skipped ? t('filesSummarySkipped', { n: localDigits(ev.skipped) }) : '', t('filesSummaryFailed', { n: localDigits(failed.length) })])),
      h('ul', { class: 'files-failed' }, ...failed.slice(0, 30).map((f) => h('li', { dir: 'auto' }, f))), ...(failed.length > 30 ? [h('p', { class: 'hint' }, '…')] : []));
  };
  const conflictSheet = (ev: JobEvent) => {
    const pl = plug()!; let answered = false;
    // (Closed unanswered — the button, Escape, the scrim, or another sheet over it —: the job is cancelled, not left waiting.)
    const sh = openSheet(t('filesNameTakenTitle'), t('cancel'), { onClose: () => { if (!answered) void pl.filesCancel({ id: ev.id }); } });
    const name = baseOf(ev.to ?? ''); const all = h('input', { type: 'checkbox' }) as HTMLInputElement;
    sh.body.append(h('p', null, t('filesNameTakenAsk', { name: `\u2068${name}\u2069` })),
      h('div', { class: 'files-compare' }, h('div', null, h('small', { class: 'src' }, t('filesIncoming')), h('span', null, ...(ev.dir ? [t('filesAFolder')] : metaNodes(joinMeta([formatBytes(ev.size ?? 0), ev.mtime ? formatDate(ev.mtime) : '']))))), h('div', null, h('small', { class: 'src' }, t('filesExisting')), h('span', null, ...metaNodes(joinMeta([formatBytes(ev.existingSize ?? 0), ev.existingMtime ? formatDate(ev.existingMtime) : '']))))),
      h('label', { class: 'check-row' }, all, h('span', null, t('filesSameForRest'))));
    const answer = (a: string) => { answered = true; sh.close(); void pl.filesAnswer({ id: ev.id, answer: a + (all.checked ? 'All' : '') }); };
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => answer('skip') }, t('skip')), h('button', { type: 'button', class: 'btn tonal', onclick: () => answer('keep') }, t('keepBoth')), h('button', { type: 'button', class: 'btn primary', onclick: () => answer('replace') }, t('replace')));
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
  const pl = plug(); if (pl) { void listen<JobEvent>(pl as never, 'files', onJob).then((s) => { sub = s as { remove(): void }; }); void import('./filesMore').then((m) => m.pruneTrash()); }
  void (async () => { await loadRoots(); drawKinds(); if (!at && !collection) { status.textContent = t('filesNoStorage'); return; } await load(); if (route.save) void saveSharedSheet(); })();
  let wake: { release(): Promise<void> } | null = null;
  if (prefs.keepOn) void (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => undefined);
  // Back (the phone's, a mouse's, Alt+←, the arrow in the bar): the open sheet or viewer closes first (the app's back
  // stack does that), then the selection or the filter, then up a folder at a time to the top of Files, and only then
  // Files is left — for the place the reader came from, not always the downloads.
  root.addEventListener('pointerdown', () => { activePane = me; }, true);
  const unBack = onBackStep(() => {
    if (gone || !root.isConnected) return false;
    if (po.peer?.() && (activePane ? activePane !== me : po.side === 'b')) return false;
    if (backStep()) return true;
    if (po.embedded && po.side === 'b') return false;
    const from = cameFrom('files'); if (from === '/' ) return false; navigate(from); return true;
  });
  // A computer's keys, as a file manager's: Ctrl+A all, Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste, Delete to the
  // bin, F2 rename the one chosen, Ctrl+F filter this folder, Alt+↑ (or Backspace) the folder above, Escape let go.
  const onKeys = (ev: KeyboardEvent) => {
    if (!root.isConnected || document.querySelector('.sheet') || !document.documentElement.classList.contains('pc')) return;
    const el = ev.target as HTMLElement; if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) { if (ev.key === 'Escape' && el === search) { search.value = ''; query = ''; search.hidden = true; draw(); } return; }
    // (Only the pane last clicked in, when two are side by side.)
    if (po.peer?.() && !root.contains(document.activeElement) && !root.matches(':hover')) return;
    const mod = ev.ctrlKey || ev.metaKey; const k = ev.key.toLowerCase();
    const one = picked.size === 1 ? entries.find((e) => e.path === [...picked][0]) : undefined;
    if (mod && k === 'a') { ev.preventDefault(); selecting = true; for (const e of shown()) picked.add(e.path); draw(); drawSel(); }
    else if (mod && (k === 'c' || k === 'x') && picked.size && canJobs()) { ev.preventDefault(); copyPicked(k === 'c' ? 'copy' : 'move'); }
    else if (mod && k === 'v' && clipboard && canJobs()) { ev.preventDefault(); void paste(); }
    else if (mod && k === 'f') { ev.preventDefault(); search.hidden = false; search.focus(); }
    else if (ev.key === 'Delete' && picked.size) { ev.preventDefault(); void confirmDelete([...picked]); }
    else if (ev.key === 'F2' && one) { ev.preventDefault(); renameSheet(one); }
    else if (ev.key === 'Escape' && selecting) { ev.preventDefault(); leaveSel(); }
    else if (ev.key === 'Escape' && clipboard && !clipboard.busy) { ev.preventDefault(); setClip(null); }
    else if ((ev.altKey && ev.key === 'ArrowUp') || (ev.key === 'Backspace' && !mod)) { const up = collection ? null : upOf(at); if (up) { ev.preventDefault(); goUp(up); } }
  };
  window.addEventListener('keydown', onKeys);
  const unSwipe = swipeToOpen(root, () => drawer());
  // (Pulled down at the top: the folder read again — what another app changed shows.)
  const unPull = po.embedded ? () => undefined : pullToRefresh(root, () => load(), { scroller: () => body });
  root.dispose = () => { keepScroll(); gone = true; clipWatch.delete(drawPaste); for (const r of liveJobs.values()) if (r.owner === me) r.owner = null; unSwipe(); unPull(); io.disconnect(); moreIo?.disconnect(); sub?.remove(); unBack(); window.removeEventListener('keydown', onKeys); void wake?.release().catch(() => undefined); };
  const pane = root as unknown as Pane;
  pane.pathNow = () => at; pane.reload = () => { if (!gone) draw(); };
  pane.dropIn = async (op, paths) => { if (!at || collection) { toast(t('filesNoStorage'), 'error'); return; } if (isArc(at)) { toast(t('arcNoPaste'), 'error'); return; } if (intoItself(paths, at)) { toast(t('filesIntoItself'), 'error'); return; } await startJob(paths.every(isArc) ? 'copy' : op, paths.filter((p) => parentOf(p) !== at), at); };
  if (po.embedded) {
    root.classList.add('files-pane'); if (po.side) root.dataset.side = po.side;
    body.addEventListener('dragover', (ev) => { if (ev.dataTransfer?.types.includes('text/kt-paths')) { ev.preventDefault(); ev.dataTransfer.dropEffect = ev.shiftKey ? 'move' : 'copy'; body.classList.add('drop-over'); } });
    body.addEventListener('dragleave', () => body.classList.remove('drop-over'));
    body.addEventListener('drop', (ev) => { body.classList.remove('drop-over'); const raw = ev.dataTransfer?.getData('text/kt-paths'); if (!raw) return; ev.preventDefault(); let ps: string[] = []; try { ps = JSON.parse(raw) as string[]; } catch { return; } void pane.dropIn(ev.shiftKey ? 'move' : 'copy', ps); });
  }
  return pane;
}
