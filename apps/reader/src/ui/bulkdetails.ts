// «Edit details» for the books chosen in the library: one author and one series for all of them. The fields start empty
// (the placeholder says what the books carry now); only what is filled is changed. A preview lists each book with the
// volume number it would get before anything is applied; one «Undo» puts every book back. Loaded when first used.
import { h, openSheet, toast, stackWhenCramped } from './dom';
import { t } from '../i18n';
import type { Book } from '../db';
import { applyBulk, restore, commonOf, commonSeries, volumeNumbers, effectiveSeries, hasWork, type BulkInput } from '../bulkdetails';
import { offerUndo } from './undo';

const field = (label: string, input: HTMLElement, extra?: HTMLElement | null) => h('div', { class: 'field names-field' }, h('span', { class: 'label' }, label), input, extra ?? null);
const switchRow = (label: string, cb: HTMLInputElement, hint?: string) => h('label', { class: 'switch-row bulk-switch' }, h('span', { class: 'bulk-switch-text' }, h('span', null, label), hint ? h('small', { class: 'hint' }, hint) : null), h('span', { class: 'switch' }, cb, h('i')));
const toggle = (): HTMLInputElement => h('input', { type: 'checkbox', role: 'switch' }) as HTMLInputElement;

/** `books`: the chosen books in the order they were chosen; `reread`: the library drawn again from what is stored; `applied`: called once the change is made. */
export function bulkDetailsSheet(books: Book[], reread: () => void, applied?: () => void): void {
  const sheet = openSheet(t('bulkSelected', { n: books.length }), t('close'));
  sheet.el.classList.add('bulk-sheet'); sheet.body.style.fontFamily = 'var(--font-ui)';
  const ids = books.map((b) => b.id);

  // What the books carry now: one name, or «several».
  const nowAuthor = commonOf(books.map((b) => b.author));
  const nowSeries = commonOf(books.map((b) => (b.series?.name ? b.series.name : undefined)));
  const author = h('input', { type: 'text', class: 'bulk-author', dir: 'auto', placeholder: nowAuthor === 'several' ? t('bulkSeveral') : nowAuthor ?? t('addAuthor'), 'aria-label': t('sortAuthor') }) as HTMLInputElement;
  const onlyEmpty = toggle();
  const series = h('input', { type: 'text', class: 'bulk-series', dir: 'auto', placeholder: nowSeries === 'several' ? t('bulkSeveral') : nowSeries ?? commonSeries(books) ?? t('bulkSeriesName'), 'aria-label': t('bulkSeriesName') }) as HTMLInputElement;
  const byOrder = toggle();
  const preview = h('ul', { class: 'bulk-preview plain-list', 'aria-label': t('bulkPreview') });
  const remove = h('button', { type: 'button', class: 'btn small text bulk-remove', 'aria-pressed': 'false', onclick: () => { removing = !removing; paint(); } }, t('bulkRemoveSeries')) as HTMLButtonElement;
  remove.hidden = !books.some((b) => b.series);
  let removing = false;

  const input = (): BulkInput => ({ author: author.value, onlyNoAuthor: onlyEmpty.checked, series: series.value, byOrder: byOrder.checked, removeSeries: removing });
  const apply = h('button', { type: 'button', class: 'btn primary bulk-apply', onclick: () => void go() }, t('bulkApply')) as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn tonal bulk-cancel', onclick: () => sheet.close() }, t('cancel'));

  function paint(): void {
    const inp = input();
    series.disabled = removing; byOrder.disabled = removing;
    remove.setAttribute('aria-pressed', String(removing)); remove.classList.toggle('on', removing);
    remove.textContent = removing ? t('bulkRemoveSeriesOn') : t('bulkRemoveSeries');
    const name = effectiveSeries(books, inp);
    const vol = volumeNumbers(books, inp.byOrder);
    preview.hidden = !name; preview.replaceChildren(...(name ? books.map((b, i) => h('li', { class: 'bulk-row' }, h('span', { class: 'bulk-title', dir: 'auto' }, b.title), h('span', { class: 'bulk-arrow', 'aria-hidden': 'true' }, '→'), h('span', { class: 'bulk-vol' }, vol[i] !== undefined ? t('volumeN', { n: vol[i]! }) : t('bulkNoVolume')))) : []));
    apply.disabled = !hasWork(books, inp);
  }
  async function go(): Promise<void> {
    const inp = input(); if (!hasWork(books, inp)) return;
    apply.disabled = true;
    const res = await applyBulk(ids, inp);
    sheet.close(); applied?.(); reread();
    void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined);
    if (!res.changed) { toast(t('bulkNothing')); return; }
    offerUndo(t('bulkChanged', { n: res.changed }),
      async () => { await restore(res.snaps, res.renamed); reread(); void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined); },
      async () => { await applyBulk(ids, inp); reread(); void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined); });
  }
  for (const el of [author, series, onlyEmpty, byOrder]) { el.addEventListener('input', paint); el.addEventListener('change', paint); }
  const acts = h('div', { class: 'actions-row eq bulk-actions' }, apply, cancel);
  sheet.body.append(
    h('p', { class: 'hint' }, t('bulkHint')),
    field(t('sortAuthor'), author), switchRow(t('bulkOnlyNoAuthor'), onlyEmpty),
    field(t('bulkSeriesName'), series, books.some((b) => b.series) ? h('div', { class: 'actions-row' }, remove) : null),
    switchRow(t('bulkNumberByOrder'), byOrder, t('bulkNumberByOrderHint')), preview);
  sheet.actions.append(acts);
  stackWhenCramped(acts);
  paint();
}
