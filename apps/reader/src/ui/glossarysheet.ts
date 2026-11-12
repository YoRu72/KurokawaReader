// The glossary's sheets (src/glossary.ts): a term added from the words picked in a book, and the list of every
// term — for one book or every book — to change or remove.
import { h, iconButton, openSheet, toast, icon, pickButton, askText } from './dom';
import { t, localDigits } from '../i18n';
import { terms, saveTerms, addTerms, termLine, termsText, parseTerms, scriptOf, destOf, setDest, seriesOf, folders, addFolder, renameFolder, removeFolder, linkedFolders, setLinked, type Term, type TermKind } from '../glossary';
import { getSettings, updateSettings } from '../settings';
import { copyText } from './share';

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
    const x: Term = { ...(x0 ?? {}), id: x0?.id ?? newId(), from: f, to: v, lang: x0?.lang ?? getSettings().aiTarget.split('-')[0], ...(!every.checked && bookId ? { book: bookId } : { book: undefined }) } as Term;
    saveTerms([...terms().filter((y) => y.id !== x.id), x]); sh.close(); toast(t('glossarySaved')); o.made?.();
  } }, icon('check'), t('textRuleSave')));
  setTimeout(() => (from.value ? to : from).focus(), 60);
}

/** The glossary: where its names are kept — this book, every book, or a folder of one's own (a series', a world's)
 *  that any book can use —, by kind (characters, places, groups, other terms), found by a search; each one
 *  changed where it stands; + for a new one; a folder made, renamed, removed, and switched on for this book; the
 *  whole book read for its names (as a job in the background); the switch for names added as the translator goes. */
export function glossarySheet(book?: { id: string; title: string }, o: { scan?: (folder?: string) => void } = {}): void {
  const sh = openSheet(t('glossary'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)'; sh.el.classList.add('gloss-sheet');
  type Tab = 'all' | TermKind;
  // (Where: 'book' — this book's own and what it uses —, 'all' — for every book —, or a folder's id.)
  let tab: Tab = 'all'; let where = book ? 'book' : 'all'; let q = '';
  // (Languages: a tap shows only those, a second leaves them out, a third clears — as the filters elsewhere.)
  const inc = new Set<string>(), exc = new Set<string>();
  const SCRIPT_LANG: Record<string, string> = { arabic: 'ar', latin: 'en', cyrillic: 'ru', cjk: 'ja', hangul: 'ko', hebrew: 'he', thai: 'th', devanagari: 'hi' };
  const langOf = (x: Term) => (x.lang ? x.lang.split('-')[0] : SCRIPT_LANG[scriptOf(x.to)] ?? '');
  const langName = (c: string) => { try { return new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'language' }).of(c) ?? c; } catch { return c; } };
  const langs = h('div', { class: 'chip-row gloss-langs' });
  const KINDS: [Tab, string][] = [['all', t('glossAll')], ['person', t('glossPeople')], ['place', t('glossPlaces')], ['group', t('glossGroups')], ['term', t('glossTerms')]];
  const places = h('div', { class: 'chip-row gloss-places' }); const tabs = h('div', { class: 'chip-row gloss-tabs' }); const folderBar = h('div', { class: 'gloss-folder-bar' });
  const search = h('input', { type: 'search', class: 'gloss-search', placeholder: t('glossSearch'), oninput: (e: Event) => { q = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
  const auto = h('input', { type: 'checkbox', checked: !!getSettings().aiAutoGlossary, onchange: (e: Event) => updateSettings({ aiAutoGlossary: (e.target as HTMLInputElement).checked }) }) as HTMLInputElement;
  const list = h('div', { class: 'gloss-list' });
  sh.body.append(
    h('label', { class: 'row tr-opt gloss-auto' }, h('span', { class: 'label' }, t('glossAuto'), h('small', { class: 'hint' }, t('glossAutoHint'))), auto),
    ...(book && o.scan ? [h('button', { type: 'button', class: 'btn tonal small gloss-scan', onclick: () => { const f = where !== 'book' && where !== 'all' ? where : undefined; sh.close(); o.scan!(f); } }, icon('books'), t('glossScanBook'))] : []),
    destBox(), places, folderBar, tabs, langs, search, list);
  // (Where the names the translator finds go, for this book: its own list, a folder made by itself for its series,
  // or a folder chosen — new names added there, or the folder only used.)
  function destBox(): HTMLElement {
    // (With no book open: the default for every book.)
    const key = book?.id ?? '*'; const box = h('div', { class: 'gloss-dest' });
    const drawDest = () => {
      const d = destOf(key);
      const opts: [string, string][] = [['book', t('glossDestBook')], ['auto', book ? t('glossDestAuto', { name: seriesOf(book.title) }) : t('glossDestAutoAny')], ...(book ? folders().map((f) => [f.id, `📁 ${f.name}`] as [string, string]) : [])];
      const pick = pickButton(t('glossDest'), opts, d.to, (v) => { setDest(key, { ...destOf(key), to: v }); if (book && v !== 'book' && v !== 'auto' && !linkedFolders(book.id).includes(v)) setLinked(book.id, [...linkedFolders(book.id), v]); drawDest(); draw(); }, t('close'));
      const add = h('input', { type: 'checkbox', checked: d.addNew, onchange: (e: Event) => setDest(key, { ...destOf(key), addNew: (e.target as HTMLInputElement).checked }) }) as HTMLInputElement;
      box.replaceChildren(h('div', { class: 'row gloss-dest-row' }, h('span', { class: 'label' }, book ? t('glossDest') : t('glossDestDefault')), pick),
        ...(d.to !== 'book' ? [h('label', { class: 'row gloss-dest-row' }, h('span', null, t('glossDestAddNew'), h('small', { class: 'hint' }, t('glossDestAddNewHint'))), add)] : []));
    };
    drawDest(); return box;
  }
  const save = (x: Term) => saveTerms([...terms().filter((y) => y.id !== x.id), x]);
  const folderName = (id?: string) => folders().find((f) => f.id === id)?.name ?? '';
  const placeOf = (x: Term) => (x.folder ? `📁 ${folderName(x.folder)}` : x.book ? (book && x.book === book.id ? book.title : t('textRuleOneBook')) : t('textRuleAllBooks'));
  const row = (x: Term, fresh = false) => {
    const from = h('input', { type: 'text', dir: 'auto', value: x.from, placeholder: t('glossaryFrom'), class: 'gloss-from' }) as HTMLInputElement;
    const to = h('input', { type: 'text', dir: 'auto', value: x.to, placeholder: t('glossaryTo'), class: 'gloss-to' }) as HTMLInputElement;
    const kind = h('select', { class: 'gloss-kind', 'aria-label': t('glossKind') }, ...KINDS.slice(1).map(([k, l]) => h('option', { value: k, selected: (x.kind ?? 'term') === k }, l))) as HTMLSelectElement;
    const commit = () => { const f = from.value.trim(), v = to.value.trim(); if (!f || !v) return; x = { ...x, from: f, to: v, kind: kind.value as TermKind, auto: x.auto && f === x.from && v === x.to ? x.auto : undefined }; save(x); el.classList.remove('fresh'); };
    from.addEventListener('change', commit); to.addEventListener('change', commit); kind.addEventListener('change', commit);
    // (Moved: to this book, every book, or a folder.)
    const moveTo = pickButton(t('glossMove'), [['book', book?.title ?? t('textRuleOneBook')], ['all', t('textRuleAllBooks')], ...folders().map((f) => [`f:${f.id}`, `📁 ${f.name}`] as [string, string])].filter(([k]) => k !== 'book' || !!book) as [string, string][], x.folder ? `f:${x.folder}` : x.book ? 'book' : 'all', (v) => { const { book: _b, folder: _f, ...rest } = x; void _b; void _f; x = { ...rest, ...(v === 'book' && book ? { book: book.id } : v.startsWith('f:') ? { folder: v.slice(2) } : {}) } as Term; if (x.from && x.to) save(x); draw(); }, t('close'));
    moveTo.classList.add('gloss-move');
    const target = getSettings().aiTarget.split('-')[0]; const codes = [...new Set([langOf(x), target, 'ar', 'en'].filter(Boolean))];
    const lang = h('select', { class: 'gloss-kind gloss-lang', 'aria-label': t('glossLang') }, ...codes.map((c) => h('option', { value: c, selected: langOf(x) === c }, langName(c)))) as HTMLSelectElement;
    lang.addEventListener('change', () => { x = { ...x, lang: lang.value }; if (x.from && x.to) save(x); });
    const el = h('div', { class: 'gloss-row' + (fresh ? ' fresh' : '') },
      h('div', { class: 'gloss-pair' }, from, h('span', { class: 'gloss-arrow' }, '→'), to),
      h('div', { class: 'gloss-meta' }, kind, lang, x.auto ? h('span', { class: 'gloss-badge' }, t('glossAutoBadge')) : null, moveTo,
        iconButton('copy', t('copy'), () => void copyText(termLine({ from: from.value, to: to.value }, false))),
        iconButton('trash', t('delete'), () => { saveTerms(terms().filter((y) => y.id !== x.id)); el.remove(); drawTabs(); })));
    void placeOf;
    return el;
  };
  const inWhere = (x: Term) => (where === 'all' ? !x.book && !x.folder : where === 'book' ? (!x.folder && x.book === book?.id) || (!!x.folder && linkedFolders(book?.id).includes(x.folder)) : x.folder === where);
  function drawPlaces() {
    const fs = folders();
    places.replaceChildren(...[...(book ? [['book', book.title]] : []), ['all', t('glossEveryBook')], ...fs.map((f) => [f.id, `📁 ${f.name}`])].map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (where === k ? ' on' : ''), dir: 'auto', onclick: () => { where = k; draw(); } }, l)),
      h('button', { type: 'button', class: 'chip small', onclick: async () => { const name = (await askText({ title: t('glossNewFolder'), label: t('glossFolderName'), ok: t('create'), cancel: t('cancel') }))?.trim(); if (!name) return; const f = addFolder(name); if (book) setLinked(book.id, [...linkedFolders(book.id), f.id]); where = f.id; draw(); toast(t('glossFolderMade', { name })); } }, icon('plus'), t('glossNewFolder')));
    // A folder shown: used by this book or not; renamed; removed. This book: its own names made a folder.
    const f = fs.find((x) => x.id === where);
    if (f) {
      const used = book ? linkedFolders(book.id).includes(f.id) : false;
      folderBar.replaceChildren(...(book ? [h('label', { class: 'row gloss-use' }, h('span', null, t('glossUseFolder', { book: book.title })), h('input', { type: 'checkbox', checked: used, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; setLinked(book.id, v ? [...linkedFolders(book.id), f.id] : linkedFolders(book.id).filter((x) => x !== f.id)); toast(v ? t('glossFolderOn') : t('glossFolderOff')); } }))] : []),
        h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn text small', onclick: async () => { const n = (await askText({ title: t('glossRename'), label: t('glossFolderName'), value: f.name, ok: t('save'), cancel: t('cancel') }))?.trim(); if (n) { renameFolder(f.id, n); draw(); } } }, icon('pen'), t('glossRename')),
          h('button', { type: 'button', class: 'btn text small danger', onclick: () => { if (!confirm(t('glossFolderDeleteAsk', { name: f.name }))) return; removeFolder(f.id); where = book ? 'book' : 'all'; draw(); } }, icon('trash'), t('delete'))));
    } else if (where === 'book' && book && terms().some((x) => !x.folder && x.book === book.id)) {
      folderBar.replaceChildren(h('button', { type: 'button', class: 'btn text small', onclick: async () => { const name = (await askText({ title: t('glossBookToFolder'), label: t('glossFolderName'), value: book.title, ok: t('create'), cancel: t('cancel') }))?.trim(); if (!name) return; const nf = addFolder(name); saveTerms(terms().map((x) => (!x.folder && x.book === book.id ? { ...x, book: undefined, folder: nf.id } : x))); setLinked(book.id, [...linkedFolders(book.id), nf.id]); where = nf.id; draw(); toast(t('glossFolderMade', { name })); } }, icon('folderPlus'), t('glossBookToFolder')));
    } else folderBar.replaceChildren();
  }
  function drawTabs() { tabs.replaceChildren(...KINDS.map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (tab === k ? ' on' : ''), onclick: () => { tab = k; draw(); } }, l, h('small', null, ` ${terms().filter((x) => inWhere(x) && (k === 'all' || (x.kind ?? 'term') === k)).length}`)))); }
  function draw() {
    drawPlaces(); drawTabs();
    const present = [...new Set(terms().filter(inWhere).map(langOf).filter(Boolean))];
    langs.hidden = present.length < 2;
    langs.replaceChildren(...present.map((c) => h('button', { type: 'button', class: 'chip small' + (inc.has(c) ? ' on' : exc.has(c) ? ' off' : ''), onclick: () => { if (inc.has(c)) { inc.delete(c); exc.add(c); } else if (exc.has(c)) exc.delete(c); else inc.add(c); draw(); } }, exc.has(c) ? '− ' : '', langName(c))));
    const langOk = (x: Term) => { const c = langOf(x); return (!inc.size || inc.has(c)) && !exc.has(c); };
    const shown = terms().filter((x) => inWhere(x) && langOk(x) && (tab === 'all' || (x.kind ?? 'term') === tab) && (!q || x.from.toLowerCase().includes(q) || x.to.toLowerCase().includes(q))).sort((a, b) => a.from.localeCompare(b.from));
    list.replaceChildren(...(shown.length ? shown.map((x) => row(x)) : [h('p', { class: 'src' }, t('glossaryNone'))]));
  }
  draw();
  // (The whole list shown's place — every kind and language — as text, one term to a line; and such text pasted back in.)
  const scopeNow = () => (where === 'book' && book ? { book: book.id } : where === 'all' ? {} : { folder: where });
  sh.actions.append(
    iconButton('import', t('paste'), async () => {
      let txt = ''; try { txt = await navigator.clipboard.readText(); } catch { txt = (await askText({ title: t('paste'), label: t('paste'), multiline: true, ok: t('add'), cancel: t('cancel') })) ?? ''; } if (!txt.trim()) return;
      const n = addTerms(parseTerms(txt).map((x) => ({ ...x, lang: x.lang ?? getSettings().aiTarget.split('-')[0], ...scopeNow() }))); draw(); toast(t('glossPasted', { n: localDigits(n) }));
    }),
    iconButton('copy', t('glossCopyAll'), () => void copyText(termsText(terms().filter(inWhere).sort((a, b) => a.from.localeCompare(b.from))))));
  // (+: a new line at the top to fill in — of the kind shown, where it is shown.)
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => {
    list.querySelector('.src')?.remove();
    const scope = scopeNow();
    const x: Term = { id: newId(), from: '', to: '', kind: tab === 'all' ? 'person' : tab, lang: getSettings().aiTarget.split('-')[0], ...scope };
    const r = row(x, true); list.prepend(r); (r.querySelector('.gloss-from') as HTMLInputElement).focus();
  } }, icon('plus'), t('glossaryAdd')));
}
