import { h, icon, iconButton, toast, clear, coverColors } from '../ui/dom';
import { t, formatBytes, formatDate } from '../i18n';
import { importFiles, listBooks, removeBooks, coverUrl, forgetCover } from '../library';
import type { Book } from '../db';
import { SUPPORTED_ACCEPT } from '../formats';
import { navigate } from '../router';

type Sort = 'recent' | 'added' | 'title' | 'author';

export function libraryView(): HTMLElement {
  let books: Book[] = [];
  let query = '';
  let sort: Sort = (localStorage.getItem('kr.sort') as Sort) || 'recent';
  let selecting = false;
  const selected = new Set<string>();

  const input = h('input', { type: 'file', multiple: true, accept: SUPPORTED_ACCEPT, hidden: true }) as HTMLInputElement;
  input.addEventListener('change', () => { if (input.files?.length) void doImport(input.files); input.value = ''; });

  const search = h('input', { type: 'search', placeholder: t('searchLibrary'), 'aria-label': t('searchLibrary'), oninput: () => { query = search.value.trim().toLowerCase(); renderGrid(); } }) as HTMLInputElement;
  const sortSel = h('select', { 'aria-label': t('sortBy'), onchange: () => { sort = sortSel.value as Sort; localStorage.setItem('kr.sort', sort); renderGrid(); } },
    h('option', { value: 'recent' }, t('sortRecent')), h('option', { value: 'added' }, t('sortAdded')), h('option', { value: 'title' }, t('sortTitle')), h('option', { value: 'author' }, t('sortAuthor'))) as HTMLSelectElement;
  sortSel.value = sort;

  const grid = h('div', { class: 'book-grid', role: 'list' });
  const heroSub = h('div', { class: 'sub' });
  const hero = h('div', { class: 'library-hero' }, h('h1', { class: 'display' }, t('library')), heroSub);
  const body = h('div', { class: 'library-body' },
    hero,
    h('div', { class: 'library-tools' }, search, sortSel),
    grid);

  const selectBtn = iconButton('check', t('select'), () => setSelecting(!selecting), { pressed: false });
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand title' }, h('img', { src: '/icons/icon.svg', alt: '' }), t('appName')),
    selectBtn,
    iconButton('settings', t('settings'), () => navigate('/settings')),
  );
  const fab = h('button', { class: 'fab', type: 'button', onclick: () => input.click() }, icon('import'), h('span', null, t('importBooks')));

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
    const list = books.filter((b) => !query || `${b.title} ${b.author ?? ''} ${b.fileName}`.toLowerCase().includes(query));
    const by: Record<Sort, (a: Book, b: Book) => number> = {
      recent: (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt),
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => a.title.localeCompare(b.title),
      author: (a, b) => (a.author ?? '￿').localeCompare(b.author ?? '￿') || a.title.localeCompare(b.title),
    };
    return list.sort(by[sort]);
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
        h('button', { class: 'btn danger small', onclick: async () => { if (confirm(t('deleteConfirm', { n: 1 }))) { await removeBooks([book.id]); forgetCover(book.id); s.close(); await refresh(); } } }, icon('trash'), t('delete')),
        h('button', { class: 'btn primary small', onclick: () => { s.close(); navigate(`/read/${book.id}`); } }, icon('play'), book.progress ? t('continueReading') : t('open')),
      );
    });
  }

  function renderGrid() {
    clear(grid);
    renderSelBar();
    const list = sorted();
    heroSub.textContent = books.length ? `${books.length} · ${t('tagline')}` : t('tagline');
    fab.hidden = selecting;
    if (!books.length) {
      grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('div', { class: 'glyph' }, icon('empty')), h('h2', null, t('emptyLibraryTitle')), h('p', null, t('emptyLibraryBody')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary large', onclick: () => input.click() }, icon('import'), t('importBooks')),
          h('button', { class: 'btn tonal large', onclick: () => void addSamples() }, icon('books'), t('sampleBooks'))),
        h('p', { style: { fontSize: '13px' } }, t('sampleBooksBody'))));
      return;
    }
    if (!list.length) { grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('p', null, t('noResults')))); return; }
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
    renderGrid();
  }

  async function doImport(files: FileList | File[]) {
    const n = files.length;
    toast(t('importing', { n }), 'info', 60000);
    let ok = 0;
    await importFiles(files, (book, file, err) => {
      if (book) ok++; else toast(t('importFailed', { name: file.name, error: String((err as Error)?.message ?? err) }), 'error', 5000);
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
