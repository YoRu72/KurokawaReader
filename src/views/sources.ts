// Sources — books browsed and fetched from the web, drawn the way Mihon draws its extensions: the sources as
// cards; the repositories of extensions the reader added (LNReader's, Mangayomi's…), each a section of its
// own with its extensions; a source as a shelf of covers with a search box, a filter sheet, chips for its
// shelves and for the tags its results share, more loading as the shelf is scrolled; a book's page with its
// details, its tags, the files to fetch — or, for Shamela and the novels, its chapters, read from the site
// or fetched whole for offline. A bell tells what came: new chapters for the novels of the library, newer
// versions of the extensions.
import { h, icon, iconButton, toast, openSheet, coverColors, pickButton } from '../ui/dom';
import { t, localDigits, getLang, countChapters, countBooks, countVolumes, formatBytes } from '../i18n';
import { navigate, back } from '../router';
import { db, uid, FAV_TAG, type Book, type Folder, type TagDef } from '../db';
import { importFiles } from '../library';
import { setJump } from './reader';
import { SourceError, type Source, type SourceBook, type SourceDetails, type SourceFilter, type FilterValues, type SourceTag, type SourceChapter, type SourceFile } from '../sources/types';
import { archiveSource } from '../sources/archive';
import { shamelaSource, addToLibrary, downloadBook, readBookFile, expandToc, catalogueState, buildCatalogue, isWeb, type ShamelaToc } from '../sources/shamela';
import * as link from '../sources/shamelalink';
import { passChallenge, forgetSite, openSite } from '../sources/http';
import { listRepos, addRepo, removeRepo, refreshRepo, renameRepo, langLabel, KIND_APP, RUNNABLE, cachedVersion, pluginCode, installedItems, installExtension, uninstallExtension, addExtensionByLink, type Repo, type ExtItem } from '../sources/repos';
import { folderSource } from '../sources/folder';
import { schedule, peekLog } from '../sources/peek';
import { SRC_PREFIX, sourceIdOf, extHandle, forgetHandle, findItem, findInLibrary, addNovelToLibrary, readNovelFile, downloadNovel, checkNovel, novelToEpub, type Handle, type WebNovel } from '../sources/ext/source';
import { readStore } from '../sources/ext/sandbox';
import { checkAll, lastReport, pendingCounts, folderNews, onUpdatesChanged, isChecking, askNotifyPermission, type UpdateReport } from '../sources/updates';
import { parseName } from '../sources/folder';
import { onHoldOrContext } from '../ui/tags';

export const SOURCES: Source[] = [archiveSource, shamelaSource];
const sourceById = (id: string) => SOURCES.find((s) => s.id === id);
const path = (src: string, o: { q?: string; shelf?: string; tags?: string[] } = {}) => { const sp = new URLSearchParams(); if (o.q) sp.set('q', o.q); if (o.shelf) sp.set('shelf', o.shelf); if (o.tags?.length) sp.set('tags', o.tags.join('\u0001')); const qs = sp.toString(); return `/sources/${src}${qs ? `?${qs}` : ''}`; };
const bookPath = (src: string, id: string) => `/sources/${src}/book/${encodeURIComponent(id)}`;
const isExt = (id: string) => id.startsWith(SRC_PREFIX);
const shelfLabel = (s: SourceTag) => (s.id === 'popular' ? t('shelfPopular') : s.id === 'latest' ? t('shelfLatest') : s.label);

/* ---------- filters kept per source ---------- */
function filterValues(src: Source): FilterValues {
  const base: FilterValues = {}; for (const f of src.filters()) base[f.id] = f.value;
  try { return { ...base, ...(JSON.parse(localStorage.getItem(`kr.src.${src.id}.filters`) ?? '{}') as FilterValues) }; } catch { return base; }
}
function saveFilters(src: Source, v: FilterValues): void { localStorage.setItem(`kr.src.${src.id}.filters`, JSON.stringify(v)); }

/* ---------- results kept for the way back ---------- */
interface Cached { items: SourceBook[]; page: number; hasMore: boolean; tags: SourceTag[]; title?: string; scroll: number }
const cache = new Map<string, Cached>();

const DIR_PREFIX = 'dir:';
const isDir = (id: string) => id.startsWith(DIR_PREFIX);
/** The source of a web folder the reader added, by its id. */
async function folderSourceFor(srcId: string): Promise<Source> {
  const repo = (await listRepos()).find((r) => r.kind === 'folder' && `${DIR_PREFIX}${r.key}` === srcId);
  if (!repo) throw new SourceError('noRepo', 'parse');
  return folderSource(repo);
}



/** The AniList tracking button of a title on its source (as Mihon has it on an entry's page): for web folders
 *  and the extensions, not for archive.org or Shamela, whose books are no manga or novel entries. It opens the
 *  tracking sheet of the title's book in the library; a title not yet there must be added first. */
function trackButton(srcId: string, bookId: () => Promise<string | undefined>, after: () => void): HTMLElement | null {
  if (srcId === archiveSource.id || srcId === shamelaSource.id) return null;
  const btn = h('button', { type: 'button', class: 'btn tonal src-track' }, icon('globe'), t('tracking')) as HTMLButtonElement;
  const label = async () => { const id = await bookId(); const b = id ? await db.getBook(id) : undefined; btn.replaceChildren(icon('globe'), b?.track ? t('tracked') : t('tracking')); btn.classList.toggle('on', !!b?.track); };
  btn.addEventListener('click', async () => {
    const { anilistOn, linked } = await import('../anilist');
    if (!anilistOn()) { toast(t('trackTurnOn')); navigate('/settings'); return; }
    if (!linked()) { toast(t('anilistLinkFirst')); navigate('/settings'); return; }
    const id = await bookId(); const b = id ? await db.getBook(id) : undefined;
    if (!b) { toast(t('trackAddFirst')); return; }
    const { trackSheet } = await import('../ui/track');
    trackSheet(b, () => { void label(); after(); });
  });
  void label();
  return btn;
}

/** A title copied by a long press (the selection handles stay off it, as in Mihon); the text copied is the
 *  element's own. */
function copyOnHold(el: HTMLElement, text?: () => string): HTMLElement {
  el.classList.add('copy-hold');
  onHoldOrContext(el, () => { const v = (text ? text() : el.textContent ?? '').trim(); if (!v) return; void navigator.clipboard.writeText(v).then(() => toast(t('copiedTitle')), () => toast(t('copyTextFailed'), 'error')); });
  return el;
}

export function sourcesView(srcId?: string, bookId?: string, q?: string, shelf?: string, tags?: string[]): HTMLElement & { dispose?: () => void } {
  if (srcId && isExt(srcId)) return lazy(async () => { const hnd = await extHandle(srcId); return bookId ? detailsView(hnd.source, bookId, hnd) : browseView(hnd.source, q ?? '', shelf, tags ?? [], hnd); }, srcId);
  if (srcId && isDir(srcId)) return lazy(async () => { const src = await folderSourceFor(srcId); return bookId ? detailsView(src, bookId) : browseView(src, q ?? '', shelf, tags ?? []); }, srcId);
  const src = srcId ? sourceById(srcId) : undefined;
  if (src && bookId) return detailsView(src, bookId);
  if (src) return browseView(src, q ?? '', shelf, tags ?? []);
  return hubView();
}

/** A view that comes once an extension is running: a shell with a spinner, then the view — or the error. */
function lazy(make: () => Promise<HTMLElement & { dispose?: () => void }>, srcId: string): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'library-body' }, h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('loadingExtension')));
  const shell = h('div', { class: 'view sources-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/sources')), h('div', { class: 'title' }, t('sources'))), body) as HTMLElement & { dispose?: () => void };
  let inner: (HTMLElement & { dispose?: () => void }) | null = null; let gone = false;
  shell.dispose = () => { gone = true; inner?.dispose?.(); };
  const run = () => make().then((el) => { if (gone) { el.dispose?.(); return; } inner = el; shell.replaceChildren(...Array.from(el.childNodes)); shell.dispose = () => { gone = true; el.dispose?.(); }; }).catch((e) => {
    if (gone) return;
    body.replaceChildren();
    const err = e as SourceError;
    const el = h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon(isDir(srcId) ? 'folder' : 'puzzle')), h('p', null, err instanceof SourceError && err.kind === 'parse' && /noExtension|notRunnable|noRepo/.test(err.message) ? t(err.message === 'notRunnable' ? 'extNotRunnable' : 'extGone') : describe(e)));
    const siteOf = async () => (isDir(srcId) ? (await folderSourceFor(srcId)).site : (await findItem(srcId))?.item.url);
    const again = () => { body.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' }))); forgetHandle(srcId); void run(); };
    el.append(...errorActions(e, () => siteOf().then((u) => u ?? ''), again));
    body.append(el);
  });
  void run();
  return shell;
}

/* ---------- the hub ---------- */
function hubView(): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'library-body sources-hub' });
  const bell = iconButton('bell', t('srcWhatsNew'), () => updatesSheet(() => void drawBell()));
  bell.classList.add('bell-btn');
  const actions = h('div', { class: 'topbar-actions' }, bell, iconButton('plus', t('addRepo'), () => addRepoSheet(() => void drawRepos())));
  const root = h('div', { class: 'view sources-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/settings')), h('div', { class: 'title' }, t('sources')), actions), body) as HTMLElement & { dispose?: () => void };
  const off = onUpdatesChanged(() => void drawBell());
  root.dispose = () => off();
  const drawBell = async () => {
    const c = await pendingCounts().catch(() => ({ chapters: 0, books: 0, extensions: 0, series: 0 }));
    const n = c.books + c.extensions + c.series;
    bell.querySelector('.count')?.remove();
    if (n) bell.append(h('span', { class: 'count' }, localDigits(n)));
    bell.classList.toggle('busy', isChecking());
  };
  void drawBell();
  // The reader's own sources first — the hint and the ways to add one on top when there is none yet — the
  // built-in catalogues after them.
  const reposBox = h('div', { class: 'repos' }); body.append(reposBox);
  const drawRepos = async () => {
    const repos = await listRepos();
    reposBox.replaceChildren();
    if (!repos.length) {
      reposBox.append(h('div', { class: 'repos-empty-box' }, h('p', { class: 'hint repos-empty' }, t('noReposYet')),
        h('div', { class: 'repos-add-row' },
          h('button', { type: 'button', class: 'btn tonal small', onclick: () => addRepoSheet(() => void drawRepos(), 'repo') }, icon('puzzle'), t('addRepoKind')),
          h('button', { type: 'button', class: 'btn tonal small', onclick: () => addRepoSheet(() => void drawRepos(), 'ext') }, icon('plus'), t('addExtKind')),
          h('button', { type: 'button', class: 'btn tonal small', onclick: () => addRepoSheet(() => void drawRepos(), 'folder') }, icon('folder'), t('addFolderKind')))));
      return;
    }
    // (Folders of books apart from the repositories of extensions: two kinds of source, said so.)
    const folders = repos.filter((r) => r.kind === 'folder'); const exts = repos.filter((r) => r.kind !== 'folder');
    if (folders.length) { reposBox.append(h('h3', { class: 'section-title' }, t('webFoldersTitle'))); for (const r of folders) reposBox.append(folderSection(r, () => void drawRepos())); }
    if (exts.length) { reposBox.append(h('h3', { class: 'section-title' }, t('repos'))); for (const r of exts) reposBox.append(repoSection(r, () => void drawRepos())); }
  };
  void drawRepos();
  body.append(h('h3', { class: 'section-title' }, t('catalogsTitle')), h('p', { class: 'hint catalog-hint' }, t('sourcesHint')));
  for (const s of SOURCES) {
    const card = h('article', { class: 'source-card' });
    const head = h('button', { type: 'button', class: 'source-head', onclick: () => navigate(path(s.id)) },
      h('span', { class: 'source-icon' }, icon(s.id === 'archive' ? 'library' : 'books')),
      h('span', { class: 'source-text' }, h('b', { dir: 'auto' }, s.name), h('small', null, s.site.replace(/^https?:\/\//, ''))),
      icon('chevronRight'));
    card.append(head, h('p', { class: 'source-desc', dir: 'auto' }, s.description));
    if (s.id === 'shamela') card.append(shamelaStatus());
    if (s.needsApp && isWeb()) card.append(h('p', { class: 'hint warn' }, t('sourceNeedsApp')));
    body.append(card);
  }
  return root;
}

/** Shamela's two helpers: the sign-in to وصلة الشاملة, and the catalogue of titles kept on the device. */
function shamelaStatus(): HTMLElement {
  const box = h('div', { class: 'source-status' });
  const draw = async () => {
    box.replaceChildren();
    const on = link.isConnected();
    box.append(h('div', { class: 'source-row' },
      icon(on ? 'check' : 'user'),
      h('span', { class: 'grow' }, h('b', null, 'وصلة الشاملة (shamela.link)'), h('small', null, on ? t('shamelaLinkOn') : t('shamelaLinkOff'))),
      on ? h('button', { type: 'button', class: 'btn small', onclick: () => { link.disconnect(); void draw(); } }, t('signOut'))
        : h('button', { type: 'button', class: 'btn small primary', onclick: () => void link.connect().catch((e) => toast(describe(e), 'error')) }, icon('user'), t('signIn'))));
    const st = await catalogueState();
    const row = h('div', { class: 'source-row' });
    const status = h('small', null, st ? t('catalogueState', { n: localDigits(st.books), when: new Date(st.at).toLocaleDateString(getLang() === 'ar' ? 'ar' : undefined) }) : t('catalogueNone'));
    const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
    const btn = h('button', { type: 'button', class: 'btn small' + (st ? '' : ' tonal'), onclick: async () => {
      btn.disabled = true; track.hidden = false; let live = true; const off = () => { live = false; }; window.addEventListener('hashchange', off, { once: true });
      try { const n = await buildCatalogue((d, tot) => { bar.style.width = `${(d / tot) * 100}%`; status.textContent = t('catalogueFetching', { n: localDigits(d), total: localDigits(tot) }); }, () => live); toast(t('catalogueDone', { n: localDigits(n) })); }
      catch (e) { toast(describe(e), 'error'); }
      finally { btn.disabled = false; track.hidden = true; void draw(); }
    } }, icon('download'), st ? t('catalogueUpdate') : t('catalogueFetch'));
    row.append(icon('books'), h('span', { class: 'grow' }, h('b', null, t('catalogue')), status, track), btn);
    box.append(row);
  };
  void draw();
  return box;
}

/* ---------- repositories ---------- */
/** A repo as a parent: its name and app on a head that opens and closes it; under it, the extensions the
 *  reader added from it as children (cards that open), and a button to add more from the repo's list. An
 *  extension added by its own link is a repo of one, shown the same way. */
function repoSection(r: Repo, redraw: () => void): HTMLElement {
  const sec = h('section', { class: 'repo-section repo-tree' });
  const kind = KIND_APP[r.kind];
  const runnable = r.items.filter((i) => i.runnable);
  const mine = installedItems(r).filter((i) => i.runnable);
  const openKey = `kr.repo.open.${r.key}`;
  let open = localStorage.getItem(openKey) !== '0';
  const menu = iconButton('more', t('more'), () => repoMenu(r, redraw));
  const novels = r.items.filter((i) => i.itemType === 'novel').length;
  const stats = r.single ? t('extSingle') : runnable.length ? t('repoTreeStats', { n: localDigits(mine.length), total: localDigits(runnable.length) }) : novels ? t('repoStatsNotRunnable', { n: localDigits(novels), app: kind }) : t('repoStatsOther', { n: localDigits(r.items.length), app: kind });
  const head = h('button', { type: 'button', class: 'source-head repo-head-btn', 'aria-expanded': String(open), onclick: () => { open = !open; localStorage.setItem(openKey, open ? '1' : '0'); head.setAttribute('aria-expanded', String(open)); kids.hidden = !open; } },
    h('span', { class: 'source-icon' }, icon(r.single ? 'puzzle' : 'folder')),
    h('span', { class: 'source-text' }, h('b', { dir: 'auto' }, r.name), h('small', null, `${kind} · ${stats}`)),
    h('span', { class: 'repo-chevron' }, icon('chevronDown')));
  sec.append(h('div', { class: 'repo-head' }, head, menu));
  if (r.error) sec.append(h('p', { class: 'hint warn' }, r.error));
  const kids = h('div', { class: 'repo-kids', hidden: !open });
  if (!runnable.length) kids.append(h('p', { class: 'hint' }, novels ? t('extNotRunnable') : t('repoNoNovels', { app: kind })));
  else {
    const grid = h('div', { class: 'ext-grid' });
    for (const i of mine) grid.append(extCard(r, i, redraw));
    if (mine.length) kids.append(grid); else kids.append(h('p', { class: 'hint' }, t('repoNoneAdded')));
    if (!r.single && runnable.length > mine.length) kids.append(h('button', { type: 'button', class: 'btn tonal small ext-add-btn', onclick: () => extensionPicker(r, redraw) }, icon('plus'), t('addExtensions', { n: localDigits(runnable.length - mine.length) })));
  }
  sec.append(kids);
  return sec;
}
/** The repo's list, to add extensions from: a search box and language chips over its extensions, each with
 *  an «Add» (its code fetched and kept) or a tick. */
function extensionPicker(r: Repo, redraw: () => void): void {
  const sh = openSheet(r.name, t('close'), { stack: true });
  const items = r.items.filter((i) => i.runnable);
  const langs = new Map<string, number>(); for (const i of items) langs.set(langLabel(i.lang), (langs.get(langLabel(i.lang)) ?? 0) + 1);
  let lang = ''; let needle = ''; let changed = false;
  const list = h('div', { class: 'ext-pick-list' });
  const have = new Set(installedItems(r).map((i) => i.id));
  const draw = () => {
    list.replaceChildren();
    const shown = items.filter((i) => (!lang || langLabel(i.lang) === lang) && (!needle || i.name.toLowerCase().includes(needle)));
    for (const i of shown.slice(0, 300)) {
      const [c1, c2] = coverColors(i.name);
      const btn = h('button', { type: 'button', class: 'btn small' + (have.has(i.id) ? ' tonal' : ' primary') }, icon(have.has(i.id) ? 'check' : 'plus'), have.has(i.id) ? t('addedMark') : t('add')) as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        if (have.has(i.id)) return;
        btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner small' }));
        try { await installExtension(r, i); have.add(i.id); changed = true; btn.className = 'btn small tonal'; btn.replaceChildren(icon('check'), t('addedMark')); }
        catch (e) { btn.className = 'btn small primary'; btn.replaceChildren(icon('plus'), t('add')); toast(describe(e), 'error'); }
        finally { btn.disabled = false; }
      });
      list.append(h('div', { class: 'ext-pick-row' },
        h('span', { class: 'ext-icon', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, i.icon ? h('img', { src: i.icon, alt: '', loading: 'lazy', onerror: (e: Event) => (e.target as HTMLElement).remove() }) : icon('puzzle')),
        h('span', { class: 'ext-text grow' }, h('b', { dir: 'auto' }, i.name), h('small', null, `${langLabel(i.lang)} · ${i.version}${i.nsfw ? ' · 18+' : ''}`)),
        btn));
    }
    if (shown.length > 300) list.append(h('p', { class: 'hint' }, t('andMore', { n: localDigits(shown.length - 300) })));
    if (!shown.length) list.append(h('p', { class: 'hint' }, t('noResults')));
  };
  if (langs.size > 1) {
    const chips = h('div', { class: 'folder-chips ext-langs' });
    const all = h('button', { type: 'button', class: 'chip on', onclick: () => { lang = ''; chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); all.classList.add('on'); draw(); } }, h('span', null, t('allShelves')));
    chips.append(all);
    for (const [l, n] of [...langs.entries()].sort((a, b) => b[1] - a[1])) { const c = h('button', { type: 'button', class: 'chip', onclick: () => { lang = l; chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('on')); c.classList.add('on'); draw(); } }, h('span', null, l), h('small', null, ` ${localDigits(n)}`)); chips.append(c); }
    sh.body.append(chips);
  }
  if (items.length > 8) sh.body.append(h('input', { type: 'search', class: 'src-search ext-find', placeholder: t('findExtension'), dir: 'auto', oninput: (e: Event) => { needle = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); } }));
  sh.body.append(list);
  draw();
  void import('../ui/pdftools').then((m) => m.onSheetClosed(sh.el, () => { if (changed) redraw(); }));
}
/** A web folder the reader added: a source card like the built-in ones, opening its root. */
function folderSection(r: Repo, redraw: () => void): HTMLElement {
  const address = r.folder ?? r.url;
  let where = address; try { const u = new URL(address); where = `${u.host}${u.pathname === '/' ? '' : decodeURIComponent(u.pathname).replace(/\/$/, '')}`; } catch { /* as given */ }
  const card = h('article', { class: 'source-card folder-card' });
  const head = h('button', { type: 'button', class: 'source-head', onclick: () => navigate(path(`${DIR_PREFIX}${r.key}`)) },
    h('span', { class: 'source-icon' }, icon('folder')),
    h('span', { class: 'source-text' }, h('b', { dir: 'auto' }, r.name), h('small', { dir: 'ltr' }, where)),
    icon('chevronRight'));
  card.append(h('div', { class: 'repo-head' }, head, iconButton('more', t('more'), () => repoMenu(r, redraw))), h('p', { class: 'source-desc', dir: 'auto' }, t('folderSourceDesc')));
  if (r.error) card.append(h('p', { class: 'hint warn' }, r.error));
  return card;
}
function extCard(r: Repo, i: ExtItem, redraw?: () => void): HTMLElement {
  const [c1, c2] = coverColors(i.name);
  const ic = h('span', { class: 'ext-icon', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, i.icon ? h('img', { src: i.icon, alt: '', loading: 'lazy', onerror: (e: Event) => (e.target as HTMLElement).remove() }) : icon('puzzle'));
  const note = i.runnable ? '' : i.note === 'notNovel' ? t('extNotNovel') : i.note === 'dartExtension' ? t('extDart') : i.note === 'luaExtension' ? t('extLua') : i.note === 'apkExtension' ? t('extApk') : i.note === 'iosModule' ? t('extIos') : t('extNotRunnable');
  const card = h('button', { type: 'button', class: 'ext-card' + (i.runnable ? '' : ' off'), title: note || i.site, onclick: () => { if (i.runnable) navigate(path(sourceIdOf(r, i))); else toast(note, 'info', 3200); } },
    ic, h('span', { class: 'ext-text' }, h('b', { dir: 'auto' }, i.name), h('small', null, `${langLabel(i.lang)} · ${i.version}${i.nsfw ? ' · 18+' : ''}`)),
    i.runnable ? h('span', { class: 'ext-dot', hidden: true }) : null);
  if (i.runnable) void cachedVersion(r, i).then((v) => { if (v && v !== i.version) { const d = card.querySelector('.ext-dot') as HTMLElement; d.hidden = false; d.title = t('extUpdateAvailable', { v: i.version }); } });
  // Held: the extension's own menu — its site, an update when there is one, its removal.
  if (redraw) onHoldOrContext(card, () => {
    const sh = openSheet(i.name, t('close'));
    sh.body.append(h('p', { class: 'hint', dir: 'ltr' }, i.site || i.url));
    const rows = h('div', { class: 'dest-list' });
    void cachedVersion(r, i).then((v) => { if (v && v !== i.version) rows.prepend(h('button', { type: 'button', class: 'dest-row', onclick: async () => { sh.close(); try { await pluginCode(r, i, true); forgetHandle(sourceIdOf(r, i)); toast(t('extUpdated', { name: i.name })); redraw(); } catch (e) { toast(describe(e), 'error'); } } }, icon('download'), h('span', { class: 'name' }, t('update'), ' ', h('small', null, `${v} → ${i.version}`)))); });
    rows.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); navigate(path(sourceIdOf(r, i))); } }, icon('play'), h('span', { class: 'name' }, t('open'))));
    rows.append(h('button', { type: 'button', class: 'dest-row danger', onclick: async () => { if (!confirm(t('removeExtConfirm', { name: i.name }))) return; sh.close(); await uninstallExtension(r, i); forgetHandle(sourceIdOf(r, i)); toast(t('extRemoved')); redraw(); } }, icon('trash'), h('span', { class: 'name' }, t('removeExt'))));
    sh.body.append(rows);
  });
  return card;
}
function repoMenu(r: Repo, redraw: () => void): void {
  const sh = openSheet(r.name, t('close'));
  sh.body.append(h('p', { class: 'hint', dir: 'ltr' }, r.url));
  sh.body.append(h('button', { type: 'button', class: 'btn tonal', onclick: async () => { sh.close(); try { const { updated } = await refreshRepo(r.key); toast(updated.length ? t('repoRefreshedUpdates', { n: localDigits(updated.length) }) : t('repoRefreshed')); } catch (e) { toast(describe(e), 'error'); } redraw(); } }, icon('refresh'), t('repoRefresh')));
  const name = h('input', { type: 'text', value: r.name, dir: 'auto' }) as HTMLInputElement;
  sh.body.append(h('label', { class: 'field' }, h('span', null, t('repoName')), name));
  sh.actions.append(
    h('button', { type: 'button', class: 'btn danger', onclick: async () => { if (!confirm(t('removeRepoConfirm', { name: r.name }))) return; await removeRepo(r.key); sh.close(); redraw(); toast(t('repoRemoved')); } }, icon('trash'), t('removeRepo')),
    h('button', { type: 'button', class: 'btn primary', onclick: async () => { const n = name.value.trim(); if (n && n !== r.name) await renameRepo(r.key, n); sh.close(); redraw(); } }, icon('check'), t('done')));
}
/** The "+" sheet: an address — a repository's (read as an index of whichever app it comes from), one
 *  extension's own code, or a folder of books. */
function addRepoSheet(after: () => void, kind: 'repo' | 'ext' | 'folder' = 'repo'): void {
  const sh = openSheet(t('addRepo'), t('close'));
  const addr = h('input', { type: 'url', placeholder: 'https://github.com/…', inputmode: 'url', autocapitalize: 'off', spellcheck: 'false', dir: 'ltr' }) as HTMLInputElement;
  const status = h('p', { class: 'hint' }, t('addRepoHint'));
  let which = kind;
  const kinds = h('div', { class: 'segmented add-kinds' });
  const drawKinds = () => {
    kinds.replaceChildren(...(['repo', 'ext', 'folder'] as const).map((k) => h('button', { type: 'button', 'aria-pressed': String(k === which), onclick: () => { which = k; drawKinds(); } }, t(k === 'repo' ? 'addRepoKind' : k === 'ext' ? 'addExtKind' : 'addFolderKind'))));
    status.textContent = t(which === 'ext' ? 'addExtHint' : which === 'folder' ? 'addFolderHint' : 'addRepoHint');
    addr.placeholder = which === 'ext' ? 'https://raw.githubusercontent.com/…/plugin.js' : which === 'folder' ? 'https://example.com/books/' : 'https://github.com/…';
  };
  drawKinds();
  sh.body.append(kinds, h('label', { class: 'field' }, h('span', null, t('repoUrl')), addr), status, h('p', { class: 'hint' }, t('reposSupported')));
  const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const given = addr.value.trim(); if (!given) { addr.focus(); return; }
    go.disabled = true; status.textContent = t('readingRepo');
    try {
      if (which === 'ext') {
        const { repo, item, added } = await addExtensionByLink(given);
        if (!added) { status.textContent = t('repoAlreadyAdded', { name: `⁨${repo.name}⁩` }); go.disabled = false; return; }
        sh.close(); after(); toast(t('extAdded', { name: `⁨${item.name}⁩` }), 'info', 4000);
        return;
      }
      const { repo, added } = await addRepo(given);
      if (!added) { status.textContent = t('repoAlreadyAdded', { name: `⁨${repo.name}⁩` }); toast(t('repoAlreadyAdded', { name: `⁨${repo.name}⁩` })); go.disabled = false; return; }
      sh.close(); after();
      const runnable = repo.items.filter((i) => i.runnable).length;
      // (The name kept whole inside a sentence of the other direction.)
      const name = `⁨${repo.name}⁩`;
      toast(repo.kind === 'folder' ? t('folderAdded', { name }) : runnable ? t('repoAdded', { name, n: localDigits(runnable) }) : t('repoAddedNotRunnable', { name, app: KIND_APP[repo.kind] }), 'info', 4000);
      // (A repository just added: its list opens, to pick the extensions wanted from it.)
      if (repo.kind !== 'folder' && runnable) extensionPicker(repo, after);
    } catch (e) {
      const err = e as SourceError;
      const at = err instanceof SourceError ? /^noIndexAt:(\d+):(.*):(https?:.*)$/.exec(err.message) : null;
      status.textContent = at ? t('repoNoIndexAt', { status: at[1], title: at[2] ? t('repoNoIndexTitle', { title: at[2] }) : '' }) : err instanceof SourceError && err.kind === 'parse' ? (err.message === 'badRepoUrl' ? t('repoBadUrl') : err.message === 'noIndex' ? t('repoNoIndex') : err.message === 'notExtension' ? t('notExtension') : describe(e)) : describe(e);
      // (A site whose check wants a person: passed from here, then the address is read again.)
      if (err instanceof SourceError && err.kind === 'cloudflare' && /^https?:\/\//i.test(given) && !sh.body.querySelector('.check-btn')) {
        status.after(h('button', { type: 'button', class: 'btn tonal check-btn', onclick: (ev: Event) => { (ev.currentTarget as HTMLElement).remove(); void passChallenge(given).then(() => go.click()); } }, icon('globe'), t('passCheck')));
      }
      go.disabled = false;
    }
  } }, icon('check'), t('addRepo'));
  sh.actions.append(go);
  addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
  setTimeout(() => addr.focus(), 60);
}

/* ---------- the bell ---------- */
function updatesSheet(after: () => void): void {
  const sh = openSheet(t('srcWhatsNew'), t('close'));
  const body = sh.body;
  const draw = async () => {
    body.replaceChildren();
    const rep = await lastReport();
    const novels = (await db.allBooks()).filter((b) => b.format === 'webnovel' && (b.remote?.newChapters ?? 0) > 0);
    const when = Number(localStorage.getItem('kr.sources.checkedAt') ?? 0);
    const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
    const line = h('small', null, when ? t('srcLastChecked', { when: new Date(when).toLocaleString(getLang() === 'ar' ? 'ar' : undefined) }) : t('neverChecked'));
    const btn = h('button', { type: 'button', class: 'btn tonal', disabled: isChecking() }, icon('refresh'), t('checkNow')) as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      btn.disabled = true; track.hidden = false;
      void askNotifyPermission().catch(() => false);
      try { const r = await checkAll({ quiet: false, notify: false, force: true, onProgress: (d, tot, title) => { bar.style.width = `${tot ? (d / tot) * 100 : 100}%`; line.textContent = t('checkingBook', { title }); } }); toast(r.chapters.length || r.extensions.length || r.volumes?.length ? t('checkFound') : t('checkNothing')); }
      catch (e) { toast(describe(e), 'error'); }
      finally { track.hidden = true; void draw(); after(); }
    });
    body.append(h('div', { class: 'source-row' }, icon('bell'), h('span', { class: 'grow' }, h('b', null, t('srcWhatsNew')), line, track), btn));
    const autoOn = localStorage.getItem('kr.sources.autoCheck') !== 'off';
    body.append(h('label', { class: 'switch-row' }, h('span', null, t('srcAutoCheck')), h('input', { type: 'checkbox', checked: autoOn, onchange: (e: Event) => { localStorage.setItem('kr.sources.autoCheck', (e.target as HTMLInputElement).checked ? 'on' : 'off'); if ((e.target as HTMLInputElement).checked) void askNotifyPermission().catch(() => false); } })));
    body.append(h('label', { class: 'switch-row' }, h('span', null, t('extAutoUpdate')), h('input', { type: 'checkbox', checked: localStorage.getItem('kr.ext.autoUpdate') !== 'off', onchange: (e: Event) => localStorage.setItem('kr.ext.autoUpdate', (e.target as HTMLInputElement).checked ? 'on' : 'off') })));
    if (novels.length) {
      body.append(h('h3', { class: 'section-title' }, t('newChapters')));
      const list = h('ul', { class: 'plain-list' });
      for (const b of novels) list.append(h('li', null, h('button', { type: 'button', onclick: () => { sh.close(); navigate(`/read/${b.id}`); } }, icon('books'), h('span', { class: 'catalog-name' }, h('b', { dir: 'auto' }, b.title), h('small', null, countChapters(b.remote!.newChapters!))), h('span', { class: 'badge new' }, localDigits(b.remote!.newChapters!)))));
      body.append(list);
    }
    if (rep?.extensions.length) {
      body.append(h('h3', { class: 'section-title' }, t('extensionUpdates')));
      const list = h('ul', { class: 'plain-list' });
      for (const u of rep.extensions) {
        const row = h('li', null);
        if (u.done) { row.append(h('span', { class: 'catalog-name grow' }, h('b', { dir: 'auto' }, u.name), h('small', null, `${u.repoName} · ${u.from} → ${u.to} · ${t('extUpdatedAuto')}`)), icon('check')); list.append(row); continue; }
        const upd = h('button', { type: 'button', class: 'btn small primary' }, icon('download'), t('update')) as HTMLButtonElement;
        upd.addEventListener('click', async () => {
          upd.disabled = true;
          try { const repo = (await listRepos()).find((r) => r.key === u.repoKey); const item = repo?.items.find((i) => i.id === u.pluginId); if (!repo || !item) throw new Error(t('extGone')); await pluginCode(repo, item, true); forgetHandle(sourceIdOf(repo, item)); row.remove(); toast(t('extUpdated', { name: u.name })); after(); }
          catch (e) { upd.disabled = false; toast(describe(e), 'error'); }
        });
        row.append(h('span', { class: 'catalog-name grow' }, h('b', { dir: 'auto' }, u.name), h('small', null, `${u.repoName} · ${u.from} → ${u.to}`)), upd);
        list.append(row);
      }
      body.append(list);
    }
    // New volumes of the series followed in the web folders: a row per series, opening its page.
    const vols = await folderNews().catch(() => []);
    if (vols.length) {
      body.append(h('h3', { class: 'section-title' }, t('notifyTitleVolumes')));
      const list = h('ul', { class: 'plain-list' });
      for (const v of vols) list.append(h('li', null, h('button', { type: 'button', onclick: () => { sh.close(); navigate(path(`dir:${v.repoKey}`, { shelf: v.series })); } }, icon('books'), h('span', { class: 'catalog-name' }, h('b', { dir: 'auto' }, v.name), h('small', { dir: 'auto' }, `${v.repoName} · ${countVolumes(v.n)}`)), h('span', { class: 'badge new' }, `+${localDigits(v.n)}`))));
      body.append(list);
    }
    if (rep?.failed.length) body.append(h('p', { class: 'hint warn' }, t('checkFailedSome', { n: localDigits(rep.failed.length), titles: rep.failed.slice(0, 3).map((f) => f.title).join('، ') })));
    if (!novels.length && !rep?.extensions.length && !vols.length) body.append(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('check')), h('p', null, t('nothingNew'))));
  };
  void draw();
}

/* ---------- a web folder: covers, a series, its volumes ---------- */
/** The library's books fetched from a source, by the id of the item each came from. */
async function fromSource(srcId: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const b of await db.allBooks()) if (b.remote?.source === srcId && b.remote.id) m.set(b.remote.id, b.id);
  return m;
}
/** Where a fetched volume goes: no folder made for it (the series shows as one entry in the library); the
 *  reader's tags asked for once per series when the library has any (as Mihon asks for a category), and
 *  remembered for the session — or never, when the reader said so. */
type Placement = { tags?: string[]; deviceOnly?: boolean };
const placements = new Map<string, Placement>();
async function askPlacement(seriesKey: string, seriesName: string): Promise<Placement> {
  const had = placements.get(seriesKey); if (had) return had;
  if (localStorage.getItem('kr.addTagsAsk') === 'off') return {};
  const defs = (await db.getMeta<TagDef[]>('tags')) ?? [];
  const names = [...new Set([...defs.map((d) => d.name), ...(await db.allBooks()).flatMap((b) => b.tags ?? [])])].filter((n) => n !== FAV_TAG);
  return new Promise<Placement>((resolve) => {
    const sh = openSheet(t('addToTags', { name: `\u2068${seriesName}\u2069` }), t('close'));
    const chosen = new Set<string>();
    const chips = h('div', { class: 'folder-chips tag-pick' });
    for (const n of names) chips.append(h('button', { type: 'button', class: 'chip tag', 'aria-pressed': 'false', onclick: (e: Event) => { const c = e.currentTarget as HTMLElement; if (chosen.has(n)) chosen.delete(n); else chosen.add(n); c.classList.toggle('on', chosen.has(n)); c.setAttribute('aria-pressed', String(chosen.has(n))); } }, icon('tag'), h('span', { dir: 'auto' }, n)));
    const never = h('input', { type: 'checkbox' }) as HTMLInputElement;
    sh.body.append(h('p', { class: 'hint' }, t(names.length ? 'addToTagsHint' : 'addToLibraryHint')), chips, h('label', { class: 'switch-row' }, h('span', null, t('addToTagsNever')), never));
    let settled = false;
    const finish = (p: Placement) => { if (settled) return; settled = true; if (never.checked) localStorage.setItem('kr.addTagsAsk', 'off'); placements.set(seriesKey, p); resolve(p); };
    // (Three ways: into the library with the tags ticked, into the library plain, or to the device alone —
    // the file saved to Download and the library left as it is.)
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', title: t('deviceOnlyHint'), onclick: () => { finish({ deviceOnly: true }); sh.close(); } }, icon('download'), t('deviceOnly')));
    if (names.length) sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { finish({}); sh.close(); } }, t('noTag')));
    sh.actions.append(
      h('button', { type: 'button', class: 'btn primary', onclick: () => { finish({ tags: [...chosen] }); sh.close(); } }, icon('check'), names.length ? t('done') : t('addToLibraryBtn')));
    void import('../ui/pdftools').then((m) => m.onSheetClosed(sh.el, () => finish({})));
  });
}
/** One file of a folder into the library, remembered as coming from there (so its row says "Open" after) and
 *  as a volume of its series. */
async function fetchVolume(src: Source, id: string, title: string, file: SourceFile, onProgress: (p: { pct: number; got: number; total: number; speed?: number }) => void, series?: Book['series'], tags?: string[], deviceOnly = false): Promise<Book> {
  // A plain file: the platform's downloader — it goes on when this page is left or the phone is locked, with
  // its speed shown, and the book lands in the library whatever is open then.
  const info = src.downloadInfo?.(file);
  if (info) {
    const { startDownload, onDownloads, downloadOf } = await import('../downloads');
    const off = onDownloads(() => { const d = downloadOf(src.id, id, info.url); if (d && d.state === 'running') onProgress({ pct: d.pct, got: d.got, total: d.total, speed: d.speed }); });
    try { return await startDownload({ url: info.url, headers: info.headers, name: file.name ?? `${title}.${file.ext}`, mime: file.mime, size: file.size, title, then: { srcId: src.id, itemId: id, title, series, tags, deviceOnly } }); }
    finally { off(); }
  }
  const got = await src.fetchFile!({ id, title, tags: [], files: [file] }, file, onProgress);
  if (deviceOnly) { const { downloadBlob } = await import('../ui/share'); downloadBlob(got, got.name); throw new Error('deviceOnly'); }
  const added = await importFiles([got]);
  if (!added.length) throw new Error(t('convertFailed'));
  await db.updateBook(added[0].id, (b) => { b.remote = { source: src.id, id }; if (series) b.series = series; if (tags?.length) b.tags = [...new Set([...(b.tags ?? []), ...tags])]; });
  return added[0];
}
/** A file's contents as a short list — the first entries, the rest behind a button. */
function tocBlock(toc: { label: string; depth: number }[], first = 4): HTMLElement {
  const box = h('div', { class: 'vol-toc' });
  const list = h('ol', { class: 'vol-toc-list' });
  const draw = (all: boolean) => {
    list.replaceChildren(...toc.slice(0, all ? toc.length : first).map((e) => h('li', { dir: 'auto', style: { paddingInlineStart: `${Math.min(e.depth, 4) * 14}px` } }, e.label)));
  };
  draw(false);
  box.append(h('b', { class: 'vol-toc-head' }, `${t('contents')} · ${localDigits(toc.length, 'prose')}`), list);
  if (toc.length > first) {
    let all = false;
    const more = h('button', { type: 'button', class: 'btn small text vol-toc-more' }, t('showAllN', { n: localDigits(toc.length, 'prose') })) as HTMLButtonElement;
    more.addEventListener('click', () => { all = !all; draw(all); more.textContent = all ? t('showLess') : t('showAllN', { n: localDigits(toc.length, 'prose') }); });
    box.append(more);
  }
  return box;
}
type Observe = (el: Element, fn: () => Promise<void>) => void;
const HEAD = '\u0000head';
/** A volume: its cover and contents (read from the file as the row comes near), its size, its button —
 *  "Download", the progress, then "Open" once it is in the library. */
function volumeRow(src: Source, b: SourceBook, lib: Map<string, string>, observe: Observe, rows: Map<string, (bookId: string) => void>): HTMLElement {
  // The editions of the volume (the row's own first): the one in the library shown if there is one.
  const alts = b.alts?.length ? b.alts : [{ label: '', id: b.id, file: b.file! }];
  let cur = alts.find((a) => lib.has(a.id)) ?? alts[0];
  const [c1, c2] = coverColors(b.title);
  const kind = h('span', { class: 'vol-kind' }, b.badge ?? cur.file.label);
  const coverTitle = h('span', { class: 'vol-cover-title', dir: 'auto' }, b.title);
  const cover = h('button', { type: 'button', class: 'vol-cover', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` }, 'aria-label': b.title, onclick: () => navigate(bookPath(src.id, cur.id)) }, coverTitle, kind);
  const sub = h('small', { class: 'vol-sub', dir: 'auto' });
  const extra = h('small', { class: 'vol-meta', dir: 'auto', hidden: true });
  const tocSlot = h('div');
  const actions = h('div', { class: 'vol-actions' });
  const chips = alts.length > 1 ? h('div', { class: 'vol-editions', role: 'tablist' }) : null;
  const openBtn = (bookId: string) => h('button', { type: 'button', class: 'btn primary small', onclick: () => navigate(`/read/${bookId}`) }, icon('play'), t('open'));
  const download = () => {
    const a = cur;
    const dl = h('button', { type: 'button', class: 'btn tonal small' }, icon('download'), h('span', null, t('download'))) as HTMLButtonElement;
    const show = (p: { pct: number; got: number; total: number; speed?: number }) => dl.replaceChildren(icon('download'), h('span', null, p.total ? `${localDigits(p.pct)}%${p.speed ? ` · ${t('perSecond', { n: formatBytes(p.speed) })}` : ''}` : p.got ? formatBytes(p.got) : '…'));
    const go = async () => {
      dl.disabled = true;
      try {
        const place = b.group ? await askPlacement(`${src.id}|${b.group}`, b.group) : {};
        const book = await fetchVolume(src, a.id, b.title, a.file, show, b.group ? { name: b.group, index: b.volume, source: src.id, shelf: b.shelf } : undefined, place.tags, place.deviceOnly);
        lib.set(a.id, book.id); if (cur === a) draw(); rows.get(HEAD)?.(''); toast(t('addedToLibrary'));
      } catch (e) { dl.disabled = false; dl.replaceChildren(icon('download'), h('span', null, t('download'))); if (!/^(cancelled|deviceOnly)$/.test((e as Error)?.message ?? '')) toast(describe(e), 'error'); }
    };
    dl.addEventListener('click', go);
    // (A download of this volume under way from before — the page was left and come back to: followed.)
    void import('../downloads').then(({ downloadOf }) => { const d = downloadOf(src.id, a.id); if (d?.state === 'running') { show(d); void go(); } });
    return dl;
  };
  // (Whoever fetches one of its editions — the series' button — tells the row.)
  for (const a of alts) rows.set(a.id, (bookId) => { lib.set(a.id, bookId); if (cur === a) draw(); });
  let token = 0;
  const draw = () => {
    const f = cur.file;
    sub.textContent = [b.author, !chips && b.description ? b.description : '', f.size !== undefined ? formatBytes(f.size) : '', (b.year ?? '').replace(/[ T]\d{1,2}:\d{2}.*$/, '')].filter(Boolean).join(' · ');
    const have = lib.get(cur.id);
    actions.replaceChildren(have ? openBtn(have) : download());
    if (chips) chips.querySelectorAll('.chip').forEach((c, i) => { c.classList.toggle('on', alts[i] === cur); c.setAttribute('aria-selected', String(alts[i] === cur)); if (lib.has(alts[i].id)) c.classList.add('have'); });
  };
  if (chips) alts.forEach((a) => chips.append(h('button', { type: 'button', class: 'chip small', role: 'tab', onclick: () => { if (cur === a) return; cur = a; draw(); look(); } }, a.label)));
  const row = h('article', { class: 'vol-row' }, cover,
    h('div', { class: 'vol-text' }, copyOnHold(h('b', { class: 'vol-title', dir: 'auto' }, b.title)), sub, chips, extra, actions, tocSlot));
  // (Held: the quick way in — into the library with tags, or to the device.)
  onHoldOrContext(cover, () => void quickAdd(src, { ...b, file: cur.file, id: cur.id }, lib, null, rows));
  draw();
  const fill = (p: { cover?: string; title?: string; author?: string; toc?: { label: string; depth: number }[] }, mine: number) => {
    if (mine !== token) return;
    cover.classList.toggle('has-img', !!p.cover);
    cover.replaceChildren(...(p.cover ? [h('img', { src: p.cover, alt: '' })] : [coverTitle]), kind);
    const line = [p.title && p.title.toLowerCase() !== b.title.toLowerCase() ? p.title : '', p.author].filter(Boolean).join(' — ');
    extra.textContent = line; extra.hidden = !line;
    tocSlot.replaceChildren(...(p.toc?.length ? [tocBlock(p.toc)] : []));
  };
  // Cover and contents of the edition shown — at once when read before in this session (a page come back to
  // keeps its height and its place), else as the row comes near. A PDF (or another format) shows the cover
  // and contents of the volume's EPUB when it has one: a cover picture of its own, not a page drawn.
  const epub = alts.find((a) => a.file.ext === 'epub')?.file ?? (b.coverFile?.ext === 'epub' ? b.coverFile : undefined);
  const look = () => {
    const mine = ++token; const shown: SourceBook = { ...b, id: cur.id, file: cur.file.ext === 'epub' || !epub ? cur.file : epub };
    const now = src.peekNow?.(shown);
    if (now) fill(now, mine);
    else if (src.peek) observe(row, async () => { cover.classList.add('loading'); try { const p = await src.peek!(shown).catch(() => null); if (p) fill(p, mine); } finally { cover.classList.remove('loading'); } });
  };
  look();
  return row;
}
/** The head of a folder of volumes: the first volume's cover, the name, how many and how big, and a button
 *  to fetch them all — into a folder of the library named after the series, skipping those already there. */
/** Indexes being made: one per source, carried on when its page is left and shown again when it comes back. */
interface IndexRun { text: string; done: Promise<void>; on?: (text: string) => void; end?: (ok: boolean, e?: unknown, changed?: boolean) => void }
const indexRuns = new Map<string, IndexRun>();
const autoTried = new Set<string>();
/** Series being fetched whole: one run per series however often its page is opened meanwhile. */
const seriesRuns = new Map<string, { text: string; on?: (text: string) => void; done?: () => void }>();
function seriesHead(src: Source, b: SourceBook, lib: Map<string, string>, observe: Observe, rows: Map<string, (bookId: string) => void>): HTMLElement {
  const files = b.files ?? [];
  const runKey = `${src.id}|${b.id}`;
  const [c1, c2] = coverColors(b.title);
  const cover = h('div', { class: 'series-cover', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, icon('books'));
  const status = h('small', { class: 'series-status', hidden: true });
  // (A volume is in the library when any of its editions is.)
  const has = (i: number) => (b.volumeIds?.[i] ?? [`f:${files[i].id}`]).some((id) => lib.has(id));
  const missing = () => files.filter((_, i) => !has(i));
  const btn = h('button', { type: 'button', class: 'btn primary series-all' }) as HTMLButtonElement;
  const label = () => { const n = missing().length; btn.disabled = !n; btn.className = `${n ? 'btn primary' : 'btn tonal'} series-all`; btn.replaceChildren(icon(n ? 'download' : 'check'), h('span', null, n ? t('downloadAllVolumes', { n: countVolumes(n) }) : t('allInLibrary'))); };
  label();
  // (A volume fetched by its own button leaves one fewer for this one.)
  rows.set(HEAD, () => { if (!btn.disabled || !missing().length) label(); labelNext(); });
  // (A run already going — the page left and opened again — shows its progress here.)
  const attach = (run: { text: string; on?: (text: string) => void; done?: () => void }) => {
    btn.disabled = true; status.hidden = false; status.textContent = run.text;
    run.on = (text) => { status.textContent = text; };
    run.done = () => { status.hidden = true; label(); };
  };
  const going = seriesRuns.get(runKey); if (going) attach(going);
  // The next volume after the last one in the library (a reader going on with the series), a tap away.
  const next = h('button', { type: 'button', class: 'btn tonal series-next', hidden: true }) as HTMLButtonElement;
  const nextOf = () => { let last = -1; files.forEach((_, i) => { if (has(i)) last = i; }); return last >= 0 && last + 1 < files.length && !has(last + 1) ? files[last + 1] : undefined; };
  const labelNext = () => {
    const f = nextOf(); next.hidden = !f || seriesRuns.has(runKey); if (!f) return;
    const v = parseName(f.name ?? f.id);
    next.replaceChildren(icon('download'), h('span', null, t('seriesNext', { title: v.marked && v.num !== undefined ? t('volumeN', { n: localDigits(String(v.num), 'prose') }) : v.base })));
  };
  next.addEventListener('click', async () => {
    const f = nextOf(); if (!f) return;
    next.disabled = true;
    try {
      const id = `f:${f.id}`;
      const place = b.id !== 'a:' ? await askPlacement(`${src.id}|${b.title}`, b.title) : {};
      const book = await fetchVolume(src, id, (f.name ?? f.id).replace(/\.[a-z0-9]{1,5}$/i, ''), f, (p) => { next.replaceChildren(icon('download'), h('span', null, p.total ? `${localDigits(p.pct)}%` : '…')); }, b.id !== 'a:' ? { name: b.title, index: parseName(f.name ?? f.id).num, source: src.id, shelf: b.id.slice(2) } : undefined, place.tags, place.deviceOnly);
      lib.set(id, book.id); rows.get(id)?.(book.id); toast(t('addedToLibrary'));
    } catch (e) { toast(describe(e), 'error'); }
    finally { next.disabled = false; label(); labelNext(); }
  });
  labelNext();
  btn.addEventListener('click', async () => {
    const todo = missing(); if (!todo.length || seriesRuns.has(runKey)) return;
    const run: { text: string; on?: (text: string) => void; done?: () => void } = { text: '' };
    seriesRuns.set(runKey, run); attach(run);
    let done = 0;
    try {
      const place = b.id !== 'a:' ? await askPlacement(`${src.id}|${b.title}`, b.title) : {};
      for (const [i, f] of todo.entries()) {
        const id = `f:${f.id}`;
        if (lib.has(id) || has(files.indexOf(f))) continue;   // (fetched meanwhile, by its own button or another edition)
        const say = (extra: string) => { run.text = `${t('fetchingVolume', { n: localDigits(i + 1), total: localDigits(todo.length) })}${extra ? ` · ${extra}` : ''}`; run.on?.(run.text); };
        say('');
        const book = await fetchVolume(src, id, (f.name ?? f.id).replace(/\.[a-z0-9]{1,5}$/i, ''), f, (p) => say(p.total ? `${localDigits(p.pct)}%${p.speed ? ` · ${t('perSecond', { n: formatBytes(p.speed) })}` : ''}` : p.got ? formatBytes(p.got) : ''), b.id !== 'a:' ? { name: b.title, index: parseName(f.name ?? f.id).num, source: src.id, shelf: b.id.slice(2) } : undefined, place.tags, place.deviceOnly);
        lib.set(id, book.id); rows.get(id)?.(book.id); done++;
      }
      toast(t('volumesAdded', { n: countVolumes(done), folder: `\u2068${b.title}\u2069` }), 'info', 4000);
      seriesRuns.delete(runKey); run.done?.();
    } catch (e) { seriesRuns.delete(runKey); toast(describe(e), 'error'); run.done?.(); status.hidden = false; status.textContent = describe(e); }
  });
  const byline = h('p', { class: 'src-author-line', dir: 'auto', hidden: true });
  const about = h('p', { class: 'series-about clamped', dir: 'auto', hidden: true, title: t('seriesAbout') });
  about.addEventListener('click', () => about.classList.toggle('clamped'));
  const head = h('article', { class: 'series-head' }, cover,
    h('div', { class: 'series-text' },
      copyOnHold(h('h2', { dir: 'auto' }, b.title)),
      byline,
      b.author ? h('p', { class: 'src-author-line', dir: 'auto' }, b.author) : null,
      h('div', { class: 'src-chips' }, ...[b.badge, b.description, ...(b.formats ?? [])].filter(Boolean).map((x) => h('span', { class: 'src-chip' }, x!))),
      h('div', { class: 'series-actions' }, next, btn, trackButton(src.id, async () => { for (const [, id] of lib) return id; return undefined; }, () => undefined)), status));
  // (The cover is the first volume's — its EPUB, else its PDF — the file the series' card on the shelf shows.)
  const v1 = b.coverFile ?? files.find((f) => f.ext === 'epub') ?? files.find((f) => f.ext === 'pdf');
  const v1b: SourceBook | undefined = v1 ? { id: `f:${v1.id}`, title: b.title, file: v1 } : undefined;
  // (The first volume's cover, and its publisher's blurb as the series' — folded to a few lines, a tap opens it.)
  const fill = (p: { cover?: string; description?: string; author?: string } | null | undefined) => {
    if (!p) return;
    if (p.cover) cover.replaceChildren(h('img', { src: p.cover, alt: '' }));
    if (p.author && !byline.textContent) { byline.textContent = p.author; byline.hidden = false; }
    if (p.description && !about.textContent) { about.textContent = p.description; about.hidden = false; }
  };
  const now = v1b ? src.peekNow?.(v1b) : undefined;
  if (now) fill(now);
  else if (v1b && src.peek) observe(head, async () => fill(await src.peek!(v1b).catch(() => null)));
  return h('div', { class: 'series-block' }, head, about);
}

/* ---------- browsing a source ---------- */
function browseView(src: Source, q: string, shelf: string | undefined, tags: string[], hnd?: Handle): HTMLElement & { dispose?: () => void } {
  let filters = filterValues(src);
  const key = `${src.id}|${q}|${shelf ?? ''}|${tags.join(',')}|${JSON.stringify(filters)}`;
  const grid = h('div', { class: 'src-grid' });
  const sentinel = h('div', { class: 'src-more' });
  const status = h('div', { class: 'src-status' });
  const tagRow = h('div', { class: 'folder-chips src-tags', hidden: true });
  const shelfRow = h('div', { class: 'folder-chips src-shelves', hidden: true });
  const input = h('input', { type: 'search', class: 'src-search', placeholder: t('searchSource', { name: src.name }), value: q, dir: 'auto', 'aria-label': t('search') }) as HTMLInputElement;
  // (A search, a shelf, a tag is the same page seen otherwise: it takes the page's place in the history, so
  // the way back leaves the page instead of going through every search made on it.)
  const form = h('form', { class: 'src-search-row', onsubmit: (e: Event) => { e.preventDefault(); navigate(path(src.id, { q: input.value.trim(), shelf, tags }), true); } },
    input, h('button', { type: 'submit', class: 'icon-btn', 'aria-label': t('search') }, icon('search')));
  const titleEl = h('div', { class: 'title' }, h('span', { dir: 'auto' }, src.name));
  const body = h('div', { class: 'library-body src-body' }, form, shelfRow, tagRow, status, grid, sentinel);
  const topActions = h('div', { class: 'topbar-actions' });
  // Search from the top bar wherever the page is scrolled to (as Mihon's search icon): the search row comes
  // back into view and takes the focus.
  topActions.append(iconButton('search', t('search'), () => { body.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(() => { input.focus(); input.select(); }, 250); }));
  if (hnd && (hnd.ln?.pluginSettings || hnd.my?.prefs.length)) topActions.append(iconButton('settings', t('extSettings'), () => extSettingsSheet(hnd)));
  // (The site itself, in the app's browser: a sign-in, a check passed there carries over — as Mihon's WebView.)
  if (/^https?:\/\//i.test(src.site ?? '')) topActions.append(iconButton('globe', t('openInAppBrowser'), () => void openSite(src.site)));
  // (What went wrong with covers and files lately, for a web folder: shown on a long press of the title.)
  if (src.id.startsWith('dir:')) { let hold = 0; const show = () => { const sh = openSheet(t('coverLog'), t('close')); const pre = h('pre', { class: 'cover-log', dir: 'ltr' }, peekLog.length ? peekLog.join('\n') : t('coverLogEmpty')); sh.body.append(h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn small tonal', onclick: () => void navigator.clipboard?.writeText(peekLog.join('\n')).then(() => toast(t('copied'))) }, icon('copy'), t('copySelected'))), pre); }; titleEl.addEventListener('pointerdown', () => { hold = window.setTimeout(show, 700); }); for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) titleEl.addEventListener(ev, () => clearTimeout(hold)); }
  const filterBtn = iconButton('filter', t('filters'), () => filterSheet(src, filters, (v) => { filters = v; saveFilters(src, v); navigate(`${path(src.id, { q, shelf, tags })}${q || shelf || tags.length ? '&' : '?'}v=${Date.now().toString(36)}`, true); }));
  // (How many filters stand away from their defaults, on the icon.)
  { const defs = src.filters(); const changed = defs.filter((d) => { const v = filters[d.id]; if (v === undefined) return false; const dv = d.value; return Array.isArray(dv) ? (v as unknown[]).length > 0 : v !== dv; }).length + tags.length; if (changed) { filterBtn.append(h('span', { class: 'count' }, localDigits(changed))); filterBtn.classList.add('has-count'); } }
  topActions.append(filterBtn);
  const root = h('div', { class: 'view sources-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back(src.id.startsWith('dir:') && !q && shelf ? path(src.id, { shelf: shelf.split('/').slice(0, -1).join('/') || undefined }) : q || shelf || tags.length ? path(src.id) : '/sources')), titleEl, topActions),
    body) as HTMLElement & { dispose?: () => void };
  let gone = false; let page = 0; let hasMore = true; let loading = false; let items: SourceBook[] = []; let allTags: SourceTag[] = [];
  // What a folder's items need: the library's books from this source, the rows to tell when one arrives,
  // and covers and contents read as their cards come near (a few at a time, the ones scrolled past dropped).
  const lib = new Map<string, string>(); const rows = new Map<string, (bookId: string) => void>();
  const lazy = new WeakMap<Element, () => Promise<void>>(); const waiting = new WeakMap<Element, () => void>();
  // (Those on the screen go first; those only near it wait their turn.)
  const lazyIo = new IntersectionObserver((es) => {
    for (const e of es) {
      const fn = lazy.get(e.target); if (!fn) continue;
      if (e.isIntersecting) {
        const r = e.boundingClientRect; const onScreen = r.bottom > 0 && r.top < window.innerHeight;
        if (!waiting.has(e.target)) waiting.set(e.target, schedule(async () => { if (gone || !lazy.has(e.target)) return; lazy.delete(e.target); lazyIo.unobserve(e.target); await fn(); }, onScreen));
      } else { waiting.get(e.target)?.(); waiting.delete(e.target); }
    }
  }, { rootMargin: '600px 0px' });
  const observe: Observe = (el, fn) => { lazy.set(el, fn); lazyIo.observe(el); };
  // (The page scrolls in its body: that is the place kept for the way back.)
  // (A folder shown from the index that the site says has changed since: drawn again, in place.)
  let stale = false;
  const redraw = () => {
    stale = false; cache.delete(key); items = []; page = 0; hasMore = true; const top = body.scrollTop;
    grid.replaceChildren(); void more().then(() => { body.scrollTop = top; });
  };
  const changed = (ev: Event) => {
    const d = (ev as CustomEvent<{ source: string; shelf: string }>).detail;
    if (gone || q || d.source !== src.id || d.shelf !== (shelf ?? '')) return;
    // (While a page is still coming, after it.)
    if (loading) stale = true; else redraw();
  };
  window.addEventListener('kr:shelf-changed', changed);
  root.dispose = () => { gone = true; io.disconnect(); lazyIo.disconnect(); window.removeEventListener('kr:shelf-changed', changed); const c = cache.get(key); if (c) c.scroll = body.scrollTop; };
  // (A web folder's own address, for "Open this folder on the site".)
  const here = src.id.startsWith('dir:') && /^https?:\/\//i.test(src.site ?? '') ? `${src.site.replace(/\/?$/, '/')}${shelf && !shelf.startsWith('::') ? `${shelf.replace(/^\/+|\/+$/g, '')}/` : ''}` : undefined;

  // Shelves (collections, categories, popular/latest) when nothing is searched.
  if (src.shelves) void src.shelves(shelf).then((list) => {
    if (gone || !list.length) return;
    shelfRow.hidden = false;
    if (!hnd) shelfRow.append(h('button', { type: 'button', class: 'chip' + (!shelf ? ' on' : ''), onclick: () => navigate(path(src.id, { q, tags }), true) }, h('span', null, t('allShelves'))));
    for (const s of list) shelfRow.append(h('button', { type: 'button', class: 'chip' + ((shelf ?? (hnd ? 'popular' : '')) === s.id ? ' on' : ''), onclick: () => navigate(path(src.id, { q, shelf: s.id, tags }), true) }, h('span', { dir: 'auto' }, shelfLabel(s)), s.count ? h('small', null, ` ${localDigits(s.count)}`) : null));
    if (shelf && !hnd) { const cur = list.find((s) => s.id === shelf); if (cur) titleEl.replaceChildren(h('span', { dir: 'auto' }, cur.label), h('small', null, src.name)); }
  }).catch(() => undefined);

  // The source's own state (a folder's index): a line with its button, at the top of the source only.
  if (src.status && !q && (!shelf || shelf.startsWith('::'))) {
    const line = h('div', { class: 'src-index' });
    const text = h('small', { class: 'grow', dir: 'auto' });
    line.append(icon('search'), text);
    body.insertBefore(line, status);
    void src.status().then((st) => {
      if (gone || !st) { line.remove(); return; }
      text.textContent = st.text;
      if (!st.action) return;
      const act = st.action;
      const btn = h('button', { type: 'button', class: 'btn small tonal' }, t('indexUpdate')) as HTMLButtonElement;
      btn.textContent = act.label;
      let auto = false;
      const start = () => {
        btn.disabled = true;
        let run = indexRuns.get(src.id);
        if (!run) {
          const r: IndexRun = { text: '', done: Promise.resolve() };
          r.done = act.run((txt) => { r.text = txt; r.on?.(txt); }, () => true, auto).then((changed) => { indexRuns.delete(src.id); r.end?.(true, undefined, changed !== false); }, (e) => { indexRuns.delete(src.id); r.end?.(false, e); });
          indexRuns.set(src.id, r); run = r;
        }
        run.on = (txt) => { text.textContent = txt; };
        run.end = (ok, e, changed) => {
          // (An index made again with nothing new leaves the page as it is: only its line says so.)
          if (ok && !changed) { btn.disabled = false; auto = false; }
          else if (ok) { cache.delete(key); if (!gone) navigate(`${path(src.id, { q, shelf, tags })}${q || shelf || tags.length ? '&' : '?'}v=${Date.now().toString(36)}`, true); }
          else {
            btn.disabled = false; auto = false; text.textContent = (e as SourceError)?.message === 'noSearch' ? t('indexNeedsWalk') : describe(e);
            // (A check in the way: the reader passes it from here, and the index is made at once after.)
            if ((e as SourceError)?.kind === 'cloudflare' && !line.querySelector('.check-btn')) line.append(h('button', { type: 'button', class: 'btn small primary check-btn', onclick: () => void passChallenge(src.site).then(() => { line.querySelector('.check-btn')?.remove(); start(); }) }, t('passCheck')));
          }
        };
        if (run.text) text.textContent = run.text;
      };
      btn.addEventListener('click', () => { auto = false; start(); });
      line.append(btn);
      if (indexRuns.has(src.id) || (st.auto && !autoTried.has(src.id))) { autoTried.add(src.id); auto = true; start(); }
    }).catch(() => line.remove());
  }

  const drawTags = () => {
    const shown = new Map<string, SourceTag>();
    for (const tg of tags) shown.set(tg, { id: tg, label: tg });
    for (const tg of allTags) if (!shown.has(tg.id) && shown.size < 16) shown.set(tg.id, tg);
    tagRow.replaceChildren(); tagRow.hidden = !shown.size;
    for (const tg of shown.values()) {
      const on = tags.includes(tg.id);
      tagRow.append(h('button', { type: 'button', class: 'chip tag' + (on ? ' on' : ''), onclick: () => navigate(path(src.id, { q, shelf, tags: on ? tags.filter((x) => x !== tg.id) : [...tags, tg.id] }), true) }, icon('tag'), h('span', { dir: 'auto' }, tg.label), tg.count ? h('small', null, ` ${localDigits(tg.count)}`) : null));
    }
  };
  const card = (b: SourceBook): HTMLElement => {
    if (b.look === 'volume' && b.file) return volumeRow(src, b, lib, observe, rows);
    if (b.look === 'series') return seriesHead(src, b, lib, observe, rows);
    const [c1, c2] = coverColors(b.title);
    const cover = h('div', { class: 'src-cover' + (b.look ? ` ${b.look}` : ''), style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, b.cover ? coverImg(b.cover, hnd) : b.look === 'folder' ? icon('folder') : h('span', { class: 'src-cover-title', dir: 'auto' }, b.title));
    const el = h('button', { type: 'button', class: 'src-card' + (b.look ? ` ${b.look}` : ''), title: b.title, onclick: () => navigate(b.openShelf !== undefined ? path(src.id, { shelf: b.openShelf }) : bookPath(src.id, b.id)) },
      cover,
      b.badge ? h('span', { class: 'src-badge left' }, b.badge) : null,
      b.lang ? h('span', { class: 'src-badge right' }, b.lang.length > 3 ? b.lang.slice(0, 3) : b.lang.toUpperCase()) : null,
      h('span', { class: 'src-title', dir: 'auto' }, b.title),
      b.author ? h('span', { class: 'src-author', dir: 'auto' }, b.author) : null,
      formatMarks(b.formats),
      b.description && src.id === 'shamela' && q && String(filters.mode) !== 'titles' ? h('span', { class: 'src-snippet', dir: 'auto' }, b.description) : null);
    // Held: added to the library from here, with the tags asked (as Mihon's long press in Browse).
    onHoldOrContext(el, () => void quickAdd(src, b, lib, hnd ?? null, rows));
    // A book already in the library (fetched from here before): marked so, and opened from its card.
    if (b.look !== 'folder' && (lib.has(b.id) || b.alts?.some((a) => lib.has(a.id)))) { el.classList.add('in-library'); cover.append(h('span', { class: 'have-mark' }, icon('check'), t('inLibrary'))); }
    // A folder: its first volume's cover (or its own picture) as it comes near, how many volumes it holds.
    if (b.look === 'folder' && b.openShelf !== undefined && src.folderCover) {
      // (The series' volumes in the library: counted on its card.)
      const mine = [...lib.keys()].filter((k) => k.startsWith(`f:${b.openShelf}/`)).length;
      // (New volumes as they are now: a series seen since the shelf was drawn has none any more.)
      const fresh = src.freshNow?.(b.openShelf) ?? b.fresh ?? 0;
      const freshMark = () => (fresh ? h('span', { class: 'fresh-mark', title: t('notifyTitleVolumes') }, `+${localDigits(fresh)}`) : null);
      if (fresh) cover.append(freshMark()!);
      const fill = (p: { cover?: string; count?: number } | null) => {
        if (p?.cover) { cover.classList.add('has-img'); cover.replaceChildren(h('img', { src: p.cover, alt: '' }), h('span', { class: 'folder-mark' }, icon('folder')), ...(fresh ? [freshMark()!] : [])); }
        if (p?.count && !b.badge) el.append(h('span', { class: 'src-badge left' }, countVolumes(p.count)));
        if (mine) el.append(h('span', { class: 'src-badge right have', title: t('inLibrary') }, icon('check'), p?.count ? `${localDigits(mine)}/${localDigits(p.count)}` : localDigits(mine)));
      };
      const now = src.folderCoverNow?.(b.openShelf);
      if (now) fill(now);
      else observe(el, async () => { cover.classList.add('loading'); try { fill(await src.folderCover!(b.openShelf!).catch(() => null)); } finally { cover.classList.remove('loading'); } });
    }
    return el;
  };
  const more = async () => {
    if (gone || loading || !hasMore) return;
    loading = true; status.textContent = page === 0 ? t('loading') : '';
    try {
      const f: FilterValues = { ...filters, tags };
      const r = await src.browse(q, f, page + 1, shelf ?? (hnd ? 'popular' : undefined));
      if (gone) return;
      page++; hasMore = r.hasMore; items.push(...r.items);
      if (r.tags?.length && page === 1) { allTags = r.tags; drawTags(); }
      if (r.title && page === 1 && (q || !shelf || !src.shelves || src.id.startsWith('dir:'))) titleEl.replaceChildren(h('span', { dir: 'auto' }, r.title), h('small', null, src.name));
      for (const b of r.items) grid.append(card(b));
      if (items.length) status.textContent = '';
      else if (r.empty) status.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('folder')), h('p', { dir: 'auto' }, r.empty.text),
        ...(r.empty.url ? [h('button', { type: 'button', class: 'btn tonal', onclick: () => void openSite(r.empty!.url!) }, icon('globe'), t('openFolderOnSite'))] : [])));
      else status.textContent = t('noResults');
      cache.set(key, { items: [...items], page, hasMore, tags: allTags, title: r.title, scroll: 0 });
      // (A short page leaves the end of the shelf in view: the next one is asked for without a scroll.)
      if (hasMore) requestAnimationFrame(() => { if (!gone && sentinel.getBoundingClientRect().top < window.innerHeight + 600) void more(); });
    } catch (e) {
      if (gone) return;
      showError(status, e, () => { hasMore = true; void more(); }, src, here);
      hasMore = false;
    } finally { loading = false; if (stale && !gone) redraw(); }
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) void more(); }, { rootMargin: '600px' });
  const had = cache.get(key);
  // (A folder's rows know which of its files are in the library before they are drawn.)
  // (What is in the library already, from any source: said on its card, as Mihon marks «In library».)
  const ready = fromSource(src.id).then((m) => { for (const [k, v] of m) lib.set(k, v); }).catch(() => undefined);
  void ready.then(() => { if (!gone) io.observe(sentinel); });
  if (had) void ready.then(() => { if (gone) return; items = [...had.items]; page = had.page; hasMore = had.hasMore; allTags = had.tags; drawTags(); for (const b of items) grid.append(card(b)); if (had.title && (q || !shelf || !src.shelves || src.id.startsWith('dir:'))) titleEl.replaceChildren(h('span', { dir: 'auto' }, had.title), h('small', null, src.name)); requestAnimationFrame(() => { body.scrollTop = had.scroll; }); });
  else void ready.then(() => void more());
  if (src.needsApp && isWeb()) status.replaceChildren(h('p', { class: 'hint warn' }, t('sourceNeedsApp')));
  if (src.id === 'shamela' && q && String(filters.mode) !== 'titles' && !link.isConnected() && (String(filters.mode) === 'chapters' || String(filters.engine) === 'link' || /^(root|wild)$/.test(String(filters.match)))) status.replaceChildren(signInNote());
  return root;
}

/** A cover from a site: loaded as a picture; one the site refuses to a bare request is fetched with the
 *  extension's headers. */
function coverImg(url: string, hnd?: Handle): HTMLElement {
  const img = h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) as HTMLImageElement;
  img.addEventListener('error', () => {
    if (img.dataset.retried || !hnd) { img.remove(); return; }
    img.dataset.retried = '1';
    void import('../sources/http').then(({ fetchBytes }) => fetchBytes(url, undefined, { headers: hnd.ln?.imageRequestInit?.headers ?? hnd.my?.headers ?? { referer: hnd.item.site } })).then((bytes) => { img.src = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer])); }).catch(() => img.remove());
  });
  return img;
}

function signInNote(): HTMLElement {
  return h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('user')), h('p', null, t('shamelaLinkNeeded')),
    h('button', { type: 'button', class: 'btn primary', onclick: () => void link.connect().catch((e) => toast(describe(e), 'error')) }, icon('user'), t('signIn')),
    h('a', { class: 'btn small', href: 'https://shamela.link/register', target: '_blank', rel: 'noopener' }, icon('external'), t('shamelaLinkRegister')));
}

/** The Mihon-like filter sheet: every filter the source offers, applied on «Done». */
function filterSheet(src: Source, current: FilterValues, apply: (v: FilterValues) => void): void {
  const sh = openSheet(t('filters'), t('close'));
  const vals: FilterValues = { ...current };
  const defs = src.filters();
  if (!defs.length) sh.body.append(h('p', { class: 'hint' }, t('noFilters')));
  const row = (f: SourceFilter): HTMLElement => {
    if (f.kind === 'toggle') return h('label', { class: 'switch-row' }, h('span', { dir: 'auto' }, f.label), h('input', { type: 'checkbox', checked: vals[f.id] !== false && vals[f.id] !== undefined ? !!vals[f.id] : f.value, onchange: (e: Event) => { vals[f.id] = (e.target as HTMLInputElement).checked; } }));
    if (f.kind === 'text') return h('label', { class: 'field' }, h('span', { dir: 'auto' }, f.label), h('input', { type: 'text', value: String(vals[f.id] ?? ''), placeholder: f.placeholder ?? '', dir: 'auto', oninput: (e: Event) => { vals[f.id] = (e.target as HTMLInputElement).value; } }));
    if (f.kind === 'multi') return h('div', { class: 'field' }, h('span', { dir: 'auto' }, f.label), h('div', { class: 'folder-chips' }, ...f.options.map((o) => { const on = () => ((vals[f.id] as string[]) ?? []).includes(o.value); const b = h('button', { type: 'button', class: 'chip' + (on() ? ' on' : ''), onclick: () => { const cur = (vals[f.id] as string[]) ?? []; vals[f.id] = on() ? cur.filter((x) => x !== o.value) : [...cur, o.value]; b.classList.toggle('on', on()); } }, h('span', { dir: 'auto' }, o.label)); return b; })));
    const opts = f.options.map((o): [string, string] => [o.value, o.label]);
    return h('div', { class: 'field' }, h('span', { dir: 'auto' }, f.label), pickButton(f.label, opts, String(vals[f.id] ?? f.value), (v) => { vals[f.id] = v; }, t('close')));
  };
  sh.body.append(...defs.map(row));
  sh.actions.append(
    h('button', { type: 'button', class: 'btn', onclick: () => { for (const f of defs) vals[f.id] = f.value; sh.close(); apply(vals); } }, t('resetFilters')),
    h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); apply(vals); } }, icon('check'), t('done')));
}

/** An extension's own settings (a site address to change, a switch…), kept in its storage. */
function extSettingsSheet(hnd: Handle): void {
  const sh = openSheet(t('extSettings'), t('close'));
  const store = readStore(hnd.key);
  const changes: Record<string, unknown> = {};
  const save = (k: string, v: unknown) => { changes[k] = v; };
  if (hnd.ln?.pluginSettings) {
    for (const [k, s] of Object.entries(hnd.ln.pluginSettings)) {
      const cur = (store[k] as { value?: unknown } | undefined)?.value ?? s.value;
      if (s.type === 'Switch') sh.body.append(h('label', { class: 'switch-row' }, h('span', { dir: 'auto' }, s.label), h('input', { type: 'checkbox', checked: !!cur, onchange: (e: Event) => save(k, (e.target as HTMLInputElement).checked) })));
      else if (s.type === 'Select' && s.options) sh.body.append(h('div', { class: 'field' }, h('span', { dir: 'auto' }, s.label), pickButton(s.label, s.options.map((o): [string, string] => [o.value, o.label]), String(cur ?? ''), (v) => save(k, v), t('close'))));
      else if (s.type === 'CheckboxGroup' && s.options) sh.body.append(h('div', { class: 'field' }, h('span', { dir: 'auto' }, s.label), h('div', { class: 'folder-chips' }, ...s.options.map((o) => { const sel = () => ((changes[k] ?? cur ?? []) as string[]).includes(o.value); const b = h('button', { type: 'button', class: 'chip' + (sel() ? ' on' : ''), onclick: () => { const list = (changes[k] ?? cur ?? []) as string[]; save(k, sel() ? list.filter((x) => x !== o.value) : [...list, o.value]); b.classList.toggle('on', sel()); } }, h('span', { dir: 'auto' }, o.label)); return b; }))));
      else sh.body.append(h('label', { class: 'field' }, h('span', { dir: 'auto' }, s.label), h('input', { type: 'text', value: String(cur ?? ''), dir: 'auto', oninput: (e: Event) => save(k, (e.target as HTMLInputElement).value) })));
    }
  } else if (hnd.my) {
    for (const p of hnd.my.prefs as Record<string, unknown>[]) {
      const k = String(p.key ?? ''); if (!k) continue;
      const et = p.editTextPreference as { title?: string; summary?: string; value?: string } | undefined;
      const lp = p.listPreference as { title?: string; summary?: string; entries?: string[]; entryValues?: string[]; valueIndex?: number } | undefined;
      const cb = (p.checkBoxPreference ?? p.switchPreferenceCompat) as { title?: string; summary?: string; value?: boolean } | undefined;
      const ms = p.multiSelectListPreference as { title?: string; entries?: string[]; entryValues?: string[]; values?: string[] } | undefined;
      const cur = store[k];
      if (et) sh.body.append(h('label', { class: 'field' }, h('span', { dir: 'auto' }, et.title ?? k), h('input', { type: 'text', value: String(cur ?? et.value ?? ''), dir: 'auto', oninput: (e: Event) => save(k, (e.target as HTMLInputElement).value) }), et.summary ? h('small', { class: 'hint' }, et.summary) : null));
      else if (lp) { const opts = (lp.entryValues ?? []).map((v, i): [string, string] => [String(v), String(lp.entries?.[i] ?? v)]); sh.body.append(h('div', { class: 'field' }, h('span', { dir: 'auto' }, lp.title ?? k), pickButton(lp.title ?? k, opts, String(cur ?? lp.entryValues?.[lp.valueIndex ?? 0] ?? ''), (v) => save(k, v), t('close')))); }
      else if (cb) sh.body.append(h('label', { class: 'switch-row' }, h('span', { dir: 'auto' }, cb.title ?? k), h('input', { type: 'checkbox', checked: cur === undefined ? !!cb.value : !!cur, onchange: (e: Event) => save(k, (e.target as HTMLInputElement).checked) })));
      else if (ms) sh.body.append(h('div', { class: 'field' }, h('span', { dir: 'auto' }, ms.title ?? k), h('div', { class: 'folder-chips' }, ...(ms.entryValues ?? []).map((v, i) => { const sel = () => ((changes[k] ?? cur ?? ms.values ?? []) as string[]).includes(String(v)); const b = h('button', { type: 'button', class: 'chip' + (sel() ? ' on' : ''), onclick: () => { const list = (changes[k] ?? cur ?? ms.values ?? []) as string[]; save(k, sel() ? list.filter((x) => x !== String(v)) : [...list, String(v)]); b.classList.toggle('on', sel()); } }, h('span', { dir: 'auto' }, String(ms.entries?.[i] ?? v))); return b; }))));
    }
  }
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const map = readStore(hnd.key);
    for (const [k, v] of Object.entries(changes)) map[k] = hnd.ln ? { created: new Date().toISOString(), value: v } : v;
    try { localStorage.setItem(`kr.ext.store.${hnd.key}`, JSON.stringify(map)); } catch { /* full */ }
    sh.close();
    if (Object.keys(changes).length) { forgetHandle(hnd.source.id); const { resetSandbox } = await import('../sources/ext/sandbox'); resetSandbox(); navigate(`${path(hnd.source.id)}?v=${Date.now().toString(36)}`, true); toast(t('saved')); }
  } }, icon('check'), t('done')));
}

/* ---------- a book ---------- */
const downloads = new Map<string, { done: number; total: number; live: boolean }>();

function detailsView(src: Source, id: string, hnd?: Handle): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'library-body src-details' });
  const titleEl = h('div', { class: 'title' }, src.name);
  const root = h('div', { class: 'view sources-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back(path(src.id))), titleEl), body) as HTMLElement & { dispose?: () => void };
  let gone = false; root.dispose = () => { gone = true; };
  body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('loading')));
  void (async () => {
    let d: SourceDetails;
    try { d = await src.details(id); } catch (e) { if (!gone) { body.replaceChildren(); showError(body, e, () => { root.replaceWith(detailsView(src, id, hnd)); }, src); } return; }
    if (gone) return;
    body.replaceChildren();
    titleEl.replaceChildren(h('span', { dir: 'auto' }, d.title));
    const [c1, c2] = coverColors(d.title);
    const head = h('div', { class: 'src-head' },
      h('div', { class: 'src-cover big', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, d.cover ? coverImg(d.cover, hnd) : h('span', { class: 'src-cover-title', dir: 'auto' }, d.title)),
      h('div', { class: 'src-head-text' },
        copyOnHold(h('h2', { dir: 'auto' }, d.title)),
        d.author ? h('p', { class: 'src-author-line', dir: 'auto' }, d.author) : null,
        h('div', { class: 'src-chips' }, ...[d.year, d.lang, d.pages ? (hnd ? countChapters(d.pages) : t('pagesN', { n: localDigits(d.pages) })) : '', d.volumes?.length ? t('volumesN', { n: localDigits(d.volumes.length) }) : '', d.badge].filter(Boolean).map((x) => h('span', { class: 'src-chip' }, x!))),
        d.url ? h('a', { class: 'src-site', href: d.url, target: '_blank', rel: 'noopener' }, icon('external'), ' ', src.site.replace(/^https?:\/\//, '')) : null));
    body.append(head);
    const actions = h('div', { class: 'src-actions' }); body.append(actions);
    if (hnd) await novelActions(actions, d, hnd, () => gone);
    else if (src.id === 'shamela') await shamelaActions(actions, d, id, () => gone);
    else fileActions(actions, src, d);
    if (d.description) { const p = h('p', { class: 'src-desc', dir: 'auto' }, d.description); const long = d.description.length > 420; if (long) { p.classList.add('clamped'); p.addEventListener('click', () => p.classList.toggle('clamped')); } body.append(p); }
    if (d.tags.length) body.append(h('div', { class: 'folder-chips src-tags' }, ...d.tags.slice(0, 30).map((tg) => h('button', { type: 'button', class: 'chip tag', onclick: () => navigate(path(src.id, hnd ? { q: tg.label } : { tags: [tg.id] })) }, icon('tag'), h('span', { dir: 'auto' }, tg.label)))));
    if (d.meta?.length && !hnd) body.append(h('dl', { class: 'src-meta' }, ...d.meta.flatMap((m) => [h('dt', null, m.label), h('dd', { dir: 'auto' }, m.value)])));
    if (d.chapters?.length) body.append(hnd ? novelChapters(d, hnd) : chaptersList(d, id, () => gone));
    if (d.toc?.length) body.append(tocBlock(d.toc, 40));
  })();
  return root;
}

/** Held on a card (as Mihon adds a title from Browse with a long press): the book or series added to the
 *  library from here — a file fetched, a web novel followed — with the tags asked, or the file to the device. */
async function quickAdd(src: Source, b: SourceBook, lib: Map<string, string>, hnd: Handle | null, rows: Map<string, (bookId: string) => void>): Promise<void> {
  const sh = openSheet(b.title, t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  if (b.author) sh.body.append(h('p', { class: 'hint', dir: 'auto' }, b.author));
  const list = h('div', { class: 'dest-list' }); sh.body.append(list);
  const row = (ic: string, label: string, fn: () => void | Promise<void>, cls = '') => list.append(h('button', { type: 'button', class: `dest-row ${cls}`, onclick: () => { sh.close(); void Promise.resolve(fn()).catch((e) => { if (!/^(cancelled|deviceOnly)$/.test((e as Error)?.message ?? '')) toast(describe(e), 'error'); }); } }, icon(ic), h('span', { class: 'name', dir: 'auto' }, label)));
  const inLib = lib.get(b.id) ?? (b.alts ?? []).map((a) => lib.get(a.id)).find(Boolean);
  if (inLib) row('play', `${t('inLibrary')} · ${t('open')}`, () => navigate(`/read/${inLib}`));
  if (b.file && !inLib) {
    const file = b.file; const title = b.title;
    const go = async (deviceOnly: boolean) => {
      const place = deviceOnly ? { deviceOnly: true } : b.group ? await askPlacement(`${src.id}|${b.group}`, b.group) : await askPlacement(`${src.id}|${b.id}`, title);
      if (place.deviceOnly && !deviceOnly) { /* chosen in the sheet */ }
      const book = await fetchVolume(src, b.id, title, file, () => undefined, b.group ? { name: b.group, index: b.volume, source: src.id, shelf: b.shelf } : undefined, place.tags, place.deviceOnly || deviceOnly);
      lib.set(b.id, book.id); rows.get(b.id)?.(book.id); toast(t('addedToLibrary'));
    };
    row('plus', t('addToLibrary'), () => go(false));
    row('download', t('deviceOnly'), () => go(true));
  }
  if (b.look === 'series' || (b.look === 'folder' && b.openShelf !== undefined)) {
    row('download', t('seriesInSource'), () => navigate(b.look === 'series' ? bookPath(src.id, b.id) : path(src.id, { shelf: b.openShelf })));
  }
  if (hnd && !b.file && b.look !== 'folder' && b.look !== 'series') {
    // A web novel: followed in the library (its chapters read online, fetched later from its page).
    row('plus', t('addToLibrary'), async () => {
      const d = await src.details(b.id); const novel = d.raw as WebNovel;
      const had = await findInLibrary(novel.src, novel.path);
      const book = had ?? await addNovelToLibrary(novel, await coverBlob(d.cover, hnd));
      const place = await askPlacement(`${src.id}|${b.id}`, b.title);
      if (place.tags?.length) await db.updateBook(book.id, (x) => { x.tags = [...new Set([...(x.tags ?? []), ...place.tags!])]; });
      lib.set(b.id, book.id); toast(t('addedToLibrary'));
    });
  }
  row('info', t('details'), () => navigate(b.openShelf !== undefined ? path(src.id, { shelf: b.openShelf }) : bookPath(src.id, b.id)));
}

/** What a book can be fetched in, told at a glance (the archive says so for every book): EPUB — the format
 *  that reads best — marked present or, in red, not available; the other formats after it; a book that can
 *  be fetched in nothing marked so in red. Nothing for a source that does not say. */
function formatMarks(formats: string[] | undefined): HTMLElement | null {
  if (!formats) return null;
  const row = h('span', { class: 'src-formats' });
  if (!formats.length) { row.append(h('span', { class: 'src-fmt missing' }, t('notAvailable'))); return row; }
  row.append(formats.includes('EPUB') ? h('span', { class: 'src-fmt ok' }, 'EPUB') : h('span', { class: 'src-fmt missing' }, `EPUB (${t('notAvailable')})`));
  for (const f of formats.filter((f) => f !== 'EPUB').slice(0, 3)) row.append(h('span', { class: 'src-fmt ok' }, f));
  return row;
}

/** archive.org and the like: a button per file, the fetched one going into the library. A work in parts
 *  (volumes as several PDFs) is fetched merged into one book, or as separate books (a series). */
function fileActions(box: HTMLElement, src: Source, d: SourceDetails): void {
  const marks = formatMarks(d.formats); if (marks) box.append(marks);
  if (!d.files.length) { box.append(h('p', { class: 'hint src-na' }, d.badge === 'borrow only' ? t('borrowOnly') : t('noFilesOffered'))); return; }
  const folder = src.id.startsWith('dir:');
  const list = h('div', { class: 'src-files' });
  // (A folder's file already in the library opens from here.)
  if (folder) void fromSource(src.id).then((m) => { const id = m.get(d.id); if (id) list.replaceChildren(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => navigate(`/read/${id}`) }, icon('play'), h('span', { class: 'grow' }, `${t('inLibrary')} · ${t('open')}`))); });
  const fileButton = (f: SourceFile, label: string, name?: string): HTMLButtonElement => {
    const btn = h('button', { type: 'button', class: 'btn tonal src-file' }, icon('download'), h('span', { class: 'grow' }, label), f.size ? h('small', null, formatBytes(f.size)) : null) as HTMLButtonElement;
    // (A download of this file under way from before — the page was left and come back to: followed.)
    if (folder) void import('../downloads').then(({ downloadOf }) => { const dd = downloadOf(src.id, d.id, f.url); if (dd?.state === 'running') btn.click(); });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const progress = (p: { pct: number; got: number; total: number; speed?: number }) => { btn.replaceChildren(icon('download'), h('span', { class: 'grow' }, p.total ? `${localDigits(p.pct)}% · ${formatBytes(p.got)} / ${formatBytes(p.total)}${p.speed ? ` · ${t('perSecond', { n: formatBytes(p.speed) })}` : ''}` : p.got ? formatBytes(p.got) : `${label}…`)); };
        // (A web folder's file is remembered as coming from there, so its row and page say "Open" after.)
        const added = folder ? [await fetchVolume(src, d.id, d.title, f, progress)] : await importFiles([await fetchOne(f, progress, name)]);
        if (!added.length) throw new Error(t('convertFailed'));
        // (Remembered as coming from here: its card says «In library» after.)
        if (!folder) await db.updateBook(added[0].id, (b) => { b.remote ??= { source: src.id, id: d.id }; });
        toast(t('addedToLibrary'));
        btn.replaceWith(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => navigate(`/read/${added[0].id}`) }, icon('play'), h('span', { class: 'grow' }, `${label} · ${t('open')}`)));
      } catch (e) { btn.disabled = false; btn.replaceChildren(icon('download'), h('span', { class: 'grow' }, label)); if (f.size) btn.append(h('small', null, formatBytes(f.size))); if (!/^(cancelled|deviceOnly)$/.test((e as Error)?.message ?? '')) toast(describe(e), 'error'); }
    });
    return btn;
  };
  const safeTitle = d.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || d.id;
  const fetchOne = async (f: SourceFile, onProgress: (p: { pct: number; got: number; total: number }) => void, name?: string): Promise<File> => {
    const file = await src.fetchFile!(d, f, onProgress);
    return name ? new File([file], name, { type: file.type }) : file;
  };
  const partName = (f: SourceFile, i: number) => { if (f.name) return f.name; const m = /(\d+)(?!.*\d)/.exec(f.id.replace(/\.[a-z0-9]+$/i, '')); return `${safeTitle} ${m ? Number(m[1]) : i + 1}.${f.ext}`; };
  for (const f of d.files) {
    if (!f.parts?.length) { list.append(fileButton(f, f.label)); continue; }
    const parts = f.parts;
    const group = h('div', { class: 'src-parts' });
    group.append(h('div', { class: 'src-parts-head' }, h('b', null, `${f.label} · ${t('partsN', { n: localDigits(parts.length) })}`), f.size ? h('small', null, formatBytes(f.size)) : null));
    // Merged into one book: PDFs page after page, texts one after another.
    if (f.ext === 'pdf' || f.ext === 'txt') {
      const merged = h('button', { type: 'button', class: 'btn tonal src-file' }, icon('download'), h('span', { class: 'grow' }, t('fetchMerged'))) as HTMLButtonElement;
      merged.addEventListener('click', async () => {
        merged.disabled = true; const say = (txt: string) => merged.replaceChildren(icon('download'), h('span', { class: 'grow' }, txt));
        try {
          const got: File[] = [];
          for (const [i, part] of parts.entries()) { say(t('fetchingPart', { n: localDigits(i + 1), total: localDigits(parts.length) })); got.push(await fetchOne(part, () => undefined)); }
          let file: File;
          if (f.ext === 'pdf') {
            say(t('mergingParts'));
            const { mergePdfs } = await import('../pdftools');
            const bytes = await mergePdfs(await Promise.all(got.map(async (g) => ({ name: g.name, bytes: new Uint8Array(await g.arrayBuffer()) }))));
            file = new File([bytes.buffer as ArrayBuffer], `${safeTitle}.pdf`, { type: 'application/pdf' });
          } else file = new File([(await Promise.all(got.map((g) => g.text()))).join('\n\n')], `${safeTitle}.txt`, { type: 'text/plain' });
          const added = await importFiles([file]);
          if (!added.length) throw new Error(t('convertFailed'));
          toast(t('addedToLibrary'));
          merged.replaceWith(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => navigate(`/read/${added[0].id}`) }, icon('play'), h('span', { class: 'grow' }, `${t('fetchMerged')} · ${t('open')}`)));
        } catch (e) { merged.disabled = false; say(t('fetchMerged')); toast(describe(e), 'error'); }
      });
      group.append(merged);
    }
    // As separate books, each a volume of the series.
    const split = h('button', { type: 'button', class: 'btn tonal src-file' }, icon('books'), h('span', { class: 'grow' }, t('fetchSeparate'))) as HTMLButtonElement;
    split.addEventListener('click', async () => {
      split.disabled = true; const say = (txt: string) => split.replaceChildren(icon('books'), h('span', { class: 'grow' }, txt));
      try {
        const got: File[] = [];
        for (const [i, part] of parts.entries()) { say(t('fetchingPart', { n: localDigits(i + 1), total: localDigits(parts.length) })); got.push(await fetchOne(part, () => undefined, partName(part, i))); }
        const added = await importFiles(got);
        if (!added.length) throw new Error(t('convertFailed'));
        toast(t('addedBooks', { n: countBooks(added.length) }));
        split.replaceWith(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => navigate(`/read/${added[0].id}`) }, icon('play'), h('span', { class: 'grow' }, `${t('fetchSeparate')} · ${t('open')}`)));
      } catch (e) { split.disabled = false; say(t('fetchSeparate')); toast(describe(e), 'error'); }
    });
    group.append(split);
    // Each part on its own, behind a toggle.
    const partList = h('div', { class: 'src-files src-part-list', hidden: true });
    parts.forEach((part, i) => partList.append(fileButton(part, (part.name ?? part.id).replace(/\.[a-z0-9]+$/i, ''), partName(part, i))));
    const tg = h('button', { type: 'button', class: 'btn small src-parts-toggle', onclick: () => { partList.hidden = !partList.hidden; tg.replaceChildren(icon(partList.hidden ? 'chevronDown' : 'chevronUp'), t('eachPart')); } }, icon('chevronDown'), t('eachPart'));
    group.append(tg, partList);
    list.append(group);
  }
  box.append(list);
}

/** A novel from an extension: read from the site, keep in the library, fetch every chapter for offline. */
async function novelActions(box: HTMLElement, d: SourceDetails, hnd: Handle, gone: () => boolean): Promise<void> {
  const novel = d.raw as WebNovel;
  let book = (await findInLibrary(novel.src, novel.path)) ?? null;
  const draw = async () => {
    if (gone()) return;
    box.replaceChildren();
    const open = async (chapter?: number) => {
      if (!book) book = await addNovelToLibrary(novel, await coverBlob(d.cover, hnd));
      if (chapter !== undefined) setJump({ bookId: book.id, kind: 'anchor', id: `${book.id}-c${chapter}` });
      navigate(`/read/${book.id}`);
    };
    const row = h('div', { class: 'src-files' });
    row.append(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => void open().catch((e) => toast(describe(e), 'error')) }, icon('play'), h('span', { class: 'grow' }, book ? t('open') : t('readOnline'))));
    if (!book) row.append(h('button', { type: 'button', class: 'btn tonal src-file', onclick: async () => { try { book = await addNovelToLibrary(novel, await coverBlob(d.cover, hnd)); toast(t('addedToLibrary')); void draw(); } catch (e) { toast(describe(e), 'error'); } } }, icon('plus'), h('span', { class: 'grow' }, t('addToLibrary'))));
    const file = book ? await readNovelFile(book.id) : null;
    const have = file?.content ? Object.keys(file.content).length : 0;
    const total = file?.chapters.length ?? novel.chapters.length;
    const offline = book && !book.remote?.online;
    const dkey = `${novel.src}|${novel.path}`;
    const dl = downloads.get(dkey);
    if (offline) row.append(h('span', { class: 'hint src-offline' }, icon('check'), ` ${t('offlineReady')}`));
    else {
      const bar = h('span'); const track = h('div', { class: 'progress-bar' }, bar);
      const label = h('span', { class: 'grow' }, dl ? t('fetchingChapters', { n: localDigits(dl.done), total: localDigits(dl.total) }) : have ? t('fetchChaptersRest', { n: localDigits(have), total: countChapters(total) }) : t('fetchChapters', { n: countChapters(total) }));
      const btn = h('button', { type: 'button', class: 'btn tonal src-file' }, icon(dl ? 'stop' : 'download'), label) as HTMLButtonElement;
      if (dl) bar.style.width = `${(dl.done / dl.total) * 100}%`;
      btn.addEventListener('click', async () => {
        const running = downloads.get(dkey);
        if (running) { running.live = false; btn.disabled = true; return; }
        try {
          if (!book) book = await addNovelToLibrary(novel, await coverBlob(d.cover, hnd));
          const state = { done: have, total, live: true }; downloads.set(dkey, state);
          btn.replaceChildren(icon('stop'), label); track.hidden = false;
          const ok = await downloadNovel(book, (done, tot) => { state.done = done; state.total = tot; if (!gone()) { bar.style.width = `${(done / tot) * 100}%`; label.textContent = t('fetchingChapters', { n: localDigits(done), total: localDigits(tot) }); } }, () => state.live);
          downloads.delete(dkey);
          toast(ok ? t('offlineDone') : t('offlineStopped'));
        } catch (e) { downloads.delete(dkey); toast(describe(e), 'error'); }
        book = (await findInLibrary(novel.src, novel.path)) ?? book;
        void draw();
      });
      row.append(btn, track);
    }
    // The novel as an EPUB file to keep or pass on: the chapters not here yet fetched first, the pictures inside.
    const epub = h('button', { type: 'button', class: 'btn tonal src-file' }, icon('file'), h('span', { class: 'grow' }, t('saveAsEpub'))) as HTMLButtonElement;
    epub.addEventListener('click', async () => {
      epub.disabled = true;
      const say = (txt: string) => epub.replaceChildren(icon('file'), h('span', { class: 'grow' }, txt));
      try {
        if (!book) book = await addNovelToLibrary(novel, await coverBlob(d.cover, hnd));
        const blob = await novelToEpub(book, (step, done, tot) => say(step === 'chapters' ? t('fetchingChapters', { n: localDigits(done), total: localDigits(tot) }) : step === 'pictures' ? t('epubPictures', { n: localDigits(done), total: localDigits(tot) }) : t('epubMaking')));
        const { downloadBlob } = await import('../ui/share');
        downloadBlob(blob, `${novel.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'novel'}.epub`);
      } catch (e) { toast(describe(e), 'error'); }
      finally { epub.disabled = false; say(t('saveAsEpub')); }
    });
    row.append(epub);
    { const tb = trackButton(hnd.source.id, async () => book?.id, () => void draw()); if (tb) row.append(tb); }
    box.append(row);
    if (book) {
      const checkBtn = h('button', { type: 'button', class: 'btn small' }, icon('refresh'), t('checkChapters')) as HTMLButtonElement;
      checkBtn.addEventListener('click', async () => { checkBtn.disabled = true; try { const n = await checkNovel(book!, false); toast(n ? t('newChaptersFound', { n: countChapters(n) }) : t('noNewChapters')); } catch (e) { toast(describe(e), 'error'); } checkBtn.disabled = false; });
      box.append(h('p', { class: 'hint novel-in-library' }, t('novelInLibrary'), ' ', checkBtn));
    }
  };
  await draw();
}
async function coverBlob(url: string | undefined, hnd: Handle): Promise<Blob | undefined> {
  if (!url) return undefined;
  try { const { fetchBytes } = await import('../sources/http'); const bytes = await fetchBytes(url, undefined, { headers: hnd.ln?.imageRequestInit?.headers ?? hnd.my?.headers ?? { referer: hnd.item.site }, retries: 0 }); const { shrinkCover } = await import('../library'); return shrinkCover(new Blob([bytes.buffer as ArrayBuffer])); } catch { return undefined; }
}

/** The chapters of a novel: a list with a box to find one; a chapter opens the book there. A long press picks
 *  chapters (as in Mihon): the picked ones can be fetched for offline, or all of them, or the ones between the
 *  first and the last picked. A chapter already fetched wears a mark. */
function novelChapters(d: SourceDetails, hnd: Handle): HTMLElement {
  const novel = d.raw as WebNovel;
  const list = h('ul', { class: 'plain-list src-chapters novel-chapters' });
  const find = h('input', { type: 'search', class: 'src-search ext-find', placeholder: t('findChapter'), dir: 'auto' }) as HTMLInputElement;
  const bar = h('div', { class: 'selection-bar chapter-sel', hidden: true });
  const title = h('h3', { class: 'section-title' }, `${t('contents')} · ${countChapters(novel.chapters.length)}`);
  const box = h('section', { class: 'src-chapters-box' }, title, find, bar, list);
  const picked = new Set<number>();
  let have = new Set<string>();
  const refreshHave = async () => { const book = await findInLibrary(novel.src, novel.path); const file = book ? await readNovelFile(book.id) : null; have = new Set(Object.keys(file?.content ?? {})); };
  const openAt = async (i: number) => {
    let book = await findInLibrary(novel.src, novel.path);
    if (!book) book = await addNovelToLibrary(novel, await coverBlob(d.cover, hnd));
    setJump({ bookId: book.id, kind: 'anchor', id: `${book.id}-c${i}` });
    navigate(`/read/${book.id}`);
  };
  const selecting = () => picked.size > 0;
  const drawBar = () => {
    bar.hidden = !selecting();
    if (!selecting()) return;
    const idx = [...picked].sort((a, b) => a - b);
    const todo = idx.filter((i) => !have.has(novel.chapters[i].path));
    bar.replaceChildren(
      h('span', { class: 'grow sel-count' }, countChapters(picked.size)),
      h('button', { type: 'button', class: 'icon-btn', title: t('selectAll'), 'aria-label': t('selectAll'), onclick: () => { novel.chapters.forEach((_, i) => picked.add(i)); draw(find.value); } }, icon('check')),
      h('button', { type: 'button', class: 'icon-btn', title: t('selectBetween'), 'aria-label': t('selectBetween'), onclick: () => { for (let i = idx[0]; i <= idx[idx.length - 1]; i++) picked.add(i); draw(find.value); } }, icon('sort')),
      h('button', { type: 'button', class: 'btn small primary', disabled: !todo.length, onclick: () => void fetchPicked(todo) }, icon('download'), todo.length ? t('downloadN', { n: countChapters(todo.length) }) : t('downloaded')),
      h('button', { type: 'button', class: 'icon-btn', title: t('close'), 'aria-label': t('close'), onclick: () => { picked.clear(); draw(find.value); } }, icon('close')));
  };
  const fetchPicked = async (idx: number[]) => {
    const paths = new Set(idx.map((i) => novel.chapters[i].path));
    picked.clear(); drawBar();
    try {
      let book = await findInLibrary(novel.src, novel.path);
      if (!book) book = await addNovelToLibrary(novel, await coverBlob(d.cover, hnd));
      const key = `${novel.src}|${novel.path}#pick`;
      const state = { done: 0, total: paths.size, live: true }; downloads.set(key, state);
      const say = (done: number, total: number) => { title.textContent = `${t('contents')} · ${t('fetchingChapters', { n: localDigits(done), total: localDigits(total) })}`; };
      const ok = await downloadNovel(book, (done, total) => { state.done = done; state.total = total; say(done, total); }, () => state.live, paths);
      downloads.delete(key);
      toast(ok ? t('chaptersFetched', { n: countChapters(paths.size) }) : t('offlineStopped'));
    } catch (e) { toast(describe(e), 'error'); }
    title.textContent = `${t('contents')} · ${countChapters(novel.chapters.length)}`;
    await refreshHave(); draw(find.value);
  };
  const draw = (needle: string) => {
    list.replaceChildren();
    const n = needle.trim().toLowerCase();
    novel.chapters.forEach((c, i) => {
      if (n && !c.name.toLowerCase().includes(n)) return;
      const on = picked.has(i); const got = have.has(c.path);
      const b = h('button', { type: 'button', 'aria-pressed': String(on), class: (on ? 'on' : '') + (got ? ' have' : ''), onclick: () => { if (selecting()) { if (on) picked.delete(i); else picked.add(i); draw(find.value); } else void openAt(i).catch((e) => toast(describe(e), 'error')); } },
        on ? icon('check') : got ? h('span', { class: 'have-mark', title: t('downloaded') }, icon('download')) : null,
        h('span', { dir: 'auto', class: 'grow' }, c.name), c.released ? h('span', { class: 'meta' }, shortDate(c.released)) : null);
      onHoldOrContext(b, () => { if (on) picked.delete(i); else picked.add(i); draw(find.value); });
      list.append(h('li', null, b));
    });
    drawBar();
  };
  find.addEventListener('input', () => draw(find.value));
  draw('');
  void refreshHave().then(() => draw(find.value));
  return box;
}
function shortDate(s: string): string {
  const d = new Date(s); if (isNaN(d.getTime())) return s.length > 16 ? '' : s;
  return d.toLocaleDateString(getLang() === 'ar' ? 'ar' : undefined, { year: '2-digit', month: 'short', day: 'numeric' });
}

/** Shamela: read from the site, keep in the library, fetch whole for offline — and search inside the book. */
async function shamelaActions(box: HTMLElement, d: SourceDetails, id: string, gone: () => boolean): Promise<void> {
  const [bookId, pageId] = id.split('#');
  const info = await readInfo(bookId);
  let book = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === bookId) ?? null;
  const draw = async () => {
    if (gone()) return;
    box.replaceChildren();
    const open = async (anchorPage?: number) => {
      if (!book) { book = await addToLibrary(info!); }
      if (anchorPage) setJump({ bookId: book.id, kind: 'anchor', id: `${book.id}-p${anchorPage}` });
      navigate(`/read/${book.id}`);
    };
    const row = h('div', { class: 'src-files' });
    row.append(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => void open(pageId ? Number(pageId) : undefined).catch((e) => toast(describe(e), 'error')) }, icon('play'), h('span', { class: 'grow' }, pageId ? t('readAtPage', { n: localDigits(pageId) }) : book ? t('open') : t('readOnline'))));
    if (!book) row.append(h('button', { type: 'button', class: 'btn tonal src-file', onclick: async () => { try { book = await addToLibrary(info!); toast(t('addedToLibrary')); void draw(); } catch (e) { toast(describe(e), 'error'); } } }, icon('plus'), h('span', { class: 'grow' }, t('addToLibrary'))));
    const file = book ? await readBookFile(book.id) : null;
    const have = file?.content ? Object.keys(file.content).length : 0;
    const offline = book && !book.remote?.online;
    const dl = downloads.get(bookId);
    if (offline) row.append(h('span', { class: 'hint src-offline' }, icon('check'), ` ${t('offlineReady')}`));
    else {
      const bar = h('span'); const track = h('div', { class: 'progress-bar' }, bar); const label = h('span', { class: 'grow' }, dl ? t('fetchingPages', { n: localDigits(dl.done), total: localDigits(dl.total) }) : have ? t('fetchOfflineRest', { n: localDigits(have), total: localDigits(info!.pages) }) : t('fetchOffline', { n: localDigits(info!.pages) }));
      const btn = h('button', { type: 'button', class: 'btn tonal src-file' }, icon(dl ? 'stop' : 'download'), label) as HTMLButtonElement;
      if (dl) { bar.style.width = `${(dl.done / dl.total) * 100}%`; }
      btn.addEventListener('click', async () => {
        const running = downloads.get(bookId);
        if (running) { running.live = false; btn.disabled = true; return; }
        try {
          if (!book) book = await addToLibrary(info!);
          const state = { done: have, total: info!.pages, live: true }; downloads.set(bookId, state);
          btn.replaceChildren(icon('stop'), label); track.hidden = false;
          const ok = await downloadBook(book, (done, total) => { state.done = done; state.total = total; if (!gone()) { bar.style.width = `${(done / total) * 100}%`; label.textContent = t('fetchingPages', { n: localDigits(done), total: localDigits(total) }); } }, () => state.live);
          downloads.delete(bookId);
          toast(ok ? t('offlineDone') : t('offlineStopped'));
        } catch (e) { downloads.delete(bookId); toast(describe(e), 'error'); }
        book = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === bookId) ?? book;
        void draw();
      });
      row.append(btn, track);
    }
    box.append(row);
    if (book) box.append(h('p', { class: 'hint' }, t('shamelaInLibrary')));
    // Searching inside the book: on the site itself (no account), or through وصلة الشاملة when chosen.
    const sbox = h('div', { class: 'src-book-search' });
    const input = h('input', { type: 'search', placeholder: t('searchInThisBook'), dir: 'auto' }) as HTMLInputElement;
    const results = h('div', { class: 'src-hits' });
    const run = async () => {
      const q = input.value.trim(); if (!q) return;
      results.replaceChildren(h('div', { class: 'hint' }, t('searching')));
      const useLink = link.isConnected() && String(filterValues(shamelaSource).engine ?? 'site') === 'link';
      try {
        if (useLink) {
          const r = await link.searchPages(q, { scope: { book_ids: [Number(bookId)] }, limit: 30 });
          results.replaceChildren(h('div', { class: 'hint' }, t('resultsCount', { n: r.total_hits })));
          for (const hit of r.results) {
            const snip = h('span', { class: 'ctx', dir: 'auto' }); snip.innerHTML = (hit.snippet_body || hit.snippet_foot || '').replace(/<(?!\/?mark>)[^>]*>/g, '');
            results.append(h('button', { type: 'button', class: 'src-hit', onclick: () => void open(hit.page_id).catch((e) => toast(describe(e), 'error')) }, h('b', null, hit.printed_page ? `ص ${hit.printed_page}` : `#${hit.page_id}`), snip));
          }
        } else {
          const { siteSearch, siteTerm } = await import('../sources/shamela');
          let pageNo = 1; const draw = async () => {
            const r = await siteSearch(siteTerm(q, 'words'), { page: pageNo, books: [Number(bookId)] });
            if (pageNo === 1) results.replaceChildren(h('div', { class: 'hint' }, r.total !== undefined ? t('resultsCount', { n: r.total }) : r.hits.length ? '' : t('noResults')));
            results.querySelector('.src-more-btn')?.remove();
            for (const hit of r.hits) { const snip = h('span', { class: 'ctx', dir: 'auto' }); snip.innerHTML = hit.snippet; results.append(h('button', { type: 'button', class: 'src-hit', onclick: () => void open(hit.page).catch((e) => toast(describe(e), 'error')) }, h('b', null, `#${localDigits(hit.page)}`), snip)); }
            if (r.next) results.append(h('button', { type: 'button', class: 'btn tonal src-more-btn', onclick: () => { pageNo = r.next!; void draw().catch((e) => results.append(h('div', { class: 'hint' }, describe(e)))); } }, t('loadMore')));
          };
          await draw();
        }
      } catch (e) { results.replaceChildren(h('div', { class: 'hint' }, describe(e))); }
    };
    sbox.append(h('form', { class: 'src-search-row', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, input, h('button', { type: 'submit', class: 'icon-btn', 'aria-label': t('search') }, icon('search'))), results);
    box.append(sbox);
  };
  await draw();

  async function readInfo(bid: string) { const { bookInfo } = await import('../sources/shamela'); return bookInfo(Number(bid)); }
}

/** The contents of a Shamela book as a tree: the branches the site folded are fetched and spliced in; a box
 *  finds a chapter by name; a chapter opens the book at its page. */
function chaptersList(d: SourceDetails, id: string, gone: () => boolean): HTMLElement {
  const [bookId] = id.split('#');
  const tree = h('div', { class: 'src-toc-tree' });
  const find = h('input', { type: 'search', class: 'src-search ext-find', placeholder: t('findChapter'), dir: 'auto' }) as HTMLInputElement;
  const count = h('small', { class: 'hint' }, '');
  const box = h('section', { class: 'src-chapters-box' }, h('h3', { class: 'section-title' }, t('contents'), ' ', count), find, tree);
  const openAt = async (page?: number) => {
    const { bookInfo } = await import('../sources/shamela');
    let book = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === bookId);
    if (!book) book = await addToLibrary(await bookInfo(Number(bookId)));
    if (page) setJump({ bookId: book.id, kind: 'anchor', id: `${book.id}-p${page}` });
    navigate(`/read/${book.id}`);
  };
  let entries: ShamelaToc[] = (d.chapters ?? []).map((c) => ({ title: c.title, page: c.page ?? 0, level: c.level }));
  const draw = (needle: string) => {
    tree.replaceChildren();
    const n = needle.trim();
    count.textContent = `(${localDigits(entries.length)})`;
    if (n) {
      const fold = (s: string) => s.normalize('NFKC').replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();
      const q = fold(n); const list = h('ul', { class: 'plain-list src-chapters' });
      for (const e of entries) if (fold(e.title).includes(q)) list.append(row(e));
      if (!list.children.length) list.append(h('li', { class: 'hint' }, t('noResults')));
      tree.append(list);
      return;
    }
    // Nested lists: the top level open, deeper branches folded behind a toggle.
    const build = (from: number, level: number): { ul: HTMLElement; next: number } => {
      const ul = h('ul', { class: 'plain-list src-chapters' + (level ? ' sub' : '') });
      let i = from;
      while (i < entries.length && entries[i].level >= level) {
        if (entries[i].level > level) { i++; continue; }
        const e = entries[i]; const li = row(e); i++;
        if (i < entries.length && entries[i].level > level) {
          const sub = build(i, entries[i].level); i = sub.next;
          const kids = sub.ul.querySelectorAll('li').length;
          const tg = h('button', { type: 'button', class: 'toc-toggle', 'aria-expanded': level < 1 ? 'true' : 'false', onclick: () => { const open = tg.getAttribute('aria-expanded') === 'true'; tg.setAttribute('aria-expanded', open ? 'false' : 'true'); sub.ul.hidden = open; tg.replaceChildren(icon(open ? 'chevronDown' : 'chevronUp'), h('small', null, localDigits(kids))); } }, icon(level < 1 ? 'chevronUp' : 'chevronDown'), h('small', null, localDigits(kids)));
          sub.ul.hidden = level >= 1;
          li.append(tg, sub.ul);
        }
        ul.append(li);
      }
      return { ul, next: i };
    };
    tree.append(build(0, Math.min(...entries.map((e) => e.level), 0)).ul);
  };
  const row = (e: ShamelaToc) => h('li', null,
    h('button', { type: 'button', onclick: () => void openAt(e.page).catch((x) => toast(describe(x), 'error')) }, h('span', { dir: 'auto' }, e.title), e.page ? h('span', { class: 'meta' }, localDigits(e.page)) : null));
  find.addEventListener('input', () => draw(find.value));
  draw('');
  // (Folded branches: fetched when the list is shown, so the contents are whole.)
  void (async () => {
    const { bookInfo } = await import('../sources/shamela');
    try {
      const info = await bookInfo(Number(bookId));
      if (!info.toc.some((e) => e.more) || gone()) return;
      const full = await expandToc(info.toc, () => !gone());
      if (gone()) return;
      entries = full; draw(find.value);
    } catch { /* the folded contents stay */ }
  })();
  return box;
}

/* ---------- errors ---------- */
/** Mihon's hint, for a check that keeps failing: an old Android System WebView fails the sites' checks. */
function oldWebView(): string {
  const ua = navigator.userAgent;
  if (!/Android/.test(ua) || !/; wv\)/.test(ua)) return '';
  const v = Number(/Chrome\/(\d+)/.exec(ua)?.[1] ?? 0);
  return v && v < 115 ? ` ${t('webviewOld', { v: String(v) })}` : '';
}
function describe(e: unknown): string {
  const err = e as SourceError;
  if (err instanceof SourceError) {
    if (err.kind === 'offline') return t('sourceOffline');
    if (err.kind === 'cloudflare') return t('sourceCloudflare') + oldWebView();
    if (err.kind === 'blocked') return t('sourceBlocked', { what: err.detail ? t('siteSaid', { title: err.detail }) : '' }) + oldWebView();
    if (err.kind === 'rate') return t('sourceRate');
    // (A sentence a source wrote for the reader — a folder refused, a page of its own — is said as it is.)
    const said = /\s/.test(err.message) && err.message.length > 12 && /[.!?…]$/.test(err.message.trim());
    if (err.kind === 'auth') return said ? err.message : t('shamelaLinkNeeded');
    if (err.kind === 'cors') return t('sourceNeedsApp');
    if (err.kind === 'parse') return err.message === 'notRunnable' ? t('extNotRunnable') : err.message === 'noExtension' ? t('extGone') : said ? err.message : t('sourceParse');
    if (err.kind === 'http' && said) return err.message;
  }
  return String((e as Error)?.message ?? e);
}
/** The ways on from an error: a site's check opened for the reader ("Confirm I'm human"), its cookies cleared
 *  (a clearance gone stale), a sign-in, or simply trying again. */
function errorActions(e: unknown, site: () => Promise<string>, retry: () => void, folder?: string): HTMLElement[] {
  const err = e as SourceError;
  const kind = err instanceof SourceError ? err.kind : '';
  const out: HTMLElement[] = [];
  // (A web folder the site will not list, or lists as a page of its own: the folder opened on the site.)
  const onSite = folder && (kind === 'auth' || kind === 'parse' || kind === 'http') ? (err.detail && /^https?:/.test(err.detail) ? err.detail : folder) : undefined;
  if (kind === 'cloudflare') out.push(h('button', { type: 'button', class: 'btn primary', onclick: () => void site().then((u) => (u ? passChallenge(u) : undefined)).then(retry) }, icon('globe'), t('passCheck')));
  else if (onSite) out.push(h('button', { type: 'button', class: 'btn primary', onclick: () => void openSite(onSite) }, icon('globe'), t('openFolderOnSite')), h('button', { type: 'button', class: 'btn tonal', onclick: retry }, t('tryAgain')));
  else if (kind === 'auth') out.push(h('button', { type: 'button', class: 'btn primary', onclick: () => void link.connect().catch((x) => toast(describe(x), 'error')) }, icon('user'), t('signIn')));
  else out.push(h('button', { type: 'button', class: 'btn tonal', onclick: retry }, t('tryAgain')));
  if (kind === 'cloudflare' || kind === 'blocked') out.push(h('button', { type: 'button', class: 'btn text', onclick: () => void site().then((u) => (u ? forgetSite(u) : 0)).then(() => { toast(t('siteCookiesCleared'), 'info', 2500); retry(); }) }, t('clearSiteCookies')));
  return out;
}
function showError(box: HTMLElement, e: unknown, retry: () => void, src: Source, folder?: string): void {
  const el = h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('globe')), h('p', null, describe(e)));
  el.append(...errorActions(e, async () => src.site ?? '', retry, folder));
  box.replaceChildren(el);
}
export { describe as describeSourceError };
export type { Book };
