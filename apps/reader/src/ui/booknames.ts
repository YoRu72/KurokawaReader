// «Edit» for a book's titles and author: the shown title and the other titles (add, remove with Undo, «Show this
// one»), a switch to keep the former title when the shown one changes, the author (set, or added where the book
// has none), and a way back to what the file itself carried.
import { h, icon, openSheet, toast } from './dom';
import { t } from '../i18n';
import { db, type Book } from '../db';
import { titlesOf, otherTitles, origTitleOf, origAuthorOf, setTitles, setAuthor } from '../booktitles';

const field = (label: string, input: HTMLElement, extra?: HTMLElement | null) => h('div', { class: 'field names-field' }, h('span', { class: 'label' }, label), input, extra ?? null);

export function editNamesSheet(book: Book, onDone: (b: Book) => void): void {
  const sheet = openSheet(t('editNames'), t('close'));
  const start = { title: book.title, others: otherTitles(book), author: book.author ?? '' };
  let others = [...start.others];
  const shown = h('input', { type: 'text', class: 'names-shown', dir: 'auto', value: start.title, 'aria-label': t('shownTitle') }) as HTMLInputElement;
  const keepCb = h('input', { type: 'checkbox', role: 'switch' }) as HTMLInputElement; keepCb.checked = true;
  const keepRow = h('label', { class: 'row names-keep', hidden: true }, h('span', { class: 'label' }, t('keepOldTitle')), h('span', { class: 'switch' }, keepCb, h('i')));
  const list = h('div', { class: 'names-others' });
  const back = h('button', { type: 'button', class: 'btn small tonal names-back-title', onclick: () => { shown.value = origTitleOf(book); sync(); } }, icon('undo'), t('backToOwnTitle'));
  const addIn = h('input', { type: 'text', class: 'names-add', dir: 'auto', placeholder: t('addTitle'), 'aria-label': t('addTitle') }) as HTMLInputElement;
  const author = h('input', { type: 'text', class: 'names-author', dir: 'auto', value: start.author, placeholder: t('addAuthor'), 'aria-label': t('sortAuthor') }) as HTMLInputElement;
  const backAuthor = h('button', { type: 'button', class: 'btn small tonal names-back-author', onclick: () => { author.value = origAuthorOf(book) ?? ''; sync(); } }, icon('undo'), t('backToOwnAuthor'));

  const addTitle = () => { const v = addIn.value.replace(/\s+/g, ' ').trim(); if (!v) return; if (v !== shown.value.trim() && !others.includes(v)) others.push(v); addIn.value = ''; paint(); };
  addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTitle(); } });
  const addBtn = h('button', { type: 'button', class: 'btn small tonal names-add-btn', onclick: addTitle }, icon('plus'), t('addTitleBtn'));

  function paint(): void {
    list.replaceChildren(...others.map((x, i) => {
      const inp = h('input', { type: 'text', dir: 'auto', value: x, class: 'names-other', 'aria-label': t('otherTitles') }) as HTMLInputElement;
      inp.addEventListener('input', () => { others[i] = inp.value; });
      return h('div', { class: 'names-row' }, inp,
        h('button', { type: 'button', class: 'btn small tonal names-show', onclick: () => { const cur = shown.value.trim(); const pick = (others[i] ?? '').trim(); if (!pick) return; others.splice(i, 1); if (cur && cur !== pick) others.unshift(cur); shown.value = pick; paint(); } }, t('showThisOne')),
        h('button', { type: 'button', class: 'btn small tonal names-remove', 'aria-label': t('remove'), title: t('remove'), onclick: () => {
          const gone = others[i]; const at = i; others.splice(i, 1); paint();
          toast(t('titleRemoved', { x: gone }), 'info', { ms: 6500, action: { label: t('undo'), run: () => { others.splice(Math.min(at, others.length), 0, gone); paint(); } } });
        } }, icon('close')));
    }));
    sync();
  }
  function sync(): void {
    keepRow.hidden = shown.value.trim() === start.title || !shown.value.trim();
    back.hidden = shown.value.trim() === origTitleOf(book);
    const o = origAuthorOf(book) ?? ''; backAuthor.hidden = author.value.trim() === o;
  }
  shown.addEventListener('input', sync); author.addEventListener('input', sync);

  const save = h('button', { type: 'button', class: 'btn primary names-save', onclick: async () => {
    const title = shown.value.replace(/\s+/g, ' ').trim();
    if (!title) { toast(t('titleEmpty'), 'error'); shown.focus(); return; }
    const rest = others.map((x) => x.trim()).filter((x) => x && x !== title);
    const au = author.value;
    const keep = keepCb.checked && !keepRow.hidden;
    const before = book.title;
    const out = await db.updateBook(book.id, (b) => {
      const titlesNow = [title, ...(keep && start.title !== title && !rest.includes(start.title) ? [start.title] : []), ...rest];
      if (title !== b.title || JSON.stringify(titlesNow) !== JSON.stringify(titlesOf(b))) setTitles(b, titlesNow);
      if (au.trim() !== (b.author ?? '')) setAuthor(b, au);
    });
    if (out && out.title !== before) void import('../glossary').then((g) => g.followRename(book.id, before, out.title));
    void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined);
    sheet.close(); if (out) { Object.assign(book, out); onDone(out); }
  } }, t('save'));
  const cancel = h('button', { type: 'button', class: 'btn tonal names-cancel', onclick: () => sheet.close() }, t('cancel'));

  sheet.body.append(
    field(t('shownTitle'), shown, h('div', { class: 'actions-row' }, back)), keepRow,
    h('div', { class: 'field names-field' }, h('span', { class: 'label' }, t('otherTitles'), h('small', { class: 'hint' }, t('otherTitlesHint'))), list, h('div', { class: 'names-addrow' }, addIn, addBtn)),
    field(t('sortAuthor'), author, h('div', { class: 'actions-row' }, backAuthor)),
    h('div', { class: 'actions-row eq' }, save, cancel));
  paint();
}
