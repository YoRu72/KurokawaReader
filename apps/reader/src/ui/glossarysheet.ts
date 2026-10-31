// The glossary's sheets (src/glossary.ts): a term added from the words picked in a book, and the list of every
// term — for one book or every book — to change or remove.
import { h, iconButton, openSheet, toast, icon } from './dom';
import { t } from '../i18n';
import { terms, saveTerms, type Term } from '../glossary';

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

export function glossarySheet(book?: { id: string; title: string }): void {
  const sh = openSheet(t('glossary'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const list = h('div', { class: 'rule-list' });
  sh.body.append(h('p', { class: 'hint' }, t('glossaryAbout')), list);
  const draw = () => {
    const all = terms();
    if (!all.length) { list.replaceChildren(h('p', { class: 'src' }, t('glossaryNone'))); return; }
    list.replaceChildren(...all.map((x) => h('div', { class: 'rule-row' },
      h('button', { type: 'button', class: 'rule-body', onclick: () => termSheet({ term: x, made: draw }) },
        h('span', { class: 'rule-find-text', dir: 'auto' }, `${x.from} → ${x.to}`),
        h('small', { class: 'src' }, x.book ? (book && x.book === book.id ? book.title : t('textRuleOneBook')) : t('textRuleAllBooks'))),
      iconButton('trash', t('delete'), () => { saveTerms(terms().filter((y) => y.id !== x.id)); draw(); }))));
  };
  draw();
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => termSheet({ book, made: draw }) }, icon('plus'), t('glossaryAdd')));
}
