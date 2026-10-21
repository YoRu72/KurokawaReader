import { h, icon, iconButton, toast, clear, coverColors } from '../ui/dom';
import { t, formatBytes, formatDate, countBooks } from '../i18n';
import { importFiles, listBooks, removeBooks, coverUrl, forgetCover } from '../library';
import { db, uid, type Book, type Folder } from '../db';
import { SUPPORTED_ACCEPT } from '../formats';
import { navigate } from '../router';
import { getSettings, updateSettings, onSettingsChange } from '../settings';
import { openScanSheet, FORMAT_GROUPS, groupOf, canScan, type Destination } from '../ui/scan';

type Sort = 'title' | 'recent' | 'added' | 'author' | 'size';
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function libraryView(): HTMLElement {
  let books: Book[] = [];
  let query = '';
  let sort: Sort = (localStorage.getItem('kr.sort') as Sort) || 'title';
  let folders: Folder[] = [];
  let activeFolder: string | null = localStorage.getItem('kr.folder') || null;
  let selecting = false;
  const selected = new Set<string>();

  const input = h('input', { type: 'file', multiple: true, accept: SUPPORTED_ACCEPT, hidden: true }) as HTMLInputElement;
  input.addEventListener('change', () => { if (input.files?.length) void doImport(input.files); input.value = ''; });

  const search = h('input', { type: 'search', placeholder: t('searchLibrary'), 'aria-label': t('searchLibrary'), oninput: () => { query = search.value.trim().toLowerCase(); renderGrid(); } }) as HTMLInputElement;
  const sortSel = h('select', { 'aria-label': t('sortBy'), onchange: () => { sort = sortSel.value as Sort; localStorage.setItem('kr.sort', sort); renderGrid(); } },
    h('option', { value: 'title' }, t('sortTitleNum')), h('option', { value: 'recent' }, t('sortRecent')), h('option', { value: 'added' }, t('sortAdded')), h('option', { value: 'author' }, t('sortAuthor')), h('option', { value: 'size' }, t('sortSize'))) as HTMLSelectElement;
  sortSel.value = sort;

  const grid = h('div', { class: 'book-grid', role: 'list' });
  const chips = h('div', { class: 'folder-chips', role: 'tablist' });
  const fmtChips = h('div', { class: 'format-chips', role: 'group', 'aria-label': t('filterFormats') });
  const heroSub = h('div', { class: 'sub' });
  const hero = h('div', { class: 'library-hero' }, h('h1', { class: 'display' }, t('library')), heroSub);
  const body = h('div', { class: 'library-body' },
    hero,
    h('div', { class: 'library-tools' }, search, sortSel),
    chips,
    fmtChips,
    grid);

  const selectBtn = iconButton('check', t('select'), () => setSelecting(!selecting), { pressed: false });
  const importTopBtn = iconButton('import', t('importBooks'), () => importMenu());
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand title' }, h('img', { src: '/icons/icon.svg', alt: '' }), t('appName')),
    importTopBtn,
    selectBtn,
    iconButton('settings', t('settings'), () => navigate('/settings')),
  );
  const fab = h('button', { class: 'fab', type: 'button', onclick: () => importMenu() }, icon('import'), h('span', null, t('importBooks')));
  const applyImportPlace = () => { const top = getSettings().importButton === 'top'; importTopBtn.hidden = !top; fab.hidden = selecting || top; };
  onSettingsChange(() => { applyImportPlace(); renderChips(); });

  /** Pick files, or scan a folder on the device. */
  function importMenu() {
    if (!canScan()) { input.click(); return; }
    import('../ui/dom').then(({ openSheet }) => {
      const s = openSheet(t('importBooks'), t('close'));
      s.body.style.fontFamily = 'var(--font-ui)';
      s.body.append(h('ul', { class: 'plain-list' },
        h('li', null, h('button', { type: 'button', onclick: () => { s.close(); input.click(); } }, icon('import'), t('importBooks'))),
        h('li', null, h('button', { type: 'button', onclick: () => { s.close(); openScan(); } }, icon('folder'), t('scanDevice')))));
    });
  }
  function openScan() {
    openScanSheet({
      folders, activeFolder,
      existing: new Set(books.map((b) => `${b.fileName}:${b.size}`)),
      fallbackPick: () => input.click(),
      onImport: async (files, dest) => {
        let target: string | null = null;
        if (dest.kind === 'folder') target = dest.id;
        else if (dest.kind === 'new') target = await newFolder();
        await doImport(files, target);
      },
    });
  }

  const selBar = h('div', { class: 'selection-bar', hidden: true });
  const root = h('div', { class: 'view library-view' }, topbar, body, selBar, fab, input);

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
    selBar.append(
      h('span', null, t('selectedCount', { n })),
      h('button', { class: 'btn small', onclick: () => { books.forEach((b) => selected.add(b.id)); renderGrid(); } }, t('selectAll')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', disabled: n === 0, onclick: () => moveSheet([...selected]) }, icon('folder'), t('moveToFolder')),
      h('button', { class: 'btn small danger', disabled: n === 0, onclick: async () => {
        if (!confirm(t('deleteConfirm', { n }))) return;
        await removeBooks([...selected]);
        selected.forEach(forgetCover);
        setSelecting(false);
        await refresh();
      } }, icon('trash'), t('delete')),
      h('button', { class: 'btn small primary', disabled: n === 0, onclick: () => {
        const ids = sorted().filter((b) => selected.has(b.id)).map((b) => b.id);
        navigate(`/read/${ids.join(',')}`);
      } }, icon('books'), n > 1 ? t('openTogether') : t('open')),
    );
  }

  function sorted(): Book[] {
    const cards = getSettings().libraryView === 'cards';
    const fmt = new Set(getSettings().formatFilter);
    const list = books.filter((b) => {
      if (fmt.size && !fmt.has(groupOf(b.format))) return false;
      const inFolder = activeFolder ? b.folderId === activeFolder : (cards && !query ? !b.folderId || !folders.some((f) => f.id === b.folderId) : true);
      return inFolder && (!query || `${b.title} ${b.author ?? ''} ${b.fileName}`.toLowerCase().includes(query));
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
    const pct = Math.round((book.progress?.pct ?? 0) * 100);
    const cover = h('div', { class: 'cover' },
      url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('div', { class: 'gen', style: { '--c1': c1, '--c2': c2 } as unknown as Record<string, string> }, h('div', { class: 't', dir: 'auto' }, book.title), h('div', { class: 'a', dir: 'auto' }, book.author ?? '')),
      h('span', { class: 'badge' }, book.format.toUpperCase()),
      pct > 0 ? h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })) : null,
      selecting ? h('div', { class: 'check' }, icon('check')) : null,
    );
    (cover.querySelector('.gen') as HTMLElement | null)?.style.setProperty('--c1', c1);
    (cover.querySelector('.gen') as HTMLElement | null)?.style.setProperty('--c2', c2);
    const el = h('button', { class: 'book-card', role: 'listitem', type: 'button', 'aria-selected': String(selecting && selected.has(book.id)), title: `${book.title}${book.author ? ' — ' + book.author : ''}` },
      cover,
      h('div', { class: 'book-meta' }, h('div', { class: 'bt', dir: 'auto' }, book.title), h('div', { class: 'ba', dir: 'auto' }, book.author ?? (book.pageCount ? `${book.pageCount} ${t('pages').toLowerCase()}` : formatBytes(book.size)))),
    );
    el.draggable = true;
    el.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/kr-book', selecting && selected.has(book.id) ? [...selected].join(',') : book.id); e.dataTransfer!.effectAllowed = 'move'; root.classList.add('dragging-book'); });
    el.addEventListener('dragend', () => root.classList.remove('dragging-book'));
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
        [t('progress'), `${Math.round((book.progress?.pct ?? 0) * 100)}%`],
      ];
      if (book.pageCount) rows.push([t('pages'), String(book.pageCount)]);
      s.body.append(h('table', { style: { borderCollapse: 'collapse' } }, ...rows.map(([k, v]) => h('tr', null, h('td', { style: { color: 'var(--text-dim)', padding: '4px 12px 4px 0' } }, k), h('td', { dir: 'auto', style: { padding: '4px 0' } }, v)))));
      s.actions.append(
        h('button', { class: 'btn small', onclick: () => { s.close(); moveSheet([book.id]); } }, icon('folder'), t('moveToFolder')),
        h('button', { class: 'btn danger small', onclick: async () => { if (confirm(t('deleteConfirm', { n: 1 }))) { await removeBooks([book.id]); forgetCover(book.id); s.close(); await refresh(); } } }, icon('trash'), t('delete')),
        h('button', { class: 'btn primary small', onclick: () => { s.close(); navigate(`/read/${book.id}`); } }, icon('play'), book.progress ? t('continueReading') : t('open')),
      );
    });
  }

  function renderFormatChips() {
    clear(fmtChips);
    const present = new Set(books.map((b) => groupOf(b.format)));
    const groups = FORMAT_GROUPS.filter((g) => present.has(g.id));
    fmtChips.hidden = groups.length < 2;
    if (fmtChips.hidden) return;
    const active = new Set(getSettings().formatFilter);
    const toggle = (id: string) => { const next = new Set(active); if (next.has(id)) next.delete(id); else next.add(id); updateSettings({ formatFilter: [...next] }); renderGrid(); };
    for (const g of groups) fmtChips.append(h('button', { type: 'button', class: 'chip small' + (active.has(g.id) ? ' on' : ''), 'aria-pressed': String(active.has(g.id)), onclick: () => toggle(g.id) }, active.has(g.id) ? icon('check') : null, h('span', { lang: g.id === 'image' ? undefined : 'en', dir: 'ltr' }, g.label)));
    if (active.size) fmtChips.append(h('button', { type: 'button', class: 'chip small add', onclick: () => { updateSettings({ formatFilter: [] }); renderGrid(); } }, icon('close'), h('span', null, t('clearFilters'))));
  }

  function renderChips() {
    clear(chips);
    chips.hidden = false;
    if (!books.length) return;
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
  }

  function askName(title: string, initial = ''): Promise<string | null> {
    return import('../ui/dom').then(({ openSheet }) => new Promise<string | null>((resolve) => {
      const sh = openSheet(title, t('close'));
      sh.body.style.fontFamily = 'var(--font-ui)';
      const input = h('input', { type: 'text', value: initial, placeholder: t('folderName'), style: { width: '100%' }, dir: 'auto', autofocus: true }) as HTMLInputElement;
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

  function renderGrid() {
    clear(grid);
    renderSelBar();
    renderChips();
    renderFormatChips();
    const list = sorted();
    heroSub.textContent = books.length ? `${countBooks(books.length)} · ${t('tagline')}` : t('tagline');
    applyImportPlace();
    if (!books.length) {
      grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('div', { class: 'glyph' }, icon('empty')), h('h2', null, t('emptyLibraryTitle')), h('p', null, t('emptyLibraryBody')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary large', onclick: () => input.click() }, icon('import'), t('importBooks')),
          h('button', { class: 'btn tonal large', onclick: () => void addSamples() }, icon('books'), t('sampleBooks'))),
        h('p', { style: { fontSize: '13px' } }, t('sampleBooksBody'))));
      return;
    }
    if (!list.length) { grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('p', null, activeFolder && !query ? t('emptyFolder') : t('noResults')), activeFolder && !query ? h('button', { class: 'btn small', onclick: () => input.click() }, icon('import'), t('importHere')) : null)); return; }
    if (getSettings().libraryView === 'cards' && !activeFolder && !query) folders.forEach((f) => grid.appendChild(folderCard(f)));
    list.forEach((b) => grid.appendChild(card(b)));
    if (getSettings().libraryView === 'cards' && !activeFolder && !query) grid.appendChild(h('button', { class: 'book-card folder-card add', type: 'button', onclick: () => void newFolder() }, h('div', { class: 'cover folder' }, icon('folderPlus')), h('div', { class: 'book-meta' }, h('div', { class: 'bt' }, t('newFolder')))));
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
    if (activeFolder && !folders.some((f) => f.id === activeFolder)) activeFolder = null;
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

  void refresh();
  return root;
}
