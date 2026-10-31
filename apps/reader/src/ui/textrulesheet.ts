// The sheets of the text rules (src/textrules.ts): a rule made from the words picked in a book — take them out
// everywhere, or put others in their place — and the list of every rule, to switch off, change or remove.
import { h, icon, iconButton, openSheet, toast } from './dom';
import { t } from '../i18n';
import { textRules, saveTextRules, patternOf, type TextRule } from '../textrules';

const newId = () => Math.random().toString(36).slice(2, 10);

/** A rule made (or changed): `made` is told the rule once saved. */
export function ruleSheet(o: { find?: string; book?: { id: string; title: string }; rule?: TextRule; made?: (r: TextRule) => void }): void {
  const r0 = o.rule;
  const sh = openSheet(r0 ? t('textRuleEdit') : t('textRuleNew'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const find = h('textarea', { rows: 2, dir: 'auto', class: 'rule-find' }) as HTMLTextAreaElement; find.value = r0?.find ?? (o.find ?? '').trim();
  const repl = h('input', { type: 'text', dir: 'auto', placeholder: t('textRuleRemoveHint') }) as HTMLInputElement; repl.value = r0?.replace ?? '';
  const regex = h('input', { type: 'checkbox', checked: !!r0?.regex }) as HTMLInputElement;
  const caseS = h('input', { type: 'checkbox', checked: !!r0?.caseSensitive }) as HTMLInputElement;
  const bookId = r0 ? r0.book : o.book?.id;
  const every = h('input', { type: 'checkbox', checked: r0 ? !r0.book : !o.book }) as HTMLInputElement;
  const err = h('p', { class: 'hint rule-err' });
  sh.body.append(
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('textRuleFind')), find),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('textRuleReplace')), repl),
    h('label', { class: 'check-row' }, regex, h('span', null, t('textRuleRegex'))),
    h('label', { class: 'check-row' }, caseS, h('span', null, t('textRuleCase'))),
    ...(bookId || o.book ? [h('label', { class: 'check-row' }, every, h('span', null, t('textRuleEveryBook')))] : []),
    h('p', { class: 'hint' }, t('textRuleHint')), err);
  const save = h('button', { type: 'button', class: 'btn primary', onclick: () => {
    const f = find.value.trim(); if (!f) { find.focus(); return; }
    const r: TextRule = { id: r0?.id ?? newId(), find: f, replace: repl.value, ...(regex.checked ? { regex: true } : {}), ...(caseS.checked ? { caseSensitive: true } : {}), ...(!every.checked && bookId ? { book: bookId } : {}), ...(r0?.off ? { off: true } : {}) };
    if (!patternOf(r)) { err.textContent = t('textRuleBad'); return; }
    // (A pattern that matches nothing at all — "" or ".*?" — would eat the text.)
    if (patternOf(r)!.test('')) { err.textContent = t('textRuleEmptyMatch'); return; }
    const list = textRules().filter((x) => x.id !== r.id); list.push(r); saveTextRules(list);
    sh.close(); toast(t('textRuleSaved')); o.made?.(r);
  } }, icon('check'), t('textRuleSave'));
  sh.actions.append(save);
  setTimeout(() => find.focus(), 60);
}

/** Every rule: switched on or off, changed, removed. */
export function rulesListSheet(book?: { id: string; title: string }): void {
  const sh = openSheet(t('textRules'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const list = h('div', { class: 'rule-list' });
  sh.body.append(h('p', { class: 'hint' }, t('textRulesAbout')), list);
  const draw = () => {
    const rules = textRules();
    if (!rules.length) { list.replaceChildren(h('p', { class: 'src' }, t('textRulesNone'))); return; }
    list.replaceChildren(...rules.map((r) => {
      const on = h('input', { type: 'checkbox', checked: !r.off, 'aria-label': t('textRuleOn') }) as HTMLInputElement;
      on.addEventListener('change', () => { saveTextRules(textRules().map((x) => (x.id === r.id ? { ...x, off: on.checked ? undefined : true } : x))); });
      return h('div', { class: 'rule-row' }, on,
        h('button', { type: 'button', class: 'rule-body', onclick: () => ruleSheet({ rule: r, made: draw }) },
          h('span', { class: 'rule-find-text', dir: 'auto' }, r.regex ? `/${r.find}/` : `«${r.find}»`),
          h('small', { class: 'src', dir: 'auto' }, `${r.replace ? `→ «${r.replace}»` : t('textRuleRemoved')} · ${r.book ? (book && r.book === book.id ? book.title : t('textRuleOneBook')) : t('textRuleAllBooks')}`)),
        iconButton('trash', t('delete'), () => { saveTextRules(textRules().filter((x) => x.id !== r.id)); draw(); }));
    }));
  };
  draw();
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => ruleSheet({ book, made: draw }) }, icon('plus'), t('textRuleNew')));
}
