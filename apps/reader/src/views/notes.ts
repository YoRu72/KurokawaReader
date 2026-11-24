// Bookmarks & notes across the whole library: every bookmark, every highlight
// with a note and every PDF pin, grouped by book; tap to open the book there.
import { h, icon, iconButton, toast } from '../ui/dom';
import { fits } from '../platform';
import { buildIndex, filterIndex, marked, matchStart, otherTitleHits, foldKey, type BookEntries } from '../notessearch';
import { t, formatDate, localDigits, countItems } from '../i18n';
import { db, stampAfter, type Book } from '../db';
import { listBooks, coverUrl } from '../library';
import { navigate, back } from '../router';
import { setJump } from '../jump';
import { markDeleted, scheduleSync } from '../sync';
import { offerPutBack, offerNoteBack } from '../undoitems';
import { copyText } from '../ui/share';
import { markLines, pdfMarkLines, pinLines, listedNotesMarkdown } from '../ui/exportnotes';

export function notesView(): HTMLElement {
  const body = h('div', { class: 'library-body notes-view' });
  const root = h('div', { class: 'view notes-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/')), h('div', { class: 'title' }, t('allNotes'))),
    body);
  let filter: 'all' | 'bookmarks' | 'notes' = 'all';
  // (Each book's entries start folded under it — the page a list of books; the ones opened stay open. With a search,
  // the books holding a match are open, as far as 150 entries go: the rest are one tap away.)
  const open = new Set<string>(); const shut = new Set<string>();
  let query = ''; let qf = ''; let timer = 0;
  let data: BookEntries[] = [];
  /** Many entries (over 300 in all): a section makes its rows only when it is open — five thousand notes are not five thousand rows. */
  let lazy = false;
  const mark = (s: string) => h('mark', { class: 'ns-mark' }, s);
  const chips = h('div', { class: 'folder-chips', role: 'tablist' });
  const clearBtn = iconButton('close', t('notesSearchClear'), () => { search.value = ''; typed(); search.focus(); }); clearBtn.classList.add('ns-clear'); clearBtn.hidden = true;
  const search = h('input', { type: 'text', inputmode: 'search', enterkeyhint: 'search', autocomplete: 'off', class: 'ns-search', placeholder: t('notesSearch'), 'aria-label': t('notesSearch'),
    oninput: () => { clearBtn.hidden = !search.value; window.clearTimeout(timer); timer = window.setTimeout(typed, 110); },
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ''; typed(); } } }) as HTMLInputElement;
  const typed = () => { clearBtn.hidden = !search.value; query = search.value.trim(); qf = query ? foldKey(query, true) : ''; draw(); };
  const list = h('div');
  body.append(h('div', { class: 'ns-box' }, search, clearBtn), chips, list);
  // (On a computer «/» or Ctrl+F goes to the search, as in the glossary.)
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) { window.removeEventListener('keydown', onKey, true); return; }
    const tg = e.target as HTMLElement | null; const typing = !!tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable);
    const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing; const find = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f';
    if ((!slash && !find) || !fits('computer') || document.querySelector('.sheet')) return;
    e.preventDefault(); e.stopPropagation(); search.focus(); search.select();
  };
  window.addEventListener('keydown', onKey, true);

  // (Undo, here: the list drawn again with what is stored — src/undoitems.ts.)
  const again = () => void render(); const alive = () => root.isConnected;
  /** Read again from what is stored (first draw, and after a deletion or an Undo). */
  async function render() {
    data = buildIndex(await listBooks()).sort((a, b) => (b.book.lastOpenedAt ?? b.book.addedAt) - (a.book.lastOpenedAt ?? a.book.addedAt));
    lazy = data.reduce((n, b) => n + b.entries.length, 0) > 300;
    draw();
  }
  /** The page drawn from what was read: the filter chip, the search. */
  function draw() {
    chips.replaceChildren(...([['all', t('allBooks')], ['bookmarks', t('bookmarks')], ['notes', t('notes')]] as [typeof filter, string][]).map(([id, label]) =>
      h('button', { type: 'button', class: 'chip' + (filter === id ? ' on' : ''), onclick: () => { filter = id; draw(); } }, h('span', null, label))));
    list.replaceChildren();
    if (!data.length) { list.append(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('bookmark')), h('h2', null, t('allNotes')), h('p', null, t('noNotesAnywhere')))); return; }
    const vis = filterIndex(data, query, filter);
    let budget = 150; let shown = 0;
    for (const b of data) {
      const ids = vis.get(b.book.id); if (!ids) continue;
      const autoOpen = !!qf && budget > 0 && !shut.has(b.book.id); if (autoOpen) budget -= ids.size;
      list.append(bookSection(b.book, ids, qf ? autoOpen : open.has(b.book.id))); shown++;
    }
    if (!shown) list.append(h('div', { class: 'empty ns-empty' }, h('div', { class: 'glyph' }, icon('search')), h('h2', null, query ? t('notesNoMatch', { q: query }) : t('allNotes')), h('p', null, query ? t('notesNoMatchHint') : t('noNotesAnywhere'))));
  }

  function bookSection(book: Book, vis: Set<string>, isOpen: boolean): HTMLElement {
    const cover = h('div', { class: 'cover' });
    const url = coverUrl(book);
    if (url) cover.appendChild(h('img', { src: url, alt: '' }));
    const items = h('ul', { class: 'plain-list' });
    const go = (kind: 'bm' | 'hl' | 'pin', id: string) => { setJump({ bookId: book.id, kind, id }); navigate(`/read/${book.id}`); };
    const mk = (s: string) => marked(s, qf, mark);
    // (Each entry as a function: a library with many notes makes the rows of a section only when it is open.)
    const makers: (() => HTMLElement)[] = [];
    if (filter !== 'notes') for (const bm of [...book.bookmarks].sort((a, b) => b.createdAt - a.createdAt)) {
      if (!vis.has(bm.id)) continue;
      makers.push(() => h('li', null,
        h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '2px' }, onclick: () => go('bm', bm.id) },
          h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, icon('bookmark'), h('span', { dir: 'auto' }, ...mk(bm.label)), h('span', { class: 'meta' }, formatDate(bm.createdAt))),
          bm.excerpt ? h('span', { class: 'meta', dir: 'auto' }, ...mk(bm.excerpt)) : null),
        h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(bm.id); await db.updateBook(book.id, (b) => { b.bookmarks = b.bookmarks.filter((x) => x.id !== bm.id); }); void render(); offerPutBack(t('bookmarkDeleted'), book.id, 'bookmarks', bm, again, alive); } }, icon('trash'))));
    }
    if (filter !== 'bookmarks') {
      book.highlights.filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt).forEach((hl, i) => {
        if (!vis.has(hl.id)) return;
        makers.push(() => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => go('hl', hl.id) },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta', dir: 'auto' }, ...mk(hl.text.length > 120 && !qf ? hl.text.slice(0, 120) + '…' : around(hl.text)))),
            h('span', { dir: 'auto' }, ...mk(hl.note!))),
          iconButton('copy', t('copy'), () => void copyText(markLines(hl).join('\n').trim())),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { const was = hl.note; await db.updateBook(book.id, (b) => { const x = b.highlights.find((y) => y.id === hl.id); if (x) { x.note = undefined; x.noteAt = stampAfter(x.noteAt); } }); scheduleSync(); void render(); if (was) offerNoteBack(t('noteDeleted'), book.id, 'highlights', hl.id, was, again, alive); } }, icon('trash'))));
      });
      (book.pdfHighlights ?? []).filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt).forEach((hl, i) => {
        if (!vis.has(hl.id)) return;
        makers.push(() => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => go('hl', hl.id) },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta', dir: 'auto' }, ...mk(hl.text.length > 120 && !qf ? hl.text.slice(0, 120) + '…' : around(hl.text)))),
            h('span', { dir: 'auto' }, ...mk(hl.note!))),
          iconButton('copy', t('copy'), () => void copyText(pdfMarkLines(book, hl).join('\n').trim())),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { const was = hl.note; await db.updateBook(book.id, (b) => { const x = (b.pdfHighlights ?? []).find((y) => y.id === hl.id); if (x) { x.note = undefined; x.noteAt = stampAfter(x.noteAt); } }); scheduleSync(); void render(); if (was) offerNoteBack(t('noteDeleted'), book.id, 'pdfHighlights', hl.id, was, again, alive); } }, icon('trash'))));
      });
      (book.pins ?? []).sort((a, b) => a.createdAt - b.createdAt).forEach((pin, i) => {
        if (!vis.has(pin.id)) return;
        makers.push(() => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => go('pin', pin.id) },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta' }, t('pageOf', { n: pin.page, total: book.pageCount ?? pin.page }))),
            h('span', { dir: 'auto' }, ...mk(pin.note))),
          iconButton('copy', t('copy'), () => void copyText(pinLines(book, pin).join('\n').trim())),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(pin.id); await db.updateBook(book.id, (b) => { b.pins = (b.pins ?? []).filter((x) => x.id !== pin.id); }); void render(); offerPutBack(t('pageNoteDeleted'), book.id, 'pins', pin, again, alive); } }, icon('trash'))));
      });
    }
    /** A long highlighted text shortened around the match, so the match is in view. */
    function around(text: string): string {
      if (text.length <= 120) return text;
      const i = Math.max(0, matchStart(text, qf)); const from = Math.max(0, Math.min(i - 40, text.length - 120));
      return (from > 0 ? '…' : '') + text.slice(from, from + 120) + (from + 120 < text.length ? '…' : '');
    }
    if (!makers.length) return h('div');
    const n = makers.length;
    const fill = () => { if (!items.childElementCount) items.append(...makers.map((m) => m())); };
    const section = h('section', { class: 'notes-book' + (isOpen ? '' : ' folded'), dataset: { book: book.id } });
    if (isOpen || !lazy) fill();
    const head = h('button', { type: 'button', class: 'notes-head', 'aria-expanded': String(isOpen), onclick: () => {
      const now = section.classList.contains('folded');
      if (qf) { if (now) shut.delete(book.id); else shut.add(book.id); } else if (now) open.add(book.id); else open.delete(book.id);
      if (now) fill();
      section.classList.toggle('folded', !now); head.setAttribute('aria-expanded', String(now));
    } }, cover, h('div', { class: 'grow' }, h('div', { class: 'bt', dir: 'auto' }, ...mk(book.title)), ...otherTitleHits(book, qf).map((x) => h('div', { class: 'sub ns-also', dir: 'auto' }, ...marked(t('alsoTitle', { x }), qf, mark))), h('div', { class: 'sub' }, [book.author, countItems(n)].filter(Boolean).join(' · '))), icon('chevronDown'));
    section.append(h('div', { class: 'notes-head-row' }, head, iconButton('library', t('continueReading'), () => navigate(`/read/${book.id}`)), iconButton('copy', t('copyAllNotes'), () => void copyText(listedNotesMarkdown(book, filter)))), items);
    return section;
  }

  void render().catch((err) => toast(String((err as Error).message ?? err), 'error'));
  return root;
}
