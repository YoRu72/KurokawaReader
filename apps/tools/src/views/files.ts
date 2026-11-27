// The Files add-on: the device's folders as a file manager shows them (Solid Explorer's shape, ZArchiver's speed):
// the storages (the app's folder, the phone, SD cards, USB drives) with their free space, breadcrumbs, a list or a
// grid, sorted by name / date / size / type with folders first, filtered by kind (images, music, video, documents,
// archives, apps), hidden files, a search within the folder; files opened in the app (the player, the archives, the
// installer) or by any app (Open with…, Open as a kind); a selection (held) copied, cut, pasted, deleted, renamed,
// shared, zipped, with properties; the operations as jobs with their progress and a question when a name is taken;
// what other apps share to «Save to device» saved where you choose.
import { resolvePath, dirOfPath, intoItself } from './filesPath';
import { sideDrawer, swipeToOpen } from '../ui/sideSwipe';
import { swipeable } from '../ui/swipe';
import { claimTouch } from '../ui/touchOwner';
import { pullToRefresh } from '../ui/gestures';
import { h, icon, iconButton, toast, openSheet, pickSheet, onLongPress } from '../ui/dom';
import { t, formatBytes, formatDate, formatDateShort, formatRowDate, localDigits, countFiles, countItems, countFolders, countLabel, getLang } from '../i18n';
/** A count of files standing alone: «العدد: 2» in Arabic, «2 files» elsewhere. */
const countLabelFiles = (n: number): string => (getLang() === 'ar' ? countLabel(n) : countFiles(n));
import { ktPlugin, listen, nativePlatform } from '../native';
import { navigate, previousPath } from '../router';
import { onBack as onBackStep } from '../ui/backstack';
import { lazyThumb, placeImg, drawThumb, pcThumbable, dropThumbs } from '../ui/thumbs';
import { mimeMatches, mimeOfName, pickResult, kindsAsked, type PickRequest } from './pickLogic';
import { kindOfFile } from './taskFiles';
import { isArc, arcPath, parseArc, arcName, looksArchive, canExtractName } from './filesArc';
import { isApps, appsPath, parseApps, appsAvailable } from './filesApps';
import { nameDotExt } from '../ui/nameExt';
import { sizeOf, calcSize, watchSize, sizeRunning, type SizeInfo } from './filesSize';
import { refitTopbar } from '../ui/fitTopbar';
import { folderIcon } from './filesGlyph';
import { splitExt, nameParts, joinMeta, readablePath, placeName, readShared, readSaved } from './filesNames';
type AppEntry = Entry & { pkg?: string; sub?: string; special?: 'data' | 'obb' | 'media' };

export interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number; ext?: string; hidden?: boolean; count?: number }
interface Root { kind: string; path: string; name: string; readable: boolean; free?: number; total?: number; appFolder?: string }
type JobEvent = { id: string; status: 'progress' | 'conflict' | 'done' | 'cancelled' | 'failed'; done?: number; total?: number; files?: number; ofFiles?: number; name?: string; from?: string; to?: string; size?: number; existingSize?: number; mtime?: number; existingMtime?: number; dir?: boolean; failed?: string[]; /** A Full check's: the files that passed it, and the ones whose copy differed. */ verified?: number; mismatch?: string[]; message?: string; /** A move's: the files left where they were (skipped, failed, cancelled), and the chosen paths still there. */ left?: number; remaining?: string[]; skipped?: number };
type Plug = {
  filesList(o: { path: string; counts?: boolean; hidden?: boolean }): Promise<{ exists: boolean; entries: Entry[]; truncated?: boolean }>;
  /** Child counts of folders, on demand (at most 64 paths a call; -1: unreadable; a count of 10000 means «10000 or more»). */ filesCounts?(o: { paths: string[]; hidden?: boolean }): Promise<{ counts: Record<string, number> }>;
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
  sharedPending(): Promise<{ items: { uri: string; name: string; size: number; mime: string }[] }>; sharedSave(o: { dir: string; clear?: boolean; uris?: string[] }): Promise<{ saved: string[]; failed: string[]; dir: string }>; sharedClear(): Promise<void>; sharedDrop?(o: { uris: string[] }): Promise<void>;
  openChooser(o: { path: string; mime?: string; title: string }): Promise<void>; openWith(o: { path: string; mime: string; title: string }): Promise<void>; shareFile(o: { path: string; title: string }): Promise<void>;
  defaultDir(): Promise<{ dir: string }>;
  /** Files' own chooser (views/openWith.ts): the apps that open a type, and one of them asked to. */
  appsFor?(o: { path: string; mime: string }): Promise<{ apps: { pkg: string; cls: string; label: string; icon?: string }[] }>; openIn?(o: { path: string; mime: string; pkg: string; cls: string }): Promise<void>;
};
type Desk = { fileUrl?(p: string): Promise<string>; listDir?(p: string): Promise<{ entries: Entry[] }>; openPath?(p: string): Promise<unknown>; homeDir?(): Promise<string> };
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Partial<Plug> | null; return p?.filesList ? (p as Plug) : null; };
const desk = (): Desk | null => (window.kurokawaTools as unknown as Desk | undefined) ?? null;
export const canBrowseFiles = (): boolean => !!(plug() || desk()?.listDir);
/** The jobs' side of the phone's plugin — and of a computer's shell where it has them (the Tauri shell's filesJob,
 *  filesCancel, filesAnswer and onFilesJob: the same rules and events as the phone's; Electron's shell has none). */
type Jobs = Pick<Plug, 'filesJob' | 'filesCancel' | 'filesAnswer'> & { addListener(ev: string, fn: (d: never) => void): unknown };
type DeskJobs = Partial<Pick<Plug, 'filesJob' | 'filesCancel' | 'filesAnswer'>> & { onFilesJob?(cb: (ev: JobEvent) => void): () => void; deletePath?(p: string): Promise<{ ok: boolean }> };
const deskJobs = (): DeskJobs | null => { const d = window.kurokawaTools as unknown as DeskJobs | undefined; return d?.filesJob && d.filesCancel && d.filesAnswer && d.onFilesJob ? d : null; };
const jobs = (): Jobs | null => {
  const p = plug(); if (p) return p as unknown as Jobs;
  const d = deskJobs(); if (!d) return null;
  return { filesJob: (o) => d.filesJob!(o), filesCancel: (o) => d.filesCancel!(o), filesAnswer: (o) => d.filesAnswer!(o), addListener: (_ev, fn) => ({ remove: d.onFilesJob!(fn as (ev: JobEvent) => void) }) };
};
/** Copy, move and delete as jobs: the phone's, or the computer's where its shell has them. */
const canJobs = (): boolean => !!jobs();
/** A file's SHA-256 by the shell's own streaming hashFile (the phone's plugin, a computer's shell), or null where there is none. */
const hashOf = (): ((p: string) => Promise<string>) | null => {
  const d = window.kurokawaTools as unknown as { hashFile?(p: string): Promise<{ sha256: string }> } | undefined; if (d?.hashFile) return async (x) => (await d.hashFile!(x)).sha256;
  const pl = ktPlugin() as unknown as { hashFile?(o: { path: string }): Promise<{ sha256: string }> } | null; if (pl?.hashFile) return async (x) => (await pl.hashFile!({ path: x })).sha256; return null;
};
/** Whether «Verify after copying → Full check» can run here (jobs and a streaming checksum). */
export const canVerifyFull = (): boolean => canJobs() && !!hashOf();
/** Whether the Jobs queue and its setting apply here (the same jobs). */
export const canRunJobs = (): boolean => canJobs();
/** The job queue (views/filesQueue.ts), once loaded — the first job asked for loads it. */
let Q: typeof import('./filesQueue') | null = null;
let queueOffered = false;
/** Job ids are never repeated, even for jobs asked for in the same millisecond (Resume asks for several at once). */
let idSeq = 0; const nid = (p: string): string => `${p}-${Date.now()}-${++idSeq}`;
/** The storages and the one-item changes (new folder, rename, the facts of one path): the phone's plugin, or a computer's
 *  shell where it has them — the Tauri shell's filesRoots, filesStat (shallow), filesMkdir and filesRename, the same
 *  shapes; Electron's shell has none. */
type Fsx = Pick<Plug, 'filesRoots' | 'filesStat' | 'filesMkdir' | 'filesRename'>;
const fsx = (): Fsx | null => { const p = plug(); if (p) return p; const d = window.kurokawaTools as unknown as Partial<Fsx> | undefined; return d?.filesRoots && d.filesStat && d.filesMkdir && d.filesRename ? (d as Fsx) : null; };
/** A storage's name in the page's language (the phone's own storage, a computer's home and its usual folders); a disk keeps its own. */
const rootName = (r: Root): string => ({ phone: t('filesInternalStorage'), home: t('filesHome'), downloads: t('filesPlaceDownloads'), desktop: t('filesPlaceDesktop'), documents: t('filesPlaceDocuments') } as Record<string, string>)[r.kind] ?? r.name;
/** Archives taken out, made and browsed with the app's own tools: the phone's plugin, or a computer's shell that has
 *  both the archive functions and the file jobs (the Tauri shell; Electron's has no jobs, and its Files page stays as
 *  it was). */
const arcOk = (): boolean => !!plug() || (canJobs() && !!(window.kurokawaTools as unknown as { archiveList?: unknown } | undefined)?.archiveList);
/** A storage's refusal in words: a name taken, a name with a separator (or, on Windows, a character it forbids), what
 *  could not be done — the phone's and the computer's shell answer with these codes. */
const fsErr = (m: string): string => (m === 'exists' ? t('filesNameTaken') : m === 'bad name' ? t('filesBadName') : m === 'cannot rename' ? t('filesFailed') : m);
/** «Everywhere in my folders» (views/filesearch.ts, loaded on first use): a computer's Tauri shell with its file index
 *  only — never the phone, Electron or the web. */
const canEverywhere = (): boolean => !plug() && !!(window.kurokawaTools as unknown as { fileSearch?: unknown } | undefined)?.fileSearch && document.documentElement.classList.contains('pc');
const rootIcon = (kind: string): string => ({ app: 'download', downloads: 'download', home: 'user', desktop: 'layout', documents: 'file' } as Record<string, string>)[kind] ?? 'storage';

/* ---------- what is kept: the view, the sort, hidden files, the last folder, the clipboard ---------- */
export type Prefs = { view: 'list' | 'grid' | 'gallery'; /** Columns chosen by pinching, per view and kind of folder (`grid:media`, `gallery:plain`…). */ cols?: Record<string, number>; sort: 'name' | 'date' | 'size' | 'type'; desc: boolean; /** Folders listed before files (on unless off). */ foldersFirst?: boolean; hidden: boolean; last?: string; kind: string; /** Two panes side by side on a wide screen. */ dual?: boolean; lastB?: string;
  /** The folder the page opens on (empty: the last one when `rememberLast`, else the first storage). */ home?: string; rememberLast?: boolean; counts?: boolean; thumbs?: boolean; density?: 'comfortable' | 'compact'; /** The text of names and details in the lists (normal when not set). */ textSize?: 'small' | 'large' | 'larger'; confirmDelete?: boolean; /** A folder's size shown in its row once counted (Calculate size); on unless off. */ dirSizes?: boolean; keepOn?: boolean; eink?: boolean; backUp?: boolean; /** After copying or moving: the engine's size check (the default), or the content compared too. */ verify?: 'size' | 'full'; /** Copy, move, delete and extract jobs: one at a time (waiting in the queue, the default) or together. */ jobsMode?: 'one' | 'together' };
const PREFS = 'kt.files.prefs';
/** The view button cycles list, grid, gallery; each says what a tap switches TO. */
const NEXT_VIEW: Record<Prefs['view'], Prefs['view']> = { list: 'grid', grid: 'gallery', gallery: 'list' };
const VIEW_TO = { list: 'filesViewToList', grid: 'filesViewToGrid', gallery: 'filesViewToGallery' } as const;
export const prefs: Prefs = { view: 'grid', sort: 'name', desc: false, hidden: false, kind: 'all', ...(() => { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>; } catch { return {}; } })() };
/** (0.22.1) While another app's picker is shown: the Files page's own view, kept aside — the picker opens in its own
 *  (the list unless changed there, kept under kt.files.pickView) and never changes the page's. */
let pageView: Prefs['view'] | null = null;
export const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(pageView ? { ...prefs, view: pageView } : prefs)); } catch { /* none */ } };
/** A name folded for searching: letter case, diacritics and the Arabic marks and letter forms aside. */
const fold = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();
/** The sort of the folder shown when it was chosen to be remembered (views/filesMenu.ts keeps the store), else the global one. */
export type SortSet = { sort: Prefs['sort']; desc: boolean; ff: boolean };
export const SORTS = 'kt.files.sorts'; export const RECENT = 'kt.files.recent';
let sortOver: SortSet | null = null;
const sortFor = (p: string): SortSet | null => { try { return (JSON.parse(localStorage.getItem(SORTS) ?? '{}') as Record<string, SortSet>)[p] ?? null; } catch { return null; } };
/** The last 8 folders visited, the latest first. */
const noteRecent = (p: string): void => { try { const a = JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[]; if (a[0] === p) return; localStorage.setItem(RECENT, JSON.stringify([p, ...a.filter((x) => x !== p)].slice(0, 8))); } catch { /* none */ } };
// (One clipboard for the page — both panes —: a copy stays on it until replaced or cleared; a cut until its move has gone
// through — what was left behind stays cut. `busy`: the move under way, while it runs nothing more is pasted from it.)
let clipboard: { op: 'copy' | 'move'; paths: string[]; busy?: string } | null = null;
const clipWatch = new Set<() => void>();
/** Where each folder was scrolled to, kept while the app runs: coming back to a folder (Back, a breadcrumb) finds it there. */
const scrollMemo = new Map<string, number>();
/** The pane last touched (two side by side): the one Back walks up. */
let activePane: object | null = null;
/** The panes told when the pane the keys go to changes (its focus ring drawn). */
const paneWatch = new Set<() => void>();
/** The hidden folders an archive's entries are taken out to before they are moved in (by the move job's id). */
const stagings = new Map<string, string>();
const STAGE = '.kurokawa-extract-';
/** The engine jobs a Full check runs under one visible job (their events go to it, not to the page's own handling). */
const subJobs = new Map<string, (ev: JobEvent) => void>();
/** Jobs started plainly (the engine checked the sizes), and moves that were a rename on one storage (nothing copied to check). */
const sizeChecked = new Set<string>(); const renamedMoves = new Set<string>();
let stagesSwept = false;
/** What a paste found gone from the clipboard (said on its bar): '' none, 'all' every item, else how many. Any new
 *  clipboard puts it down. */
let clipGone = '';
const setClip = (c: typeof clipboard, gone = '') => { clipboard = c; clipGone = c ? gone : ''; keepResume({ clip: c ? { op: c.op, paths: c.paths, ...(c.busy ? { busy: c.busy } : {}) } : null }); for (const f of clipWatch) f(); };
export { intoItself }; // (views/filesPath.ts)
// (The jobs under way and the pane that asked for each: only that pane answers a job's questions and shows its row; a
// pane gone — the page moved on — leaves its jobs to the next pane that hears of them.)
type JobRec = { owner: object | null; label: string; cancel: () => void; ended?: boolean };
const liveJobs = new Map<string, JobRec>();
/* ---------- surviving a restart of the page (Android ending its renderer to free memory) ---------- */
// (The phone's engine jobs run on in the app while the page is loaded again: what each one is — its words for the Jobs
// sheet and its row — is kept beside it, a few dozen at most, so the page that comes back can show them again.)
type LiveNote = { label: string; kind: 'copy' | 'move' | 'delete'; from: string; to?: string; what?: string };
const LIVE = 'kt.files.live';
const liveNotes = (): Record<string, LiveNote> => { try { const v = JSON.parse(localStorage.getItem(LIVE) ?? '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, LiveNote>) : {}; } catch { return {}; } };
const liveNote = (id: string, n: LiveNote | null) => { const all = liveNotes(); if (n) all[id] = n; else if (!(id in all)) return; else delete all[id]; const ks = Object.keys(all); for (const k of ks.slice(0, Math.max(0, ks.length - 40))) delete all[k]; try { if (Object.keys(all).length) localStorage.setItem(LIVE, JSON.stringify(all)); else localStorage.removeItem(LIVE); } catch { /* none */ } };
/** Where the page stood — the folder (and the other pane's), its scroll, the clipboard —, kept small, for the page that
 *  comes back after Android ended its renderer (ui/restore.ts reads it once, then only on such a return). */
const RESUME = 'kt.resume.files';
type ResumeFiles = { at?: string; b?: string; y?: number; clip?: { op: 'copy' | 'move'; paths: string[]; busy?: string } | null };
let resumeTimer = 0; let resumeNext: ResumeFiles | null = null;
const keepResume = (part: Partial<ResumeFiles>) => {
  if (!plug()) return; // (the phone only: a computer's page is never ended this way)
  if (!resumeNext) { try { resumeNext = JSON.parse(localStorage.getItem(RESUME) ?? '{}') as ResumeFiles; } catch { resumeNext = {}; } }
  const next: ResumeFiles = { ...resumeNext, ...part }; if (next.clip) next.clip = { op: next.clip.op, paths: next.clip.paths.slice(0, 500), ...(next.clip.busy ? { busy: next.clip.busy } : {}) }; resumeNext = next;
  window.clearTimeout(resumeTimer); resumeTimer = window.setTimeout(() => { try { const t0 = JSON.stringify(next); if (t0.length < 200000) localStorage.setItem(RESUME, t0); } catch { /* none */ } }, 300);
};
/** What ui/restore.ts handed over for the page that came back (taken once). */
const takeResume = (): ResumeFiles | null => { const w = window as unknown as { __ktResumeFiles?: ResumeFiles | null }; const r = w.__ktResumeFiles ?? null; w.__ktResumeFiles = null; return r; };

import { isRemote, isVirtual, parseRemote, connections, connectionSheet, connectionMenu, scanSheet, rplug, vplug, vfs, vfsRoots, kindIcon, describe, canShareFolder, folderShareSheet, type Conn, type VRoots } from './filesRemote';
const KINDS: [string, string, RegExp | null][] = [['all', 'filesKindAll', null], ['image', 'filesKindImages', /^(jpe?g|png|gif|webp|bmp|heic|heif|hif|avif|svg|tiff?|ico|wbmp|jfif|apng)$/], ['audio', 'filesKindMusic', /^(mp3|m4a|flac|ogg|opus|wav|aac|wma)$/], ['video', 'filesKindVideo', /^(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|mts|flv|wmv|3gp)$/], ['doc', 'filesKindDocs', /^(pdf|epub|mobi|azw3?|docx?|xlsx?|pptx?|txt|md|rtf|odt|cbz|cbr)$/], ['archive', 'filesKindArchives', /^(zip|7z|rar|tar|gz|tgz|xz|bz2|zst|lz4|iso|001)$/], ['apk', 'filesKindApps', /^(apk|apks|xapk|apkm)$/]];
const ICON: Record<string, string> = { video: 'film', audio: 'music', ebook: 'books', image: 'images', sub: 'subtitles', archive: 'archive', doc: 'file', other: 'file', locked: 'lock' };
const MIMES: [string, string, string][] = [['image/*', 'filesAsImage', 'images'], ['audio/*', 'filesAsMusic', 'music'], ['video/*', 'filesAsVideo', 'film'], ['text/plain', 'filesAsText', 'type'], ['application/pdf', 'filesAsDocument', 'file'], ['application/zip', 'filesAsArchive', 'archive'], ['*/*', 'filesAsAny', 'apps']];
/** The books and comics the Reader opens (its detect.ts), with the MIME its manifest takes them under. */
const READER_PKG = 'app.kurokawa.reader';
const READER_MIME: Record<string, string> = { epub: 'application/epub+zip', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook', azw: 'application/x-mobipocket-ebook', azw3: 'application/x-mobipocket-ebook', kf8: 'application/x-mobipocket-ebook', prc: 'application/x-mobipocket-ebook', fb2: 'application/x-fictionbook+xml', cbz: 'application/vnd.comicbook+zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', odt: 'application/vnd.oasis.opendocument.text', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain' };
const readerMime = (name: string): string | null => READER_MIME[(name.split('.').pop() ?? '').toLowerCase()] ?? null;
const mimeOf = (p: string): string => { const k = kindOfFile(p); if (/\.(txt|nfo|md|srt|ass|vtt|json|xml|log|csv|ini|cfg)$/i.test(p)) return 'text/plain'; if (/\.pdf$/i.test(p)) return 'application/pdf'; if (/\.apk$/i.test(p)) return 'application/vnd.android.package-archive'; return ({ video: 'video/*', audio: 'audio/*', image: 'image/*', ebook: 'application/epub+zip', archive: 'application/zip' } as Record<string, string>)[k] ?? '*/*'; };
// (A place under a scheme — «apps://com.x», «remote://id» — has the scheme's root above it, «apps://»; trimming the
// last part as a folder would leave «apps:/», which became «apps:», a place that lists nothing.)
const parentOf = (p: string): string => { const top = /^([a-z]+:\/\/)[^/]*\/?$/.exec(p); if (top) return top[1]; return dirOfPath(p); };
/** «apps:» and «apps:/» (left by an older version) mended to «apps://». */
const mendScheme = (p: string): string => p.replace(/^([a-z]+):\/?$/, '$1://');
const baseOf = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p;
/** `p`'s answer, or null when it has not come within `ms` (it is not stopped: its answer is simply not waited for). */
const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> => new Promise((res) => { const tm = setTimeout(() => res(null), ms); p.then((v) => { clearTimeout(tm); res(v); }, () => { clearTimeout(tm); res(null); }); });
/** A listing's entries made safe to draw: a path and a name always text (a name missing taken from the path), a date and
 *  a size always numbers — one odd entry from a storage never stops the folder from showing. Entries without a path go. */
export const sane = (list: unknown): Entry[] => {
  if (!Array.isArray(list)) return []; const out: Entry[] = [];
  for (const x of list as Partial<Entry>[]) {
    if (!x || typeof x !== 'object' || typeof x.path !== 'string' || !x.path) continue;
    const name = typeof x.name === 'string' && x.name ? x.name : baseOf(x.path) || x.path;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    out.push({ ...x, name, path: x.path, dir: !!x.dir, size: num(x.size, -1), mtime: num(x.mtime, 0), ext: typeof x.ext === 'string' ? x.ext : undefined } as Entry);
  }
  return out;
};
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
  const p = plug(); if (p) return p.filesList({ path, counts: false, hidden: prefs.hidden });
  const d = desk(); if (d?.listDir) { const r = await d.listDir(path); return { exists: true, entries: (r.entries ?? []).filter((e) => prefs.hidden || !e.name.startsWith('.')).map((e) => ({ ...e, ext: e.dir ? undefined : (e.name.split('.').pop() ?? '').toLowerCase() })) }; }
  return { exists: false, entries: [] };
}
// (The folder child counts asked for on demand, kept per path and the folder's date — a bounded LRU, so going back shows them at once.)
const cntCache = new Map<string, { m: number; n: number }>(); const CNT_MAX = 2000; const cntM = new Map<string, number>(); // (the date of each folder asked about, kept till its answer comes — even to a page left meanwhile)
const cntGet = (e: Entry): number | undefined => { const c = cntCache.get(e.path); if (!c || c.m !== e.mtime) return undefined; cntCache.delete(e.path); cntCache.set(e.path, c); return c.n; };
const cntPut = (path: string, m: number, n: number) => { cntCache.delete(path); cntCache.set(path, { m, n }); while (cntCache.size > CNT_MAX) cntCache.delete(cntCache.keys().next().value as string); };
// (One collator for every sort: building one costs more than a thousand comparisons.)
let collator: Intl.Collator | null = null;
function sortEntries(list: Entry[]): Entry[] {
  const col = collator ?? (collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }));
  const S = sortOver ?? { sort: prefs.sort, desc: prefs.desc, ff: prefs.foldersFirst !== false };
  const szs = S.sort === 'size' ? new Map<string, number>() : null;
  const sz = (e: Entry): number => { if (!e.dir) return e.size; let v = szs!.get(e.path); if (v === undefined) { v = sizeOf(e.path, e.mtime)?.bytes ?? -1; szs!.set(e.path, v); } return v; };
  const by = (a: Entry, b: Entry): number => S.sort === 'date' ? (a.mtime - b.mtime) || col.compare(a.name, b.name) : S.sort === 'size' ? (sz(a) - sz(b)) || col.compare(a.name, b.name) : S.sort === 'type' ? col.compare(a.ext ?? '', b.ext ?? '') || col.compare(a.name, b.name) : col.compare(a.name, b.name);
  return list.sort((a, b) => (S.ff ? Number(b.dir) - Number(a.dir) : 0) || (S.desc ? -by(a, b) : by(a, b)));
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
export type Pane = HTMLElement & { dispose?: () => void; pathNow: () => string; dropIn: (op: 'copy' | 'move', paths: string[]) => Promise<void>; reload: () => void; /** The view (list or grid) changed: button and rows redrawn in place. */ restyle: () => void; /** A computer's keyboard focus moved here from the other pane (F6, Tab). */ focusPc?: () => void };
/** Another app's «pick a file» (views/pick.ts): the page as a picker — files of the kind asked chosen, folders walked. */
/** (D5) Where a picker opens: the folder this asking app last picked from, else the last one any app did. */
const PICK_BY = 'kt.files.pickLast.by', PICK_RECENT = 'kt.files.pickRecent';
const readJson = <T,>(k: string, d: T): T => { try { const v = JSON.parse(localStorage.getItem(k) ?? 'null') as T | null; return v ?? d; } catch { return d; } };
function pickStart(caller: string): string { const by = readJson<Record<string, string>>(PICK_BY, {}); if (caller && typeof by[caller] === 'string') return by[caller]; try { return localStorage.getItem('kt.files.pickLast') ?? ''; } catch { return ''; } }
/** The folder a pick came from, kept: for this app, for any app, and among the last four picked from. */
function notePick(caller: string, dir: string): void {
  try { localStorage.setItem('kt.files.pickLast', dir); } catch { /* none */ }
  if (caller) { const by = readJson<Record<string, string>>(PICK_BY, {}); delete by[caller]; by[caller] = dir; const keys = Object.keys(by); for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete by[k]; try { localStorage.setItem(PICK_BY, JSON.stringify(by)); } catch { /* none */ } }
  const rec = [dir, ...readJson<string[]>(PICK_RECENT, []).filter((x) => typeof x === 'string' && x !== dir)].slice(0, 4); try { localStorage.setItem(PICK_RECENT, JSON.stringify(rec)); } catch { /* none */ }
}
const pickRecent = (): string[] => readJson<string[]>(PICK_RECENT, []).filter((x) => typeof x === 'string' && !!x).slice(0, 4);
/** `done` may answer the paths that could not be handed over (nothing was): the screen says so and waits. */
export type PickMode = { req: PickRequest; done: (paths: string[]) => void | Promise<string[] | { refused: string[]; why?: string } | void>; cancel: () => void };
type PaneOpts = { embedded?: boolean; side?: 'a' | 'b'; peer?: () => Pane | null; pick?: PickMode; /** Opened by another app («Open with»): its folders walked inside the page; Back at `start` hands back to that app. */ handedIn?: { start: string; leave: () => void } };
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
  // (A picker, like a pane beside another, keeps the address as it is: its folders are walked inside the page.)
  const pk = po.pick; const quiet = !!po.embedded || !!pk || !!po.handedIn;
  // (Another app's picker: like the reference pickers, a list with each folder's count and date — its own view.)
  // (D5: a request for pictures or videos only — «attach a photo» — opens on the pictures themselves, until a view is chosen here.)
  if (pk) { if (!pageView) pageView = prefs.view; const media = pk.req.mimes.length > 0 && pk.req.mimes.every((m) => /^(image|video)\//.test(m)); prefs.view = (() => { try { const v = localStorage.getItem('kt.files.pickView'); return v === 'grid' || v === 'gallery' || v === 'list' ? v : media ? 'gallery' : 'list'; } catch { return media ? 'gallery' : 'list'; } })(); }
  // (A computer's file manager — details list, navigation pane, address bar, status bar, keys — in views/filesPc.ts, loaded on the first folder shown there.)
  let pcm: typeof import('./filesPc') | null = null; let pcCtl: import('./filesPc').PcCtl | null = null;
  const body = h('div', { class: 'files-body' }); const sizeNote = h('p', { class: 'hint files-sizenote', hidden: true });
  const crumbs = h('div', { class: 'files-crumbs', dir: 'ltr' }); const rootsRow = h('div', { class: 'chip-row files-roots' }); const kindRow = h('div', { class: 'chip-row files-kinds' });
  const listEl = h('div', { class: 'files-list' }); const status = h('p', { class: 'hint files-status' }); const jobsEl = h('div', { class: 'files-jobs' });
  const search = h('input', { type: 'search', class: 'files-search', placeholder: t('filesSearchHere'), hidden: true, oninput: () => { query = fold(search.value.trim()); draw(); } }) as HTMLInputElement;
  const selBar = h('div', { class: 'files-selbar', hidden: true });
  // (A phone's header while choosing: close, the count, select all, invert — in the one bar's place.)
  const selHead = h('div', { class: 'files-selhead' });
  const shelfEl = h('div', { class: 'files-shelf', hidden: true });
  // (What is on the clipboard, while it is: how many — or the one's name —, copied or to be moved, Paste here and Cancel.)
  const clipBar = h('div', { class: 'files-clipbar', role: 'toolbar', 'aria-label': t('filesClipboard'), hidden: true });
  const backBtn = iconButton('back', t('back'), () => { backStep(); }); backBtn.classList.add('files-back'); backBtn.hidden = true;
  const titleEl = h('span', { class: 'files-title' }, t('navFiles')); const subEl = h('small', { class: 'files-sub' });
  // (A phone's header: the folder's name, its parent's path under it; a tap opens the folders above — the crumbs, as a drop-down.)
  const pathEl = h('small', { class: 'files-path', dir: 'ltr' }, h('bdi', null)); const phoneNow = () => !document.documentElement.classList.contains('pc');
  const denseNow = () => phoneNow() && !pk && prefs.view === 'list' && prefs.density !== 'comfortable';
  let pathOpen = false; const offPath = () => { document.removeEventListener('pointerdown', onPathOut, true); document.removeEventListener('keydown', onPathKey, true); };
  const onPathOut = (e: Event) => { if (!(e.target as Element).closest?.('.files-crumbs, .files-head')) setPath(false); };
  const onPathKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPath(false); };
  const setPath = (on: boolean) => { pathOpen = on && phoneNow() && !crumbs.hidden; crumbs.classList.toggle('open', pathOpen); headEl.setAttribute('aria-expanded', String(pathOpen)); offPath(); if (pathOpen) { document.addEventListener('pointerdown', onPathOut, true); document.addEventListener('keydown', onPathKey, true); } };
  const headEl = h('div', { class: 'title files-head', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': t('filesPathMenu'), onclick: () => { if (phoneNow()) setPath(!pathOpen); } }, titleEl, h('span', { class: 'files-head2' }, pathEl, subEl, h('span', { class: 'files-chev' }, icon('chevronRight')))) as HTMLElement;
  /** The title, a long name cut in its middle so its end (the extension) stays in sight. */
  const setTitle = (text: string, isDir = true) => { const np = nameParts(text, isDir); titleEl.setAttribute('dir', np.dir); titleEl.title = text; titleEl.replaceChildren(h('span', { class: 'mid-head' }, np.head), h('span', { class: 'mid-tail' }, np.tail)); };
  // (A phone's search: «N of M», a clear button, and the switch that takes the search into the sub-folders — streamed under the list.)
  const countEl = h('span', { class: 'files-search-count', 'aria-live': 'polite' }); let stopSub: (() => void) | null = null; const subHost = h('div', { class: 'files-subres', hidden: true });
  const runSub = () => { stopSub?.(); stopSub = null; if (!subSw.checked || !query) { subHost.hidden = true; subHost.replaceChildren(); return; } subHost.hidden = false; void import('./filesMenu').then((m) => { if (gone || !subSw.checked) return; stopSub?.(); stopSub = m.subSearch(subHost, { at, q: search.value.trim(), hidden: !!prefs.hidden, find: (o) => plug()!.filesSearch(o), open: (e) => void open(e), goTo: (d) => { search.value = ''; query = ''; search.hidden = true; subSw.checked = false; go(d); } }); }); };
  const subSw = h('input', { type: 'checkbox', onchange: runSub }) as HTMLInputElement; search.addEventListener('input', () => { if (subSw.checked) runSub(); });
  const clearBtn = iconButton('close', t('fmClear'), () => { search.value = ''; query = ''; search.focus(); draw(); runSub(); });
  const searchMeta = h('div', { class: 'files-search-meta', hidden: true }, h('div', { class: 'files-search-line' }, countEl, clearBtn), h('label', { class: 'switch-row files-sub-row' }, h('span', { class: 'grow' }, t('fmSubToo')), subSw));
  // (The keyboard over the lower part of the page: the list gets that much room under its last rows, following the visual viewport.)
  const onVv = () => { const v = window.visualViewport; if (v) listEl.style.paddingBottom = `${Math.max(0, Math.round(window.innerHeight - v.height - v.offsetTop))}px`; };
  search.addEventListener('focus', () => { window.visualViewport?.addEventListener('resize', onVv); onVv(); }); search.addEventListener('blur', () => { window.visualViewport?.removeEventListener('resize', onVv); listEl.style.paddingBottom = ''; });
  const fab = h('button', { type: 'button', class: 'fab files-fab', 'aria-label': t('newFolder'), onclick: () => fabSheet() }, icon('plus'));
  // (The list/grid button: the same button for good — its focus stays —, showing the view a tap switches TO, named by
  // what it does; it redraws the folder in place — the address stays the same, so a navigate() to it would draw nothing.)
  const viewBtn = iconButton(NEXT_VIEW[prefs.view] === 'list' ? 'list' : NEXT_VIEW[prefs.view] === 'gallery' ? 'images' : 'grid', t(VIEW_TO[NEXT_VIEW[prefs.view]]), () => { prefs.view = NEXT_VIEW[prefs.view]; if (pk) { try { localStorage.setItem('kt.files.pickView', prefs.view); } catch { /* this time only */ } } savePrefs(); applyView(); po.peer?.()?.restyle(); });
  // (The Jobs button: only while the queue holds a job — running or waiting — with their number on it.)
  let offQ: (() => void) | null = null; let offUnfinished: (() => void) | null = null;
  const jobsBadge = h('span', { class: 'files-jobs-badge', 'aria-hidden': 'true' });
  const jobsBtn = iconButton('jobs', t('filesJobs'), () => void useQueue().then((m) => m.jobsSheet(() => (prefs.jobsMode === 'together' ? 'together' : 'one')))); jobsBtn.classList.add('files-jobs-btn'); jobsBtn.hidden = true; jobsBtn.append(jobsBadge);
  const drawJobsBadge = () => { const n = Q?.count() ?? 0; jobsBtn.hidden = n === 0; jobsBadge.textContent = localDigits(n); const lbl = n ? t('filesJobsCount', { n: localDigits(n) }) : t('filesJobs'); jobsBtn.title = lbl; jobsBtn.setAttribute('aria-label', lbl); };
  let filterBtn!: HTMLElement; let sortBtn!: HTMLElement; // (on a phone these three live in the ⋮ sheet: the bar keeps the name its room)
  const root = h('div', { class: 'view files-view' },
    h('header', { class: 'topbar' }, iconButton('menu', t('filesDrawer'), () => drawer()), backBtn, headEl, h('div', { class: 'topbar-actions' }, jobsBtn,
      iconButton('search', t('search'), () => { if (pk) { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; query = ''; draw(); } return; } if (canEverywhere()) { void everywhere(); return; } if (phoneNow() && !pk) { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; query = ''; } draw(); return; } if (plug() && !collection) { void import('./filesMore').then((m) => m.searchSheet(at, roots.find((x) => at === x.path || at.startsWith(x.path + '/'))?.path ?? at, prefs.hidden, (e) => void open(e), (d) => go(d))); return; } search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; query = ''; draw(); } }),
      filterBtn = iconButton('filter', t('filesFilterHere'), () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; query = ''; draw(); } }),
      viewBtn,
      sortBtn = iconButton('sort', t('sortBy'), () => sortSheet()),
      iconButton('more', t('more'), () => moreSheet()))),
    clipBar, search, searchMeta, shelfEl, h('div', { class: 'files-strip' }, rootsRow, crumbs, kindRow), body, selBar, fab) as HTMLElement & { dispose?: () => void };
  root.querySelector('.topbar')?.append(selHead);
  // (Extractions left half done — a stop, a crash, a full disk: Finish, Restore the archive, or Leave as is.)
  if (!quiet) void import('./extractShelf').then((m) => m.shelfBanner(shelfEl)).catch(() => {});
  body.append(sizeNote, listEl, subHost, status, jobsEl);
  // (A phone's button tapped twice in a blink — a thumb's bounce —: done once. Only a finger's taps; a mouse's are its own.)
  { let byTouch = false; let last: { el: Element | null; at: number } = { el: null, at: 0 };
    root.addEventListener('pointerdown', (e) => { byTouch = e.pointerType === 'touch'; }, true);
    root.addEventListener('click', (e) => { if (!byTouch) return; const b = (e.target as Element).closest?.('button, [role="button"]'); if (!b) return; const now = performance.now(); if (last.el === b && now - last.at < 450) { e.stopPropagation(); e.preventDefault(); return; } last = { el: b, at: now }; }, true); }
  let at = mendScheme(route.p ?? (route.c ? '' : pk ? pickStart(pk.req.caller) || prefs.home || '' : (prefs.rememberLast === false ? prefs.home ?? '' : (po.side === 'b' ? prefs.lastB : prefs.last) ?? prefs.home ?? ''))); let remotes: Conn[] = [];
  let vroots: VRoots = { shell: null, trees: [], shizuku: false };
  const remoteNow = (): Conn | null => (isRemote(at) ? remotes.find((c) => c.id === parseRemote(at).id) ?? null : null); void remoteNow; let collection: string | null = route.c ?? null; let entries: Entry[] = []; let query = ''; let selecting = false; const picked = new Set<string>(); let roots: Root[] = []; let allFiles = true; let gone = false;
  // (Pictures: asked for only as rows come near the screen, a few at a time — ui/thumbs.ts —; the phone's from its
  // plugin, which keeps them on disk; a computer's drawn here from the shell's address of the file.)
  const thumbOf = async (path: string, name: string, px: number): Promise<string | null> => {
    const pl = plug();
    if (isArc(path)) return (await import('./filesArc')).arcThumb(path, px);
    if (isApps(path)) return (await import('./filesApps')).appIcon(parseApps(path).pkg);
    if (pl) return (await pl.filesThumb({ path, px })).url;
    const u = await desk()?.fileUrl?.(path); return u ? drawThumb(u, name, px) : null;
  };
  const thumbInto = (el: HTMLElement, e: Entry) => { const px = prefs.view === 'grid' ? 240 : prefs.view === 'gallery' ? (colsNow() <= 3 ? 240 : 160) : 96; lazyThumb(el, `f:${e.path}:${e.mtime}:${e.size}:${px}`, () => thumbOf(e.path, e.name, px), (u) => placeImg(el, u)); };
  const pcThumbs = () => !plug() && !!desk()?.fileUrl;

  // ---- the storages and the way here
  const loadRoots = async () => {
    const fx = fsx();
    // (Each part asked with a deadline: one that never answers — a plugin call lost to a restarted page — leaves the
    // others, and the folder, to show; never a blank page.)
    if (fx) { try { const r = await within(fx.filesRoots(), 6000); if (!r) throw new Error('slow'); roots = (Array.isArray(r.roots) ? r.roots : []).filter((x) => x && typeof x.path === 'string').map((x) => ({ ...x, name: rootName(x) })); allFiles = r.allFiles !== false; } catch { roots = []; } }
    else { const d = desk(); const home = d?.homeDir ? (await within(d.homeDir().catch(() => ''), 6000)) ?? '' : ''; roots = home ? [{ kind: 'phone', path: home, name: t('filesHome'), readable: true }] : []; }
    rootsRow.replaceChildren(...roots.filter((r) => r.kind !== 'remote' && r.kind !== 'saf' && r.kind !== 'root').map((r) => h('button', { type: 'button', class: 'chip' + (at === r.path || at.startsWith(r.path + '/') ? ' on' : ''), onclick: () => { if (!r.readable) { void askAccess(); return; } go(r.path); } },
      icon(rootIcon(r.kind)), h('span', null, r.name), r.free !== undefined ? h('small', { class: 'src' }, ` ${formatBytes(r.free)}`) : null)));
    remotes = (await within(connections().catch(() => [] as Conn[]), 4000)) ?? []; for (const c of remotes) roots.push({ kind: 'remote', path: `remote://${c.id}`, name: c.name, readable: true });
    vroots = (await within(vfsRoots().catch(() => vroots), 4000)) ?? vroots; if (vroots.shell) roots.push({ kind: 'root', path: 'root://', name: t('filesRootStorage'), readable: true }); for (const tr of vroots.trees) roots.push({ kind: 'saf', path: `saf://${tr.id}`, name: tr.name, readable: true });
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
  const syncBack = () => { const hide = !collection && (!upOf(at) || (phoneNow() && prefs.view === 'list')); if (backBtn.hidden !== hide) { backBtn.hidden = hide; requestAnimationFrame(() => refitTopbar(root.querySelector('.topbar'))); } };
  const drawCrumbs = () => {
    syncBack(); { const up = collection ? null : upOf(at); const rt = roots.find((x) => x.path === at); pathEl.firstElementChild!.textContent = up ? readablePath(up) : rt && !collection ? [rt.name, rt.free !== undefined ? formatBytes(rt.free) : ''].filter(Boolean).join(' · ') : ''; }
    if (collection) { crumbs.hidden = true; setPath(false); const c = COLLECTIONS.find(([k]) => k === collection); crumbs.replaceChildren(h('button', { type: 'button', class: 'crumb', onclick: () => drawer() }, t((c?.[1] ?? 'filesRecent') as 'filesRecent'))); titleEl.textContent = t((c?.[1] ?? 'filesRecent') as 'filesRecent'); titleEl.removeAttribute('dir'); return; }
    // (Inside an archive: the folder there, or the archive's own name at its top — decoded, never «%2Fstorage%2F…».)
    const rootHere = roots.find((x) => x.path === at); if (rootHere) setTitle(rootHere.name); else if (isApps(at) && at === 'apps://') setTitle(t('appsTitle')); else setTitle(placeName(at) || t('navFiles'), !isArc(at) || !!parseArc(at).inner);
    const r = roots.find((x) => at === x.path || at.startsWith(x.path + '/')); const base = r?.path ?? (isApps(at) ? 'apps://' : isArc(at) ? arcPath(parseArc(at).archive) : isRemote(at) ? `remote://${parseRemote(at).id}` : at.startsWith('saf://') ? at.replace(/^(saf:\/\/[^/]*).*$/, '$1') : at.startsWith('root://') ? 'root://' : '/'); const rest = at.slice(base.length).split('/').filter(Boolean);
    const parts: HTMLElement[] = [...(isArc(at) ? [h('button', { type: 'button', class: 'crumb', 'aria-label': placeName(parentOf(parseArc(at).archive)), title: parentOf(parseArc(at).archive), onclick: () => go(parentOf(parseArc(at).archive)) }, icon('archive')), h('span', { class: 'crumb-sep' }, '›')] : []), h('button', { type: 'button', class: 'crumb', onclick: () => go(base) }, h('bdi', null, isApps(at) ? t('appsTitle') : isArc(at) ? arcName(at) : (r?.name ?? '/')))];
    let acc = base; for (const seg of rest) { acc += `/${seg}`; const p = acc; parts.push(h('span', { class: 'crumb-sep' }, '›'), h('button', { type: 'button', class: 'crumb', onclick: () => go(p) }, h('bdi', null, seg))); }
    crumbs.replaceChildren(...parts); crumbs.scrollLeft = crumbs.scrollWidth;
    // (At a place's own top the path would only say the title again: left out until there is a way back to show.)
    crumbs.hidden = parts.length === 1 && !rest.length && !isArc(at); setPath(false);
  };
  const drawKinds = () => kindRow.replaceChildren(...KINDS.map(([k, label]) => h('button', { type: 'button', class: 'chip small' + (prefs.kind === k ? ' on' : ''), onclick: () => { prefs.kind = k; savePrefs(); drawKinds(); draw(); } }, t(label as 'filesKindAll'))));

  // ---- the folder
  // (Each folder a step in the history — the browser's Back and Forward, a mouse's side buttons walk the folders —;
  // the way up by Back steps back through that history when the folder above is the step before, else takes its place.)
  const scrollNow = (): number => Math.max(window.scrollY, body.scrollTop);
  let movedOn = false; // (this page has gone elsewhere: its scroll was kept then, not again when it is taken down)
  const keepScroll = () => { if (movedOn) return; const k = collection ? `c:${collection}` : at; if (k && shownAt === k) scrollMemo.set(k, scrollNow()); };
  const go = (path: string, how: 'push' | 'replace' | 'back' = 'push') => { if (gone) return; keepScroll(); collection = null; path = mendScheme(path); const was = at; at = /^[a-z]+:\/\/$/.test(path) ? path : /^(\/|[A-Za-z]:\/)/.test(path) ? resolvePath(path) : path.replace(/\/+$/, '') || '/'; if (po.side === 'b') prefs.lastB = at; else if (!pk) prefs.last = at; savePrefs(); picked.clear(); selecting = false; search.value = ''; query = ''; search.hidden = true; try { pcCtl?.bar(); } catch { /* drawn again with the listing */ } if (!quiet) { movedOn = true; if (how === 'back') history.back(); else navigate(`/files?p=${encodeURIComponent(at)}`, how === 'replace' || was === at); } void load(); };
  const openCollection = (kind: string) => { if (gone) return; keepScroll(); collection = kind; picked.clear(); selecting = false; query = ''; search.hidden = true; if (!quiet) { movedOn = true; navigate(`/files?c=${kind}`); } void load(); };
  /** The place above `p`: the folder up; inside an archive the folder up there, and from its top the folder that holds
   *  the archive; null at a storage's top (the top of Files). */
  const upOf = (p: string): string | null => {
    if (!p) return null;
    if (isArc(p)) { const { archive, inner } = parseArc(p); return inner ? arcPath(archive, inner.split('/').slice(0, -1).join('/')) : parentOf(archive); }
    if (roots.some((r) => r.path === p) || /^[a-z]+:\/\/$/.test(p) || p === '/') return null;
    const up = parentOf(p); return up && up !== p ? up : null;
  };
  /** Up one place, by Back: through the history when the place above is the step before (so Forward still works). */
  const goUp = (to: string) => { const url = `/files?p=${encodeURIComponent(mendScheme(to))}`; go(to, !quiet && previousPath() === url ? 'back' : 'replace'); };
  /** One step of Back inside Files: what is open first (the selection, the filter), then up a folder — out of an archive to
   *  the folder that holds it — to the top of Files; false there (Files is left for where the reader came from). */
  const backStep = (): boolean => {
    if (gone || !root.isConnected) return false;
    if (selecting) { leaveSel(); return true; }
    if (phoneNow() && !pk && clipboard && !clipboard.busy && canJobs() && at === clipAt && !isArc(at)) { clipAt = ''; setClip(null); return true; } // (a phone's paste bar, in the folder where it was filled: Back only puts the clipboard down; walking on, Back walks up)
    if (ew) { ew.close(); return true; }
    if (!search.hidden) { search.value = ''; query = ''; search.hidden = true; draw(); return true; }
    if (collection) { const back = prefs.last && !prefs.last.startsWith('c:') ? prefs.last : roots[0]?.path; if (back) { goUp(back); return true; } return false; }
    const up = upOf(at); if (up) { goUp(up); return true; }
    return false;
  };
  // (Only the latest listing asked for draws: a slow folder answering after the reader went on is dropped. Another place
  // asked: the rows of the last one let go at once — nothing chosen, selected all or deleted, from a folder no longer shown.)
  let loadSeq = 0; let shownAt: string | null = null; let firstLoad = true;
  // (A listing that has not answered in a while — a storage slow to wake, a question of Android's still open, a call lost
  // to a page the system restarted —: a calm card instead of a spinner for ever, with Try again and the storage's top.
  // The answer, when it comes, still replaces it.)
  const STILL_MS = (window as unknown as { __ktStillMs?: number }).__ktStillMs ?? 8000;
  const topOf = (p: string): string | null => roots.find((x) => p === x.path || p.startsWith(x.path + '/'))?.path ?? roots[0]?.path ?? null;
  const stateCard = (kind: 'still' | 'gone' | 'failed', why = ''): HTMLElement => {
    const top = topOf(at); const lines = { still: [t('filesStillReading'), t('filesStillHint')], gone: ['', ''], failed: [t('filesShowFailed'), why] }[kind];
    return h('div', { class: 'files-state', 'data-state': kind, role: 'status' }, kind === 'still' ? h('div', { class: 'spinner small' }) : icon(kind === 'gone' ? 'folder' : 'alert'),
      lines[0] ? h('b', null, lines[0]) : null, lines[1] ? h('small', { class: 'src', dir: 'auto' }, lines[1]) : null,
      h('div', { class: 'files-state-acts' }, h('button', { type: 'button', class: 'btn tonal files-state-retry', onclick: () => void load() }, icon('refresh'), t('tryAgain')),
        top && top !== at ? h('button', { type: 'button', class: 'btn tonal files-state-root', onclick: () => go(top) }, icon('storage'), t('filesGoRoot')) : null));
  };
  const load = async () => {
    const my = ++loadSeq; const want = collection ? `c:${collection}` : at; const stale = () => gone || my !== loadSeq; const first = firstLoad; firstLoad = false;
    if (!pcm && !phoneNow() && !pk && !po.handedIn) { try { pcm = await import('./filesPc'); } catch { /* the plain list */ } if (stale()) return; }
    if (pcm && !pcCtl && !phoneNow() && !pk && !po.handedIn) pcCtl = pcm.mount(pcHost());
    if (want !== shownAt) { entries = []; picked.clear(); selecting = false; shownAt = want; }
    sortOver = collection || !phoneNow() ? null : sortFor(at); if (!collection && !pk && !isVirtual(at)) noteRecent(at);
    try { drawCrumbs(); pcCtl?.at(at); } catch { /* the way here is drawn again next time */ }
    void checkWritable(); drawPaste(); listEl.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner small' }))); status.textContent = ''; fab.hidden = !!collection || isArc(at);
    const still = window.setTimeout(() => { if (!stale()) listEl.replaceChildren(stateCard('still')); }, STILL_MS);
    let got: Entry[] = []; let note = ''; let missing = false;
    try {
      if (collection) { const pl = plug(); const r = pl ? await pl.filesCollection({ kind: collection, limit: 600 }) : { entries: [] }; if (stale()) return; got = r.entries; }
      else { const r = await listDir(at); if (stale()) return; const hid = (await import('./filesMore')).hiddenPaths(); if (stale()) return; const all = sane(r?.entries); got = (hid.length ? all.filter((e) => !hid.includes(e.path)) : all).filter((e) => !e.name.startsWith(STAGE)); if (r?.exists === false) { note = t('folderNotFound'); missing = true; } if (r?.truncated) toast(t('filesTruncated'), 'info'); }
    }
    catch (e) { if (stale()) return; got = []; note = String((e as Error)?.message ?? e); }
    finally { window.clearTimeout(still); }
    // (The folder the page came back to — the last one, remembered — is gone or no longer allowed: its storage's top instead.)
    if (missing && first && !route.p && !collection) { const top = topOf(at); if (top && top !== at) { go(top, 'replace'); return; } }
    entries = sane(got); { const have = new Set(entries.map((e) => e.path)); for (const x of [...picked]) if (!have.has(x)) picked.delete(x); } if (!picked.size) selecting = false; reorder();
    // (Back to a folder seen before: where it was scrolled to.)
    const y = scrollMemo.get(want) ?? 0;
    try { draw(y); drawSel(); } catch (err) { listEl.replaceChildren(stateCard('failed', String((err as Error)?.message ?? err))); return; }
    // (A folder gone: the list says it is empty, the line under it why, and the way to the storage's top beside them.)
    status.textContent = note; if (missing) listEl.append(stateCard('gone'));
    if (!quiet && !collection && !missing) keepResume(po.side === 'b' ? { b: at } : { at, y });
    if (y) requestAnimationFrame(() => { if (stale()) return; window.scrollTo(0, y); body.scrollTop = y; });
  };
  const shown = (): Entry[] => { if (pcCtl) sortOver = pcCtl.sortSet(); const re = kindRe(); const list = entries.filter((e) => (!re || e.dir || re.test(e.ext ?? '')) && (!query || fold(e.name).includes(query))); return collection ? list.sort((a, b) => b.mtime - a.mtime) : sortEntries(list); };
  // ---- columns of the grid and the gallery: pinched (phone) or Ctrl + wheel (computer), kept per view and kind of folder
  let mediaFolder = false;
  const colKey = () => `${prefs.view}:${mediaFolder ? 'media' : 'plain'}`;
  const forcedCols = (list: Entry[]): number => {
    if (prefs.view === 'list') { listEl.style.removeProperty('--cols'); return 0; }
    const files = list.filter((x) => !x.dir); mediaFolder = files.length > 0 && files.filter((x) => { const k = kindOfFile(x.name); return k === 'image' || k === 'video'; }).length * 2 >= files.length;
    const n = prefs.cols?.[colKey()] ?? 0; if (n) listEl.style.setProperty('--cols', String(n)); else listEl.style.removeProperty('--cols'); return n;
  };
  const colsNow = (): number => { const n = prefs.cols?.[colKey()]; if (n) return n; return Math.max(1, getComputedStyle(listEl).gridTemplateColumns.split(' ').filter((x) => x && x !== 'none').length); };
  const setCols = (n: number) => { const [lo, hi] = prefs.view === 'gallery' ? [3, 6] : [2, 12]; const v = Math.max(lo, Math.min(hi, Math.round(n))); if (v === colsNow() && prefs.cols?.[colKey()]) return; (prefs.cols ??= {})[colKey()] = v; savePrefs(); applyView(); };
  // (Two fingers on the list: spreading them makes the pictures bigger — fewer columns —, pinching smaller; Ctrl + wheel the same on a computer.)
  let pinch: { d0: number; c0: number } | null = null; let lastWheel = 0;
  const two = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const onTouchStart = (e: TouchEvent) => { if (prefs.view !== 'list' && e.touches.length === 2) pinch = { d0: two(e), c0: colsNow() }; else pinch = null; };
  const onTouchMove = (e: TouchEvent) => { if (!pinch || e.touches.length !== 2) return; if (e.cancelable) e.preventDefault(); const r = two(e) / Math.max(1, pinch.d0); if (r > 1.25 || r < 0.8) { const c = pinch.c0 / r; setCols(c); } };
  const onTouchEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
  const onWheel = (e: WheelEvent) => { if (!e.ctrlKey || prefs.view === 'list') return; e.preventDefault(); const now = Date.now(); if (now - lastWheel < 140) return; lastWheel = now; setCols(colsNow() + (e.deltaY < 0 ? -1 : 1)); };
  listEl.addEventListener('touchstart', onTouchStart, { passive: true }); listEl.addEventListener('touchmove', onTouchMove, { passive: false }); listEl.addEventListener('touchend', onTouchEnd, { passive: true }); listEl.addEventListener('touchcancel', onTouchEnd, { passive: true }); listEl.addEventListener('wheel', onWheel, { passive: false });
  // ---- folder sizes on demand (views/filesSize.ts): counted in the background, kept until the folder's date changes
  const sizeable = (e: Entry): boolean => e.dir && !collection && !isVirtual(e.path) && !isApps(e.path) && !!(plug() || desk()?.listDir);
  const sizeList = async (p: string): Promise<Entry[]> => { const pl = plug(); if (pl) return (await pl.filesList({ path: p, counts: false, hidden: true })).entries; return (await desk()!.listDir!(p)).entries ?? []; };
  let batch: { stop: boolean; done: number; total: number; run: { cancel(): void } | null } | null = null;
  const refreshRow = (path: string) => { const r = rowEls.get(path); if (r?.el.isConnected) r.el.replaceWith(safeRow(r.e)); };
  const paintSizeNote = (list: Entry[]) => {
    if (batch) { const b = batch; sizeNote.hidden = false; sizeNote.replaceChildren(h('span', { class: 'grow' }, t('filesSizeBatch', { done: localDigits(b.done), total: localDigits(b.total) })), h('button', { type: 'button', class: 'btn text small', onclick: () => { b.stop = true; b.run?.cancel(); } }, t('cancel'))); return; }
    const unknown = prefs.sort === 'size' ? list.filter((e) => sizeable(e) && !sizeOf(e.path, e.mtime)) : [];
    if (!unknown.length) { sizeNote.hidden = true; sizeNote.replaceChildren(); return; }
    sizeNote.hidden = false; sizeNote.replaceChildren(h('span', { class: 'grow' }, t('filesSizeUnknown', { n: localDigits(unknown.length) })), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void calcAll(unknown) }, t('filesSizeCalcAll')));
  };
  const calcAll = async (todo: Entry[]) => {
    const b = { stop: false, done: 0, total: todo.length, run: null as { cancel(): void } | null }; batch = b; paintSizeNote([]);
    for (const e of todo) { if (b.stop || gone) break; const run = calcSize(e.path, e.mtime, sizeList); b.run = run; const info = await run.done; if (info) { b.done++; refreshRow(e.path); paintSizeNote([]); } }
    batch = null; if (!gone) draw(window.scrollY);
  };
  /** In a folder's properties: its size counted on demand — Calculate, progress, Cancel; kept for the next time. */
  const sizeControl = (sizeLine: HTMLElement, e: Entry, mtime: number, offs: (() => void)[]) => {
    const val = sizeLine.lastElementChild as HTMLElement; const bar = h('div', { class: 'files-sizectl' });
    const text = (i: { bytes: number; files: number; folders: number }) => `${formatBytes(i.bytes)} · ${countFiles(i.files)} · ${countFolders(i.folders)}`;
    const put = (x: string) => { val.dir = getComputedStyle(document.documentElement).direction; val.replaceChildren(...metaNodes(x)); };
    const show = (i: SizeInfo) => put(text(i) + (i.unread ? ` · ${t('filesSizeUnread', { n: localDigits(i.unread) })}` : ''));
    const idle = () => { const k = sizeOf(e.path, mtime); if (k) show(k); bar.replaceChildren(h('button', { type: 'button', class: 'btn tonal small files-size-go', onclick: () => attach(calcSize(e.path, mtime, sizeList)) }, icon('refresh'), k ? t('filesSizeAgain') : t('filesCalcSize'))); };
    const attach = (run: ReturnType<typeof calcSize>) => {
      bar.replaceChildren(h('button', { type: 'button', class: 'btn text small files-size-stop', onclick: () => run.cancel() }, t('cancel')));
      const off = watchSize(e.path, (p, end) => { if (end === undefined) { put(`${text(p)} …`); return; } off(); if (end) { show(end); refreshRow(e.path); } idle(); });
      offs.push(off);
    };
    const live = sizeRunning(e.path); if (live) attach(live); else idle();
    sizeLine.after(bar);
    return { start: () => { if (!sizeRunning(e.path)) attach(calcSize(e.path, mtime, sizeList)); } };
  };
  // ---- the fast scroller of a long list (views/filesScroll.ts): a handle on the end edge with a bubble naming the place
  let fastList: Entry[] = []; let drawTo: (i: number) => void = () => undefined; let fast: { update(): void; dispose(): void } | null = null;
  const pageTop = (): number => (pcCtl && body.scrollHeight > body.clientHeight + 1 ? body.getBoundingClientRect().top : ((root.querySelector('.topbar') as HTMLElement | null)?.getBoundingClientRect().bottom ?? 0));
  const scrollRoot = (): HTMLElement => (body.scrollHeight > body.clientHeight + 1 ? body : (document.scrollingElement as HTMLElement));
  const sliceEls = () => [...listEl.children].filter((c) => (c as { from?: number }).from !== undefined) as (HTMLElement & { from: number; to: number })[];
  const fastIndex = (): number => { const edge = pageTop(); for (const c of sliceEls()) { const r = c.getBoundingClientRect(); if (r.bottom > edge + 1) return c.from + Math.min(1, Math.max(0, (edge - r.top) / Math.max(1, r.height))) * (c.to - c.from); } return 0; };
  const fastJump = (i: number) => { drawTo(i); const c = sliceEls().find((x) => i >= x.from && i < x.to); if (!c) return; const r = c.getBoundingClientRect(); const dy = r.top + ((i - c.from) / Math.max(1, c.to - c.from)) * r.height - pageTop(); const sc = scrollRoot(); if (sc === body) body.scrollTop += dy; else window.scrollBy(0, dy); };
  const fastLabel = (i: number): string => {
    const e = fastList[i]; if (!e) return '';
    if (prefs.sort === 'date') return e.mtime > 0 ? new Date(e.mtime).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '—';
    if (prefs.sort === 'size') { const n = e.dir ? sizeOf(e.path, e.mtime)?.bytes ?? -1 : e.size; if (n < 0) return '—'; const steps = [0, 1024, 102400, 1048576, 10485760, 104857600, 1073741824]; let k = 0; for (let x = 0; x < steps.length; x++) if (n >= steps[x]) k = x; return k ? `≥ ${formatBytes(steps[k])}` : '< 1 KB'; }
    if (prefs.sort === 'type') return e.dir ? '' : (e.ext ?? '').toUpperCase() || '—';
    const c = [...nameParts(e.name, e.dir).head.trim()][0] ?? ''; return /[0-9٠-٩]/.test(c) ? '#' : c.toUpperCase();
  };
  const syncFast = () => {
    if (fastList.length < 60 || po.embedded) { fast?.dispose(); fast = null; root.classList.remove('has-fast'); return; }
    if (fast) { fast.update(); return; }
    void import('./filesScroll').then((m) => {
      if (gone || fast || fastList.length < 60) return;
      root.classList.add('has-fast');
      fast = m.fastScroller(root, { name: t('filesFastScroller'), pc: document.documentElement.classList.contains('pc'), total: () => fastList.length, current: fastIndex, label: fastLabel, jump: fastJump,
        track: () => { const nav = document.querySelector('.bottom-nav') as HTMLElement | null; const fb = fab.getBoundingClientRect(); const navTop = nav && nav.offsetHeight ? nav.getBoundingClientRect().top : window.innerHeight; const bottom = (fb.height && fab.isConnected && getComputedStyle(fab).display !== 'none' ? Math.min(fb.top, navTop) : navTop) - 10; return { top: Math.max(pageTop(), 0) + 8, bottom }; } });
    }).catch(() => undefined);
  };
  /** A phone's list: «..» first when there is a folder above — its own row, in no selection, sort or count. */
  const upRow = (): HTMLElement[] => [...(pcCtl?.details() ? [pcCtl.header()] : []), ...upRow0()];
  const upRow0 = (): HTMLElement[] => { syncBack(); const up = collection || !phoneNow() || prefs.view !== 'list' ? null : upOf(at); return up ? [h('div', { class: 'files-uprow', role: 'button', tabindex: '0', 'aria-label': t('filesUpRow'), onclick: () => { if (!selecting) goUp(up); } }, h('span', { class: 'files-ic' }, folderIcon('', true)), h('span', { class: 'grow files-main' }, h('span', { class: 'files-name', dir: 'ltr' }, '..')))] : []; };
  let moreIo: IntersectionObserver | null = null; let chunkIo: IntersectionObserver | null = null;
  // ---- child counts of folders, asked for on demand: only the folder rows on screen (and one screenful ahead), in batches
  // of 64, after the first paint; a folder left asks no more; answers are kept (cntCache), so coming back shows them at once.
  let cntIo: IntersectionObserver | null = null; const cntWatch = new WeakMap<Element, Entry>(); const cntQ = new Set<string>(); let cntBusy = false;
  const cntOn = (): boolean => prefs.counts !== false && !collection && !isVirtual(at) && typeof IntersectionObserver === 'function' && !!plug()?.filesCounts;
  const cntReset = () => { cntIo?.disconnect(); cntIo = null; cntQ.clear(); if (cntM.size > 400) cntM.clear(); };
  const cntRun = async () => {
    if (cntBusy) return; cntBusy = true;
    try {
      while (cntQ.size && !gone) {
        const pl = plug(); if (!pl?.filesCounts) break; const batch = [...cntQ].slice(0, 64); for (const x of batch) cntQ.delete(x);
        const at0 = shownAt; const r = await pl.filesCounts({ paths: batch, hidden: prefs.hidden }).catch(() => null); if (!r?.counts) continue;
        for (const [p, n] of Object.entries(r.counts)) {
          if (typeof n !== 'number') continue; const m = cntM.get(p); cntM.delete(p); if (n >= 0 && m !== undefined) cntPut(p, m, n);
          const live = gone ? undefined : rowEls.get(p); if (shownAt !== at0 || !live) continue; live.e.count = n; refreshRow(p);
        }
      }
    } finally { cntBusy = false; }
  };
  const cntWant = (el: HTMLElement, e: Entry) => {
    if (!e.dir || e.count !== undefined || !cntOn()) return;
    if (!cntIo) cntIo = new IntersectionObserver((es) => {
      let any = false;
      for (const x of es) { if (!x.isIntersecting) continue; const en = cntWatch.get(x.target); cntIo?.unobserve(x.target); if (en && en.count === undefined) { cntQ.add(en.path); cntM.set(en.path, en.mtime); any = true; } }
      if (any) void cntRun();
    }, { root: null, rootMargin: `${Math.max(400, window.innerHeight)}px 0px` });
    cntWatch.set(el, e); cntIo.observe(el);
  };
  // (A phone's empty folder: a calm drawn box, what it says, and what can be done: a new folder, paste what was copied.)
  const emptyBox = (): HTMLElement => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 96 72'); svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = '<path d="M14 26 48 10l34 16v34L48 68 14 60z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M14 26l34 16 34-16M48 42v26" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>';
    return h('div', { class: 'files-empty empty', role: 'status' }, svg, h('b', null, t('fmEmpty')), h('div', { class: 'files-empty-btns' }, ...(isArc(at) || isVirtual(at) ? [] : [h('button', { type: 'button', class: 'btn tonal', onclick: () => newFolderSheet() }, icon('folderPlus'), t('newFolder'))]), ...(canPaste() ? [h('button', { type: 'button', class: 'btn tonal', onclick: () => void paste() }, icon('copy'), t('filesPaste'))] : []))); };
  const draw = (minPx = 0, ensure = '') => {
    const list = shown(); pcCtl?.sync(list); { const on = !search.hidden && phoneNow() && !pk; searchMeta.hidden = !on; if (on) { countEl.textContent = t('fmOf', { n: localDigits(list.length), m: localDigits(entries.length) }); clearBtn.hidden = !search.value; } else if (subSw.checked) { subSw.checked = false; runSub(); } } listEl.className = `files-list ${prefs.view === 'gallery' ? 'grid gallery' : prefs.view}${forcedCols(list) ? ' cols' : ''}${prefs.density === 'compact' ? ' compact' : ''}${denseNow() ? ' dense' : ''}${prefs.textSize ? ` ts-${prefs.textSize}` : ''}`; root.classList.toggle('eink', !!prefs.eink);
    moreIo?.disconnect(); moreIo = null; chunkIo?.disconnect(); chunkIo = null; dropThumbs(listEl); rowEls.clear(); cntReset();
    paintSizeNote(list);
    if (!list.length) { fastList = []; syncFast(); subEl.textContent = ''; listEl.replaceChildren(...upRow(), query || !phoneNow() || collection || entries.length || pk ? h('p', { class: 'empty small' }, query ? t('filesNothingMatches') : t('folderEmpty')) : emptyBox()); return; }
    // (Big folders drawn in slices: the first screenfuls at once, the rest as the list is scrolled towards — a folder of
    // twenty thousand entries opens as fast as one of twenty. Each slice is a block of its own, and a block a few screens
    // away from what is seen keeps only its height — its rows let go, drawn again when it comes back near —: the page
    // holds a few hundred rows, not every one scrolled past, and stays as quick at the end of the folder as at its top.
    // (In a grid a block holds whole lines: a multiple of the columns.))
    const byDay = !!collection || prefs.sort === 'date'; let drawn = 0;
    const cols = prefs.view !== 'list' && listEl.isConnected ? Math.max(1, getComputedStyle(listEl).gridTemplateColumns.split(' ').filter((x) => x && x !== 'none').length) : 1;
    const CHUNK = cols * Math.ceil(120 / cols);
    const rowsOf = (from: number, to: number): DocumentFragment => {
      const frag = document.createDocumentFragment(); let lastDay = '';
      if (byDay) for (let i = from - 1; i >= 0; i--) if (!list[i].dir) { lastDay = dayOf(list[i].mtime); break; }
      for (let i = from; i < to; i++) { const e = list[i]; if (byDay && !e.dir) { let day = ''; try { day = dayOf(e.mtime); } catch { /* none */ } if (day !== lastDay) { lastDay = day; frag.append(h('div', { class: 'files-section' }, day)); } } frag.append(safeRow(e)); }
      return frag;
    };
    chunkIo = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
      for (const x of es) {
        const c = x.target as HTMLElement & { from?: number; to?: number };
        // (The page taken out — another tab, kept to come back to —: nothing is «out of sight» then; slices stay as they are.)
        if (!c.isConnected || !listEl.isConnected) continue;
        if (x.isIntersecting && c.dataset.away) { delete c.dataset.away; c.replaceChildren(rowsOf(c.from!, c.to!)); c.style.height = ''; }
        else if (!x.isIntersecting && !c.dataset.away && c.childElementCount) { c.style.height = `${c.offsetHeight}px`; c.dataset.away = '1'; dropThumbs(c); for (const [k, v] of rowEls) if (c.contains(v.el)) rowEls.delete(k); c.replaceChildren(); }
      }
    }, { root: null, rootMargin: '1600px 0px' }) : null;
    const slice = (): HTMLElement => { const from = drawn; drawn = Math.min(list.length, drawn + CHUNK); const c = h('div', { class: 'files-chunk' }) as HTMLElement & { from?: number; to?: number }; c.from = from; c.to = drawn; c.append(rowsOf(from, drawn)); chunkIo?.observe(c); return c; };
    listEl.replaceChildren(...upRow(), slice());
    // (The fast scroller's: slices drawn down to an index, in place before the sentinel that asks for more.)
    fastList = list; drawTo = (i) => { const sen = listEl.querySelector('.files-more-sentinel'); while (drawn <= i && drawn < list.length) { const c = slice(); if (sen) sen.before(c); else listEl.append(c); } if (drawn >= list.length) { moreIo?.disconnect(); moreIo = null; sen?.remove(); } };
    // (A scroll to come back to: drawn down to it first.)
    // (A page laid out at no size — built while hidden —: one slice is enough until it is seen; never the whole folder.)
    while (minPx && drawn < list.length && listEl.offsetHeight < minPx + window.innerHeight) { const h0 = listEl.offsetHeight; listEl.append(slice()); if (listEl.offsetHeight <= h0) break; }
    if (ensure) { const at = list.findIndex((x) => x.path === ensure); while (at >= drawn && drawn < list.length) listEl.append(slice()); }
    // (Watched anew after each slice: a slice too short to push the sentinel out of reach — a grid on a tall screen —
    // left it «still in view», and no change, no call: the list stopped there.)
    if (drawn < list.length) { const sentinel = h('div', { class: 'files-more-sentinel' }); listEl.append(sentinel); moreIo = new IntersectionObserver((es) => { if (!es.some((x) => x.isIntersecting)) return; sentinel.before(slice()); if (drawn >= list.length) { moreIo?.disconnect(); moreIo = null; sentinel.remove(); return; } moreIo?.unobserve(sentinel); moreIo?.observe(sentinel); }, { root: null, rootMargin: '1200px 0px' }); moreIo.observe(sentinel); }
    const dirs = list.filter((e) => e.dir).length; const files = list.length - dirs;
    subEl.textContent = [dirs ? countFolders(dirs) : '', files ? countFiles(files) : ''].filter(Boolean).join(', '); status.textContent = '';
    syncFast();
  };
  // (The window crossing 840 px — a turned phone, a resized window —: the rows drawn again in the layout that now fits.)
  const mqW = window.matchMedia('(min-width: 840px)'); let mqT = 0;
  const onMqW = () => { clearTimeout(mqT); mqT = window.setTimeout(() => { if (!gone) { syncBack(); draw(window.scrollY); if (selecting) drawSel(); } }, 150); };
  // (The app's layout turning from the computer's to the phone's — a window made narrow —: the computer's parts are
  // taken down, their listeners with them; turning back, they are put up again.)
  const pcObs = new MutationObserver(() => {
    if (gone) return;
    if (pcCtl && phoneNow()) { pcCtl.dispose(); pcCtl = null; void load(); }
    else if (!pcCtl && pcm && !phoneNow() && !pk && !po.handedIn) void load();
  });
  pcObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  mqW.addEventListener('change', onMqW);
  const paintView = () => { const next = NEXT_VIEW[prefs.view]; const to = next === 'gallery' ? 'images' : next; viewBtn.dataset.icon = to; viewBtn.replaceChildren(icon(to)); const lbl = t(VIEW_TO[next]); viewBtn.title = lbl; viewBtn.setAttribute('aria-label', lbl); };
  /** The view changed: the first row in sight stays where it is on the screen, the rows are drawn at the new size (their
   *  pictures asked again at it), the button shows what a tap does now. */
  const applyView = () => {
    paintView(); let anchor: { path: string; top: number } | null = null; const edge = (root.querySelector('.topbar') as HTMLElement | null)?.getBoundingClientRect().bottom ?? 0;
    for (const [p, { el }] of rowEls) { if (!el.isConnected) continue; const r = el.getBoundingClientRect(); if (r.bottom > edge + 1 && (!anchor || r.top < anchor.top)) anchor = { path: p, top: r.top }; }
    draw(0, anchor?.path ?? '');
    const now = anchor ? rowEls.get(anchor.path)?.el : null;
    if (anchor && now) { const d = now.getBoundingClientRect().top - anchor.top; if (d) { if (body.scrollHeight > body.clientHeight + 1 && body.scrollTop) body.scrollTop += d; else window.scrollBy(0, d); } }
    if (!anchor) { window.scrollTo(0, 0); }
  };
  /** A row that cannot be drawn — whatever is odd about its entry — is drawn plainly, never taking the list with it. */
  const safeRow = (e: Entry): HTMLElement => {
    try { const el = row(e); cntWant(el, e); return el; } catch { const el = h('div', { class: 'files-row odd', role: 'button', tabindex: '0', onclick: () => { if (!selecting) void open(e); } }, h('span', { class: 'files-ic' }, icon(e.dir ? 'folder' : 'file')), h('span', { class: 'grow files-main' }, h('bdi', { class: 'files-name', dir: 'auto' }, String(e.name ?? e.path)))); rowEls.set(e.path, { el, e }); return el; }
  };
  const row = (e: Entry): HTMLElement => {
    if (e.dir && e.count === undefined && prefs.counts !== false) { const c = cntGet(e); if (c !== undefined) e.count = c; }
    const waitCnt = e.dir && e.count === undefined && cntOn(); const cntText = (n: number): string => (n >= 10000 ? countItems(n).replace('10000', '10000+') : countItems(n));
    const k = e.dir ? 'folder' : /\.kurokawa$/i.test(e.name) ? 'locked' : kindOfFile(e.name); const thumbable = !e.dir && (k === 'image' || k === 'video' || /\.apk$/i.test(e.name));
    const ae = e as AppEntry; const appIc = !!ae.pkg && isApps(e.path) && e.dir;
    const canThumb = (thumbable && plug() && (!isVirtual(e.path) || isArc(e.path))) || appIc || (thumbable && pcThumbs() && !isVirtual(e.path) && pcThumbable(e.name));
    const ic = h('span', { class: 'files-ic' + ((thumbable && (!isVirtual(e.path) || isArc(e.path)) || appIc) && prefs.thumbs !== false ? ' thumb' : ''), 'data-thumb': canThumb ? e.path : undefined }, e.dir && phoneNow() && !ae.special && !appIc && !isVirtual(e.path) ? folderIcon(e.name) : icon(e.dir ? (ae.special ? 'folder' : appIc ? 'apps' : 'folder') : ICON[k] ?? 'file'));
    // (The second line: only what is known — an archive's entry without a date shows its size alone, never «10 MB ·».)
    const when = e.mtime > 0 ? (prefs.view !== 'list' ? formatDateShort(e.mtime) : formatDate(e.mtime)) : '';
    const known = e.dir && prefs.dirSizes !== false && sizeable(e) ? sizeOf(e.path, e.mtime) : null;
    const meta = ae.sub ? joinMeta([ae.sub, ae.pkg && e.dir && !ae.special ? formatBytes(e.size) : '']) : e.dir ? joinMeta([e.count !== undefined && e.count >= 0 ? cntText(e.count) : '', known ? formatBytes(known.bytes) : '', isArc(e.path) ? when : '']) : collection ? joinMeta([formatBytes(e.size), baseOf(parentOf(e.path))]) : joinMeta([e.size >= 0 ? formatBytes(e.size) : '', when]);
    const dense = denseNow();
    const metaD = dense && !ae.sub && !collection ? (e.dir ? joinMeta([e.count !== undefined && e.count >= 0 ? (e.count === 0 ? t('filesRowEmpty') : cntText(e.count)) : '', known ? formatBytes(known.bytes) : '']) : e.size >= 0 ? formatBytes(e.size) : '') : meta;
    if (pk) {
      // (The picker's row: a folder opens; a file is chosen — or, of another kind than asked, greyed and said so.)
      const ok = e.dir || pickable(e);
      // (A folder: its count and its date, as the reference pickers show; a file: its size and date.)
      const pmeta = e.dir && !ae.sub ? joinMeta([e.count !== undefined && e.count >= 0 ? (e.count === 0 ? t('filesRowEmpty') : cntText(e.count)) : '', when]) : meta;
      const pr = h('div', { class: 'files-row' + (chosen.has(e.path) ? ' picked' : '') + (ok ? '' : ' pick-off') + (e.hidden ? ' hidden-file' : ''), role: 'button', tabindex: '0', 'aria-pressed': e.dir ? undefined : String(chosen.has(e.path)), onclick: () => void open(e) },
        ic, h('span', { class: 'grow files-main' }, nameEl(e.name, e.dir), h('small', { class: waitCnt ? 'src cnt-wait' : 'src' }, ...metaNodes(pmeta))),
        h('span', { class: 'pick-mark' + (chosen.has(e.path) && chosen.size > 1 && pk.req.multiple ? ' order' : '') }, ...(chosen.has(e.path) && chosen.size > 1 && pk.req.multiple ? [localDigits([...chosen.keys()].indexOf(e.path) + 1)] : [icon(e.dir ? 'chevronRight' : chosen.has(e.path) ? 'check' : 'circle')])));
      if (canThumb && prefs.thumbs !== false) thumbInto(ic, e);
      // (Kept by path, so a folder's count, when it comes, redraws this row.)
      rowEls.set(e.path, { el: pr, e });
      return pr;
    }
    if (pcCtl?.details()) { const pr = pcCtl.row(e, ic); rowEls.set(e.path, { el: pr, e }); return pr; }
    const el = h('div', { class: 'files-row' + (picked.has(e.path) ? ' picked' : '') + (e.hidden ? ' hidden-file' : ''), role: 'button', tabindex: '0', 'data-p': e.path, onclick: () => { if (selecting) { toggle(e); return; } void open(e); } },
      ic, h('span', { class: 'grow files-main' }, nameEl(e.name, e.dir), h('small', { class: waitCnt ? 'src cnt-wait' : 'src' }, ...metaNodes(metaD))),
      trail(e)); rowEls.set(e.path, { el, e });
    // (A computer's right-click: the item's menu at the pointer; a long press — or a right-click while choosing —: choosing.)
    onLongPress(el, (ev) => { if (ev.type === 'contextmenu' && !selecting && document.documentElement.classList.contains('pc')) { itemSheet(e, ev); return; } if (!selecting) { selecting = true; } toggle(e); if (phoneNow() && ev.type === 'pointerdown' && picked.has(e.path)) startDrag(e, ev as PointerEvent); });
    // (A phone: a tap on the 36 px icon chooses the row; a tap elsewhere opens it.)
    if (!ae.special) ic.addEventListener('click', (ev) => { if (!phoneNow() || prefs.view !== 'list') return; ev.stopPropagation(); selecting = true; toggle(e); });
    if (canThumb && prefs.thumbs !== false) thumbInto(ic, e);
    // (A phone: a row swiped back toward the reading's start is deleted (asked first, as always) — the other way
    // is the drawer's.)
    if (!quiet && !ae.special && !isApps(e.path) && !isVirtual(e.path) && plug()) {
      const del = { label: t('delete'), icon: 'trash', run: () => void confirmDelete([e.path]) }; const back = () => ({ left: del });   // (toward the line's start: ui/swipe.ts mirrors it in Arabic)
      swipeable(el, back, icon, () => !selecting && !collection);
    }
    if (po.embedded) { el.draggable = true; el.addEventListener('dragstart', (ev) => { const ps = picked.has(e.path) ? [...picked] : [e.path]; ev.dataTransfer?.setData('text/kt-paths', JSON.stringify(ps)); ev.dataTransfer?.setData('text/plain', ps.join('\n')); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove'; }); }
    return el;
  };

  // ---- the selection
  // (Chosen or let go: the rows in the page marked where they are — the list not drawn anew, so it stays where it was
  // scrolled to, however far down a big folder that is; rows drawn later read the choice themselves.)
  const rowEls = new Map<string, { el: HTMLElement; e: Entry }>();
  // (The order of choosing: the Set keeps it — a first tap is 1; what select-all adds comes after, in the order shown; a
  // let-go item gives its place up. Two or more chosen: each shows its number where the tick was.)
  let orderOf = new Map<string, number>();
  const reorder = () => { orderOf = new Map(); let i = 0; for (const p of picked) orderOf.set(p, ++i); };
  const trail = (e: Entry): HTMLElement => { if (denseNow()) return h('span', { class: 'files-date' }, formatRowDate(e.mtime)); if (!selecting) return iconButton('more', t('more'), (ev) => { ev.stopPropagation(); itemSheet(e, ev); }); const on = picked.has(e.path); const n = orderOf.get(e.path); return on && picked.size > 1 && n ? h('span', { class: 'files-check order', 'data-on': 'true', 'data-n': String(n), 'aria-label': t('btPicked', { n: localDigits(n) }) }, localDigits(n)) : h('span', { class: 'files-check', 'data-on': String(on) }, icon(on ? 'check' : 'circle')); };
  const applySel = () => {
    reorder(); pcCtl?.sel();
    for (const [p, { el, e }] of rowEls) {
      if (!el.isConnected) { rowEls.delete(p); continue; }
      const on = picked.has(p); el.classList.toggle('picked', on); if (denseNow() || el.classList.contains('d-row')) continue; // (a phone's compact row: its date stays, the icon becomes the tick)
      const last = el.lastElementChild as HTMLElement | null; const wasCheck = !!last?.classList.contains('files-check');
      if (wasCheck !== selecting || (selecting && (last?.dataset.on !== String(on) || (last?.dataset.n ?? '') !== (on && picked.size > 1 ? String(orderOf.get(p)) : '')))) last?.replaceWith(trail(e));
    }
  };
  const toggle = (e: Entry) => { if (picked.has(e.path)) picked.delete(e.path); else picked.add(e.path); if (!picked.size) selecting = false; applySel(); drawSel(); };
  /** The selection bar never clips: its actions are kept by priority (lower first) as many as fit, the rest wait under ⋮. */
  type SelAct = { ic: string; label: string; prio: number; run?: () => void; off?: boolean; danger?: boolean };
  let selActs: SelAct[] = []; let selMore = false;
  const paintSelBar = (): void => {
    const n = picked.size; let k = selActs.length;
    const draw1 = (): SelAct[] => {
      const keep = new Set([...selActs].sort((x, y) => x.prio - y.prio).slice(0, k)); const hid = selActs.filter((x) => !keep.has(x));
      const btn = (x: SelAct) => { const b = iconButton(x.ic, x.label, x.run); if (x.off) { b.disabled = true; b.classList.add('files-off'); } return b; };
      selBar.replaceChildren(h('span', { class: 'files-selcount' }, countItems(n)), ...selActs.filter((x) => keep.has(x)).map(btn),
        ...(selMore || hid.length ? [iconButton('more', t('more'), () => selectionSheet(hid))] : []), iconButton('close', t('close'), leaveSel));
      return hid;
    };
    draw1(); while (k > 0 && selBar.scrollWidth > selBar.clientWidth + 1) { k--; draw1(); }
  };
  // (One observer, only while something is selected; let go when the selection ends and when the view goes.)
  let selRo: ResizeObserver | null = null;
  const watchSelBar = (on: boolean): void => { if (!on) { selRo?.disconnect(); selRo = null; return; } if (!selRo && typeof ResizeObserver !== 'undefined') { selRo = new ResizeObserver(() => { if (!selBar.hidden && selActs.length) paintSelBar(); }); selRo.observe(selBar); } };
  const drawSel = () => {
    selBar.hidden = !selecting; if (!selecting) { watchSelBar(false); root.classList.remove('selecting'); document.documentElement.classList.remove('files-selecting'); selBar.classList.remove('phone-sel'); return; } root.classList.add('selecting');
    const n = picked.size; const one = n === 1 ? entries.find((e) => e.path === [...picked][0]) : undefined;
    const all = (): void => { for (const e of shown()) picked.add(e.path); applySel(); drawSel(); };
    if (phoneNow() && !pk) { watchSelBar(false); paintPhoneSel(n, one, all); return; }
    document.documentElement.classList.remove('files-selecting'); selBar.classList.remove('phone-sel'); watchSelBar(true);
    // (Inside an archive only what reads: copy (taken out on Paste), share, take out; cut shown greyed with its reason.)
    if (isArc(at)) {
      selMore = false;
      selActs = [{ ic: 'check', label: t('filesSelectAll'), prio: 1, run: all },
        ...(canJobs() ? [{ ic: 'copy', label: t('filesCopy'), prio: 2, run: () => copyPicked('copy') }, { ic: 'scissors', label: t('arcNoCut'), prio: 8, off: true }, { ic: 'archive', label: t('extractHere'), prio: 1, run: () => { const ps = [...picked]; leaveSel(); void extractEntries(ps, parentOf(parseArc(at).archive)); } }] : []),
        ...(n > 1 ? [{ ic: 'pen', label: `${t('filesBatchRename')} — ${t('btWhyArchive')}`, prio: 9, off: true }] : []),
        ...(plug() ? [{ ic: 'share', label: t('share'), prio: 3, run: () => { const ps = [...picked]; leaveSel(); void shareArc(ps); } }] : [])];
      paintSelBar(); return;
    }
    selMore = true;
    selActs = [{ ic: 'check', label: t('filesSelectAll'), prio: 1, run: all },
      ...(canJobs() ? [{ ic: 'copy', label: t('filesCopy'), prio: 2, run: () => copyPicked('copy') }, { ic: 'scissors', label: t('filesCut'), prio: 3, run: () => copyPicked('move') }] : []),
      ...(n > 1 ? [{ ic: 'pen', label: t('filesBatchRename'), prio: 4, run: () => void batchRename() }] : []),
      ...(comparePair() ? [{ ic: 'columns', label: t('filesCompare'), prio: 4, run: () => { const pr = comparePair(); if (pr) runCompare(pr); } }] : []),
      ...(po.peer?.() ? [{ ic: 'swap', label: t('filesToOtherPane'), prio: 7, run: () => { const ps = [...picked]; leaveSel(); pickSheet(t('filesToOtherPane'), [['copy', t('filesCopy'), 'copy'], ['move', t('filesMove'), 'scissors']], 'copy', (op) => void po.peer!()!.dropIn(op as 'copy' | 'move', ps), t('cancel')); } }] : []),
      { ic: 'trash', label: t('delete'), prio: 5, danger: true, run: () => void confirmDelete([...picked]) },
      ...(plug() && !isVirtual(at) ? [{ ic: 'lock', label: t('vaultLock'), prio: 8, run: () => { const ps = [...picked]; leaveSel(); void import('./filesMore').then((m) => { if (!m.canVault()) { toast(t('vaultUnavailable'), 'error'); return; } m.vaultSheet(!ps.every((x) => /\.kurokawa$/i.test(x)), ps, jobRow, () => void load()); }); } }] : []),
      ...(one ? [{ ic: 'pen', label: t('rename'), prio: 4, run: () => renameSheet(one) }] : []),
      { ic: 'share', label: t('share'), prio: 6, run: () => void shareMany([...picked]) }];
    paintSelBar();
  };
  const leaveSel = () => { selecting = false; picked.clear(); applySel(); drawSel(); };
  const invertSel = () => { for (const e of shown()) { if (picked.has(e.path)) picked.delete(e.path); else picked.add(e.path); } if (!picked.size) selecting = false; applySel(); drawSel(); };
  // (Drag-choosing: after the long press, the finger moving on over rows chooses the rows it passes; at the screen's top or
  // bottom edge the list scrolls. The touch is the drag's alone — taken through the touch owner — until the finger is up.)
  let dragOff: (() => void) | null = null;
  const startDrag = (e: Entry, ev: PointerEvent) => {
    dragOff?.(); if (!claimTouch('files-drag')) return;
    const list = shown(); const idx = new Map(list.map((x, i) => [x.path, i] as const)); let last = idx.get(e.path) ?? -1; let px = ev.clientX, py = ev.clientY; let raf = 0; let moved = false; // (the layout shifts when choosing starts: a finger that has not moved chooses nothing more)
    const hit = () => { if (!moved) return; const r = (document.elementFromPoint(px, py) as HTMLElement | null)?.closest<HTMLElement>('.files-row'); const i = r?.dataset.p !== undefined ? idx.get(r.dataset.p) : undefined; if (i === undefined || last < 0 || i === last) return; const [a, b] = i > last ? [last + 1, i] : [i, last - 1]; for (let k = a; k <= b; k++) picked.add(list[k].path); last = i; applySel(); drawSel(); };
    const tick = () => { raf = requestAnimationFrame(tick); const H = window.innerHeight; if (py > H - 100) window.scrollBy(0, Math.min(22, 4 + (py - (H - 100)) / 3)); else if (py < pageTop() + 70) window.scrollBy(0, -Math.min(22, 4 + (pageTop() + 70 - py) / 3)); hit(); };
    const mv = (m: PointerEvent) => { px = m.clientX; py = m.clientY; if (!moved && Math.hypot(px - ev.clientX, py - ev.clientY) > 12) moved = true; hit(); };
    const tm = (m: TouchEvent) => { if (m.cancelable) m.preventDefault(); };
    const stop = () => { cancelAnimationFrame(raf); document.removeEventListener('pointermove', mv, true); document.removeEventListener('pointerup', stop, true); document.removeEventListener('pointercancel', stop, true); document.removeEventListener('touchmove', tm); if (dragOff === stop) dragOff = null; };
    document.addEventListener('pointermove', mv, true); document.addEventListener('pointerup', stop, true); document.addEventListener('pointercancel', stop, true); document.addEventListener('touchmove', tm, { passive: false });
    dragOff = stop; raf = requestAnimationFrame(tick);
  };
  /** «More» for several chosen: the same grouped sheet as for one item, with what is valid for several. */
  const multiMoreSheet = (): void => {
    const sh = openSheet(t('filesSelCount', { n: localDigits(picked.size) }), t('close')); const ps = [...picked];
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    const g1: HTMLElement[] = [act('share', t('share'), () => void shareMany(ps))];
    const g2: HTMLElement[] = [act('pen', t('filesBatchRename'), () => void batchRename()), ...(arcOk() ? [act('archive', t('filesCompress'), () => void compress(ps))] : []), ...(comparePair() ? [act('columns', t('filesCompare'), () => { const pr = comparePair(); if (pr) runCompare(pr); })] : [])];
    const g3: HTMLElement[] = plug() && !isVirtual(at) ? [act('lock', t('vaultLock'), () => { leaveSel(); void import('./filesMore').then((m) => { if (!m.canVault()) { toast(t('vaultUnavailable'), 'error'); return; } m.vaultSheet(!ps.every((x) => /\.kurokawa$/i.test(x)), ps, jobRow, () => void load()); }); })] : [];
    sh.body.append(...[g1, g2, g3].filter((g) => g.length).map((g) => h('div', { class: 'dest-list more-grp' }, ...g)));
  };
  /** A phone's selection: the header (close, count, select all, invert) and the bar at the bottom — five equal slots. */
  const paintPhoneSel = (n: number, one: Entry | undefined, all: () => void): void => {
    const root_ = document.documentElement; root_.classList.add('files-selecting'); selBar.classList.add('phone-sel');
    selHead.replaceChildren(iconButton('close', t('close'), leaveSel), h('span', { class: 'files-selcount grow' }, t('filesSelCount', { n: localDigits(n) })), iconButton('check', t('filesSelectAll'), all), iconButton('swap', t('filesInvert'), invertSel));
    const arc = isArc(at); const ps = () => [...picked];
    const slot = (id: string, ic: string, label: string, run: () => void, off = false): HTMLElement => { const b = h('button', { type: 'button', 'aria-label': label, 'data-icon': ic, class: 'sel-slot' + (id === 'delete' ? ' danger' : '') + (off ? ' files-off' : ''), 'data-slot': id, onclick: run }, icon(ic), h('span', { class: 'sel-lbl' }, label)) as HTMLButtonElement; if (off) b.disabled = true; return b; };
    const slots: HTMLElement[] = [];
    if (canJobs()) slots.push(slot('copy', 'copy', t('filesCopy'), () => copyPicked('copy')));
    if (arc) { if (canJobs()) { const cut = slot('cut', 'scissors', t('filesCut'), () => undefined, true); cut.title = t('arcNoCut'); slots.push(cut); } if (canJobs()) slots.push(slot('extract', 'archive', t('extractHere'), () => { const p = ps(); leaveSel(); void extractEntries(p, parentOf(parseArc(at).archive)); })); if (plug()) slots.push(slot('share', 'share', t('share'), () => { const p = ps(); leaveSel(); void shareArc(p); })); }
    else {
      if (canJobs()) slots.push(slot('cut', 'scissors', t('filesCut'), () => copyPicked('move')));
      slots.push(slot('delete', 'trash', t('delete'), () => void confirmDelete(ps())));
      if (one) slots.push(slot('rename', 'pen', t('rename'), () => renameSheet(one))); else if (arcOk()) slots.push(slot('archive', 'archive', t('filesCompress'), () => void compress(ps()))); else slots.push(slot('rename', 'pen', t('filesBatchRename'), () => void batchRename()));
    }
    slots.push(slot('more', 'more', t('more'), () => { if (one) itemSheet(one, undefined, true); else if (!arc) multiMoreSheet(); else selectionSheet([]); })); // (one entry, in an archive too: its own ways — Extract to, Open, Share)
    selBar.replaceChildren(...slots);
  };
  /** The chosen put on the clipboard — a cut inside an archive is a copy (an archive is not changed from here). */
  let clipAt = '';
  const copyPicked = (op: 'copy' | 'move', paths = [...picked]) => {
    if (!paths.length) return; const fromArc = paths.some(isArc); const o = fromArc ? 'copy' : op;
    setClip({ op: o, paths }); clipAt = at; if (fromArc && op === 'move') toast(t('arcCutAsCopy')); if (selecting) leaveSel(); // (the clipboard bar says the rest)
  };

  // ---- the picker: what is chosen (kept while folders are walked), the bar with Cancel and Select
  const chosen = new Map<string, Entry>();
  let showAll = false;
  const pickable = (e: Entry): boolean => !!pk && !e.dir && !isVirtual(e.path) && !isApps(e.path) && (showAll || mimeMatches(mimeOfName(e.name), pk.req.mimes));
  /** The answer: the folder it came from is kept (apart from ordinary browsing) for next time. */
  const finishPick = (paths: string[]) => {
    if (!pk || !paths.length) return; if (paths.some((x) => refused.has(x))) { drawPick(); return; }
    const dir = paths[0].replace(/\/[^/]*$/, '') || '/'; notePick(pk.req.caller, dir);
    void Promise.resolve(pk.done(pickResult(pk.req, paths))).then((r) => { const list = Array.isArray(r) ? r : r && Array.isArray(r.refused) ? r.refused : []; if (gone || !list.length) return; refusedWhy = !Array.isArray(r) && r?.why === 'gone' ? 'gone' : 'nolink'; for (const x of list) refused.add(x); drawPick(); });
  };
  // (Files Android could not give the asking app a link to: said here — which, and why —, and nothing handed back
  // until they are taken out of the choice, or Cancel.)
  const refused = new Set<string>(); let refusedWhy: 'nolink' | 'gone' = 'nolink'; const pickNote = h('p', { class: 'pick-refused', role: 'alert', hidden: true });
  const pickCount = h('span', { class: 'pick-count' });
  const pickGo = h('button', { type: 'button', class: 'btn primary', onclick: () => { if (pk && chosen.size) finishPick([...chosen.keys()]); } }) as HTMLButtonElement;
  const drawPick = () => {
    if (!pk) return; const n = chosen.size; const one = n === 1 ? [...chosen.values()][0] : undefined;
    pickCount.classList.toggle('has', n > 0); pickCount.textContent = !n ? t('pickNothingYet') : one ? one.name : countLabelFiles(n);
    const bad = [...chosen.values()].filter((e) => refused.has(e.path)); pickNote.hidden = !bad.length;
    if (bad.length) pickNote.textContent = `${refusedWhy === 'gone' ? (bad.length === 1 ? t('pickGoneOne', { name: bad[0].name }) : t('pickGoneMany', { n: localDigits(bad.length) })) : bad.length === 1 ? t('pickRefusedOne', { name: bad[0].name }) : t('pickRefusedMany', { n: localDigits(bad.length) })} ${pk.req.multiple ? t('pickRefusedFix') : t('pickRefusedFixOne')}`;
    pickGo.replaceChildren(icon('check'), n && getLang() !== 'ar' ? t('pickAddN', { n: localDigits(n) }) : t('pickAdd')); /* (Arabic: the count said once, «العدد: n» beside, never squeezed into the button) */ pickGo.disabled = !n || bad.length > 0;
  };
  const choose = (e: Entry) => {
    if (!pk) return;
    if (!pickable(e)) { toast(isVirtual(e.path) || isApps(e.path) ? t('pickNotHere') : t('pickWrongKind')); return; }
    if (!pk.req.multiple) { chosen.clear(); chosen.set(e.path, e); refused.delete(e.path); finishPick([e.path]); return; }
    if (chosen.has(e.path)) chosen.delete(e.path); else { chosen.set(e.path, e); refused.delete(e.path); } // (chosen again: tried again)
    draw(); drawPick();
  };

  // ---- opening
  const open = async (e: Entry) => {
    const ae = e as AppEntry;
    if (pk && !e.dir) { choose(e); return; }
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
    // («Always open .mkv with…»: the choice made in Files' own chooser goes first — Kurokawa's own way, or an app.)
    if (pl?.appsFor || desk()?.openPath) { const ow = await import('./openWith'); const d = ow.defaultFor(e.name); if (d && await runChoice(d, e)) return; }
    // («.ts»: a video only when its first bytes are MPEG-TS packets — a TypeScript source is text.)
    let tsVideo = false;
    if (/\.ts$/i.test(e.name) && pl) { const r = await (pl as unknown as { uriRead?(o: { path: string; max: number }): Promise<{ b64: string }> }).uriRead?.({ path: e.path, max: 400 }).catch(() => null); if (typeof r?.b64 === 'string') { const [{ fromB64 }, { sniffTs }] = await Promise.all([import('./textCodec'), import('./openWithLogic')]); tsVideo = sniffTs(fromB64(r.b64)); if (!tsVideo && e.size < 4_000_000) { const m = await import('./filesMore'); await m.editorSheet(e, () => void load()); return; } } }
    try {
      if (k === 'video' || k === 'audio') { const { openPlayer } = await import('./player'); const { localFileUrl } = await import('../player/files'); const u = await localFileUrl(e.path); if (u) { await openPlayer(u, e.name, { localPath: e.path }); return; } }
      // (An installed app's own APKs — its base and its parts — are there to look into, not to install again.)
      if (/\.apk$/i.test(e.name) && at.startsWith('apps://')) { go(arcPath(e.path)); return; }
      if (/\.(apk|apks|xapk|apkm)$/i.test(e.name)) { const m = await import('./apk'); if (m.canInstallApps()) { await m.installSheet(e.path); return; } }
      if (looksArchive(e.name) && !/\.epub$/i.test(e.name)) { go(arcPath(e.path)); return; }
      if (/\.(srt|ass|ssa|vtt|sub)$/i.test(e.name) && e.size < 4_000_000) { const { workshopSheet } = await import('../subs/workshop'); const vid = shown().find((x) => !x.dir && kindOfFile(x.name) === 'video' && x.name.replace(/\.[^.]+$/, '').startsWith(e.name.replace(/\.[^.]+$/, '').replace(/\.[a-z]{2,3}$/i, ''))); await workshopSheet(e.path, vid?.path); return; }
      if (/\.(txt|nfo|md|log|json|xml|srt|ass|vtt|csv|ini|cfg|yml|yaml|html?|css|js|ts|py|sh|java|kt|c|h|cpp)$/i.test(e.name) && !tsVideo && e.size < 4_000_000 && pl) { const m = await import('./filesMore'); await m.editorSheet(e, () => void load()); return; }
      if (k === 'image' && pl) { const m = await import('./filesMore'); const { localFileUrl } = await import('../player/files'); const pics = shown().filter((x) => !x.dir && (kindOfFile(x.name) === 'image' || kindOfFile(x.name) === 'video')); await m.imageViewer(pics, Math.max(0, pics.findIndex((x) => x.path === e.path)), localFileUrl, (x) => void confirmDelete([x.path])); return; }
      if (pl) { if (pl.appsFor) { await chooseThenOpen(e); return; } await pl.openChooser({ path: e.path, mime: mimeOf(e.name), title: e.name }); return; }
      const d = desk(); if (d?.openPath) { await d.openPath(e.path); return; }
    } catch (err) { toast(String((err as Error).message ?? err), 'error'); }
  };
  /** One of Kurokawa's own ways for a file, as the chooser or a kept default names it; false when it does not apply here. */
  const openWay = async (w: import('./openWithLogic').OwnWay, e: Entry): Promise<boolean> => {
    const pl = plug();
    if (w === 'player') { const { openPlayer } = await import('./player'); const { localFileUrl } = await import('../player/files'); const u = await localFileUrl(e.path); if (!u) return false; await openPlayer(u, e.name, { localPath: e.path }); return true; }
    if (w === 'viewer' && pl) { const m = await import('./filesMore'); const { localFileUrl } = await import('../player/files'); const pics = shown().filter((x) => !x.dir && (kindOfFile(x.name) === 'image' || kindOfFile(x.name) === 'video')); const list = pics.some((x) => x.path === e.path) ? pics : [e]; await m.imageViewer(list, Math.max(0, list.findIndex((x) => x.path === e.path)), localFileUrl, (x) => void confirmDelete([x.path])); return true; }
    if (w === 'editor' && pl) { const m = await import('./filesMore'); await m.editorSheet(e, () => void load()); return true; }
    if (w === 'archive') { go(arcPath(e.path)); return true; }
    if (w === 'installer') { const m = await import('./apk'); if (!m.canInstallApps()) return false; await m.installSheet(e.path); return true; }
    if (w === 'system') { const d = desk(); if (!d?.openPath) return false; await d.openPath(e.path); return true; }
    return false;
  };
  const runChoice = async (c: import('./openWithLogic').DefaultApp, e: Entry): Promise<boolean> => {
    if ('own' in c) return openWay(c.own, e);
    const pl = plug(); if (!pl?.openIn) return false;
    try { await pl.openIn({ path: e.path, mime: mimeOf(e.name), pkg: c.app.pkg, cls: c.app.cls }); return true; }
    catch { const ow = await import('./openWith'); ow.forgetDefault((await import('./openWithLogic')).extOf(e.name)); toast(t('owAppGone'), 'error', 4000); await chooseThenOpen(e); return true; }
  };
  /** Files' own «Open with…»: Kurokawa's ways first, then the apps; «Just once» or «Always». */
  const chooseThenOpen = async (e: Entry) => { const ow = await import('./openWith'); const c = await ow.chooseOpener(e, mimeOf(e.name), !plug()); if (c && !(await runChoice(c, e))) toast(t('filesFailed'), 'error'); };
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
    const item = (ic: string, name: string, sub: string | HTMLElement | null, fn: () => void, extra?: HTMLElement, cur = false, more?: () => void) => h('button', { type: 'button', class: 'dest-row files-drawer-row' + (cur ? ' on' : ''), ...(cur ? { 'aria-current': 'true' } : {}), ...(more ? { oncontextmenu: (ev: Event) => { ev.preventDefault(); more(); } } : {}), onclick: () => { sh.close(); fn(); } }, h('span', { class: 'files-drawer-ic' }, icon(ic)), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, name), sub ? (typeof sub === 'string' ? h('small', { class: 'src', dir: 'ltr' }, sub) : sub) : null), extra ?? null);
    const here = roots.filter((r) => !collection && (at === r.path || at.startsWith(r.path.replace(/\/+$/, '') + '/'))).sort((a, b) => b.path.length - a.path.length)[0];
    const storage = (r: Root) => { const used = r.total && r.free !== undefined ? Math.round(((r.total - r.free) / r.total) * 100) : null; return item(rootIcon(r.kind), r.name, used === null ? r.path : h('span', { class: 'files-usage' }, h('span', { class: 'files-usage-bar' + (used > 90 ? ' full' : '') }, h('i', { style: { width: `${used}%` } })), h('small', { class: 'src' }, t('filesFreeOf', { free: formatBytes(r.free!), total: formatBytes(r.total!) }))), () => { if (!r.readable) { void askAccess(); return; } go(r.path); }, undefined, r === here && at === r.path); };
    const bm = bookmarks();
    sh.body.append(section(t('filesStorages'), ...roots.map(storage)));
    // Bookmarks: opened by a tap; the kebab edits (a name, pinned to the home screen, moved up, removed).
    const bmMenu = (b: { name: string; path: string }) => {
      const m = openSheet(b.name, t('close')); const row = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { m.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
      m.body.append(h('div', { class: 'dest-list' },
        row('pen', t('rename'), () => { const r = openSheet(t('rename'), t('cancel')); const inp = h('input', { type: 'text', value: b.name, dir: 'auto' }) as HTMLInputElement; r.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp)); r.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { const name = inp.value.trim() || b.name; saveBookmarks(bookmarks().map((x) => (x.path === b.path ? { ...x, name } : x))); r.close(); sh.close(); drawer(); } }, icon('check'), t('rename'))); setTimeout(() => inp.focus(), 50); }),
        ...(plug() ? [row('pin', t('filesPinHome'), () => void pinHome(b.path, b.name))] : []),
        row('up', t('filesMoveUp'), () => { const a = bookmarks(); const i = a.findIndex((x) => x.path === b.path); if (i > 0) { [a[i - 1], a[i]] = [a[i], a[i - 1]]; saveBookmarks(a); } sh.close(); drawer(); }),
        row('down', t('fmMoveDown'), () => { const a = bookmarks(); const i = a.findIndex((x) => x.path === b.path); if (i >= 0 && i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; saveBookmarks(a); } sh.close(); drawer(); }),
        row('trash', t('delete'), () => { saveBookmarks(bookmarks().filter((x) => x.path !== b.path)); sh.close(); drawer(); })));
    };
    if (bm.length) sh.body.append(section(t('fmFav'), ...bm.map((b) => item('bookmark', b.name, readablePath(b.path), () => go(b.path), iconButton('more', t('more'), (ev) => { ev.stopPropagation(); bmMenu(b); }), !collection && b.path === at, () => bmMenu(b)))));
    { let rc: string[] = []; try { rc = (JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[]).slice(0, 8); } catch { /* none */ } if (rc.length) sh.body.append(section(t('fmRecentFolders'), ...rc.map((p) => item('history', placeName(p), readablePath(p), () => go(p), undefined, !collection && p === at)))); }
    if (plug()) sh.body.append(section(t('filesCollections'), ...COLLECTIONS.map(([k, label, ic]) => item(ic, t(label as 'filesRecent'), null, () => openCollection(k), undefined, collection === k))), section('', item('trash', t('filesTrash'), null, () => void import('./filesMore').then((m) => m.trashSheet(() => void load())))));
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
    if (appsAvailable()) sh.body.append(section(t('appsTitle'), item('apps', t('appsTitle'), t('appsHint'), () => go('apps://'), undefined, at === 'apps://')));
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
    sh.body.append(h('div', { class: 'dest-list' }, act('folderPlus', t('newFolder'), () => newFolderSheet()), ...(!phoneNow() && canPaste() ? [act('copy', t('filesPaste'), () => void paste())] : []), ...(!phoneNow() && clipboard && !clipboard.busy ? [act('close', t('filesClipClear'), () => setClip(null))] : []), act('bookmarkAdd', t('filesBookmarkHere'), () => { const b = bookmarks(); if (!b.some((x) => x.path === at)) { b.push({ name: placeName(at) || at, path: at }); saveBookmarks(b); } toast(t('filesBookmarked')); }), ...(plug() ? [act('upload', t('filesSavedShared'), () => void saveSharedSheet())] : [])));
  };

  // ---- sheets: an item's, the selection's, sort, more, rename, new folder, properties, delete
  const itemSheet = (e: Entry, at?: Event, rest = false) => {
    if ((e as AppEntry).pkg && isApps(e.path) && e.dir && !(e as AppEntry).special) { void import('./filesApps').then((m) => m.appSheet((e as AppEntry).pkg!, e.name, { go, pickDir: async () => { try { const { ktPlugin } = await import('../native'); return (await ktPlugin()?.pickDir())?.dir ?? null; } catch { return null; } }, defaultDir: `${roots.find((r) => r.kind === 'app')?.path ?? '/storage/emulated/0/Download/Kurokawa'}/Apps` })); return; }
    if (isArc(e.path)) { arcItemSheet(e, at); return; }
    const pl = isVirtual(e.path) ? null : plug(); const sh = openSheet(e.name, t('close'), { at });
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    // (rest: the «More» of a phone's selection — what the bar's slots do not: Open with, Open as, Share · the archive's ways · size and facts · hide, .nomedia, vault; apart in groups.)
    const G = (g: number, xs: HTMLElement[]): HTMLElement[] => { for (const x of xs) x.dataset.g = String(g); return rest && g === 0 ? [] : xs; };
    const lists = (xs: HTMLElement[]): HTMLElement[] => { if (!rest) return [h('div', { class: 'dest-list' }, ...xs)]; const gs = new Map<string, HTMLElement[]>(); for (const x of xs) { const k = x.dataset.g ?? '9'; (gs.get(k) ?? gs.set(k, []).get(k)!).push(x); } return [...gs.keys()].sort().map((k) => h('div', { class: 'dest-list more-grp' }, ...gs.get(k)!)); };
    sh.body.append(h('p', { class: 'src', dir: 'ltr' }, readablePath(e.path)), ...lists([
      ...G(0, [act('external', t('open'), () => void open(e))]),
      ...G(1, (pl && !e.dir ? [act('apps', t('openWith'), () => { if (pl.appsFor) void chooseThenOpen(e); else void pl.openWith({ path: e.path, mime: mimeOf(e.name), title: e.name }); }), act('type', t('filesOpenAs'), () => openAs(e))] : [])),
      ...G(1, (!pl && !e.dir && !isVirtual(e.path) && !isArc(e.path) && desk()?.openPath ? [act('apps', t('openWith'), () => void chooseThenOpen(e))] : [])),
      ...G(1, (pl ? [act('share', t('share'), () => void pl.shareFile({ path: e.path, title: e.name }))] : [])),
      ...G(0, (canJobs() ? [act('copy', t('filesCopy'), () => copyPicked('copy', [e.path])), act('scissors', t('filesCut'), () => copyPicked('move', [e.path]))] : [])),
      ...G(0, [act('pen', t('rename'), () => renameSheet(e))]),
      ...G(4, (pl ? [act('lock', /\.kurokawa$/i.test(e.name) ? t('vaultUnlock') : t('vaultLock'), () => void import('./filesMore').then((m) => { if (!m.canVault()) { toast(t('vaultUnavailable'), 'error'); return; } m.vaultSheet(!/\.kurokawa$/i.test(e.name), [e.path], jobRow, () => void load()); }))] : [])),
      ...G(4, (e.path.startsWith('root://') ? [act('terminal', t('filesPermissions'), () => rootOpsSheet(e))] : [])),
      ...G(4, (pl && e.dir ? [act('eyeOff', t('filesHideFolder'), () => void import('./filesMore').then((m) => { m.hidePath(e.path); toast(t('filesHiddenNow')); void load(); })), act('images', t('filesNomedia'), () => void import('./filesMore').then((m) => m.toggleNomedia(e.path)).then((on) => toast(on ? t('filesNomediaOn') : t('filesNomediaOff'))).catch((err) => toast(String((err as Error).message ?? err), 'error')))] : [])),
      ...G(2, (!e.dir && !isVirtual(e.path) && looksArchive(e.name) ? [act('folder', /\.(apk|apks|xapk|apkm)$/i.test(e.name) ? t('apkBrowse') : t('filesOpenAsArchive'), () => { sh.close(); go(arcPath(e.path)); })] : [])),
      ...G(2, (arcOk() && !e.dir && canExtractName(e.name) ? [act('archive', t('extractHere'), () => void extractHere(e)), act('archive', t('extractTo'), () => void import('./extract').then((m) => m.extractSheet(e.path)))] : [])),
      ...G(2, (arcOk() ? [act('archive', t('filesCompress'), () => void compress([e.path]))] : [])),
      ...G(0, [act('check', t('filesSelect'), () => { selecting = true; picked.add(e.path); applySel(); drawSel(); })]),
      ...G(3, (sizeable(e) ? [act('refresh', t('filesCalcSize'), () => void propertiesSheet(e, true))] : [])),
      ...G(3, [act('info', t('properties'), () => void propertiesSheet(e))]),
      ...G(0, [act('trash', t('delete'), () => void confirmDelete([e.path]))]),
    ]));
    // (A book the Reader opens: «Open in Kurokawa Reader» — only where the system says the Reader is installed and takes it.)
    const rm = readerMime(e.name); if (pl?.appsFor && pl.openIn && !e.dir && rm) void pl.appsFor({ path: e.path, mime: rm }).then((r) => {
      const app = r.apps.find((a) => a.pkg === READER_PKG); if (!app || !sh.body.isConnected) return; const list = rest ? null : sh.body.querySelector('.dest-list'); if (rest) { if (!sh.body.querySelector('.files-open-reader')) { const rr = act('books', t('filesOpenInReader'), () => void pl.openIn!({ path: e.path, mime: rm, pkg: READER_PKG, cls: app.cls }).catch(() => toast(t('filesReaderFailed'), 'error'))); rr.classList.add('files-open-reader'); sh.body.append(h('div', { class: 'dest-list more-grp' }, rr)); } return; } if (!list || list.querySelector('.files-open-reader')) return;
      const row = act('books', t('filesOpenInReader'), () => void pl.openIn!({ path: e.path, mime: rm, pkg: READER_PKG, cls: app.cls }).catch(() => toast(t('filesReaderFailed'), 'error'))); row.classList.add('files-open-reader'); list.firstElementChild?.after(row);
    }).catch(() => undefined);
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
      act('check', t('filesSelect'), () => { selecting = true; picked.add(e.path); applySel(); drawSel(); }),
      act('info', t('properties'), () => void propertiesSheet(e))),
      h('p', { class: 'hint' }, t('arcReadOnly')));
  };
  const selectionSheet = (hid: SelAct[] = []) => {
    const sh = openSheet(countItems(picked.size), t('close')); const paths = [...picked];
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    const mk = (x: SelAct) => { const r = act(x.ic, x.label, x.run ?? (() => undefined)); if (x.off) { (r as HTMLButtonElement).disabled = true; r.classList.add('files-off'); } if (x.danger) r.classList.add('danger'); return r; };
    const extra = hid.filter((x) => !x.danger).map(mk); const risky = hid.filter((x) => x.danger).map(mk);
    if (isArc(at)) { sh.body.append(h('div', { class: 'dest-list' }, ...extra)); return; }
    sh.body.append(h('div', { class: 'dest-list' }, ...extra, act('archive', t('filesCompress'), () => void compress(paths)), act('pen', t('filesBatchRename'), () => void batchRename()), act('check', t('filesInvert'), () => { const all = shown(); for (const e of all) { if (picked.has(e.path)) picked.delete(e.path); else picked.add(e.path); } applySel(); drawSel(); }), act('info', t('properties'), () => { const one = entries.find((e) => e.path === paths[0]); if (one) void propertiesSheet(one); })), ...(risky.length ? [h('div', { class: 'dest-list sel-risky' }, ...risky)] : []));
  };
  const sortSheet = () => {
    const sh = openSheet(t('sortBy'), t('close'));
    const opt = (key: Prefs['sort'], label: string) => h('button', { type: 'button', class: 'dest-row' + (prefs.sort === key ? ' on' : ''), onclick: () => { if (prefs.sort === key) prefs.desc = !prefs.desc; else { prefs.sort = key; prefs.desc = false; } savePrefs(); pcCtl?.adopt(); sh.close(); draw(); } }, icon(prefs.sort === key ? (prefs.desc ? 'arrowDown' : 'arrowUp') : 'circle'), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' }, opt('name', t('sortName')), opt('date', t('sortDate')), opt('size', t('sortSize')), opt('type', t('sortType'))), h('p', { class: 'hint' }, t('filesSortHint')));
  };
  // (A phone's ⋮: one sheet — View, Sort, Show, This folder, Tools — built in views/filesMenu.ts; what it opens is this page's own.)
  const moreSheet = () => {
    if (phoneNow() && !pk) {
      const A = (ic: string, label: string, run: () => void) => ({ ic, label, run }); const real = !isVirtual(at) && !isArc(at) && !collection;
      const bmd = bookmarks().some((x) => x.path === at);
      void import('./filesMenu').then((m) => m.moreMenu({
        prefs, savePrefs, at, setOver: (o) => { sortOver = o; }, redraw: (w) => { if (w === 'view') { applyView(); po.peer?.()?.restyle(); } else if (w === 'hidden') void load(); else draw(); },
        folder: [...(real ? [A('folderPlus', t('newFolder'), () => newFolderSheet())] : []), A('check', t('filesSelectAll'), () => { selecting = true; for (const e of shown()) picked.add(e.path); applySel(); drawSel(); }), A('refresh', t('refresh'), () => void load()),
          ...(real ? [A(bmd ? 'bookmark' : 'bookmarkAdd', bmd ? t('fmUnbookmark') : t('filesBookmarkHere'), () => { if (bmd) saveBookmarks(bookmarks().filter((x) => x.path !== at)); else { const b = bookmarks(); b.push({ name: placeName(at) || at, path: at }); saveBookmarks(b); toast(t('filesBookmarked')); } })] : []),
          A('info', t('properties'), () => void propertiesSheet({ name: placeName(at), path: at, dir: true, size: 0, mtime: 0 }))],
        tools: [...(plug() ? [A('chart', t('filesAnalyzer'), () => pickSheet(t('filesAnalyzer'), roots.filter((r) => r.readable).map((r): [string, string, string] => [r.path, r.name, 'storage']), roots[0]?.path ?? '', (path) => { const r = roots.find((x) => x.path === path)!; void import('./filesMore').then((mm) => mm.analyzerSheet(r, (e) => void open(e), (d) => go(d), (paths) => void confirmDelete(paths))); }, t('close')))] : []),
          ...(real && fileHost() ? [A('copy', t('filesDups'), () => findDups()), A('columns', t('filesCompare'), () => { const pr = comparePair(); if (pr) runCompare(pr); else { selecting = true; applySel(); drawSel(); toast(t('fmCompareHint'), 'info'); } })] : []),
          ...(plug() ? [A('shield', t('filesVerify'), () => void import('./filesMore').then((mm) => mm.filesSettingsSheet(at, () => { void loadRoots(); void load(); }))), A('jobs', t('filesJobs'), () => jobsBtn.click()), A('trash', t('filesTrash'), () => void import('./filesMore').then((mm) => mm.trashSheet(() => void load())))] : [])],
        more: [...(plug() ? [A('trash', t('filesTrashSetting'), () => void import('./filesMore').then((mm) => { mm.setTrashOn(!mm.trashOn()); toast(mm.trashOn() ? t('filesTrashOn') : t('filesTrashOff')); }))] : []),
          A('settings', t('filesSettings'), () => void import('./filesMore').then((mm) => mm.filesSettingsSheet(at, () => { void loadRoots(); void load(); }))), A('eyeOff', t('filesHiddenFolders'), () => void import('./filesMore').then((mm) => mm.hiddenSheet((p) => go(p), () => void load()))),
          ...(canShareFolder() && !isVirtual(at) ? [A('wifi', t('fshareTitle'), () => void folderShareSheet(at, baseOf(at) || at))] : []), ...(plug() && !isVirtual(at) ? [A('pin', t('filesPinHome'), () => void pinHome(at, baseOf(at) || at))] : []),
          ...(plug() ? [A('key', t('archiveForgetPw'), () => void import('../archives').then((a) => { a.forgetPasswords(); a.setRememberPasswords(false); toast(t('done')); })), A('upload', t('filesSavedShared'), () => void saveSharedSheet())] : []), ...(plug() && !allFiles ? [A('key', t('filesAccessAllow'), () => void askAccess())] : [])],
      }));
      return;
    }
    const sh = openSheet(t('navFiles'), t('close'));
    const act = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' },
      ...(phoneNow() ? [act('filter', t('filesFilterHere'), () => filterBtn.click()), act(viewBtn.dataset.icon ?? 'grid', viewBtn.title, () => viewBtn.click()), act('sort', t('sortBy'), () => sortSheet())] : []),
      ...(isArc(at) || collection ? [] : [act('folderPlus', t('newFolder'), () => newFolderSheet())]),
      act('check', t('filesSelectAll'), () => { selecting = true; for (const e of shown()) picked.add(e.path); applySel(); drawSel(); }),
      act(prefs.hidden ? 'eye' : 'eye', prefs.hidden ? t('filesHideHidden') : t('filesShowHidden'), () => { prefs.hidden = !prefs.hidden; savePrefs(); void load(); }),
      act('refresh', t('refresh'), () => void load()),
      ...(plug() ? [act('trash', t('filesTrashSetting'), () => void import('./filesMore').then((m) => { m.setTrashOn(!m.trashOn()); toast(m.trashOn() ? t('filesTrashOn') : t('filesTrashOff')); }))] : []),
      ...(window.matchMedia('(min-width: 840px)').matches ? [act('columns', prefs.dual ? t('filesOnePane') : t('filesTwoPanes'), () => { prefs.dual = !prefs.dual; savePrefs(); navigate(`/files?p=${encodeURIComponent(at)}&t=${Date.now()}`, true); })] : []),
      act('settings', t('filesSettings'), () => void import('./filesMore').then((m) => m.filesSettingsSheet(at, () => { void loadRoots(); void load(); }))),
      act('eyeOff', t('filesHiddenFolders'), () => void import('./filesMore').then((m) => m.hiddenSheet((p) => go(p), () => void load()))),
      ...(canShareFolder() && !isVirtual(at) ? [act('wifi', t('fshareTitle'), () => void folderShareSheet(at, baseOf(at) || at))] : []),
      ...(plug() && !isVirtual(at) ? [act('pin', t('filesPinHome'), () => void pinHome(at, baseOf(at) || at))] : []),
      ...(plug() ? [act('key', t('archiveForgetPw'), () => void import('../archives').then((a) => { a.forgetPasswords(); a.setRememberPasswords(false); toast(t('done')); }))] : []),
      ...(!isVirtual(at) && !isArc(at) && !isApps(at) && !collection && fileHost() ? [act('copy', t('filesDups'), () => findDups())] : []),
      act('info', t('properties'), () => void propertiesSheet({ name: placeName(at), path: at, dir: true, size: 0, mtime: 0 })),
      ...(plug() ? [act('upload', t('filesSavedShared'), () => void saveSharedSheet())] : []),
      ...(plug() && !allFiles ? [act('key', t('filesAccessAllow'), () => void askAccess())] : [])));
  };
  // ---- renaming many at once: the sheet (views/filesBatchUi.ts), its run a job with progress and Cancel, then an Undo
  const renameOne = async (dir: string, from: string, to: string): Promise<void> => {
    const path = dir === '/' ? `/${from}` : `${dir}/${from}`;
    if (isVirtual(path)) { await vfs.rename(path, to); return; }
    const fx = fsx(); if (!fx) throw new Error(t('btWhyNoEngine')); const r = await fx.filesRename({ path, name: to }); if (r && r.ok === false) throw new Error('cannot rename');
  };
  const namesIn = async (dir: string): Promise<string[] | null> => {
    try {
      if (isVirtual(dir)) return (await vfs.list(dir)).entries.map((e) => e.name);
      const p = plug(); if (p) return (await p.filesList({ path: dir, hidden: true, counts: false })).entries.map((e) => e.name);
      const d = desk(); if (d?.listDir) return ((await d.listDir(dir)).entries ?? []).map((e) => e.name);
    } catch { /* not known */ }
    return null;
  };
  const batchHost = (items: Entry[]) => ({
    items: items.map((e) => ({ path: e.path, name: e.name, dir: e.dir, size: e.size, mtime: e.mtime })), shown: shown().map((e) => ({ path: e.path, name: e.name, dir: e.dir, size: e.size, mtime: e.mtime })), byHand: true,
    names: namesIn, rename: renameOne, fmtSize: formatBytes,
    progress: (label: string, cancel: () => void) => { const id = `rn-${Date.now()}`; const el = jobRow(id, label, cancel); return { set: (d: number, n: number) => { const b = el.querySelector('.files-job-bar i') as HTMLElement | null; if (b && n) b.style.width = `${Math.round((d / n) * 100)}%`; const m = el.querySelector('.files-job-meta'); if (m) m.textContent = `${localDigits(d)} / ${localDigits(n)}`; }, end: () => el.remove() }; },
    after: (moved: Map<string, string>) => { if (moved.size && picked.size) { const next = [...picked].map((x) => moved.get(x) ?? x); picked.clear(); for (const x of next) picked.add(x); } void load().then(() => { if (!gone && localStorage.getItem('kt.files.renamejob')) void import('./filesBatchUi').then((m) => m.interruptedBanner(batchHost([]), body)); }); },
  });
  const batchRename = async () => {
    const byPath = new Map(entries.map((e) => [e.path, e])); const items = [...picked].map((p) => byPath.get(p)).filter((e): e is Entry => !!e);
    if (items.length < 2) return;
    const m = await import('./filesBatchUi'); const why = m.whyNot(items.map((e) => e.path), !!(fsx() || items.every((e) => isVirtual(e.path))) && !items.some((e) => isApps(e.path)));
    if (why) { toast(t('btNoRenameHere', { why }), 'error', 5000); return; }
    await m.batchSheet(batchHost(items));
  };
  const renameSheet = (e: Entry) => {
    const pl = fsx(); if (!pl) return; if (isArc(e.path)) { toast(t('arcReadOnly'), 'info'); return; } const sh = openSheet(t('rename'), t('cancel'));
    // (A file: «name . extension» as the downloader's Save as — the extension on its own, so a stem retyped cannot lose it.)
    const [stem, ext] = splitExt(e.name, e.dir);
    const inp = h('input', { type: 'text', value: stem, dir: 'auto', placeholder: t('fileName'), class: 'grow', spellcheck: 'false' }) as HTMLInputElement;
    const extIn = e.dir ? null : h('input', { type: 'text', value: ext, dir: 'ltr', placeholder: t('extension'), class: 'ext-in', spellcheck: 'false', autocapitalize: 'off' }) as HTMLInputElement;
    const compose = () => { const n = inp.value.trim(); const x = (extIn?.value ?? '').trim().replace(/^\.+/, ''); return extIn && x && n ? `${n}.${x}` : n; };
    sh.body.append(h('div', { class: 'field' }, h('span', { class: 'label' }, t('fileName')), extIn ? nameDotExt(inp, extIn) : inp));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = compose(); if (!name || name === e.name) { sh.close(); return; } try { if (isVirtual(e.path)) { await vfs.rename(e.path, name); } else { const r = await pl.filesRename({ path: e.path, name }); if (r && r.ok === false) throw new Error(t('filesFailed')); } sh.close(); leaveSel(); void load(); } catch (err) { toast(fsErr(String((err as Error).message ?? err)), 'error'); } } }, icon('check'), t('rename')));
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  };
  const newFolderSheet = () => {
    const pl = fsx(); if (!pl) return; if (isArc(at)) { toast(t('arcReadOnly'), 'info'); return; } const sh = openSheet(t('newFolder'), t('cancel')); const inp = h('input', { type: 'text', dir: 'auto', placeholder: t('folderNamePlaceholder') }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim(); if (!name) return; try { if (isVirtual(at)) { await vfs.mkdir(at, name); } else { const r = await pl.filesMkdir({ path: `${at}/${name}` }); if (!r.ok) throw new Error(t('filesCannotMake')); } sh.close(); void load(); } catch (err) { toast(fsErr(String((err as Error).message ?? err)), 'error'); } } }, icon('check'), t('create')));
    setTimeout(() => inp.focus(), 50);
  };
  const propertiesSheet = async (e: Entry, auto = false) => {
    const pl = plug(); const fx = fsx(); const offs: (() => void)[] = []; const sh = openSheet(t('properties'), t('close'), { onClose: () => { for (const f of offs.splice(0)) f(); } }); const rows = h('div', { class: 'files-props' });
    const line = (k: string, v: string) => h('div', { class: 'files-prop' }, h('small', { class: 'src' }, k), h('span', { dir: 'auto' }, v));
    rows.append(line(t('fileName'), e.name), line(t('folderPath'), readablePath(e.path)));
    sh.body.append(rows);
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal small', onclick: () => { void navigator.clipboard?.writeText(readablePath(e.path)); toast(t('copied')); } }, icon('copy'), t('filesCopyPath')));
    // (Inside an archive: what the archive says of it — the phone is not asked about a file that is not on it.)
    if (isArc(e.path)) { rows.append(...(e.dir ? [line(t('fileSize'), joinMeta([formatBytes(e.size), e.count !== undefined ? countFiles(e.count) : '']))] : [line(t('fileSize'), e.size >= 0 ? formatBytes(e.size) : '—')]), ...(e.mtime > 0 ? [line(t('fileDate'), formatDate(e.mtime))] : []), line(t('filesAccess'), t('filesReadOnly'))); return; }
    if (!fx) { rows.append(line(t('fileSize'), e.dir ? '' : formatBytes(e.size)), line(t('fileDate'), formatDate(e.mtime))); return; }
    const sizeLine = line(t('fileSize'), '…'); rows.append(sizeLine);
    try {
      const s = await fx.filesStat({ path: e.path, id: 'props' });
      // (A computer's shell answers shallowly: a folder's contents are not counted there.)
      sizeLine.lastElementChild!.textContent = e.dir || s.dir ? (pl || s.files !== undefined ? `${formatBytes(s.size)} · ${countFiles(s.files ?? 0)} · ${countFolders(s.folders ?? 0)}` : '—') : formatBytes(s.size);
      if (e.dir && sizeable(e)) { const k = sizeOf(e.path, e.mtime > 0 ? e.mtime : s.mtime);  const c = sizeControl(sizeLine, e, e.mtime > 0 ? e.mtime : s.mtime, offs); if (auto) c.start(); }
      rows.append(line(t('fileDate'), formatDate(s.mtime)), ...(s.mime ? [line(t('filesKind'), s.mime)] : []), line(t('filesAccess'), [s.readable ? t('filesReadable') : '', s.writable ? t('filesWritable') : t('filesReadOnly')].filter(Boolean).join(' · ')));
      if (!pl) return;
      const m = await import('./filesMore'); await m.richProperties(rows, e, line); await m.archiveProperties(rows, e, line);
    } catch (err) { sizeLine.lastElementChild!.textContent = String((err as Error).message ?? err); }
  };
  const confirmDelete = async (paths: string[]) => {
    const pl = plug(); if (!pl) { if (deskJobs()) deskDelete(paths); return; } if (paths.some(isArc)) { toast(t('arcReadOnly'), 'info'); return; }
    if (prefs.confirmDelete === false) { const m0 = await import('./filesMore'); if (m0.trashOn() && !paths.some((p) => p.includes('/.kurokawa-trash/') || isVirtual(p))) { leaveSel(); try { trashed(await m0.toTrash(paths)); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } return; } }
    const sh = openSheet(t('delete'), t('cancel'));
    sh.body.append(h('p', null, t('filesDeleteAsk', { n: localDigits(paths.length) })), h('p', { class: 'hint', dir: 'auto' }, paths.slice(0, 5).map(baseOf).join(' · ') + (paths.length > 5 ? ' …' : '')));
    const m = await import('./filesMore'); const toBin = m.trashOn() && !paths.some((p) => p.includes('/.kurokawa-trash/') || isVirtual(p));
    sh.body.append(h('p', { class: 'hint' }, toBin ? t('filesDeleteToTrash') : t('filesDeleteForeverHint')));
    // (With the recycle bin on, a second way: gone from the phone at once, the bin passed by.)
    if (toBin) sh.actions.append(h('button', { type: 'button', class: 'btn tonal danger', onclick: () => { sh.close(); leaveSel(); void startJob('delete', paths); } }, icon('trash'), t('filesDeleteForever')));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary danger', onclick: async () => { sh.close(); leaveSel(); if (!toBin) { void startJob('delete', paths); return; } try { trashed(await m.toTrash(paths)); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } } }, icon('trash'), t('delete')));
  };
  /** A computer's delete (its shell's jobs): to the system's recycle bin (asked first unless that is turned off), or —
   *  the second button — deleted for good by a job, with its progress and Cancel. */
  const deskDelete = (paths: string[]) => {
    if (!paths.length) return; if (paths.some(isArc)) { toast(t('arcReadOnly'), 'info'); return; }
    const toBin = async () => {
      leaveSel(); const d = deskJobs(); let moved = 0; const left: string[] = [];
      for (const p of paths) { try { if ((await d!.deletePath!(p)).ok) moved++; else left.push(p); } catch { left.push(p); } }
      void load(); if (left.length) toast(t('filesTrashSystemFailed', { n: localDigits(left.length) }), 'error'); else toast(t('filesMovedToTrash', { n: localDigits(moved) }));
    };
    const canBin = !!deskJobs()?.deletePath;
    if (canBin && prefs.confirmDelete === false) { void toBin(); return; }
    const sh = openSheet(t('delete'), t('cancel'));
    sh.body.append(h('p', null, canBin ? t('filesTrashSystemAsk', { n: localDigits(paths.length) }) : t('filesDeleteAsk', { n: localDigits(paths.length) })), h('p', { class: 'hint', dir: 'auto' }, paths.slice(0, 5).map(baseOf).join(' · ') + (paths.length > 5 ? ' …' : '')), h('p', { class: 'hint' }, canBin ? t('filesTrashSystemHint') : t('filesDeleteForeverHint')));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal danger', onclick: () => { sh.close(); leaveSel(); void startJob('delete', paths); } }, icon('trash'), t('filesDeleteForever')));
    if (canBin) sh.actions.append(h('button', { type: 'button', class: 'btn primary danger', onclick: () => { sh.close(); void toBin(); } }, icon('trash'), t('filesTrashSystem')));
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
  const extractHere = async (e: Entry) => {
    const id = nid('fe'); const dest = parentOf(e.path);
    const job: import('./filesQueue').QJob = { id, kind: 'extract', label: t('filesExtracting', { name: e.name }), what: e.name, from: e.path, to: dest, cancel: () => undefined, save: { op: 'extractHere', paths: [e.path], dest },
      start: async () => { const a = await import('../archives'); const aj = a.extractArchiveJob({ path: e.path, dest, replace: 'ask' as never }); job.cancel = () => void a.cancelArchive(aj.id); watchArchiveJob(aj.id, aj.done, e.name); void aj.done.then(() => Q?.finish(id), () => Q?.finish(id)); return true; } };
    await queued(job);
  };
  const watchArchiveJob = (id: string, done: Promise<unknown>, name: string) => { const el = jobRow(id, t('filesExtracting', { name }), () => void import('../archives').then((m) => m.cancelArchive(id))); done.then(() => { el.remove(); void load(); toast(t('filesExtracted', { name })); }, (err) => { el.remove(); toast(String((err as Error).message ?? err), 'error'); }); };
  const compress = async (paths: string[]) => { const m = await import('./filesMore'); leaveSel(); await m.makeArchiveSheet(paths, at, (id, label, done, cancel) => { const el = jobRow(id, label, cancel); void done.then(() => el.remove(), () => el.remove()); }, () => void load()); };
  const zipSheet = async (paths: string[]) => {
    const { createZip } = await import('../archives'); const sh = openSheet(t('filesZip'), t('cancel'));
    const stem = paths.length === 1 ? baseOf(paths[0]).replace(/\.[^.]+$/, '') : baseOf(at) || 'archive';
    const inp = h('input', { type: 'text', value: `${stem}.zip`, dir: 'auto' }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('fileName')), inp), h('p', { class: 'hint' }, t('filesZipHint', { n: localDigits(paths.length) })));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { const name = inp.value.trim() || `${stem}.zip`; sh.close(); leaveSel(); const out = `${at}/${name.endsWith('.zip') ? name : name + '.zip'}`; const el = jobRow('zip', t('filesZipping', { name }), () => undefined); try { const r = await createZip(out, paths, (p) => { const b = el.querySelector('.files-job-bar i') as HTMLElement | null; if (b && p.total) b.style.width = `${Math.round((p.done / p.total) * 100)}%`; }); el.remove(); if (r.cancelled) return; void load(); toast(t('filesZipped', { name: r.path ? baseOf(r.path) : name })); } catch (err) { el.remove(); toast(String((err as Error).message ?? err), 'error'); } } }, icon('archive'), t('filesZip')));
  };

  // ---- the jobs: copy / move / delete, with their progress, cancel and the question when a name is taken
  if (!stagesSwept) { stagesSwept = true; try { if (localStorage.getItem('kt.files.stages')) void import('./filesVerify').then((m) => { const jb = jobs(); if (jb) m.sweepStages((ps) => jb.filesJob({ id: nid('fq'), op: 'delete', paths: ps })); }); } catch { /* none */ } }
  const me = {};
  const jobRow = (id: string, label: string, cancel: () => void): HTMLElement => {
    const el = h('div', { class: 'files-job', 'data-id': id }, h('div', { class: 'grow' }, h('span', { class: 'files-job-label', dir: 'auto' }, label), h('div', { class: 'files-job-bar' }, h('i')), h('small', { class: 'src files-job-meta' })), iconButton('close', t('cancel'), cancel));
    jobsEl.append(el); return el;
  };
  /** A job of this pane's: its row here, and it known as this pane's (the other pane only reads its folder again at the end). */
  const ownRow = (id: string, label: string, cancel: () => void) => { liveJobs.set(id, { owner: gone ? null : me, label, cancel }); return jobRow(id, label, cancel); };
  /** The first names of what a job is about, for the Jobs sheet. */
  const whatOf = (paths: string[]): string => paths.slice(0, 2).map(baseOf).join(', ') + (paths.length > 2 ? ` +${localDigits(paths.length - 2)}` : '');
  /** The queue's view of this page: how jobs run (the setting) and where the engine's events come from. */
  const qhost = { mode: (): 'one' | 'together' => (prefs.jobsMode === 'together' ? 'together' : 'one'), events: () => jobs() as unknown as { addListener(ev: string, fn: (d: never) => void): unknown } | null };
  /** The queue's chunk, and this pane listening to it for the Jobs button's badge. */
  const useQueue = async () => { const m = await import('./filesQueue'); Q = m; if (!offQ && !gone) offQ = m.subscribe(drawJobsBadge); drawJobsBadge(); return m; };
  /** A job given to the queue: it starts at once when it may, else waits its turn (and says so). */
  const queued = async (job: import('./filesQueue').QJob): Promise<boolean> => { const m = await useQueue(); const where = m.enqueue(job, qhost); if (where === 'duplicate') return false; if (where === 'waiting') toast(t('filesJobQueued', { n: localDigits(m.snapshot().waiting.length) })); return true; };
  /** True when the job was asked for: it starts now or waits its turn in the queue (its events come once it starts). */
  const startJob = async (op: 'copy' | 'move' | 'delete', paths: string[], dest?: string, id = nid('fj'), label0?: string): Promise<boolean> => {
    const pl = jobs(); if (!pl) return false;
    // (An archive's entries: taken out, as a copy — an archive is not changed from here, so never deleted or moved out of.)
    if (paths.length && paths.every(isArc)) { if (op === 'delete' || !dest) { toast(t('arcReadOnly'), 'error'); return false; } if (isArc(dest)) { toast(t('arcNoPaste'), 'error'); return false; } void extractEntries(paths, dest); return false; }
    if (dest && isArc(dest)) { toast(t('arcNoPaste'), 'error'); return false; }
    const srcV = paths.some(isVirtual), dstV = !!dest && isVirtual(dest);
    if (op === 'delete' && srcV) { const dirs = paths.filter((p) => entries.find((e) => e.path === p)?.dir); try { await vfs.delete(paths, dirs); toast(t('filesDeleted', { n: localDigits(paths.length) })); void load(); } catch (err) { toast(friendlyVfs(String((err as Error).message ?? err)), 'error'); } return false; }
    if ((srcV || dstV) && op !== 'delete' && srcV && dstV) { toast(t('remoteNoBetween'), 'error'); return false; }
    // (An extraction's move into place is a part of the extraction's own place in the queue.)
    if (stagings.has(id)) return launchJob(op, paths, dest, id, label0);
    const remote = (srcV || dstV) && op !== 'delete'; const n = countItems(paths.length);
    const label = label0 ?? (remote ? (srcV ? t('remoteDownloading', { n }) : t('remoteUploading', { n })) : op === 'delete' ? t('filesDeleting', { n }) : op === 'move' ? t('filesMoving', { n }) : t('filesCopying', { n }));
    const dropped = () => { const c = clipboard; if (c?.busy === id) setClip({ op: 'move', paths: c.paths }); };
    const job: import('./filesQueue').QJob = { id, kind: remote ? 'remote' : op, label, what: whatOf(paths), from: parentOf(paths[0]), to: dest, cancel: () => liveJobs.get(id)?.cancel(), dropped,
      ...(!remote && !label0 && op !== 'delete' && dest ? { save: { op, paths, dest } } : {}),
      start: async () => { const ok = await launchJob(op, paths, dest, id, label0); if (!ok) dropped(); return ok; } };
    return queued(job);
  };
  /** The job itself, started now (what the queue calls when its turn comes). True when it was started. */
  const launchJob = async (op: 'copy' | 'move' | 'delete', paths: string[], dest?: string, id = nid('fj'), label0?: string): Promise<boolean> => {
    const pl = jobs(); if (!pl) return false;
    const srcV = paths.some(isVirtual), dstV = !!dest && isVirtual(dest);
    if ((srcV || dstV) && op !== 'delete') {
      const label = srcV ? t('remoteDownloading', { n: countItems(paths.length) }) : t('remoteUploading', { n: countItems(paths.length) });
      ownRow(id, label, () => void vfs.cancel(id));
      try { await vfs.job(id, srcV ? 'down' : 'up', paths, dest!, op === 'move'); return true; } catch (err) { liveJobs.delete(id); jobsEl.querySelector(`[data-id="${id}"]`)?.remove(); toast(friendlyVfs(String((err as Error).message ?? err)), 'error'); return false; }
    }
    if (op !== 'delete' && dest && !stagings.has(id)) {
      if (prefs.verify === 'full' && hashOf()) { const how = fullPlan(op, paths, dest); if (how === 'run') return verifiedJob(op, paths, dest, id, label0); if (how === 'rename') renamedMoves.add(id); }
      sizeChecked.add(id);
    }
    const label = label0 ?? (op === 'delete' ? t('filesDeleting', { n: countItems(paths.length) }) : op === 'move' ? t('filesMoving', { n: countItems(paths.length) }) : t('filesCopying', { n: countItems(paths.length) }));
    ownRow(id, label, () => void pl.filesCancel({ id }));
    try { await pl.filesJob({ id, op, paths, dest, conflict: 'ask' }); if (plug()) liveNote(id, { label, kind: op, from: parentOf(paths[0] ?? ''), to: dest, what: whatOf(paths) }); return true; } catch (err) { liveJobs.delete(id); jobsEl.querySelector(`[data-id="${id}"]`)?.remove(); toast(String((err as Error).message ?? err), 'error'); return false; }
  };
  // ---- «Verify after copying»: the Full check (views/filesVerify.ts)
  const rootOf = (p: string): string => roots.filter((r) => p === r.path || p.startsWith(r.path.replace(/\/+$/, '') + '/')).sort((a, b) => a.path.length - b.path.length)[0]?.path ?? '';  // (the shortest: the storage itself — the app's folder lies inside the phone's)
  /** run: copied through a stage and checked; rename: a move inside one storage (nothing is copied); plain: not checkable here
   *  (two items of one name, a link, a remote or an archive) — the engine's size check then. */
  const fullPlan = (op: 'copy' | 'move', paths: string[], dest: string): 'run' | 'rename' | 'plain' => {
    if (paths.some(isVirtual) || paths.some(isArc) || isVirtual(dest) || isArc(dest) || !fsx()) return 'plain';
    if (new Set(paths.map(baseOf)).size !== paths.length) return 'plain';
    if (op === 'move') { const d = rootOf(dest); if (d && paths.every((x) => rootOf(x) === d)) return 'rename'; }
    return 'run';
  };
  const listAll = async (dir: string): Promise<Entry[]> => { const pp = plug(); if (pp) return (await pp.filesList({ path: dir, hidden: true })).entries; const d = desk(); return d?.listDir ? ((await d.listDir(dir)).entries ?? []) : []; };
  const verifiedJob = async (op: 'copy' | 'move', paths: string[], dest: string, id: string, label0?: string): Promise<boolean> => {
    const pl = jobs(); const fx = fsx(); const hash = hashOf(); if (!pl || !fx || !hash) return false;
    const label = label0 ?? (op === 'move' ? t('filesMoving', { n: countItems(paths.length) }) : t('filesCopying', { n: countItems(paths.length) }));
    let run: { cancel(): void; done: Promise<import('./filesVerify').VerifyEnd> } | null = null; let stop = false;
    ownRow(id, label, () => { stop = true; run?.cancel(); });
    const mod = await import('./filesVerify'); if (stop) { liveJobs.delete(id); jobsEl.querySelector(`[data-id="${id}"]`)?.remove(); return false; }
    const bar = (pct: number, meta: string) => { Q?.progress(id, pct, meta); const el = jobsEl.querySelector(`[data-id="${id}"]`); if (!el) return; (el.querySelector('.files-job-bar i') as HTMLElement).style.width = `${pct}%`; (el.querySelector('.files-job-meta') as HTMLElement).textContent = meta; };
    const stage = `${dest.replace(/\/+$/, '')}/${STAGE}v-${id}`;
    run = mod.runVerified({
      start: async (sid, sop, sp, sd, conflict, on) => { subJobs.set(sid, (ev) => { on(ev); if (ev.status !== 'progress' && ev.status !== 'conflict') subJobs.delete(sid); }); try { await pl.filesJob({ id: sid, op: sop, paths: sp, dest: sd, conflict }); } catch (e) { subJobs.delete(sid); throw e; } },
      cancelSub: (sid) => void pl.filesCancel({ id: sid }), ask: (ev) => conflictSheet(ev as JobEvent),
      list: listAll, mkdir: async (p) => { await fx.filesMkdir({ path: p }); }, hash,
      progress: bar,
      words: { copying: (n) => t('filesVerifyCopying', { name: n }), checking: (n, i, c) => t('filesVerifyChecking', { name: n, i: localDigits(i), n: localDigits(c) }), placing: t('filesVerifyPlacing'), mismatch: (n) => t('filesVerifyMismatch', { name: n }), kept: (n) => t('filesVerifyKept', { name: n }) },
    }, { id, op, paths, dest, stage });
    void run.done.then((r) => { subJobs.delete(id); onJob({ id, status: r.status, files: r.files, done: r.files, total: r.files, failed: r.failed, skipped: r.skipped, verified: r.verified, mismatch: r.mismatch, ...(op === 'move' ? { left: r.left, remaining: r.remaining } : {}) } as JobEvent); });
    return true;
  };
  // ---- Compare two files; Find duplicate files (views/filesCompare.ts, filesDups.ts)
  const fileHost = (): import('./filesCompare').FileHost | null => {
    const hash = hashOf(); if (!hash || isVirtual(at) || isArc(at)) return null;
    const kp = ktPlugin() as unknown as { uriRead?(o: { path: string; max: number; offset?: number }): Promise<{ b64: string }> } | null; const d = window.kurokawaTools as unknown as { readFile?(p: string): Promise<ArrayBuffer> } | undefined;
    return { list: listAll, hash,
      ...(kp?.uriRead ? { read: async (path: string, offset: number, max: number) => { const r = await kp.uriRead!({ path, max, offset }); const { fromB64 } = await import('./textCodec'); return typeof r?.b64 === 'string' ? fromB64(r.b64) : null; } } : {}),
      ...(d?.readFile ? { readSmall: async (path: string) => new Uint8Array(await d.readFile!(path)) } : {}) };
  };
  const comparePair = (): [Entry, Entry] | null => { if (picked.size !== 2 || !fileHost()) return null; const two = [...picked].map((x) => entries.find((e) => e.path === x)); return two[0] && two[1] && !two[0].dir && !two[1].dir ? [two[0], two[1]] : null; };
  const runCompare = (pair: [Entry, Entry]) => { const host = fileHost(); if (!host) return; leaveSel(); void import('./filesCompare').then((m) => m.compareSheet(pair[0], pair[1], host)); };
  const findDups = () => { const host = fileHost(); if (!host) return; void import('./filesDups').then((m) => m.dupSheet(at, host, (ps) => void confirmDelete(ps))); };
  /** Why the clipboard cannot be pasted here (said on the bar, its Paste greyed), or null when it can. */
  const pasteBlock = (): string | null => {
    const c = clipboard; if (!c) return null;
    if (c.busy) return t('filesPasteBusy');
    if (clipGone === 'all') return t('filesClipAllGone');
    if (!at || collection || isApps(at)) return t('filesPasteNoFolder');
    if (isArc(at)) return t('arcNoPaste');
    if (writable === false) return t('filesPasteReadOnly');
    if (intoItself(c.paths, at)) return t('filesIntoItself');
    if (c.op === 'move' && c.paths.every((p) => parentOf(p) === at)) return t('filesPasteSameFolder');
    if (c.paths.some(isVirtual) && !c.paths.every(isArc) && isVirtual(at)) return t('remoteNoBetween');
    return null;
  };
  /** Which of `paths` are no longer there (the storage says so; an unknown answer counts as there: the job tells). */
  const gonePaths = async (paths: string[]): Promise<string[]> => {
    const fx = fsx(); if (!fx) return []; const out: string[] = [];
    for (const p of paths.slice(0, 200)) { if (isArc(p) || isVirtual(p)) continue; try { const r = await fx.filesStat({ path: p, shallow: true } as never); if (r && r.exists === false) out.push(p); } catch { /* unknown */ } }
    return out;
  };
  const canPaste = (): boolean => !!clipboard && canJobs() && !pasteBlock();
  // (Whether this folder takes new files: asked of the phone once per folder — its own facts, not its contents.)
  let writable: boolean | null = null;
  const checkWritable = async () => {
    writable = null; const pl = fsx(); const here = at; if (!pl || !here || collection || isVirtual(here) || isApps(here)) return;
    try { const st = await pl.filesStat({ path: here, shallow: true } as never); if (here === at && !gone) { writable = st && st.writable === false ? false : true; drawClip(); } } catch { /* unknown: Paste tries */ }
  };
  /** The clipboard bar: what is on it (the one's name, or how many), copied or to be moved, Paste here and Cancel. */
  const drawClip = () => {
    const c = clipboard; const show = !!c && canJobs() && !pk; clipBar.hidden = !show; if (c) clipBar.dataset.op = c.op; root.classList.toggle('has-clip', show);
    if (!c || !show) { clipBar.replaceChildren(); return; }
    const why = pasteBlock(); const one = c.paths.length === 1; const fromArc = c.paths.every(isArc);
    const what = one ? nameEl(baseOf(c.paths[0]), false, 'files-clip-name') : h('b', { class: 'files-clip-name' }, t('filesClipCount', { n: localDigits(c.paths.length) }));
    const how = c.busy ? t('filesPasteBusy') : clipGone ? t('filesClipSomeGone', { n: localDigits(Number(clipGone)) }) : fromArc ? t('filesClipExtract') : c.op === 'copy' ? t('filesClipCopy') : t('filesClipMove');
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
  let pasting = false;
  const paste = async () => {
    const c = clipboard; if (!c || !canJobs() || pasting) return; pasting = true;
    try { await pasteNow(c); } finally { pasting = false; }
  };
  const pasteNow = async (c: NonNullable<typeof clipboard>) => {
    const why = pasteBlock(); if (why) { toast(why, 'error'); return; }
    if (c.paths.every(isArc)) { await extractEntries(c.paths, at); return; }
    // (Items gone since they were put on the clipboard — moved or deleted elsewhere, or a cut half-moved before the
    // page was ended —: the bar says so, and no job starts; what is still there stays on it for the next Paste.)
    const missing = await gonePaths(c.paths); if (clipboard !== c) return;
    if (missing.length) { const rest = c.paths.filter((p) => !missing.includes(p)); setClip(rest.length ? { op: c.op, paths: rest } : c, rest.length ? String(missing.length) : 'all'); return; }
    if (c.op === 'copy') { await startJob('copy', c.paths, at); return; }
    const id = nid('fj'); setClip({ ...c, busy: id });
    if (!(await startJob('move', c.paths, at, id)) && clipboard?.busy === id) setClip({ op: 'move', paths: c.paths });
  };
  /** An archive's entries taken out into `dest` as a paste does: unpacked (with progress) to a hidden folder there, then
   *  moved in by a job of the phone's — the same question when a name is taken, Cancel, the summary —, the hidden
   *  folder removed at the end, whatever happened. */
  const extractEntries = async (paths: string[], dest: string): Promise<void> => {
    const jb = jobs(); if (!jb || !arcOk() || !paths.length) return;
    const id = nid('fx'); const label = paths.length === 1 ? t('filesExtracting', { name: baseOf(paths[0]) }) : t('filesExtractingN', { n: localDigits(paths.length) });
    const job: import('./filesQueue').QJob = { id, kind: 'extract', label, what: whatOf(paths), from: parseArc(paths[0]).archive, to: dest, cancel: () => undefined, save: { op: 'extract', paths, dest }, start: () => runExtract(paths, dest, id, label, job) };
    await queued(job);
  };
  /** The extraction at its turn: unpacked (cancel = the archive job), then moved in (cancel = the move job). True when the
   *  move was started — its end is the job's end; false when nothing is left to wait for. */
  const runExtract = async (paths: string[], dest: string, id: string, label: string, qj: import('./filesQueue').QJob): Promise<boolean> => {
    const jb = jobs(); if (!jb || !arcOk()) return false; const m = await import('./filesArc'); const a = await import('../archives');
    const stage = `${dest.replace(/\/+$/, '')}/${STAGE}${id}`; let stopped = false; let jobId = '';
    const el = jobRow(id, label, () => { stopped = true; if (jobId) void a.cancelArchive(jobId); }); qj.cancel = () => { stopped = true; if (jobId) void a.cancelArchive(jobId); };
    const dropStage = () => void jb.filesJob({ id: nid('fq'), op: 'delete', paths: [stage] }).catch(() => undefined);
    try {
      const job = m.arcExtract(paths, stage, (pr) => { const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0; const b = el.querySelector('.files-job-bar i') as HTMLElement | null; if (b && pr.total) b.style.width = `${pct}%`; const meta = `${baseOf(pr.file || '')} · ${formatBytes(pr.done)}${pr.total ? ` / ${formatBytes(pr.total)}` : ''}`; (el.querySelector('.files-job-meta') as HTMLElement).textContent = meta; Q?.progress(id, pct, meta); });
      jobId = job.id; await job.done;
    } catch (err) { el.remove(); dropStage(); if (!stopped && !/stopped|cancel/i.test(String((err as Error).message ?? err))) toast(String((err as Error).message ?? err), 'error', 5000); else toast(t('filesCancelled')); return false; }
    el.remove(); if (stopped) { dropStage(); toast(t('filesCancelled')); return false; }
    const moveId = nid('fj'); stagings.set(moveId, stage); Q?.link(moveId, id); qj.cancel = () => void jb.filesCancel({ id: moveId });
    if (!(await launchJob('move', paths.map((p) => `${stage}/${parseArc(p).inner}`), dest, moveId, t('filesExtractingN', { n: localDigits(paths.length) })))) { stagings.delete(moveId); dropStage(); return false; }
    return true;
  };
  /** «Resume» on the unfinished jobs of an earlier run: asked for again, in their order (a delete is never among them). */
  const resumeSaved = (list: import('./filesQueue').Saved[]) => { for (const j of list) { try { const one = j.op === 'extract' ? extractEntries(j.paths, j.dest) : j.op === 'extractHere' ? extractHere({ path: j.paths[0], name: baseOf(j.paths[0]) } as Entry) : startJob(j.op, j.paths, j.dest); void one.catch(() => undefined); } catch { /* a bad entry is dropped, never thrown on */ } } };
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
    if (ends(ev)) Q?.finish(ev.id);
    const subJob = subJobs.get(ev.id); if (subJob) { subJob(ev); return; }
    // (A cut whose move ended — this page's, or one a page Android ended had started —: what the move left stays cut.)
    if (ends(ev)) { const c = clipboard; if (c?.busy === ev.id) { const rest = ev.remaining ?? (ev.status === 'done' && !ev.failed?.length ? [] : c.paths); setClip(rest.length ? { op: 'move', paths: rest } : null); } }
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
    liveNote(ev.id, null);
    // (An archive's entries moved in from their hidden folder: the folder goes, whatever happened.)
    const stage = stagings.get(ev.id); if (stage) { stagings.delete(ev.id); void jobs()?.filesJob({ id: nid('fq'), op: 'delete', paths: [stage] }).catch(() => undefined); }
    if (ev.status === 'done') { if (ev.failed?.length) summarySheet(ev); else if (ev.left) toast(t('filesLeftInPlace', { n: localDigits(ev.left) }), 'info', 5000); else if (ev.skipped) toast(t('filesDoneSkipped', { n: localDigits(ev.skipped) })); else if (renamedMoves.has(ev.id)) toast(t('filesVerifyRenamed'), 'info', 5000); else if (ev.verified !== undefined) toast(t('filesVerifiedDone', { n: localDigits(ev.verified) })); else if (sizeChecked.has(ev.id)) toast(t('filesDoneSizes')); else toast(t('filesDone')); sizeChecked.delete(ev.id); renamedMoves.delete(ev.id); }
    else if (ev.status === 'cancelled') { if (ev.failed?.length) summarySheet(ev); else toast(ev.left ? t('filesCancelledLeft', { n: localDigits(ev.left) }) : t('filesCancelled')); }
    else if (ev.status === 'failed') toast(ev.message ?? t('filesFailed'), 'error');
  };
  /** The end of a job where some items failed: the others went through; what failed, and why, listed. */
  const summarySheet = (ev: JobEvent) => {
    const failed = ev.failed ?? []; const sh = openSheet(t('filesSummaryTitle'), t('close'));
    sh.body.append(h('p', null, joinMeta([t('filesSummaryDone', { n: localDigits(Math.max(0, (ev.files ?? 0) - (ev.skipped ?? 0))) }), ev.skipped ? t('filesSummarySkipped', { n: localDigits(ev.skipped) }) : '', t('filesSummaryFailed', { n: localDigits(failed.length) })])),
      ...(ev.mismatch?.length ? [h('p', { class: 'hint files-verify-note' }, icon('info'), h('span', null, t('filesVerifyMismatchNote', { n: localDigits(ev.mismatch.length) })))] : []),
      h('ul', { class: 'files-failed' }, ...failed.slice(0, 30).map((f) => h('li', { dir: 'auto' }, f))), ...(failed.length > 30 ? [h('p', { class: 'hint' }, '…')] : []));
  };
  const conflictSheet = (ev: JobEvent) => {
    const pl = jobs()!; let answered = false;
    // (Closed unanswered — the button, Escape, the scrim, or another sheet over it —: the job is cancelled, not left waiting.)
    const sh = openSheet(t('filesNameTakenTitle'), t('cancel'), { onClose: () => { if (!answered) void pl.filesCancel({ id: ev.id }); } });
    const name = baseOf(ev.to ?? ''); const all = h('input', { type: 'checkbox' }) as HTMLInputElement;
    sh.body.append(h('p', null, t('filesNameTakenAsk', { name: `\u2068${name}\u2069` })),
      h('div', { class: 'files-compare' }, h('div', null, h('small', { class: 'src' }, t('filesIncoming')), h('span', null, ...(ev.dir ? [t('filesAFolder')] : metaNodes(joinMeta([formatBytes(ev.size ?? 0), ev.mtime ? formatDate(ev.mtime) : '']))))), h('div', null, h('small', { class: 'src' }, t('filesExisting')), h('span', null, ...metaNodes(joinMeta([formatBytes(ev.existingSize ?? 0), ev.existingMtime ? formatDate(ev.existingMtime) : '']))))),
      h('label', { class: 'check-row' }, all, h('span', null, t('filesSameForRest'))), h('p', { class: 'hint' }, t('replaceNoUndo')));   // (undo-redo) said plainly: Replace cannot be taken back
    const answer = (a: string) => { answered = true; sh.close(); void pl.filesAnswer({ id: ev.id, answer: a + (all.checked ? 'All' : '') }); };
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => answer('skip') }, t('skip')), h('button', { type: 'button', class: 'btn tonal', onclick: () => answer('keep') }, t('keepBoth')), h('button', { type: 'button', class: 'btn primary', onclick: () => answer('replace') }, t('replace')));
  };

  // ---- what other apps shared to «Save to device»
  const saveSharedSheet = async () => {
    const pl = plug(); if (!pl) return; const items = readShared(await pl.sharedPending().catch(() => null));
    const sh = openSheet(t('filesSaveToDevice'), t('close'));
    if (!items.length) { sh.body.append(h('p', { class: 'hint' }, t('filesNothingShared'))); return; }
    const off = new Set<string>();   // the rows not ticked
    const list = h('div', { class: 'dest-list' }); const title = sh.el.querySelector('h3');
    const save = h('button', { type: 'button', class: 'btn primary', onclick: () => void doSave() }) as HTMLButtonElement;
    const left = (): typeof items => items.filter((x) => !off.has(x.uri));
    const draw = () => {
      const sel = left();
      list.replaceChildren(...items.map((it) => {
        const on = !off.has(it.uri);
        const flip = () => { if (off.has(it.uri)) off.delete(it.uri); else off.add(it.uri); draw(); };
        const box = h('button', { type: 'button', class: 'files-check shared-pick', role: 'checkbox', 'aria-checked': String(on), 'aria-label': `\u2068${it.name}\u2069`, 'data-on': String(on), onclick: (e: Event) => { e.stopPropagation(); flip(); } }, icon(on ? 'check' : 'circle'));
        const del = iconButton('close', t('sharedRowRemove'), (e) => {
          e.stopPropagation(); const at0 = items.indexOf(it); items.splice(at0, 1); const was = off.delete(it.uri); draw();
          void import('../ui/undo').then((u) => u.offerUndo(t('sharedDiscarded', { n: localDigits(1) }), () => { items.splice(Math.min(at0, items.length), 0, it); if (was) off.add(it.uri); if (sh.el.isConnected) draw(); }, undefined, { commit: () => pl.sharedDrop?.({ uris: [it.uri] }) }));
        }); del.classList.add('shared-del');
        return h('div', { class: 'dest-row shared-row' + (on ? '' : ' off'), onclick: flip }, box, icon(ICON[kindOfFile(it.name)] ?? 'file'), nameEl(it.name), h('small', { class: 'src shared-size' }, it.size >= 0 ? formatBytes(it.size) : ''), del);
      }));
      if (!items.length) list.append(h('p', { class: 'hint' }, t('filesNothingShared')));
      if (title) title.textContent = t('filesSaveToDeviceN', { n: localDigits(items.length) });
      save.replaceChildren(icon('download'), t(sel.length < items.length ? 'filesSaveHereN' : 'filesSaveHere', { n: localDigits(sel.length) })); save.disabled = !sel.length;
    };
    const doSave = async () => {
      const sel = left(); if (!sel.length) return; sh.close(); const el = jobRow('shared', t('filesSaving', { n: localDigits(sel.length) }), () => undefined);
      try { const res = readSaved(await pl.sharedSave({ dir: at, uris: sel.map((x) => x.uri) })); el.remove(); void load(); toast(res.failed.length ? t('filesSomeFailed', { n: localDigits(res.failed.length), why: res.failed[0] }) : t('filesSavedN', { n: localDigits(res.saved.length) }), res.failed.length ? 'error' : 'info'); } catch (err) { el.remove(); toast(String((err as Error).message ?? err), 'error'); }
    };
    sh.body.append(list, h('p', { class: 'hint', dir: 'ltr' }, at));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); /* (undo-redo) held: cleared for real only once its Undo is over; Undo brings the sheet back */ void import('../ui/undo').then((u) => u.offerUndo(t('sharedDiscarded', { n: localDigits(items.length) }), () => void saveSharedSheet(), undefined, { commit: () => pl.sharedClear() })); } }, t('filesDiscard')), save);
    draw();
  };

  if (pk) {
    // (The picker: who asked and for what, above; Cancel and Select below; nothing that changes files.)
    root.classList.add('picker'); fab.remove(); root.querySelector('.topbar-actions button[data-icon="more"]')?.remove();
    // (× at the start, as the reference pickers: cancels — the asking app gets nothing; the drawer's places are in the storages' row.)
    const x = iconButton('close', t('cancel'), () => pk.cancel()); x.classList.add('pick-close');
    root.querySelector('.topbar button[data-icon="menu"]')?.replaceWith(x);
    const kinds = kindsAsked(pk.req.mimes, { image: t('filesKindImages'), video: t('filesKindVideo'), audio: t('filesKindMusic'), text: t('filesKindDocs') });
    const sub = [pk.req.caller ? t('pickFor', { app: pk.req.caller }) : '', kinds.length ? t('pickKinds', { kinds: kinds.join(document.documentElement.lang === 'ar' ? '، ' : ', ') }) : ''].filter(Boolean).join(' · ');
    (crumbs.parentElement ?? crumbs).before(h('div', { class: 'pick-head' }, icon(pk.req.multiple ? 'copy' : 'file'), h('span', { class: 'grow' }, h('b', null, pk.req.multiple ? t('pickTitleMany') : t('pickTitle')), sub ? h('small', { dir: 'auto' }, sub) : null), ...(pk.req.mimes.length && !pk.req.mimes.includes('*/*') ? [h('label', { class: 'switch-row pick-all' }, h('span', null, t('pickShowAll')), h('input', { type: 'checkbox', onchange: (ev: Event) => { showAll = (ev.target as HTMLInputElement).checked; draw(); } }))] : [])));
    // (D5: the folders picked from lately, a tap away.)
    const rec = pickRecent();
    if (rec.length) (crumbs.parentElement ?? crumbs).before(h('div', { class: 'pick-recent', role: 'group', 'aria-label': t('pickRecent') }, h('span', { class: 'label' }, t('pickRecent')), ...rec.map((d) => h('button', { type: 'button', class: 'chip', title: d, dir: 'auto', onclick: () => go(d) }, icon('folder'), h('bdi', null, d.split('/').pop() || d)))));
    // (Cancel and Add of one width: the pair in a grid whose columns share the wider one's width.)
    root.append(pickNote, h('div', { class: 'pick-bar' + (pk.req.multiple ? '' : ' single'), role: 'toolbar' }, ...(pk.req.multiple ? [pickCount] : [h('span', { class: 'grow' })]), h('span', { class: 'pick-acts' }, h('button', { type: 'button', class: 'btn text', onclick: () => pk.cancel() }, t('cancel')), ...(pk.req.multiple ? [pickGo] : []))));
    drawPick();
  }
  // ---- «Everywhere in my folders» (a computer's Tauri shell): its panel over the folder, loaded on first use
  let ew: import('./filesearch').Everywhere | null = null;
  const everywhere = async () => {
    if (gone || pk) return; if (ew) { ew.focus(); return; }
    const m = await import('./filesearch'); if (gone || ew) return;
    if (selecting) leaveSel(); search.value = ''; query = ''; search.hidden = true;
    ew = m.openEverywhere(root, { open: (e) => void open(e), menu: (e, ev) => itemSheet(e, ev), go: (d) => go(d), filter: () => { search.hidden = false; search.focus(); draw(); }, onClose: () => { ew = null; } });
  };
  // (Ctrl+Shift+F anywhere in the app — ui/backnav.ts — brings this page and asks it here.)
  const onEverywhere = () => { if (root.isConnected && canEverywhere() && po.side !== 'b') void everywhere(); };
  window.addEventListener('kt:filesearch', onEverywhere);
  if ((window as unknown as { __ktFsearch?: number }).__ktFsearch && po.side !== 'b' && !pk) { delete (window as unknown as { __ktFsearch?: number }).__ktFsearch; if (canEverywhere()) void everywhere(); }
  // ---- start
  let sub: { remove(): void } | null = null;
  // (Back after Android ended the page: the clipboard as it was, the folder's scroll; the engine's jobs still running
  // shown again — their rows, the Jobs sheet, a name-taken question they wait on asked again.)
  let restoredBusy = '';
  { const back = !quiet && !pk ? takeResume() : null;
    // (A cut whose move was running stays busy — no second Paste — while the engine still runs that move, and goes
    // when it does not: its items are moved, or half moved. A copy comes back as it was.)
    if (back?.clip && !clipboard && Array.isArray(back.clip.paths) && back.clip.paths.length) { const op = back.clip.op === 'move' ? 'move' : 'copy'; const busy = op === 'move' && typeof back.clip.busy === 'string' ? back.clip.busy : ''; setClip({ op, paths: back.clip.paths.filter((x) => typeof x === 'string'), ...(busy ? { busy } : {}) }); restoredBusy = busy; }
    if (back?.y && back.at === at) scrollMemo.set(at, back.y); }
  const pfl = plug() as unknown as { filesLive?(): Promise<{ jobs?: { id: string; asking?: JobEvent | null }[] }> } | null;
  const dropBusy = (live: { id: string }[]) => { if (restoredBusy && clipboard?.busy === restoredBusy && !live.some((j) => j.id === restoredBusy)) setClip(null); restoredBusy = ''; };
  if (restoredBusy && !pfl?.filesLive) dropBusy([]);
  if (!quiet && !pk && pfl?.filesLive) void pfl.filesLive().then(async (r) => {
    const live = Array.isArray(r?.jobs) ? r.jobs : []; const notes = liveNotes(); dropBusy(live);
    for (const id of Object.keys(notes)) if (!live.some((j) => j.id === id)) liveNote(id, null);
    for (const j of live) {
      const n = notes[j.id]; if (gone || !n || liveJobs.has(j.id)) continue;
      const cancel = () => void jobs()?.filesCancel({ id: j.id }); liveJobs.set(j.id, { owner: me, label: n.label, cancel }); jobRow(j.id, n.label, cancel);
      (await useQueue()).adopt({ id: j.id, kind: n.kind, label: n.label, what: n.what, from: n.from, to: n.to, cancel, start: async () => true }, qhost);
      if (j.asking && !gone) conflictSheet({ ...j.asking, id: j.id, status: 'conflict' });
    }
  }).catch(() => dropBusy([]));
  const jp = jobs(); if (jp) void listen<JobEvent>(jp as never, 'files', onJob).then((s) => { sub = s as { remove(): void }; });
  // (The queue: another pane's jobs show here too; jobs an earlier run left waiting are offered — never run — once per start.)
  if (Q) { offQ = Q.subscribe(drawJobsBadge); drawJobsBadge(); }
  // (Offered again at the next page until the user has answered: «queueOffered» is set by the answer, not by the offer.)
  if (!quiet && !pk && canJobs() && !queueOffered) { try { if (localStorage.getItem('kt.files.queue') || localStorage.getItem('kt.files.queue.unfinished')) void useQueue().then((m) => { if (!gone && !queueOffered) offUnfinished = m.offerUnfinished(resumeSaved, () => { queueOffered = true; }); }); } catch { /* none */ } }
  const pl = plug(); if (pl) void import('./filesMore').then((m) => m.pruneTrash());
  listEl.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner small' })));
  void (async () => { try { await loadRoots(); } catch { /* the storages' row stays as it is */ } drawKinds(); if (gone) return; if (!at && !collection) { status.textContent = t('filesNoStorage'); return; } await load(); if (route.save) void saveSharedSheet(); if (!pk && po.side !== 'b' && localStorage.getItem('kt.files.renamejob')) void import('./filesBatchUi').then((m) => m.interruptedBanner(batchHost([]), body)); })();
  let wake: { release(): Promise<void> } | null = null;
  if (prefs.keepOn) void (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => undefined);
  // Back (the phone's, a mouse's, Alt+←, the arrow in the bar): the open sheet or viewer closes first (the app's back
  // stack does that), then the selection or the filter, then up a folder at a time to the top of Files, and only then
  // Files is left — for the place the reader came from, not always the downloads.
  // (Two panes side by side: the keys go to the pane last clicked in or focused — F6, Tab —, ringed; never by hover.)
  const isMine = (): boolean => (activePane ? activePane === me : po.side !== 'b');
  const markActive = () => { if (activePane === me) return; activePane = me; for (const f of paneWatch) f(); };
  const drawActive = () => root.classList.toggle('pane-active', !!po.peer?.() && isMine()); paneWatch.add(drawActive); drawActive();
  root.addEventListener('pointerdown', markActive, true); root.addEventListener('focusin', markActive);
  const unBack = onBackStep(() => {
    if (gone || !root.isConnected) return false;
    if (po.peer?.() && !isMine()) return false;
    // (Opened by another app and still where it began: Back hands back to that app.)
    if (po.handedIn && at === po.handedIn.start && !selecting && search.hidden && !collection) { po.handedIn.leave(); return true; }
    if (backStep()) return true;
    // (A picker at its top: Back is «Cancel» — the asking app gets nothing.)
    if (pk) { pk.cancel(); return true; }
    if (po.embedded && po.side === 'b') return false;
    // (Its top: the dispatcher's own way out — to the tab the reader came from, else the downloads; never round.)
    return false;
  }, 'drill', 'files');
  // A computer's keys, as a file manager's: Ctrl+A all, Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste, Delete to the
  // bin, F2 rename the one chosen, Ctrl+F filter this folder, Alt+↑ (or Backspace) the folder above, Escape let go.
  const onKeys = (ev: KeyboardEvent) => {
    if (!root.isConnected || document.querySelector('.sheet') || !document.documentElement.classList.contains('pc')) return;
    const el = ev.target as HTMLElement; if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) { if (ev.key === 'Escape' && el === search) { search.value = ''; query = ''; search.hidden = true; draw(); } return; }
    // (Only the pane last clicked in, when two are side by side.)
    if (po.peer?.() && !isMine()) return; drawActive();
    const mod = ev.ctrlKey || ev.metaKey; const k = ev.key.toLowerCase();
    const one = picked.size === 1 ? entries.find((e) => e.path === [...picked][0]) : undefined;
    if (pcCtl?.key(ev)) return;
    if (mod && k === 'a') { ev.preventDefault(); selecting = true; for (const e of shown()) picked.add(e.path); applySel(); drawSel(); }
    else if (mod && (k === 'c' || k === 'x') && picked.size && canJobs()) { ev.preventDefault(); copyPicked(k === 'c' ? 'copy' : 'move'); }
    else if (mod && k === 'v' && clipboard && canJobs()) { ev.preventDefault(); void paste(); }
    else if (mod && k === 'f' && !(ev.shiftKey && canEverywhere())) { ev.preventDefault(); search.hidden = false; search.focus(); }
    else if (ev.key === 'Delete' && picked.size) { ev.preventDefault(); void confirmDelete([...picked]); }
    else if (ev.key === 'F2' && one) { ev.preventDefault(); renameSheet(one); }
    else if (ev.key === 'F2' && picked.size > 1) { ev.preventDefault(); void batchRename(); }
    else if (ev.key === 'Escape' && selecting) { ev.preventDefault(); leaveSel(); }
    else if (ev.key === 'Escape' && clipboard && !clipboard.busy) { ev.preventDefault(); setClip(null); }
    else if ((ev.altKey && ev.key === 'ArrowUp') || (ev.key === 'Backspace' && !mod)) { const up = collection ? null : upOf(at); if (up) { ev.preventDefault(); goUp(up); } }
  };
  window.addEventListener('keydown', onKeys);
  const onScrollKeep = () => { if (!quiet && !collection && root.isConnected && shownAt === at) keepResume({ at, y: scrollNow() }); };
  window.addEventListener('scroll', onScrollKeep, { passive: true }); body.addEventListener('scroll', onScrollKeep, { passive: true });
  const unSwipe = swipeToOpen(root, () => drawer());
  // (Pulled down at the top: the folder read again — what another app changed shows.)
  const unPull = po.embedded ? () => undefined : pullToRefresh(root, () => load(), { scroller: () => body });
  root.dispose = () => { if (pk && pageView) { prefs.view = pageView; pageView = null; } pcCtl?.dispose(); pcCtl = null; pcObs.disconnect(); stopSub?.(); stopSub = null; window.visualViewport?.removeEventListener('resize', onVv); keepScroll(); gone = true; cntReset(); dragOff?.(); document.documentElement.classList.remove('files-selecting'); offPath(); mqW.removeEventListener('change', onMqW); clearTimeout(mqT); watchSelBar(false); clipWatch.delete(drawPaste); paneWatch.delete(drawActive); for (const r of liveJobs.values()) if (r.owner === me) r.owner = null; unSwipe(); unPull(); for (const [ev, fn] of [['touchstart', onTouchStart], ['touchmove', onTouchMove], ['touchend', onTouchEnd], ['touchcancel', onTouchEnd], ['wheel', onWheel]] as const) listEl.removeEventListener(ev, fn as EventListener); fast?.dispose(); fast = null; moreIo?.disconnect(); chunkIo?.disconnect(); dropThumbs(listEl); sub?.remove(); offQ?.(); offQ = null; offUnfinished?.(); unBack(); window.removeEventListener('keydown', onKeys); window.removeEventListener('scroll', onScrollKeep); body.removeEventListener('scroll', onScrollKeep); window.removeEventListener('kt:filesearch', onEverywhere); ew?.dispose(); ew = null; void wake?.release().catch(() => undefined); };
  /** What the computer's file manager (views/filesPc.ts) may reach of this pane. */
  const pcHost = (): import('./filesPc').PcHost => ({
    root, body, listEl, side: po.side, dual: !!po.embedded, peer: () => po.peer?.() ?? null,
    at: () => at, go: (p, how = 'push') => go(p, how), goUp: () => { const up = upOf(at); if (up) goUp(up); }, upOf: () => (collection ? null : upOf(at)), load: () => void load(), roots: () => roots,
    shown, entries: () => entries, picked, setSel: (ps) => { picked.clear(); for (const x of ps) picked.add(x); selecting = picked.size > 0; applySel(); drawSel(); },
    open: (e) => void open(e), itemMenu: (e, ev) => itemSheet(e, ev), rowOf: (p) => rowEls.get(p)?.el, redraw: () => draw(window.scrollY),
    ensure: (p) => { let el = rowEls.get(p)?.el; if (!el?.isConnected) { draw(0, p); el = rowEls.get(p)?.el; } el?.scrollIntoView({ block: 'nearest' }); el?.focus({ preventScroll: true }); },
    listDir: async (p) => { const r = await listDir(p); return { exists: r.exists, entries: sane(r.entries) }; },
    stat: async (p) => { const fx = fsx(); if (!fx || isVirtual(p)) return null; try { const r = await fx.filesStat({ path: p }); return { exists: r.exists !== false, dir: !!r.dir }; } catch { return null; } },
    rename: async (dir, from, to) => { await renameOne(dir, from, to); }, err: fsErr,
    del: (ps) => void confirmDelete(ps),
    forever: (ps) => { if (ps.some(isArc)) { toast(t('arcReadOnly'), 'info'); return; } const sh = openSheet(t('delete'), t('cancel')); sh.body.append(h('p', null, t('filesDeleteAsk', { n: localDigits(ps.length) })), h('p', { class: 'hint', dir: 'auto' }, ps.slice(0, 5).map(baseOf).join(' · ') + (ps.length > 5 ? ' …' : '')));
      sh.actions.append(h('button', { type: 'button', class: 'btn primary danger', onclick: () => { sh.close(); leaveSel(); void startJob('delete', ps); } }, icon('trash'), t('filesDeleteForever'))); },
    paste: () => void paste(), hasClip: () => canPaste(), newFolder: () => newFolderSheet(), props: (e) => void propertiesSheet(e),
    filterShut: () => { if (search.hidden) return false; search.value = ''; query = ''; search.hidden = true; draw(); return true; },
    setView: (v) => { prefs.view = v; savePrefs(); applyView(); po.peer?.()?.restyle(); },
  });
  const pane = root as unknown as Pane; pane.focusPc = () => pcCtl?.focus();
  pane.pathNow = () => at; pane.reload = () => { if (!gone) draw(); }; pane.restyle = () => { if (!gone) applyView(); };
  pane.dropIn = async (op, paths) => { if (!at || collection) { toast(t('filesNoStorage'), 'error'); return; } if (isArc(at)) { toast(t('arcNoPaste'), 'error'); return; } if (intoItself(paths, at)) { toast(t('filesIntoItself'), 'error'); return; } await startJob(paths.every(isArc) ? 'copy' : op, paths.filter((p) => parentOf(p) !== at), at); };
  if (po.embedded) {
    root.classList.add('files-pane'); if (po.side) root.dataset.side = po.side;
    body.addEventListener('dragover', (ev) => { if (ev.dataTransfer?.types.includes('text/kt-paths')) { ev.preventDefault(); ev.dataTransfer.dropEffect = ev.shiftKey ? 'move' : 'copy'; body.classList.add('drop-over'); } });
    body.addEventListener('dragleave', () => body.classList.remove('drop-over'));
    body.addEventListener('drop', (ev) => { body.classList.remove('drop-over'); const raw = ev.dataTransfer?.getData('text/kt-paths'); if (!raw) return; ev.preventDefault(); let ps: string[] = []; try { ps = JSON.parse(raw) as string[]; } catch { return; } void pane.dropIn(ev.shiftKey ? 'move' : 'copy', ps); });
  }
  return pane;
}
