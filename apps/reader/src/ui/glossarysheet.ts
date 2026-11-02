// The glossary's sheets (src/glossary.ts): a term added from the words picked in a book, and the list of every
// term — for one book or every book — to change or remove.
import { h, iconButton, openSheet, toast, icon } from './dom';
import { t } from '../i18n';
import { terms, saveTerms, type Term, type TermKind } from '../glossary';
import { getSettings, updateSettings } from '../settings';

const newId = () => Math.random().toString(36).slice(2, 10);

export function termSheet(o: { from?: string; book?: { id: string; title: string }; term?: Term; made?: () => void }): void {
  const x0 = o.term;
  const sh = openSheet(x0 ? t('glossaryEdit') : t('glossaryAdd'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const from = h('input', { type: 'text', dir: 'auto' }) as HTMLInputElement; from.value = x0?.from ?? (o.from ?? '').trim().slice(0, 120);
  const to = h('input', { type: 'text', dir: 'auto', placeholder: t('glossaryToHint') }) as HTMLInputElement; to.value = x0?.to ?? '';
  const bookId = x0 ? x0.book : o.book?.id;
  const every = h('input', { type: 'checkbox', checked: x0 ? !x0.book : !o.book }) as HTMLInputElement;
  sh.body.append(
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('glossaryFrom')), from),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('glossaryTo')), to),
    ...(bookId || o.book ? [h('label', { class: 'check-row' }, every, h('span', null, t('textRuleEveryBook')))] : []),
    h('p', { class: 'hint' }, t('glossaryHint')));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => {
    const f = from.value.trim(), v = to.value.trim(); if (!f) { from.focus(); return; } if (!v) { to.focus(); return; }
    const x: Term = { id: x0?.id ?? newId(), from: f, to: v, ...(!every.checked && bookId ? { book: bookId } : {}) };
    saveTerms([...terms().filter((y) => y.id !== x.id), x]); sh.close(); toast(t('glossarySaved')); o.made?.();
  } }, icon('check'), t('textRuleSave')));
  setTimeout(() => (from.value ? to : from).focus(), 60);
}

/** The glossary: its names by kind (characters, places, groups, other terms), this book's or every book's, found
 *  by a search; each one changed where it stands, a new one added with + as a line to fill in; and the switch that
 *  lets the translator add the names it meets on its own (off until chosen). */
export function glossarySheet(book?: { id: string; title: string }): void {
  const sh = openSheet(t('glossary'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)'; sh.el.classList.add('gloss-sheet');
  type Tab = 'all' | TermKind;
  let tab: Tab = 'all'; let scope: 'book' | 'all' = book ? 'book' : 'all'; let q = '';
  const KINDS: [Tab, string][] = [['all', t('glossAll')], ['person', t('glossPeople')], ['place', t('glossPlaces')], ['group', t('glossGroups')], ['term', t('glossTerms')]];
  const tabs = h('div', { class: 'chip-row gloss-tabs' }); const scopes = h('div', { class: 'segmented small' });
  const search = h('input', { type: 'search', class: 'gloss-search', placeholder: t('glossSearch'), oninput: (e: Event) => { q = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
  const auto = h('input', { type: 'checkbox', checked: !!getSettings().aiAutoGlossary, onchange: (e: Event) => updateSettings({ aiAutoGlossary: (e.target as HTMLInputElement).checked }) }) as HTMLInputElement;
  const list = h('div', { class: 'gloss-list' });
  sh.body.append(
    h('label', { class: 'row tr-opt gloss-auto' }, h('span', { class: 'label' }, t('glossAuto'), h('small', { class: 'hint' }, t('glossAutoHint'))), auto),
    ...(book ? [scopes] : []), tabs, search, list);
  const save = (x: Term) => saveTerms([...terms().filter((y) => y.id !== x.id), x]);
  const row = (x: Term, fresh = false) => {
    const from = h('input', { type: 'text', dir: 'auto', value: x.from, placeholder: t('glossaryFrom'), class: 'gloss-from' }) as HTMLInputElement;
    const to = h('input', { type: 'text', dir: 'auto', value: x.to, placeholder: t('glossaryTo'), class: 'gloss-to' }) as HTMLInputElement;
    const kind = h('select', { class: 'gloss-kind', 'aria-label': t('glossKind') }, ...KINDS.slice(1).map(([k, l]) => h('option', { value: k, selected: (x.kind ?? 'term') === k }, l))) as HTMLSelectElement;
    const commit = () => { const f = from.value.trim(), v = to.value.trim(); if (!f || !v) return; x = { ...x, from: f, to: v, kind: kind.value as TermKind, auto: x.auto && f === x.from && v === x.to ? x.auto : undefined }; save(x); el.classList.remove('fresh'); };
    from.addEventListener('change', commit); to.addEventListener('change', commit); kind.addEventListener('change', commit);
    const el = h('div', { class: 'gloss-row' + (fresh ? ' fresh' : '') },
      h('div', { class: 'gloss-pair' }, from, h('span', { class: 'gloss-arrow' }, '→'), to),
      h('div', { class: 'gloss-meta' }, kind, x.auto ? h('span', { class: 'gloss-badge' }, t('glossAutoBadge')) : null, h('small', { class: 'src' }, x.book ? (book && x.book === book.id ? book.title : t('textRuleOneBook')) : t('textRuleAllBooks')),
        iconButton('trash', t('delete'), () => { saveTerms(terms().filter((y) => y.id !== x.id)); el.remove(); })));
    return el;
  };
  function draw() {
    tabs.replaceChildren(...KINDS.map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (tab === k ? ' on' : ''), onclick: () => { tab = k; draw(); } }, l, h('small', null, ` ${terms().filter((x) => inScope(x) && (k === 'all' || (x.kind ?? 'term') === k)).length}`))));
    if (book) scopes.replaceChildren(...([['book', t('glossThisBook')], ['all', t('glossEveryBook')]] as ['book' | 'all', string][]).map(([k, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(scope === k), onclick: () => { scope = k; draw(); } }, l)));
    const shown = terms().filter((x) => inScope(x) && (tab === 'all' || (x.kind ?? 'term') === tab) && (!q || x.from.toLowerCase().includes(q) || x.to.toLowerCase().includes(q))).sort((a, b) => a.from.localeCompare(b.from));
    list.replaceChildren(...(shown.length ? shown.map((x) => row(x)) : [h('p', { class: 'src' }, t('glossaryNone'))]));
  }
  const inScope = (x: Term) => scope === 'all' || !book || x.book === book.id || !x.book;
  draw();
  // (+: a new line at the top to fill in — of the kind shown, for this book when one is open.)
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => {
    list.querySelector('.src')?.remove();
    const x: Term = { id: newId(), from: '', to: '', kind: tab === 'all' ? 'person' : tab, ...(book && scope === 'book' ? { book: book.id } : {}) };
    const r = row(x, true); list.prepend(r); (r.querySelector('.gloss-from') as HTMLInputElement).focus();
  } }, icon('plus'), t('glossaryAdd')));
}
