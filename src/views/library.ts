import { h, icon, iconButton, toast, clear, coverColors, pickSheet } from '../ui/dom';
import { t, formatBytes, formatDate, countBooks, localDigits, formatDuration, getLang, countMinutes } from '../i18n';
import { importFiles, listBooks, removeBooks, coverUrl, forgetCover, shareBooks } from '../library';
import { db, uid, FAV_TAG, type Book, type Folder, type TagDef } from '../db';
import { SUPPORTED_ACCEPT, prewarm } from '../formats';
import { navigate } from '../router';
import { readContentUri } from '../native';
import { getSettings, updateSettings, onSettingsChange } from '../settings';
import { openScanSheet, FORMAT_GROUPS, groupOf, canScan } from '../ui/scan';
import { pickDestination, type Destination } from '../ui/destination';
import { todayKey, liveStatsOf } from '../stats';

type Sort = 'title' | 'recent' | 'added' | 'author' | 'size';
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function libraryView(): HTMLElement {
  let books: Book[] = [];
  let query = '';
  let sort: Sort = (localStorage.getItem('kr.sort') as Sort) || 'title';
  let folders: Folder[] = [];
  let tagDefs: TagDef[] = [];
  let activeFolder: string | null = localStorage.getItem('kr.folder') || null;
  let tagFilter: string | null = localStorage.getItem('kr.tag') || null;
  let selecting = false;
  const selected = new Set<string>();

  const input = h('input', { type: 'file', multiple: true, accept: SUPPORTED_ACCEPT, hidden: true }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (!files.length) return;
    // Ask where the books go (library / a folder / a new folder) whenever folders are in use.
    if (folders.length || books.length) {
      const d = await pickDestination(folders, activeFolder ? { kind: 'folder', id: activeFolder } : { kind: 'library' }, t('importBooks'));
      if (!d) return;
      await doImport(files, await resolveDestination(d));
    } else await doImport(files, null);
  });

  async function resolveDestination(d: Destination): Promise<string | null> {
    if (d.kind === 'folder') return d.id;
    if (d.kind === 'new') return createFolder(d.name);
    return null;
  }

  const search = h('input', { type: 'search', placeholder: t('searchLibrary'), 'aria-label': t('searchLibrary'), oninput: () => { query = search.value.trim().toLowerCase(); renderGrid(); } }) as HTMLInputElement;
  const SORTS: [Sort, string, string][] = [['title', t('sortTitleNum'), 'type'], ['recent', t('sortRecent'), 'clock'], ['added', t('sortAdded'), 'import'], ['author', t('sortAuthor'), 'info'], ['size', t('sortSize'), 'books']];
  const sortLabel = h('span', null, SORTS.find((x) => x[0] === sort)?.[1] ?? '');
  const sortSel = h('button', { type: 'button', class: 'sort-btn', 'aria-label': t('sortBy'), onclick: () => pickSheet(t('sortBy'), SORTS, sort, (v) => { sort = v; localStorage.setItem('kr.sort', sort); sortLabel.textContent = SORTS.find((x) => x[0] === sort)?.[1] ?? ''; renderGrid(); }, t('close')) }, icon('sort'), sortLabel, icon('chevronDown'));

  const selectBtn = iconButton('check', t('select'), () => setSelecting(!selecting), { pressed: false });
  selectBtn.classList.add('tool-btn');
  const grid = h('div', { class: 'book-grid', role: 'list' });
  const resume = h('div', { class: 'resume-card', hidden: true });
  const chips = h('div', { class: 'folder-chips', role: 'tablist' });
  const tagChips = h('div', { class: 'format-chips tag-chips', role: 'group', 'aria-label': t('tags') });
  const fmtChips = h('div', { class: 'format-chips', role: 'group', 'aria-label': t('filterFormats') });
  const heroSub = h('div', { class: 'sub' });
  const heroGoal = h('div', { class: 'goal-line', hidden: true });
  const hero = h('div', { class: 'library-hero' }, h('h1', { class: 'display' }, t('library')), heroSub, heroGoal);
  const convertBtn = iconButton('convert', t('convertFile'), () => void import('../ui/convert').then((m) => m.convertPicker(books, () => void pickFiles())));
  convertBtn.classList.add('tool-btn');
  const pdfToolsBtn = iconButton('file', t('pdfTools'), () => void import('../ui/pdftools').then((m) => m.pdfToolsSheet(books, undefined, () => void refresh())));
  pdfToolsBtn.classList.add('tool-btn');
  // Search across books: a word or phrase in many books at once.
  const searchBooksBtn = iconButton('search', t('searchBooks'), () => void import('../ui/librarysearch').then((m) => m.librarySearchSheet(books, folders, activeFolder)));
  searchBooksBtn.classList.add('tool-btn');
  const body = h('div', { class: 'library-body' },
    hero,
    h('div', { class: 'library-tools' }, search, sortSel, selectBtn, convertBtn, pdfToolsBtn, searchBooksBtn),
    chips,
    tagChips,
    fmtChips,
    resume,
    grid);

  const importTopBtn = iconButton('import', t('importBooks'), () => importMenu());
  const syncTopBtn = iconButton('cloud', t('sync'), () => void import('../ui/syncsheet').then((m) => m.syncSheet()));
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand title' }, h('img', { src: '/icons/icon.svg', alt: '' }), h('span', { class: 'brand-name' }, t('appName'))),
    importTopBtn,
    syncTopBtn,
    iconButton('chart', t('readingStats'), () => void import('../ui/stats').then((m) => m.showStats())),
    iconButton('bookmark', t('allNotes'), () => navigate('/notes')),
    iconButton('settings', t('settings'), () => navigate('/settings')),
  );
  const fab = h('button', { class: 'fab', type: 'button', onclick: () => importMenu() }, icon('import'), h('span', null, t('importBooks')));
  const applyImportPlace = () => { const place = getSettings().importButton; importTopBtn.hidden = place !== 'top'; fab.hidden = selecting || place !== 'fab'; };
  onSettingsChange(() => { applyImportPlace(); renderChips(); });

  /** Pick files, or scan a folder on the device. */
  /** Android: pick through the plugin so files can be linked with a lasting grant; elsewhere the plain file input. */
  async function pickFiles(): Promise<void> {
    const plugin = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: { pickDocuments?(): Promise<{ files: { uri: string; name: string; size: number; mime?: string }[] }>; readDocument(o: { uri: string }): Promise<{ data: string }> } } } }).Capacitor;
    const k = plugin?.Plugins?.Kurokawa;
    if (plugin?.getPlatform?.() !== 'android' || !k?.pickDocuments) { input.click(); return; }
    let picked: { uri: string; name: string; size: number; mime?: string }[];
    try { picked = (await k.pickDocuments()).files; } catch { return; }
    if (!picked.length) return;
    const link = getSettings().importMode === 'link';
    const files: File[] = [];
    toast(t('importing', { n: localDigits(picked.length) }), 'info', 60000);
    for (const f of picked) {
      try {
        const file = await readContentUri(f.uri, f.name || 'document', f.mime || '') as File & { krSource?: { uri: string } };
        if (link) file.krSource = { uri: f.uri };
        files.push(file);
      } catch (err) { toast(t('importFailed', { name: f.name, error: String((err as Error).message ?? err) }), 'error', 4000); }
    }
    if (folders.length || books.length) {
      const d = await pickDestination(folders, activeFolder ? { kind: 'folder', id: activeFolder } : { kind: 'library' }, t('importBooks'));
      if (!d) return;
      await doImport(files, await resolveDestination(d));
    } else await doImport(files);
  }
  function importMenu() {
    if (!canScan()) { void pickFiles(); return; }
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(t('importBooks'), t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      s.body.append(h('ul', { class: 'plain-list' },
        h('li', null, h('button', { type: 'button', onclick: () => { s.close(); void pickFiles(); } }, icon('import'), t('importBooks'))),
        h('li', null, h('button', { type: 'button', onclick: () => { s.close(); openScan(); } }, icon('folder'), t('scanDevice'))),));
    });
  }
  function openScan() {
    openScanSheet({
      folders, activeFolder,
      existing: new Set(books.map((b) => `${b.fileName}:${b.size}`)),
      fallbackPick: () => void pickFiles(),
      onImport: async (files, dest) => { await doImport(files, await resolveDestination(dest)); },
    });
  }

  const selBar = h('div', { class: 'selection-bar', hidden: true });
  const onCommand = (e: Event) => { const c = (e as CustomEvent<string>).detail; if (!root.isConnected) return; if (c === 'import') void pickFiles(); else if (c === 'scan') openScan(); };
  document.addEventListener('kr:command', onCommand);
  const root = h('div', { class: 'view library-view' }, topbar, body, selBar, fab, input);
  // The PC's navigation rail asks for an import or a search across books.
  const onAsk = (e: Event) => {
    if (!root.isConnected) { window.removeEventListener('kr:library', onAsk); return; }
    const what = (e as CustomEvent<string>).detail;
    if (what === 'import') importMenu(); else if (what === 'search') searchBooksBtn.click();
  };
  window.addEventListener('kr:library', onAsk);
  const FINE_POINTER = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const endDrag = () => root.classList.remove('dragging-book');
  for (const ev of ['dragend', 'drop', 'pointerup', 'touchend', 'touchcancel'] as const) document.addEventListener(ev, endDrag, { passive: true });

  function setSelecting(v: boolean) {
    selecting = v;
    if (!v) selected.clear();
    selectBtn.setAttribute('aria-pressed', String(v));
    renderGrid();
  }

  function renderSelBar() {
    clear(selBar);
    selBar.hidden = !selecting;
    if (!selecting) return;
    const n = selected.size;
    const act = (name: string, label: string, onclick: () => void, cls = '') => h('button', { class: 'sel-act' + (cls ? ' ' + cls : ''), type: 'button', disabled: n === 0, 'aria-label': label, title: label, onclick }, icon(name), h('span', null, label));
    selBar.append(
      h('div', { class: 'sel-head' },
        h('span', { class: 'sel-count' }, t('selectedCount', { n })),
        h('button', { class: 'btn small', type: 'button', onclick: () => { if (selected.size === books.length) selected.clear(); else books.forEach((b) => selected.add(b.id)); renderGrid(); } }, selected.size === books.length && n ? t('selectNone') : t('selectAll')),
        h('span', { class: 'spacer' }),
        iconButton('close', t('close'), () => setSelecting(false))),
      h('div', { class: 'sel-actions' },
        act('heart', t('favorite'), () => void Promise.all([...selected].map((id) => setTag([id], FAV_TAG, true))).then(() => { setSelecting(false); return refresh(); })),
        act('check', t('markDone'), () => void setDone([...selected], true).then(() => setSelecting(false))),
        act('tag', t('tags'), () => tagsSheet([...selected])),
        act('folder', t('moveToFolder'), () => moveSheet([...selected])),
        act('external', t('shareFile'), () => void shareBooks([...selected])),
        act('trash', t('delete'), async () => {
          if (!confirm(t('deleteConfirm', { n }))) return;
          await removeBooks([...selected]);
          selected.forEach(forgetCover);
          setSelecting(false);
          await refresh();
        }, 'danger'),
        act('books', n > 1 ? t('openTogether') : t('open'), () => { const ids = sorted().filter((b) => selected.has(b.id)).map((b) => b.id); navigate(`/read/${ids.join(',')}`); }, 'primary'),
      ),
    );
  }

  function sorted(): Book[] {
    const cards = getSettings().libraryView === 'cards';
    const fmt = new Set(getSettings().formatFilter);
    const st = new Set(getSettings().statusFilter);
    const list = books.filter((b) => {
      if (fmt.size && !fmt.has(groupOf(b.format))) return false;
      if (st.size && !st.has(statusOf(b))) return false;
      if (tagFilter && !(b.tags ?? []).includes(tagFilter)) return false;
      const inFolder = activeFolder ? b.folderId === activeFolder : (cards && !query ? !b.folderId || !folders.some((f) => f.id === b.folderId) : true);
      return inFolder && (!query || `${b.title} ${b.author ?? ''} ${b.fileName} ${(b.tags ?? []).join(' ')}`.toLowerCase().includes(query));
    });
    const by: Record<Sort, (a: Book, b: Book) => number> = {
      recent: (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt),
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => natural.compare(a.title, b.title),
      author: (a, b) => natural.compare(a.author ?? '￿', b.author ?? '￿') || natural.compare(a.title, b.title),
      size: (a, b) => b.size - a.size,
    };
    return list.sort(by[sort]);
  }

  function folderCard(f: Folder): HTMLElement {
    const inside = books.filter((b) => b.folderId === f.id);
    const covers = inside.slice(0, 4).map((b) => coverUrl(b));
    const el = h('button', { class: 'book-card folder-card', type: 'button', title: f.name, dataset: { folder: f.id } },
      h('div', { class: 'cover folder' }, h('div', { class: 'stack' }, ...covers.map((u, i) => u ? h('img', { src: u, alt: '' }) : h('div', { class: 'ph', style: { background: coverColors(inside[i].title)[0] } }))), icon('folder')),
      h('div', { class: 'book-meta' }, h('div', { class: 'bt', dir: 'auto' }, f.name), h('div', { class: 'ba' }, t('booksInFolder', { n: inside.length }))));
    el.addEventListener('click', () => { activeFolder = f.id; localStorage.setItem('kr.folder', f.id); renderChips(); renderGrid(); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); folderSheet(f.id); });
    let pt: number | undefined; el.addEventListener('pointerdown', () => { pt = window.setTimeout(() => folderSheet(f.id), 560); }); const cancel = () => window.clearTimeout(pt); el.addEventListener('pointerup', cancel); el.addEventListener('pointerleave', cancel);
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/kr-book')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', async (e) => { e.preventDefault(); el.classList.remove('drop'); const ids = (e.dataTransfer?.getData('text/kr-book') ?? '').split(',').filter(Boolean); await moveBooks(ids, f.id); });
    return el;
  }

  function card(book: Book): HTMLElement {
    const url = coverUrl(book);
    const [c1, c2] = coverColors(book.title);
    const pct = Math.round((book.progress?.pct ?? 0) * 100); const done = isDone(book);
    const doneAt = getSettings().doneMark;
    // The mark: how far the book is read, and «read» once it is (the one takes the other's place).
    const doneBadge = done && getSettings().showDone ? h('span', { class: `badge done at-${doneAt}` }, icon('check'), t('doneBadge')) : !done && pct > 0 && getSettings().showProgress ? h('span', { class: `badge done pct at-${doneAt}` }, getLang() === 'ar' ? `٪${localDigits(pct)}` : `${pct}%`) : null;
    const cover = h('div', { class: 'cover' },
      url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('div', { class: 'gen', style: { '--c1': c1, '--c2': c2 } as unknown as Record<string, string> }, h('div', { class: 't', dir: 'auto' }, book.title), h('div', { class: 'a', dir: 'auto' }, book.author ?? '')),
      h('span', { class: 'badges' }, h('span', { class: 'badge' }, book.format.toUpperCase()), doneBadge && doneAt === 'beside' ? doneBadge : null),
      (book.tags ?? []).includes(FAV_TAG) ? h('span', { class: 'badge fav', 'aria-label': t('favorites') }, icon('heartFill')) : null,
      doneBadge && doneAt !== 'beside' ? doneBadge : null,
      !done && pct > 0 && getSettings().showProgress ? h('div', { class: 'progress', 'aria-label': `${pct}%` }, h('i', { style: { width: `${pct}%` } })) : null,
      selecting ? h('div', { class: 'check' }, icon('check')) : null,
    );
    (cover.querySelector('.gen') as HTMLElement | null)?.style.setProperty('--c1', c1);
    (cover.querySelector('.gen') as HTMLElement | null)?.style.setProperty('--c2', c2);
    const el = h('button', { class: 'book-card', role: 'listitem', type: 'button', 'aria-selected': String(selecting && selected.has(book.id)), title: `${book.title}${book.author ? ' — ' + book.author : ''}` },
      cover,
      h('div', { class: 'book-meta' }, h('div', { class: 'bt', dir: 'auto' }, book.title), h('div', { class: 'ba', dir: 'auto' }, book.author ?? (book.pageCount ? `${book.pageCount} ${t('pages').toLowerCase()}` : formatBytes(book.size)))),
    );
    // Mouse-only: on touch screens a long press is the folder menu, and a WebView
    // drag that never ends used to leave every chip with a dashed drop outline.
    if (FINE_POINTER) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/kr-book', selecting && selected.has(book.id) ? [...selected].join(',') : book.id); e.dataTransfer!.effectAllowed = 'move'; root.classList.add('dragging-book'); });
      el.addEventListener('dragend', endDrag);
    }
    let pressTimer: number | undefined;
    el.addEventListener('pointerdown', () => { pressTimer = window.setTimeout(() => { if (!selecting) { setSelecting(true); selected.add(book.id); renderGrid(); } }, 520); });
    const cancel = () => window.clearTimeout(pressTimer);
    el.addEventListener('pointerup', cancel); el.addEventListener('pointerleave', cancel); el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showDetails(book); });
    el.addEventListener('click', () => {
      if (selecting) {
        if (selected.has(book.id)) selected.delete(book.id); else selected.add(book.id);
        el.setAttribute('aria-selected', String(selected.has(book.id)));
        renderSelBar();
      } else navigate(`/read/${book.id}`);
    });
    return el;
  }

  function showDetails(book: Book) {
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(book.title, t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      s.body.style.fontSize = '14px';
      const rows: [string, string][] = [
        [t('sortAuthor'), book.author ?? t('unknownAuthor')],
        [t('format'), `${book.format.toUpperCase()} · ${book.fileName}`],
        [t('size'), formatBytes(book.size)],
        [t('added'), formatDate(book.addedAt)],
        [t('lastOpened'), formatDate(book.lastOpenedAt)],
        [t('progress'), isDone(book) ? t('doneBadge') : `${Math.round((book.progress?.pct ?? 0) * 100)}%`],
      ];
      if (book.pageCount) rows.push([t('pages'), String(book.pageCount)]);
      if (book.tags?.length) rows.push([t('tags'), book.tags.join(' · ')]);
      s.body.append(h('table', { style: { borderCollapse: 'collapse' } }, ...rows.map(([k, v]) => h('tr', null, h('td', { style: { color: 'var(--text-dim)', padding: '4px 12px 4px 0' } }, k), h('td', { dir: 'auto', style: { padding: '4px 0' } }, v)))));
      s.actions.append(
        (() => { const isFav = (book.tags ?? []).includes(FAV_TAG); return h('button', { class: 'btn small' + (isFav ? ' tonal' : ''), onclick: async () => { await setTag([book.id], FAV_TAG, !isFav); s.close(); await refresh(); toast(isFav ? t('removedFromFavorites') : t('addedToFavorites')); } }, icon(isFav ? 'heartFill' : 'heart'), isFav ? t('unfavorite') : t('favorite')); })(),
        (() => { const d = isDone(book); return h('button', { class: 'btn small' + (d ? ' tonal' : ''), onclick: async () => { await setDone([book.id], !d); s.close(); toast(d ? t('markedNotDone') : t('markedDone')); } }, icon(d ? 'undo' : 'check'), d ? t('markNotDone') : t('markDone')); })(),
        h('button', { class: 'btn small', onclick: () => { s.close(); tagsSheet([book.id]); } }, icon('tag'), t('manageTags')),
        h('button', { class: 'btn small', onclick: () => { s.close(); moveSheet([book.id]); } }, icon('folder'), t('moveToFolder')),
        h('button', { class: 'btn small', onclick: () => { void shareBooks([book.id]); } }, icon('external'), t('shareFile')),
        ...(!['image', 'cbz', 'anki', 'audio', 'unknown'].includes(book.format) ? [h('button', { class: 'btn small', onclick: () => { s.close(); void import('../ui/convert').then((m) => m.convertSheet(book, () => void refresh())); } }, icon('convert'), t('convertFile'))] : []),
        ...(book.format === 'pdf' ? [h('button', { class: 'btn small', onclick: () => { s.close(); void import('../ui/pdftools').then(async (m) => m.pdfToolsSheet(await db.allBooks(), book, () => void refresh())); } }, icon('file'), t('pdfTools'))] : []),
        h('button', { class: 'btn danger small', onclick: async () => { if (confirm(t('deleteConfirm', { n: 1 }))) { await removeBooks([book.id]); forgetCover(book.id); s.close(); await refresh(); } } }, icon('trash'), t('delete')),
        h('button', { class: 'btn primary small', onclick: () => { s.close(); navigate(`/read/${book.id}`); } }, icon('play'), book.progress ? t('continueReading') : t('open')),
      );
    });
  }

  function renderFormatChips() {
    clear(fmtChips);
    const present = new Set(books.map((b) => groupOf(b.format)));
    const groups = FORMAT_GROUPS.filter((g) => present.has(g.id));
    fmtChips.hidden = books.length < 2;
    if (fmtChips.hidden) return;
    const active = new Set(getSettings().formatFilter);
    const toggle = (id: string) => { const next = new Set(active); if (next.has(id)) next.delete(id); else next.add(id); updateSettings({ formatFilter: [...next] }); renderGrid(); };
    for (const g of groups) fmtChips.append(h('button', { type: 'button', class: 'chip small' + (active.has(g.id) ? ' on' : ''), 'aria-pressed': String(active.has(g.id)), onclick: () => toggle(g.id) }, active.has(g.id) ? icon('check') : null, h('span', { lang: g.id === 'image' ? undefined : 'en', dir: 'ltr' }, g.label)));
    // Reading status
    const st = new Set(getSettings().statusFilter);
    const states: [string, string, string][] = [['unread', t('statusUnread'), 'library'], ['reading', t('statusReading'), 'play'], ['finished', t('statusFinished'), 'check']];
    fmtChips.append(h('span', { class: 'chip-sep' }));
    for (const [id, label, ic] of states) fmtChips.append(h('button', { type: 'button', class: 'chip small' + (st.has(id) ? ' on' : ''), 'aria-pressed': String(st.has(id)), onclick: () => { const next = new Set(st); if (next.has(id)) next.delete(id); else next.add(id); updateSettings({ statusFilter: [...next] }); renderGrid(); } }, icon(st.has(id) ? 'check' : ic), h('span', null, label)));
    if (active.size || st.size) fmtChips.append(h('button', { type: 'button', class: 'chip small add', onclick: () => { updateSettings({ formatFilter: [], statusFilter: [] }); renderGrid(); } }, icon('close'), h('span', null, t('clearFilters'))));
  }

  function allTags(): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const tg of tagDefs) counts.set(tg.name, 0);
    for (const b of books) for (const name of b.tags ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name === FAV_TAG ? -1 : b.name === FAV_TAG ? 1 : natural.compare(a.name, b.name)));
  }

  function setTagFilter(name: string | null) {
    tagFilter = name;
    if (name) localStorage.setItem('kr.tag', name); else localStorage.removeItem('kr.tag');
    renderGrid();
  }

  function renderTagChips() {
    clear(tagChips);
    const tags = allTags();
    tagChips.hidden = !tags.length;
    if (!tags.length) return;
    for (const tag of tags) {
      const on = tagFilter === tag.name;
      const fav = tag.name === FAV_TAG;
      const c = h('button', { type: 'button', class: 'chip small' + (on ? ' on' : '') + (fav ? ' fav' : ''), 'aria-pressed': String(on), title: t('booksInFolder', { n: tag.count }), onclick: () => setTagFilter(on ? null : tag.name) }, on ? icon('check') : icon(fav ? 'heartFill' : 'tag'), h('span', { dir: 'auto' }, fav ? t('favorites') : tag.name));
      if (fav) { tagChips.append(c); continue; }
      c.addEventListener('contextmenu', (e) => { e.preventDefault(); tagSheet(tag.name); });
      let pt: number | undefined;
      c.addEventListener('pointerdown', () => { pt = window.setTimeout(() => tagSheet(tag.name), 560); });
      const cancel = () => window.clearTimeout(pt);
      c.addEventListener('pointerup', cancel); c.addEventListener('pointerleave', cancel);
      tagChips.append(c);
    }
    if (tagFilter) tagChips.append(h('button', { type: 'button', class: 'chip small add', 'aria-label': t('addBooks'), title: t('addBooks'), onclick: () => void addBooksToTag(tagFilter!) }, icon('plus'), h('span', null, t('addBooks'))));
  }

  async function saveTagDefs(next: TagDef[]): Promise<void> { tagDefs = next; await db.setMeta('tags', next); }
  /** Remember a tag so it stays (also when empty) until it is deleted. */
  async function declareTag(name: string): Promise<void> {
    if (name === FAV_TAG || tagDefs.some((x) => x.name === name)) return;
    await saveTagDefs([...tagDefs, { name, createdAt: Date.now() }]);
  }

  /** A searchable checklist of the library's books. */
  function bookChecklist(initial: Iterable<string>, onChange?: (n: number) => void): { el: HTMLElement; selected: Set<string>; focus: () => void } {
    const sel = new Set(initial);
    const search = h('input', { type: 'search', placeholder: t('searchLibrary'), dir: 'auto', class: 'book-pick-search' }) as HTMLInputElement;
    const count = h('span', { class: 'hint' });
    const list = h('div', { class: 'book-pick' });
    const all = [...books].sort((a, b) => natural.compare(a.title, b.title));
    let visible: Book[] = all;
    const sync = () => { count.textContent = t('selectedCount', { n: localDigits(sel.size) }); onChange?.(sel.size); };
    const draw = () => {
      const q = search.value.trim().toLocaleLowerCase();
      visible = q ? all.filter((b) => `${b.title} ${b.author ?? ''} ${b.fileName}`.toLocaleLowerCase().includes(q)) : all;
      clear(list);
      if (!visible.length) { list.append(h('p', { class: 'hint', style: { margin: '8px 2px' } }, t('noResults'))); return; }
      for (const b of visible.slice(0, 400)) {
        const url = coverUrl(b);
        const thumb = h('span', { class: 'thumb' });
        if (url) thumb.append(h('img', { src: url, alt: '', loading: 'lazy' })); else { const [c1, c2] = coverColors(b.title); thumb.style.background = `linear-gradient(160deg, ${c1}, ${c2})`; }
        const row = h('label', { class: 'book-pick-row' + (sel.has(b.id) ? ' on' : '') },
          h('input', { type: 'checkbox', checked: sel.has(b.id), onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; if (on) sel.add(b.id); else sel.delete(b.id); row.classList.toggle('on', on); sync(); } }),
          thumb,
          h('span', { class: 'meta' }, h('b', { dir: 'auto' }, b.title), b.author ? h('small', { dir: 'auto' }, b.author) : null));
        list.append(row);
      }
    };
    const toggleAll = h('button', { type: 'button', class: 'btn small', onclick: () => { const every = visible.every((b) => sel.has(b.id)); for (const b of visible) { if (every) sel.delete(b.id); else sel.add(b.id); } draw(); sync(); } }, icon('check'), t('selectAll'));
    search.addEventListener('input', draw);
    draw(); sync();
    return { el: h('div', { class: 'book-pick-wrap' }, h('div', { class: 'book-pick-bar' }, search, toggleAll), count, list), selected: sel, focus: () => search.focus() };
  }

  /** Create a tag, optionally putting some books in it right away. */
  function newTagSheet(): void {
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(t('newTag'), t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      const name = h('input', { type: 'text', placeholder: t('tagName'), dir: 'auto', style: { width: '100%' } }) as HTMLInputElement;
      const pickCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      let picker: ReturnType<typeof bookChecklist> | null = null;
      const holder = h('div', { hidden: true, style: { marginTop: '8px' } });
      const createBtn = h('button', { class: 'btn primary small', type: 'button' }, icon('check'), t('create')) as HTMLButtonElement;
      pickCb.addEventListener('change', () => {
        holder.hidden = !pickCb.checked;
        if (pickCb.checked && !picker) { picker = bookChecklist([]); holder.append(picker.el); }
      });
      const done = async () => {
        const n = name.value.trim();
        if (!n) { name.focus(); return; }
        if (n === FAV_TAG || allTags().some((x) => x.name === n)) { toast(t('tagExists'), 'error'); name.focus(); return; }
        createBtn.disabled = true;
        await declareTag(n);
        const ids = pickCb.checked && picker ? [...picker.selected] : [];
        if (ids.length) await setTag(ids, n, true);
        s.close();
        setTagFilter(n);
        toast(ids.length ? t('addedToTag', { n: localDigits(ids.length), name: n }) : t('tagCreated'));
      };
      s.body.append(
        h('form', { onsubmit: (e: Event) => { e.preventDefault(); void done(); } }, name),
        h('label', { class: 'row', hidden: !books.length, style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px' } }, h('span', { class: 'switch' }, pickCb, h('i')), h('span', null, t('addBooksNow'))),
        holder);
      createBtn.addEventListener('click', () => void done());
      s.actions.append(createBtn);
      setTimeout(() => name.focus(), 80);
    });
  }

  /** Pick books from the library to put in (or take out of) a tag. */
  function addBooksToTag(tag: string): void {
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(tag === FAV_TAG ? t('favorites') : tag, t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      const before = new Set(books.filter((b) => (b.tags ?? []).includes(tag)).map((b) => b.id));
      const picker = bookChecklist(before);
      s.body.append(picker.el);
      s.actions.append(h('button', { class: 'btn primary small', type: 'button', onclick: async () => {
        const add = [...picker.selected].filter((id) => !before.has(id));
        const drop = [...before].filter((id) => !picker.selected.has(id));
        s.close();
        if (add.length) await setTag(add, tag, true);
        if (drop.length) await setTag(drop, tag, false);
        if (add.length) toast(t('addedToTag', { n: localDigits(add.length), name: tag === FAV_TAG ? t('favorites') : tag }));
      } }, icon('check'), t('done')));
    });
  }

  async function setTag(ids: string[], name: string, on: boolean): Promise<void> {
    const at = Date.now();
    if (on) await declareTag(name);
    for (const id of ids) {
      const bk = books.find((b) => b.id === id);
      const next = new Set(bk?.tags ?? []);
      if (on) next.add(name); else next.delete(name);
      const tags = [...next];
      await db.updateBook(id, (b) => { if (tags.length) b.tags = tags; else delete b.tags; b.tagsAt = at; });
      if (bk) { if (tags.length) bk.tags = tags; else delete bk.tags; bk.tagsAt = at; }
    }
    renderGrid();
  }

  function tagsSheet(ids: string[]) {
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(t('tags'), t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      s.body.style.fontSize = '14px';
      const list = h('div', { class: 'dest-list' });
      const input = h('input', { type: 'text', placeholder: t('newTag'), dir: 'auto', style: { flex: '1' } }) as HTMLInputElement;
      const draw = () => {
        clear(list);
        const sel = books.filter((b) => ids.includes(b.id));
        const tags = allTags();
        if (!tags.length) { list.append(h('p', { style: { color: 'var(--md-on-surface-dim)', margin: '8px 2px' } }, t('noTags'))); return; }
        for (const tag of tags) {
          const on = sel.length > 0 && sel.every((b) => (b.tags ?? []).includes(tag.name));
          list.append(h('label', { class: 'dest-row' + (on ? ' on' : '') },
            h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => { void setTag(ids, tag.name, (e.target as HTMLInputElement).checked).then(draw); } }),
            icon(tag.name === FAV_TAG ? 'heartFill' : 'tag'),
            h('span', { class: 'name', dir: 'auto' }, tag.name === FAV_TAG ? t('favorites') : tag.name, h('span', { style: { color: 'var(--md-on-surface-dim)', fontSize: '12px' } }, ` · ${localDigits(tag.count)}`))));
        }
      };
      const add = () => { const name = input.value.trim(); if (!name) return; input.value = ''; void setTag(ids, name, true).then(draw); };
      s.body.append(
        h('form', { onsubmit: (e: Event) => { e.preventDefault(); add(); }, style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, input, h('button', { class: 'btn primary small', type: 'submit' }, icon('plus'), t('addTag'))),
        list);
      draw();
      s.actions.append(h('button', { class: 'btn primary small', type: 'button', onclick: () => s.close() }, icon('check'), t('done')));
    });
  }

  function tagSheet(name: string) {
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(name, t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      s.body.append(h('ul', { class: 'plain-list' },
        h('li', null, h('button', { type: 'button', onclick: async () => { s.close(); const next = await askName(t('renameTag'), name, t('tagName')); if (next && next !== name) await renameTag(name, next); } }, icon('type'), t('renameTag'))),
        h('li', null, h('button', { type: 'button', onclick: async () => { if (!confirm(t('deleteTagConfirm', { name }))) return; s.close(); await deleteTag(name); } }, icon('trash'), t('deleteTag')))));
    });
  }

  async function renameTag(from: string, to: string): Promise<void> {
    const at = Date.now();
    for (const b of books) {
      if (!(b.tags ?? []).includes(from)) continue;
      const tags = [...new Set((b.tags ?? []).map((x) => (x === from ? to : x)))];
      await db.updateBook(b.id, (x) => { x.tags = tags; x.tagsAt = at; });
      b.tags = tags; b.tagsAt = at;
    }
    await saveTagDefs([...tagDefs.filter((x) => x.name !== from && x.name !== to), { name: to, createdAt: Date.now() }]);
    void import('../sync').then((m) => m.markDeleted(`tag:${from}`)).catch(() => {});
    if (tagFilter === from) setTagFilter(to); else renderGrid();
  }

  async function deleteTag(name: string): Promise<void> {
    const at = Date.now();
    for (const b of books) {
      if (!(b.tags ?? []).includes(name)) continue;
      const tags = (b.tags ?? []).filter((x) => x !== name);
      await db.updateBook(b.id, (x) => { if (tags.length) x.tags = tags; else delete x.tags; x.tagsAt = at; });
      if (tags.length) b.tags = tags; else delete b.tags;
      b.tagsAt = at;
    }
    await saveTagDefs(tagDefs.filter((x) => x.name !== name));
    void import('../sync').then((m) => m.markDeleted(`tag:${name}`)).catch(() => {});
    if (tagFilter === name) setTagFilter(null); else renderGrid();
  }

  /** Read: marked so, or read to its end and not marked otherwise. */
  function isDone(b: Book): boolean { return b.done ?? (b.progress?.pct ?? 0) >= 0.98; }
  async function setDone(ids: string[], on: boolean): Promise<void> {
    const at = Date.now();
    for (const id of ids) {
      await db.updateBook(id, (b) => { b.done = on; b.doneAt = at; });
      const bk = books.find((b) => b.id === id); if (bk) { bk.done = on; bk.doneAt = at; }
    }
    renderGrid();
  }
  function statusOf(b: Book): string {
    const pct = b.progress?.pct ?? 0;
    if (isDone(b)) return 'finished';
    return b.lastOpenedAt || pct > 0 ? 'reading' : 'unread';
  }

  function renderChips() {
    clear(chips);
    chips.hidden = false;
    const importChip = getSettings().importButton === 'chips' ? h('button', { type: 'button', class: 'chip add import-chip', 'aria-label': t('importBooks'), title: t('importBooks'), onclick: () => importMenu() }, icon('import'), h('span', null, t('importBooks'))) : null;
    if (!books.length) { if (importChip) chips.append(importChip); else chips.hidden = true; return; }
    const chip = (label: string, id: string | null, iconName?: string) => {
      const c = h('button', { type: 'button', class: 'chip' + (activeFolder === id ? ' on' : ''), role: 'tab', 'aria-selected': String(activeFolder === id), dataset: { folder: id ?? '' }, onclick: () => { activeFolder = id; if (id) localStorage.setItem('kr.folder', id); else localStorage.removeItem('kr.folder'); renderChips(); renderGrid(); } }, iconName ? icon(iconName) : null, h('span', null, label));
      // Drop target for dragged books
      c.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/kr-book')) { e.preventDefault(); c.classList.add('drop'); } });
      c.addEventListener('dragleave', () => c.classList.remove('drop'));
      c.addEventListener('drop', async (e) => { e.preventDefault(); c.classList.remove('drop'); const ids = (e.dataTransfer?.getData('text/kr-book') ?? '').split(',').filter(Boolean); await moveBooks(ids, id); });
      if (id) { let pt: number | undefined; c.addEventListener('contextmenu', (e) => { e.preventDefault(); folderSheet(id); }); c.addEventListener('pointerdown', () => { pt = window.setTimeout(() => folderSheet(id), 560); }); const cancel = () => window.clearTimeout(pt); c.addEventListener('pointerup', cancel); c.addEventListener('pointerleave', cancel); }
      return c;
    };
    chips.append(chip(t('allBooks'), null, 'library'));
    for (const f of folders) chips.append(chip(f.name, f.id, 'folder'));
    chips.append(h('button', { type: 'button', class: 'chip add', onclick: () => void newFolder() }, icon('folderPlus'), h('span', null, t('newFolder'))));
    if (importChip) chips.append(importChip);
    chips.append(h('button', { type: 'button', class: 'chip add', onclick: () => newTagSheet() }, icon('tag'), h('span', null, t('newTag'))));
  }

  function askName(title: string, initial = '', placeholder = t('folderName')): Promise<string | null> {
    return import('../ui/dom').then(({ openSheet }) => new Promise<string | null>((resolve) => {
      const sh = openSheet(title, t('close'));
      sh.body.style.fontFamily = 'var(--font-ui)';
      const input = h('input', { type: 'text', value: initial, placeholder, style: { width: '100%' }, dir: 'auto', autofocus: true }) as HTMLInputElement;
      const done = () => { const v = input.value.trim(); sh.close(); resolve(v || null); };
      sh.body.append(h('form', { onsubmit: (e: Event) => { e.preventDefault(); done(); } }, input));
      sh.actions.append(h('button', { class: 'btn primary small', type: 'button', onclick: done }, icon('check'), initial ? t('rename') : t('create')));
      sh.el.addEventListener('transitionend', () => undefined);
      const obs = new MutationObserver(() => { if (!document.body.contains(sh.el)) { obs.disconnect(); resolve(null); } });
      obs.observe(document.body, { childList: true });
      setTimeout(() => input.focus(), 80);
    }));
  }

  async function newFolder(): Promise<string | null> {
    const name = await askName(t('newFolder'));
    if (!name) return null;
    return createFolder(name);
  }

  async function createFolder(name: string): Promise<string> {
    const f: Folder = { id: uid(), name, createdAt: Date.now() };
    folders = [...folders, f];
    await db.setMeta('folders', folders);
    renderChips(); renderGrid();
    return f.id;
  }

  async function moveBooks(ids: string[], folderId: string | null): Promise<void> {
    for (const id of ids) { await db.updateBook(id, (b) => { if (folderId) b.folderId = folderId; else delete b.folderId; }); const bk = books.find((b) => b.id === id); if (bk) { if (folderId) bk.folderId = folderId; else delete bk.folderId; } }
    setSelecting(false);
    renderGrid();
  }

  function moveSheet(ids: string[]) {
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(t('moveToFolder'), t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      const item = (name: string, iconName: string, fn: () => void) => h('li', null, h('button', { type: 'button', onclick: async () => { s.close(); await fn(); } }, icon(iconName), name));
      s.body.append(h('ul', { class: 'plain-list' },
        ...folders.map((f) => item(f.name, 'folder', () => moveBooks(ids, f.id))),
        item(t('newFolder'), 'folderPlus', async () => { const id = await newFolder(); if (id) await moveBooks(ids, id); }),
        item(t('noFolder'), 'close', () => moveBooks(ids, null))));
    });
  }

  function folderSheet(id: string) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(f.name, t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      s.body.append(h('ul', { class: 'plain-list' },
        h('li', null, h('button', { type: 'button', onclick: async () => { s.close(); const name = await askName(t('renameFolder'), f.name); if (name) { f.name = name; await db.setMeta('folders', folders); renderChips(); renderGrid(); } } }, icon('type'), t('renameFolder'))),
        h('li', null, h('button', { type: 'button', onclick: async () => { if (!confirm(t('deleteFolderConfirm', { name: f.name }))) return; folders = folders.filter((x) => x.id !== id); await db.setMeta('folders', folders); for (const b of books) if (b.folderId === id) { delete b.folderId; await db.updateBook(b.id, (bb) => { delete bb.folderId; }); } if (activeFolder === id) { activeFolder = null; localStorage.removeItem('kr.folder'); } renderChips(); renderGrid(); s.close(); } }, icon('trash'), t('deleteFolder')))));
    });
  }

  let prewarmed = '';
  function renderResume() {
    clear(resume);
    const last = [...books].filter((b) => b.lastOpenedAt && !isDone(b)).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
    resume.hidden = !last || selecting || !!query || !!activeFolder || !!tagFilter;
    if (resume.hidden || !last) return;
    if (prewarmed !== last.id) { prewarmed = last.id; prewarm(last, () => db.getFile(last.id)); }
    const pct = Math.round((last.progress?.pct ?? 0) * 100);
    const cover = h('div', { class: 'cover' });
    const url = coverUrl(last);
    if (url) cover.appendChild(h('img', { src: url, alt: '' })); else { const [c1, c2] = coverColors(last.title); cover.style.background = `linear-gradient(160deg, ${c1}, ${c2})`; }
    resume.append(
      cover,
      h('div', { class: 'resume-meta' },
        h('div', { class: 'eyebrow' }, t('continueReading')),
        h('div', { class: 'bt', dir: 'auto' }, last.title),
        h('div', { class: 'sub' }, last.author ? h('bdi', null, last.author) : null, last.author ? ' · ' : null, h('bdi', null, `${localDigits(pct)}%`)),
        h('div', { class: 'bar' }, h('span', { style: { width: `${pct}%` } }))),
      h('button', { class: 'btn primary small', type: 'button', onclick: () => navigate(`/read/${last.id}`) }, icon('play'), t('open')));
  }

  function renderGoal() {
    const goal = getSettings().readingGoalMinutes;
    const today = books.reduce((a, b) => a + ((liveStatsOf(b.id) ?? b.stats)?.days[todayKey()]?.ms ?? 0), 0);
    clear(heroGoal);
    heroGoal.hidden = !goal;
    if (!goal) return;
    heroGoal.append(
      h('span', null, `${t('today')}: ${formatDuration(today)} · ${countMinutes(goal)}`),
      h('div', { class: 'bar' }, h('span', { style: { width: `${Math.min(100, (today / (goal * 60000)) * 100)}%` } })));
  }

  function renderGrid() {
    clear(grid);
    renderResume();
    renderGoal();
    renderSelBar();
    renderChips();
    renderTagChips();
    renderFormatChips();
    const list = sorted();
    heroSub.textContent = books.length ? `${countBooks(books.length)} · ${t('tagline')}` : t('tagline');
    applyImportPlace();
    if (!books.length) {
      grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('div', { class: 'glyph' }, icon('empty')), h('h2', null, t('emptyLibraryTitle')), h('p', null, t('emptyLibraryBody')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary large', onclick: () => importMenu() }, icon('import'), t('importBooks')),
          h('button', { class: 'btn tonal large', onclick: () => void addSamples() }, icon('books'), t('sampleBooks'))),
        h('p', { style: { fontSize: '13px' } }, t('sampleBooksBody'))));
      return;
    }
    if (!list.length && tagFilter && !query) {
      const tag = tagFilter;
      grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('div', { class: 'glyph' }, icon(tag === FAV_TAG ? 'heart' : 'tag')), h('p', null, t('emptyTagBody')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => addBooksToTag(tag) }, icon('plus'), t('addBooks')),
          h('button', { class: 'btn', onclick: () => setTagFilter(null) }, icon('close'), t('clearFilters')))));
      return;
    }
    if (!list.length) { grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('p', null, tagFilter && !query ? t('noTaggedBooks') : activeFolder && !query ? t('emptyFolder') : t('noResults')),
      tagFilter && !query ? h('button', { class: 'btn small', onclick: () => setTagFilter(null) }, icon('close'), t('clearFilters')) : activeFolder && !query ? h('button', { class: 'btn small', onclick: () => input.click() }, icon('import'), t('importHere')) : null)); return; }
    if (getSettings().libraryView === 'cards' && !activeFolder && !query && !tagFilter) folders.forEach((f) => grid.appendChild(folderCard(f)));
    list.forEach((b) => grid.appendChild(card(b)));
  }

  async function addSamples() {
    toast(t('addingSamples'), 'info', 60000);
    try {
      const { importSamples } = await import('../samples');
      const added = await importSamples();
      toast(t('imported', { n: added.length }));
      await refresh();
    } catch (err) {
      toast(t('importFailed', { name: 'samples', error: String((err as Error)?.message ?? err) }), 'error', 5000);
    }
  }

  async function refresh() {
    books = await listBooks();
    folders = (await db.getMeta<Folder[]>('folders')) ?? [];
    tagDefs = (await db.getMeta<TagDef[]>('tags')) ?? [];
    if (activeFolder && !folders.some((f) => f.id === activeFolder)) activeFolder = null;
    if (tagFilter && !tagDefs.some((x) => x.name === tagFilter) && !books.some((b) => (b.tags ?? []).includes(tagFilter!))) { tagFilter = null; localStorage.removeItem('kr.tag'); }
    renderGrid();
  }

  async function doImport(files: FileList | File[], folderId: string | null = activeFolder) {
    const n = files.length;
    toast(t('importing', { n }), 'info', 60000);
    let ok = 0;
    const target = folderId;
    await importFiles(files, (book, file, err) => {
      if (book) { ok++; if (target) void db.updateBook(book.id, (b) => { b.folderId = target; }); } else toast(t('importFailed', { name: file.name, error: String((err as Error)?.message ?? err) }), 'error', 5000);
    });
    if (ok) toast(t('imported', { n: ok }));
    await refresh();
  }

  // Drag and drop anywhere on the view.
  let overlay: HTMLElement | null = null;
  let dragDepth = 0;
  root.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; if (!overlay) { overlay = h('div', { class: 'drop-overlay' }, t('dropHint')); document.body.appendChild(overlay); } });
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay?.remove(); overlay = null; } });
  root.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; overlay?.remove(); overlay = null; if (e.dataTransfer?.files.length) void doImport(e.dataTransfer.files); });

  // Files handed to the installed app (PWA file handling).
  const lq = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    const files = await Promise.all(params.files.map((fh) => fh.getFile()));
    if (files.length) { const added = await importFiles(files); await refresh(); if (added.length) navigate(`/read/${added.map((b) => b.id).join(',')}`); }
  });

  // Back from a book opened from the search across books: that search opens again, as it was.
  void refresh().then(async () => {
    try { if (!sessionStorage.getItem('kr.searchReturn')) return; } catch { return; }
    const { takeReturn } = await import('../booksearch');
    const back = takeReturn();
    if (back && root.isConnected) void import('../ui/librarysearch').then((m) => m.librarySearchSheet(books, folders, activeFolder, back));
  });
  return root;
}
