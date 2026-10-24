// Bookmarks & notes across the whole library: every bookmark, every highlight
// with a note and every PDF pin, grouped by book; tap to open the book there.
import { h, icon, iconButton, toast } from '../ui/dom';
import { t, formatDate, localDigits } from '../i18n';
import { db, type Book } from '../db';
import { listBooks, coverUrl } from '../library';
import { navigate } from '../router';
import { setJump } from './reader';
import { markDeleted } from '../sync';

export function notesView(): HTMLElement {
  const body = h('div', { class: 'library-body notes-view' });
  const root = h('div', { class: 'view notes-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/')), h('div', { class: 'title' }, t('allNotes'))),
    body);
  let filter: 'all' | 'bookmarks' | 'notes' = 'all';
  const chips = h('div', { class: 'folder-chips', role: 'tablist' });
  const list = h('div');
  body.append(chips, list);

  async function render() {
    const books = (await listBooks()).filter((b) => b.bookmarks.length || b.highlights.some((x) => x.note) || b.pins?.length || b.pdfHighlights?.some((x) => x.note));
    chips.replaceChildren(...([['all', t('allBooks')], ['bookmarks', t('bookmarks')], ['notes', t('notes')]] as [typeof filter, string][]).map(([id, label]) =>
      h('button', { type: 'button', class: 'chip' + (filter === id ? ' on' : ''), onclick: () => { filter = id; void render(); } }, h('span', null, label))));
    list.replaceChildren();
    if (!books.length) { list.append(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('bookmark')), h('h2', null, t('allNotes')), h('p', null, t('noNotesAnywhere')))); return; }
    for (const book of books.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt))) list.append(bookSection(book));
  }

  function bookSection(book: Book): HTMLElement {
    const cover = h('div', { class: 'cover' });
    const url = coverUrl(book);
    if (url) cover.appendChild(h('img', { src: url, alt: '' }));
    const items = h('ul', { class: 'plain-list' });
    const open = (kind: 'bm' | 'hl' | 'pin', id: string) => { setJump({ bookId: book.id, kind, id }); navigate(`/read/${book.id}`); };
    if (filter !== 'notes') for (const bm of [...book.bookmarks].sort((a, b) => b.createdAt - a.createdAt)) {
      items.append(h('li', null,
        h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '2px' }, onclick: () => open('bm', bm.id) },
          h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, icon('bookmark'), h('span', { dir: 'auto' }, bm.label), h('span', { class: 'meta' }, formatDate(bm.createdAt))),
          bm.excerpt ? h('span', { class: 'meta', dir: 'auto' }, bm.excerpt) : null),
        h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(bm.id); await db.updateBook(book.id, (b) => { b.bookmarks = b.bookmarks.filter((x) => x.id !== bm.id); }); void render(); } }, icon('trash'))));
    }
    if (filter !== 'bookmarks') {
      book.highlights.filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt).forEach((hl, i) => {
        items.append(h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => open('hl', hl.id) },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta', dir: 'auto' }, hl.text.length > 120 ? hl.text.slice(0, 120) + '…' : hl.text)),
            h('span', { dir: 'auto' }, hl.note!)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { await db.updateBook(book.id, (b) => { const x = b.highlights.find((y) => y.id === hl.id); if (x) x.note = undefined; }); void render(); } }, icon('trash'))));
      });
      (book.pdfHighlights ?? []).filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt).forEach((hl, i) => {
        items.append(h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => open('hl', hl.id) },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta', dir: 'auto' }, hl.text.length > 120 ? hl.text.slice(0, 120) + '…' : hl.text)),
            h('span', { dir: 'auto' }, hl.note!)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { await db.updateBook(book.id, (b) => { const x = (b.pdfHighlights ?? []).find((y) => y.id === hl.id); if (x) x.note = undefined; }); void render(); } }, icon('trash'))));
      });
      (book.pins ?? []).sort((a, b) => a.createdAt - b.createdAt).forEach((pin, i) => {
        items.append(h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => open('pin', pin.id) },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta' }, t('pageOf', { n: pin.page, total: book.pageCount ?? pin.page }))),
            h('span', { dir: 'auto' }, pin.note)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(pin.id); await db.updateBook(book.id, (b) => { b.pins = (b.pins ?? []).filter((x) => x.id !== pin.id); }); void render(); } }, icon('trash'))));
      });
    }
    if (!items.children.length) return h('div');
    return h('section', { class: 'notes-book' },
      h('div', { class: 'notes-head', onclick: () => navigate(`/read/${book.id}`) }, cover, h('div', null, h('div', { class: 'bt', dir: 'auto' }, book.title), h('div', { class: 'sub' }, [book.author, t('itemsCount', { n: items.children.length })].filter(Boolean).join(' · ')))),
      items);
  }

  void render().catch((err) => toast(String((err as Error).message ?? err), 'error'));
  return root;
}
