// The glossary (src/glossary.ts) as the AI sheet's «Glossary» tab (src/ui/aisheet.ts): the open book's glossary shown
// as a folder named after the book, its files by kind — Characters, Places, Skills, Citations… and the reader's own —
// each with how many it holds; a file opened shows its terms, each changed where it stands; the search looks through
// the whole folder. Also: every book's glossary and other folders; a former volume's glossary offered (shared,
// copied, or not); the files written out (one text file per kind, in a folder named after the book) and read back.
import { h, iconButton, openSheet, toast, icon, pickButton, askText } from './dom';
import { t, localDigits } from '../i18n';
import type { Strings } from '../i18n/en';
import { terms, saveTerms, addTerms, termLine, termsText, parseTerms, termLang, misScripted, langForNew, scriptVerdict, destOf, setDest, seriesOf, folders, addFolder, renameFolder, removeFolder, linkedFolders, setLinked, glossarySnapshot, glossaryRestore, kindOf, kindOrder, KINDS, glossaryFiles, parseKindFile, kindFromFileName, safeName, volDecision, volCandidates, shareGlossary, copyGlossary, stopSharing, setVolChoice, folderBooks, volumeStem, type Term, type TermKind, type BuiltinKind, type BookRef, type VolCandidate } from '../glossary';
import { offerUndo } from './undo';
import { getSettings, updateSettings } from '../settings';
import { aiReady, retranslateTerms } from '../ai';
import { copyText, downloadBlob } from './share';
import { pendingKinds } from './namespanel';

const newId = () => Math.random().toString(36).slice(2, 10);
// (The last retranslation's Undo: kept for the session — the sheet closed and opened again still offers it.)
let undo: (() => void) | null = null;
const baseLang = (c: string) => (c || '').split('-')[0];
/** A language's name in the interface's language («العربية», "Japanese"). */
export const langLabel = (c: string): string => { try { return new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'language' }).of(c) ?? c; } catch { return c; } };
const KIND_KEYS: Record<BuiltinKind, keyof Strings> = { person: 'glossPeople', place: 'glossPlaces', group: 'glossGroups', skill: 'glossSkills', item: 'glossItems', title: 'glossTitlesRanks', creature: 'glossCreatures', event: 'glossEvents', quote: 'glossQuotes', term: 'glossTermsFile' };
const KIND_ICONS: Record<BuiltinKind, string> = { person: 'user', place: 'globe', group: 'grid', skill: 'flash', item: 'archive', title: 'star', creature: 'puzzle', event: 'clock', quote: 'note', term: 'define' };
/** A file's name: the built-in kinds in the interface's language, the reader's own as he named them. */
export const kindLabel = (k: TermKind | string): string => { const x = kindOf(k); return x.startsWith('u:') ? x.slice(2) : t(KIND_KEYS[x as BuiltinKind]); };
export const kindIcon = (k: TermKind | string): string => { const x = kindOf(k); return x.startsWith('u:') ? 'file' : KIND_ICONS[x as BuiltinKind]; };
const iso = (x: string) => `⁨${x}⁩`;
const nameQ = (x: string) => (document.documentElement.lang === 'ar' ? `«${iso(x)}»` : iso(x));
const listSep = () => (document.documentElement.lang === 'ar' ? '، ' : ', ');
// (A former volume's glossary taken by itself and then undone: not taken again while the app is open.)
const declined = new Set<string>();

/** The old entry points: the AI sheet on its «Glossary» tab. */
export function glossarySheet(book?: { id: string; title: string }): void { void import('./aisheet').then((m) => m.aiSheet({ tab: 'glossary', book })); }

type BookInfo = BookRef & { title: string };
let booksCache: Promise<BookInfo[]> | null = null;
async function allBooks(fresh = false): Promise<BookInfo[]> {
  if (!booksCache || fresh) booksCache = import('../library').then((m) => m.listBooks()).then((l) => l.filter((b) => b.format !== 'series').map((b) => ({ id: b.id, title: b.title, ...(b.titles?.length ? { others: b.titles.filter((x) => x !== b.title) } : {}), ...(b.series?.name ? { series: { name: b.series.name, index: b.series.index } } : {}) })), () => []);
  return booksCache;
}

/** The «Glossary» tab. `book`: the open book (else every book's glossary and the list of books' glossaries). */
export function glossaryPanel(book0?: { id: string; title: string }, o: { scan?: (folder?: string) => void; toNames?: () => void } = {}): { el: HTMLElement; actions: HTMLElement[]; addFrom(text: string): void; refresh(): void } {
  let book = book0; const root = h('div', { class: 'gloss-panel' });
  // (Where: 'book' — this book's own and what it uses —, 'all' — for every book —, or a folder's id. The file open,
  // or none: the folder's files listed.)
  let where = book ? 'book' : 'all'; let file: TermKind | null = null; let q = '';
  const inc = new Set<string>(), exc = new Set<string>();
  const langOf = (x: Term) => termLang(x) || '-';
  const langName = (c: string) => (c === '-' ? t('glossLangUnset') : langLabel(c));
  const picked = new Set<string>(); const made = new Set<TermKind>();
  let titles = new Map<string, string>(); let books: BookInfo[] = [];
  const titleOf = (id: string, fb = '') => titles.get(id) ?? fb;
  const vol = h('div', { class: 'gloss-vol-box' }); const head = h('div', { class: 'gloss-head' });
  const places = h('div', { class: 'chip-row gloss-places' }); const folderBar = h('div', { class: 'gloss-folder-bar' }); const bookList = h('div', { class: 'gloss-books' });
  const langs = h('div', { class: 'chip-row gloss-langs' });
  const search = h('input', { type: 'search', class: 'gloss-search', placeholder: t('glossSearch'), oninput: (e: Event) => { q = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
  const autoCb = h('input', { type: 'checkbox', checked: !!getSettings().aiAutoGlossary, onchange: (e: Event) => updateSettings({ aiAutoGlossary: (e.target as HTMLInputElement).checked }) }) as HTMLInputElement;
  const list = h('div', { class: 'gloss-list' }); const retrBar = h('div', { class: 'gloss-retr-bar' }); const fileBar = h('div', { class: 'gloss-file-bar' });
  const opts = h('details', { class: 'gloss-opts' }, h('summary', null, icon('settings'), t('glossOptions')),
    h('label', { class: 'row tr-opt gloss-auto' }, h('span', { class: 'label' }, t('glossAuto'), h('small', { class: 'hint' }, t('glossAutoHint'))), h('span', { class: 'switch' }, autoCb, h('i'))),
    volModeField(), destBox());
  root.append(vol, head, places, folderBar, bookList, opts, search, fileBar, langs, retrBar, list);

  // (Where the names the translator finds go, for this book: its own list, a folder made by itself for its series,
  // or a folder chosen — new names added there, or the folder only used.)
  function destBox(): HTMLElement {
    const box = h('div', { class: 'gloss-dest' });
    const drawDest = () => {
      const key = book?.id ?? '*'; const d = destOf(key);
      const opts: [string, string][] = [['book', t('glossDestBook')], ['auto', book ? t('glossDestAuto', { name: seriesOf(titleOf(book.id, book.title)) }) : t('glossDestAutoAny')], ...(book ? folders().map((f) => [f.id, `📁 ${f.name}`] as [string, string]) : [])];
      const pick = pickButton(t('glossDest'), opts, d.to, (v) => { setDest(key, { ...destOf(key), to: v }); if (book && v !== 'book' && v !== 'auto' && !linkedFolders(book.id).includes(v)) setLinked(book.id, [...linkedFolders(book.id), v]); drawDest(); draw(); }, t('close'));
      const add = h('input', { type: 'checkbox', checked: d.addNew, onchange: (e: Event) => setDest(key, { ...destOf(key), addNew: (e.target as HTMLInputElement).checked }) }) as HTMLInputElement;
      box.replaceChildren(h('div', { class: 'row gloss-dest-row' }, h('span', { class: 'label' }, book ? t('glossDest') : t('glossDestDefault')), pick),
        ...(d.to !== 'book' ? [h('label', { class: 'row gloss-dest-row' }, h('span', null, t('glossDestAddNew'), h('small', { class: 'hint' }, t('glossDestAddNewHint'))), h('span', { class: 'switch' }, add, h('i')))] : []));
    };
    (box as HTMLElement & { redraw?: () => void }).redraw = drawDest; drawDest(); return box;
  }
  /** «A former volume's glossary»: taken by itself, offered, or never — a pick list, its choice ticked. */
  function volModeField(): HTMLElement {
    const v = getSettings().aiVolGlossary ?? 'auto';
    return h('div', { class: 'field gloss-vol-mode' }, h('span', { class: 'label' }, t('glossVolMode')),
      pickButton<'auto' | 'ask' | 'never'>(t('glossVolMode'), [['auto', t('glossVolAuto')], ['ask', t('glossVolAsk')], ['never', t('glossVolNever')]], v, (x) => { updateSettings({ aiVolGlossary: x }); declined.clear(); volDone = false; cands = null; void checkVol(); }, t('close')),
      h('small', { class: 'hint' }, t('glossVolModeHint')));
  }

  /* ---------- a former volume's glossary (offered when this book has none) ---------- */
  let volDone = false; let cands: VolCandidate[] | null = null; let notice: { cand: VolCandidate; undo: () => void } | null = null;
  async function checkVol(force = false): Promise<void> {
    if (!book || (volDone && !force)) return; volDone = true;
    books = await allBooks(); const me: BookRef = books.find((b) => b.id === book!.id) ?? { id: book.id, title: book.title };
    const mode = getSettings().aiVolGlossary ?? 'auto';
    const d = volDecision(me, books, declined.has(book.id) && mode === 'auto' ? 'ask' : mode);
    if (d.kind === 'auto') {
      const und = shareGlossary(book.id, d.cand, true); notice = { cand: d.cand, undo: und }; cands = null;
      offerUndo(t('glossVolUsing', { title: iso(d.cand.title) }), () => { und(); notice = null; declined.add(book!.id); cands = volCandidates(me, books); if (root.isConnected) draw(); }, () => { void checkVol(true); });
    } else cands = d.kind === 'ask' ? d.cands : null;
    if (root.isConnected) draw();
  }
  function drawVol(): void {
    if (!book || where !== 'book') { vol.replaceChildren(); return; }
    if (notice) {
      const n = notice;
      vol.replaceChildren(h('div', { class: 'gloss-vol notice', role: 'status' }, icon('info'), h('p', null, t('glossVolUsing', { title: iso(n.cand.title) })),
        h('div', { class: 'gloss-vol-btns' },
          h('button', { type: 'button', class: 'btn small tonal gloss-vol-change', onclick: () => { n.undo(); notice = null; declined.add(book!.id); const me = books.find((b) => b.id === book!.id) ?? { id: book!.id, title: book!.title }; cands = volCandidates(me, books); draw(); } }, icon('pen'), t('glossVolChange')),
          h('button', { type: 'button', class: 'btn small tonal gloss-vol-undo', onclick: () => { n.undo(); notice = null; declined.add(book!.id); draw(); } }, icon('undo'), t('undo')))));
      return;
    }
    if (!cands?.length) { vol.replaceChildren(); return; }
    const [c, ...others] = cands;
    const choose = (fn: () => void, msg: string) => { fn(); cands = null; draw(); toast(msg); };
    vol.replaceChildren(h('div', { class: 'gloss-vol card' },
      h('p', { class: 'gloss-vol-title' }, icon('folder'), h('span', null, t('glossVolFrom', { title: iso(c.title), n: localDigits(c.count) }))),
      ...(c.match === 'similar' ? [h('small', { class: 'hint' }, t('glossVolSimilar'))] : []),
      h('p', { class: 'hint' }, t('glossVolHint')),
      h('div', { class: 'gloss-vol-btns' },
        h('button', { type: 'button', class: 'btn small primary gloss-vol-share', onclick: () => choose(() => shareGlossary(book!.id, c), t('glossVolShared', { title: iso(c.title) })) }, icon('folder'), t('glossVolShare')),
        h('button', { type: 'button', class: 'btn small tonal gloss-vol-copy', onclick: () => choose(() => copyGlossary(book!.id, c), t('glossVolCopied')) }, icon('copy'), t('glossVolCopy')),
        h('button', { type: 'button', class: 'btn small gloss-vol-empty', onclick: () => choose(() => setVolChoice(book!.id, { choice: 'empty' }), t('glossVolEmptyDone')) }, icon('plus'), t('glossVolEmpty'))),
      ...(others.length ? [h('details', { class: 'gloss-vol-others' }, h('summary', null, t('glossVolOthers')),
        ...others.map((x) => h('button', { type: 'button', class: 'dest-row', onclick: () => { cands = [x, ...cands!.filter((y) => y !== x)]; draw(); } }, icon('folder'), h('span', { class: 'grow' }, t('glossVolFrom', { title: iso(x.title), n: localDigits(x.count) })))))] : [])));
  }

  /* ---------- the folder's header: the book's title (or the series', when shared), who shares it ---------- */
  function drawHead(): void {
    if (where === 'book' && book) {
      const shared = linkedFolders(book.id).map((f) => ({ f, name: folders().find((x) => x.id === f)?.name ?? '', others: folderBooks(f).filter((id) => id !== book!.id && titles.has(id)) })).filter((x) => x.name && x.others.length);
      const vols = (f: string) => folderBooks(f).filter((id) => titles.has(id)).map((id) => ({ id, v: volumeStem(titleOf(id)).vol })).sort((a, b) => (a.v ?? 0) - (b.v ?? 0));
      head.replaceChildren(h('div', { class: 'gloss-head-row' }, icon('folder'), h('div', { class: 'grow' },
        h('h4', { class: 'gloss-title', dir: 'auto' }, shared.length ? shared[0].name : titleOf(book.id, book.title)),
        ...(shared.length ? [h('small', { class: 'hint gloss-vols' }, t('glossVolumes', { list: vols(shared[0].f).map((x) => iso(x.v !== null ? String(x.v) : titleOf(x.id))).join(listSep()) }))] : []))),
        ...shared.map((s) => h('div', { class: 'gloss-shared' }, h('span', { class: 'grow' }, t('glossSharedWith', { list: s.others.map((id) => nameQ(titleOf(id))).join(listSep()) })),
          h('button', { type: 'button', class: 'btn text small gloss-stop-share', onclick: () => { if (!confirm(t('glossStopShareAsk'))) return; const before = glossarySnapshot(); stopSharing(book!.id, s.f); draw(); offerUndo(t('glossStopped'), () => { glossaryRestore(before); if (root.isConnected) draw(); }); } }, icon('close'), t('glossStopShare')))));
    } else if (where !== 'all' && folders().some((f) => f.id === where)) {
      const f = folders().find((x) => x.id === where)!; const users = folderBooks(f.id).filter((id) => titles.has(id));
      head.replaceChildren(h('div', { class: 'gloss-head-row' }, icon('folder'), h('div', { class: 'grow' }, h('h4', { class: 'gloss-title', dir: 'auto' }, f.name),
        ...(users.length ? [h('small', { class: 'hint' }, t('glossUsedBy', { list: users.map((id) => nameQ(titleOf(id))).join(listSep()) }))] : []))));
    } else head.replaceChildren(h('div', { class: 'gloss-head-row' }, icon('globe'), h('h4', { class: 'gloss-title grow' }, t('glossEveryBook'))));
  }

  const save = (x: Term) => saveTerms([...terms().filter((y) => y.id !== x.id), x]);
  const kindsHere = (): TermKind[] => kindOrder([...KINDS, ...terms().map(kindOf).filter((k) => k.startsWith('u:')), ...made]);
  const row = (x: Term, fresh = false) => {
    const from = h('input', { type: 'text', dir: 'auto', value: x.from, placeholder: t('glossaryFrom'), class: 'gloss-from' }) as HTMLInputElement;
    const to = h('input', { type: 'text', dir: 'auto', value: x.to, placeholder: t('glossaryTo'), class: 'gloss-to' }) as HTMLInputElement;
    const kind = h('select', { class: 'gloss-kind', 'aria-label': t('glossKind') }, ...kindsHere().map((k) => h('option', { value: k, selected: kindOf(x) === k }, kindLabel(k)))) as HTMLSelectElement;
    const commit = () => { const f = from.value.trim(), v = to.value.trim(); if (!f || !v) return; const moved = kindOf(x) !== kind.value; x = { ...x, from: f, to: v, kind: kind.value as TermKind, auto: x.auto && f === x.from && v === x.to ? x.auto : undefined }; save(x); el.classList.remove('fresh'); if (moved && !fresh) draw(); else drawFileBar(); };
    from.addEventListener('change', commit); to.addEventListener('change', commit); kind.addEventListener('change', commit);
    // (Moved: to this book, every book, or a folder.)
    const moveTo = pickButton(t('glossMove'), [['book', book ? titleOf(book.id, book.title) : t('textRuleOneBook')], ['all', t('textRuleAllBooks')], ...folders().map((f) => [`f:${f.id}`, `📁 ${f.name}`] as [string, string])].filter(([k]) => k !== 'book' || !!book) as [string, string][], x.folder ? `f:${x.folder}` : x.book ? 'book' : 'all', (v) => { const { book: _b, folder: _f, ...rest } = x; void _b; void _f; x = { ...rest, ...(v === 'book' && book ? { book: book.id } : v.startsWith('f:') ? { folder: v.slice(2) } : {}) } as Term; if (x.from && x.to) { save(x); draw(); } }, t('close'));
    moveTo.classList.add('gloss-move');
    const target = baseLang(getSettings().aiTarget); const codes = [...new Set([langOf(x), target, 'ar', 'en'])];
    const lang = h('select', { class: 'gloss-kind gloss-lang', 'aria-label': t('glossLang') }, ...codes.map((c) => h('option', { value: c, selected: langOf(x) === c, disabled: c === '-' }, langName(c)))) as HTMLSelectElement;
    lang.addEventListener('change', () => { if (lang.value === '-') return; x = { ...x, lang: lang.value }; if (x.from && x.to) { save(x); draw(); } });
    const sel = h('input', { type: 'checkbox', class: 'gloss-sel', 'aria-label': t('glossSelect'), checked: picked.has(x.id), onchange: () => { if (sel.checked) picked.add(x.id); else picked.delete(x.id); drawRetr(); } }) as HTMLInputElement;
    const wrong = !fresh && misScripted(x);
    const el = h('div', { class: 'gloss-row' + (fresh ? ' fresh' : '') + (wrong ? ' wrong' : '') + (kindOf(x) === 'quote' ? ' quote' : ''), 'data-id': x.id },
      h('div', { class: 'gloss-pair' }, from, h('span', { class: 'gloss-arrow' }, '→'), to),
      ...(wrong ? [h('p', { class: 'gloss-warn' }, icon('info'), t('glossWrongScript', { lang: langLabel(termLang(x)) }))] : []),
      h('div', { class: 'gloss-meta' }, ...(fresh ? [] : [sel]), kind, lang, x.auto ? h('span', { class: 'gloss-badge' }, t('glossAutoBadge')) : null, moveTo,
        ...(fresh ? [] : [iconButton('rotate', t('glossRetrOne'), () => { const now = terms().find((y) => y.id === x.id); if (now) retranslate([now]); })]),
        iconButton('copy', t('copy'), () => void copyText(termLine({ from: from.value, to: to.value }, false))),
        iconButton('trash', t('delete'), () => { const gone = terms().find((y) => y.id === x.id) ?? x; saveTerms(terms().filter((y) => y.id !== x.id)); picked.delete(x.id); el.remove(); drawFileBar(); drawRetr();
          // (Undo: the term back as it was; the list drawn again if it is still open.)
          offerUndo(t('termDeleted', { name: gone.from }), () => { saveTerms([...terms().filter((y) => y.id !== gone.id), gone]); if (root.isConnected) draw(); }, () => { saveTerms(terms().filter((y) => y.id !== gone.id)); if (root.isConnected) draw(); }); })));
    return el;
  };
  const inWhere = (x: Term) => (where === 'all' ? !x.book && !x.folder : where === 'book' ? (!x.folder && x.book === book?.id) || (!!x.folder && linkedFolders(book?.id).includes(x.folder)) : x.folder === where);
  function drawPlaces(): void {
    const fs = folders();
    places.replaceChildren(...[...(book ? [['book', titleOf(book.id, book.title)]] : []), ['all', t('glossEveryBook')], ...fs.map((f) => [f.id, `📁 ${f.name}`])].map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (where === k ? ' on' : ''), dir: 'auto', onclick: () => { where = k; file = null; draw(); } }, l)),
      h('button', { type: 'button', class: 'chip small', onclick: async () => { const name = (await askText({ title: t('glossNewFolder'), label: t('glossFolderName'), ok: t('create'), cancel: t('cancel') }))?.trim(); if (!name) return; const f = addFolder(name); if (book) setLinked(book.id, [...linkedFolders(book.id), f.id]); where = f.id; file = null; draw(); toast(t('glossFolderMade', { name })); } }, icon('plus'), t('glossNewFolder')));
    // A folder shown: used by this book or not; renamed; removed. This book: its own names made a folder.
    const f = fs.find((x) => x.id === where);
    if (f) {
      const used = book ? linkedFolders(book.id).includes(f.id) : false;
      const useCb = h('input', { type: 'checkbox', checked: used, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; setLinked(book!.id, v ? [...linkedFolders(book!.id), f.id] : linkedFolders(book!.id).filter((x) => x !== f.id)); toast(v ? t('glossFolderOn') : t('glossFolderOff')); } }) as HTMLInputElement;
      folderBar.replaceChildren(...(book ? [h('label', { class: 'row gloss-use' }, h('span', null, t('glossUseFolder', { book: titleOf(book.id, book.title) })), h('span', { class: 'switch' }, useCb, h('i')))] : []),
        h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn text small', onclick: async () => { const n = (await askText({ title: t('glossRename'), label: t('glossFolderName'), value: f.name, ok: t('save'), cancel: t('cancel') }))?.trim(); if (n) { renameFolder(f.id, n); draw(); } } }, icon('pen'), t('glossRename')),
          h('button', { type: 'button', class: 'btn text small danger', onclick: () => { if (!confirm(t('glossFolderDeleteAsk', { name: f.name }))) return; const before = glossarySnapshot(); removeFolder(f.id); const after = glossarySnapshot(); where = book ? 'book' : 'all'; draw();
            // (Undo: the folder back whole — its terms, the books that used it.)
            offerUndo(t('glossFolderDeleted', { name: f.name }), () => { glossaryRestore(before); if (root.isConnected) draw(); }, () => { glossaryRestore(after); if (root.isConnected) draw(); }); } }, icon('trash'), t('delete'))));
    } else if (where === 'book' && book && terms().some((x) => !x.folder && x.book === book!.id)) {
      folderBar.replaceChildren(h('button', { type: 'button', class: 'btn text small', onclick: async () => { const name = (await askText({ title: t('glossBookToFolder'), label: t('glossFolderName'), value: titleOf(book!.id, book!.title), ok: t('create'), cancel: t('cancel') }))?.trim(); if (!name) return; const nf = addFolder(name); saveTerms(terms().map((x) => (!x.folder && x.book === book!.id ? { ...x, book: undefined, folder: nf.id } : x))); setLinked(book!.id, [...linkedFolders(book!.id), nf.id]); where = nf.id; draw(); toast(t('glossFolderMade', { name })); } }, icon('folderPlus'), t('glossBookToFolder')));
    } else folderBar.replaceChildren();
    // (No book open: the books that have a glossary, each opened here.)
    if (!book0) {
      const withGloss = books.map((b) => ({ b, n: terms().filter((x) => (!x.folder && x.book === b.id) || (!!x.folder && linkedFolders(b.id).includes(x.folder))).length })).filter((x) => x.n);
      bookList.replaceChildren(...(withGloss.length ? [h('h4', { class: 'upd-title' }, t('glossBooksList')), h('div', { class: 'dest-list' }, ...withGloss.map(({ b, n }) => h('button', { type: 'button', class: 'dest-row gloss-book', onclick: () => { book = { id: b.id, title: b.title }; where = 'book'; file = null; volDone = true; (destEl as HTMLElement & { redraw?: () => void }).redraw?.(); draw(); } }, icon('books'), h('span', { class: 'grow', dir: 'auto' }, b.title), h('small', null, t('glossCount', { n: localDigits(n) })))))] : []));
      if (book) bookList.prepend(h('button', { type: 'button', class: 'btn text small', onclick: () => { book = undefined; where = 'all'; file = null; draw(); } }, icon('back'), t('glossBooksList')));
    }
  }
  const destEl = opts.querySelector('.gloss-dest') as HTMLElement;
  /** The folder's files: those holding terms (or found by the model), each with how many; «New file» last. */
  function drawFiles(here: Term[]): void {
    const counts = new Map<TermKind, number>(); for (const x of here) { const k = kindOf(x); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const shown = kindOrder([...counts.keys(), ...made, ...(where === 'book' ? pendingKinds(book?.id) : [])]);
    if (!here.length && !made.size) {
      list.replaceChildren(h('div', { class: 'gloss-empty' }, h('p', { class: 'src' }, t('glossEmpty')),
        h('div', { class: 'row-btns' }, ...(o.scan && where !== 'all' ? [h('button', { type: 'button', class: 'btn tonal small gloss-scan', onclick: () => o.scan!(where !== 'book' ? where : undefined) }, icon('books'), t('glossScanBook'))] : []),
          h('button', { type: 'button', class: 'btn text small gloss-new-file', onclick: () => void newFile() }, icon('plus'), t('glossNewFile')))));
      return;
    }
    list.replaceChildren(h('div', { class: 'gloss-files', role: 'list' },
      ...shown.map((k) => h('button', { type: 'button', role: 'listitem', class: 'gloss-file', dataset: { kind: k }, onclick: () => { file = k; draw(); } }, h('span', { class: 'gloss-file-icon' }, icon(kindIcon(k))), h('span', { class: 'grow gloss-file-name', dir: 'auto' }, kindLabel(k)), h('small', { class: 'gloss-file-count' }, counts.get(k) ? t('glossCount', { n: localDigits(counts.get(k)!) }) : t('glossFound')), icon('chevronRight'))),
      h('button', { type: 'button', class: 'gloss-file gloss-new-file', onclick: () => void newFile() }, h('span', { class: 'gloss-file-icon' }, icon('plus')), h('span', { class: 'grow' }, t('glossNewFile')))),
      ...(o.scan && where !== 'all' ? [h('button', { type: 'button', class: 'btn tonal small gloss-scan', onclick: () => { const f = where !== 'book' && where !== 'all' ? where : undefined; o.scan!(f); } }, icon('books'), t('glossScanBook'))] : []));
  }
  async function newFile(): Promise<void> {
    const name = (await askText({ title: t('glossNewFile'), label: t('glossFileName'), ok: t('create'), cancel: t('cancel') }))?.trim(); if (!name) return;
    const k = KINDS.find((x) => kindLabel(x).toLocaleLowerCase() === name.toLocaleLowerCase()) ?? kindOf(kindFromFileName(name) as string);
    made.add(k); file = k; draw(); addRow();
  }
  function drawFileBar(): void {
    if (!file || q) { fileBar.replaceChildren(); return; }
    const n = terms().filter((x) => inWhere(x) && kindOf(x) === file).length;
    fileBar.replaceChildren(h('button', { type: 'button', class: 'btn text small gloss-back', onclick: () => { file = null; freshRow = null; draw(); } }, icon(document.documentElement.dir === 'rtl' ? 'chevronRight' : 'chevronLeft'), t('glossAllFiles')),
      h('span', { class: 'gloss-file-now' }, icon(kindIcon(file)), h('b', { dir: 'auto' }, kindLabel(file)), h('small', null, t('glossCount', { n: localDigits(n) }))));
  }
  function draw(): void {
    drawVol(); drawHead(); drawPlaces(); drawFileBar();
    const here = terms().filter(inWhere);
    const listing = !file && !q;
    langs.hidden = true; retrBar.hidden = listing;
    if (listing) { drawFiles(here); shownNow = []; return; }
    const present = [...new Set(here.map(langOf).filter(Boolean))];
    langs.hidden = present.length < 2;
    langs.replaceChildren(...present.map((c) => h('button', { type: 'button', class: 'chip small' + (inc.has(c) ? ' on' : exc.has(c) ? ' off' : ''), onclick: () => { if (inc.has(c)) { inc.delete(c); exc.add(c); } else if (exc.has(c)) exc.delete(c); else inc.add(c); draw(); } }, exc.has(c) ? '− ' : '', langName(c))));
    const langOk = (x: Term) => { const c = langOf(x); return (!inc.size || inc.has(c)) && !exc.has(c); };
    // (The search looks through the whole folder, whatever file is open.)
    const shown = here.filter((x) => langOk(x) && (q ? x.from.toLowerCase().includes(q) || x.to.toLowerCase().includes(q) : kindOf(x) === file)).sort((a, b) => a.from.localeCompare(b.from));
    list.replaceChildren(...(shown.length ? shown.map((x) => row(x)) : [h('p', { class: 'src' }, q ? t('glossNoMatch') : t('glossFileEmpty'))]));
    // (A new line being filled in stays at the top when the list is drawn again — the books' titles come, say.)
    if (freshRow && !freshRow.classList.contains('fresh')) freshRow = null;
    if (freshRow) { list.querySelector(':scope > .src')?.remove(); list.prepend(freshRow); }
    shownNow = shown; for (const id of [...picked]) if (!shown.some((x) => x.id === id)) picked.delete(id);
    drawRetr();
  }
  /* Retranslate: one entry (its row's button), the ones ticked, or every one shown; the instructions asked for first. */
  let shownNow: Term[] = [];
  function drawRetr(): void {
    const n = picked.size;
    retrBar.replaceChildren(
      h('button', { type: 'button', class: 'btn tonal small gloss-retr-sel', disabled: !n, onclick: () => retranslate(terms().filter((x) => picked.has(x.id))) }, icon('rotate'), t('glossRetrSelected'), n ? h('span', { class: 'gloss-count' }, localDigits(n)) : null),
      h('button', { type: 'button', class: 'btn text small gloss-retr-all', disabled: !shownNow.length, onclick: () => retranslate(shownNow.map((x) => terms().find((y) => y.id === x.id)).filter(Boolean) as Term[]) }, icon('rotate'), t('glossRetrAll')),
      ...(undo ? [h('button', { type: 'button', class: 'btn text small gloss-retr-undo', onclick: () => { const u = undo; undo = null; u?.(); draw(); toast(t('glossRetrUndone')); } }, icon('undo'), t('glossRetrUndo'))] : []));
  }
  const retranslate = (l: Term[]) => retranslateSheet(l, { changed: () => draw(), undo: (fn) => { undo = fn; drawRetr(); } });
  // (Where a term made here goes: the book's own list — or the folder it shares, so every volume has it —, every
  // book, or the folder shown.)
  const scopeNow = (): { book?: string; folder?: string } => {
    if (where === 'book' && book) { const d = destOf(book.id); return d.to !== 'book' && d.to !== 'auto' && d.addNew && linkedFolders(book.id).includes(d.to) ? { folder: d.to } : { book: book.id }; }
    return where === 'all' ? {} : { folder: where };
  };
  function addRow(from = ''): void {
    list.querySelector(':scope > .src')?.remove();
    const x: Term = { id: newId(), from, to: '', kind: file ?? 'person', lang: baseLang(getSettings().aiTarget), ...scopeNow() };
    const r = row(x, true); freshRow = r; list.prepend(r); (r.querySelector(from ? '.gloss-to' : '.gloss-from') as HTMLInputElement).focus();
  }
  let freshRow: HTMLElement | null = null;
  const folderName = () => (where === 'book' && book ? titleOf(book.id, book.title) : where === 'all' ? t('glossEveryBook') : folders().find((f) => f.id === where)?.name ?? 'glossary');

  /* ---------- the files: written out (a folder of text files, one per kind; or one text file), read back ---------- */
  function filesMenu(ev: Event): void {
    const sh = openSheet(t('glossFiles'), t('close'), { stack: true, at: ev }); sh.body.style.fontFamily = 'var(--font-ui)';
    const item = (ic: string, label: string, fn: () => void, cls = '') => h('button', { type: 'button', class: 'dest-row ' + cls, onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label));
    sh.body.append(h('div', { class: 'dest-list' },
      item('archive', t('glossExportZip'), () => void exportZip(), 'gloss-export-zip'),
      item('download', t('glossExportTxt'), () => exportTxt(), 'gloss-export-txt'),
      item('import', t('glossImportFiles'), () => importFiles(), 'gloss-import'),
      item('import', t('paste'), () => void paste(), 'gloss-paste'),
      item('copy', t('glossCopyAll'), () => void copyText(termsText(terms().filter(inWhere).sort((a, b) => a.from.localeCompare(b.from)))), 'gloss-copy-all')));
  }
  async function exportZip(): Promise<void> {
    const here = terms().filter(inWhere); if (!here.length) { toast(t('glossaryNone')); return; }
    const name = folderName(); const { zipWrite } = await import('../zipstore');
    const blob = await zipWrite(glossaryFiles(here, name, kindLabel).map((f) => ({ name: f.name, blob: new TextEncoder().encode(f.text) })), { type: 'application/zip' });
    downloadBlob(blob, `${safeName(name)}.zip`); toast(t('glossExported', { n: localDigits(here.length) }));
  }
  function exportTxt(): void {
    const here = terms().filter(inWhere).sort((a, b) => a.from.localeCompare(b.from)); if (!here.length) { toast(t('glossaryNone')); return; }
    downloadBlob(new Blob([termsText(here) + '\n'], { type: 'text/plain;charset=utf-8' }), `${safeName(folderName())}.txt`); toast(t('glossExported', { n: localDigits(here.length) }));
  }
  const withLang = (got: ReturnType<typeof parseTerms>) => { const tl = baseLang(getSettings().aiTarget); return got.map((x) => ({ ...x, lang: x.lang ?? (langForNew(x.to, tl) || undefined), ...scopeNow() })); };
  function importFiles(): void {
    const input = h('input', { type: 'file', accept: '.txt,.zip,text/plain,application/zip', multiple: true, style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const fs = [...(input.files ?? [])]; input.remove(); if (!fs.length) return;
      try { const n = await importGlossaryFiles(fs, withLang); draw(); toast(t('glossPasted', { n: localDigits(n) })); }
      catch (e) { toast(String((e as Error).message ?? e), 'error', 5000); }
    });
    document.body.append(input); input.click();
  }
  async function paste(): Promise<void> {
    let txt = ''; try { txt = await navigator.clipboard.readText(); } catch { txt = (await askText({ title: t('paste'), label: t('paste'), multiline: true, ok: t('add'), cancel: t('cancel') })) ?? ''; } if (!txt.trim()) return;
    // (Each line under its own language when it names one; else the one translated into, when its rendering can be
    // in it; else the one its script alone tells, or none — never an English rendering kept as Arabic.)
    const tl = baseLang(getSettings().aiTarget); const got = withLang(parseTerms(txt).map((x) => (file && !x.kind ? { ...x, kind: file } : x)));
    const other = got.filter((x) => baseLang(x.lang ?? '') !== tl).length;
    const n = addTerms(got); draw(); toast(t('glossPasted', { n: localDigits(n) }) + (other ? ` · ${t('glossPastedOther', { lang: langLabel(tl), n: localDigits(other) })}` : ''), 'info', other ? 5000 : 2200);
  }
  const filesBtn = h('button', { type: 'button', class: 'btn small tonal gloss-files-btn', onclick: (e: Event) => filesMenu(e) }, icon('folder'), t('glossFiles'));
  const addBtn = h('button', { type: 'button', class: 'btn small tonal gloss-add', onclick: () => { if (!file && !q) { file = 'person'; draw(); } addRow(); } }, icon('plus'), t('glossaryAdd'));

  void allBooks(true).then((l) => { books = l; titles = new Map(l.map((b) => [b.id, b.title])); if (root.isConnected || true) draw(); });
  draw(); void checkVol();
  return {
    el: root, actions: [filesBtn, addBtn],
    // (A word picked in the book: its file — Characters by default — open, a new line filled with it.)
    addFrom: (text: string) => { where = book ? 'book' : 'all'; q = ''; search.value = ''; if (!file) file = 'person'; draw(); addRow(text.trim().slice(0, 120)); },
    refresh: () => { if (root.isConnected) draw(); },
  };
}

/** Files read back into the glossary: a .zip of a folder (each text file's name its kind), text files (named after
 *  a kind, or one file in the old form: `name = rendering`, then its kind and language after tabs). */
export async function importGlossaryFiles(files: File[], fill: (got: ReturnType<typeof parseTerms>) => Omit<Term, 'id'>[]): Promise<number> {
  const got: ReturnType<typeof parseTerms> = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const JSZip = (await import('jszip')).default; const zip = await JSZip.loadAsync(f);
      for (const e of Object.values(zip.files)) if (!e.dir && /\.txt$/i.test(e.name)) got.push(...parseKindFile(e.name, await e.async('string')));
    } else {
      const text = await f.text(); const k = kindFromFileName(f.name);
      got.push(...(k.startsWith('u:') ? parseTerms(text) : parseKindFile(f.name, text)));
    }
  }
  return addTerms(fill(got));
}
/* ---------- Retranslate: new renderings for some terms, in the language translated into ---------- */
/** The instructions shown in the box: the reader's own, or the default, the language named in them. */
export function retranslatePrompt(target = getSettings().aiTarget): string {
  return (getSettings().aiGlossPrompt?.trim() || t('glossRetrDefault')).replaceAll('{lang}', langLabel(target));
}
/** The instructions kept: the language's name kept as «{lang}» (the same words then name the next language
 *  chosen); the default kept as nothing. */
function keepPrompt(text: string, target: string): void {
  const v = text.trim().replaceAll(langLabel(target), '{lang}');
  updateSettings({ aiGlossPrompt: v === t('glossRetrDefault').trim() ? '' : v });
}
const BATCH = 30;
/** The floating box: the instructions (the reader's own, kept; or the default again), then the run — in batches,
 *  its progress, Stop; each entry's rendering changed only when its new one has come, one not written in the
 *  language's script refused and counted; Undo puts the glossary back as it was. Nothing is changed when there is
 *  no AI service, no connection, or the service fails at once. */
export function retranslateSheet(list: Term[], o: { changed?: () => void; undo?: (fn: (() => void) | null) => void } = {}): void {
  if (!list.length) { toast(t('glossRetrNone')); return; }
  const target = getSettings().aiTarget; const tl = baseLang(target);
  let stop = false; let running = false;
  const sh = openSheet(t('glossRetrTitle'), t('close'), { stack: true, onClose: () => { stop = true; } });
  sh.el.classList.add('gloss-retr-sheet'); sh.body.style.fontFamily = 'var(--font-ui)';
  const box = h('textarea', { class: 'gloss-retr-prompt', rows: 9, dir: 'auto', spellcheck: 'false', 'aria-label': t('glossRetrPrompt') }) as HTMLTextAreaElement;
  box.value = retranslatePrompt(target);
  const reset = h('button', { type: 'button', class: 'btn text small gloss-retr-reset', onclick: () => { box.value = t('glossRetrDefault').replaceAll('{lang}', langLabel(target)); box.focus(); } }, icon('undo'), t('glossRetrReset'));
  const status = h('p', { class: 'src gloss-retr-status', role: 'status' }); const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
  const report = h('div', { class: 'gloss-retr-report' });
  sh.body.append(h('p', { class: 'gloss-retr-info' }, t('glossRetrInfo', { n: localDigits(list.length), lang: langLabel(target) })),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('glossRetrPrompt')), box),
    h('div', { class: 'gloss-retr-tools' }, h('small', { class: 'hint' }, t('glossRetrHint')), reset), track, status, report);
  const cancel = h('button', { type: 'button', class: 'btn text gloss-retr-cancel', onclick: () => { if (running) { stop = true; cancel.disabled = true; } else sh.close(); } }, t('cancel'));
  const go = h('button', { type: 'button', class: 'btn primary gloss-retr-go', onclick: () => void run() }, icon('rotate'), t('glossRetranslate'));
  sh.actions.append(cancel, go);
  setTimeout(() => box.focus(), 60);

  async function run(): Promise<void> {
    if (!box.value.trim()) { box.focus(); return; }
    if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { toast(t('glossRetrOffline'), 'error', 4000); return; }
    const instructions = box.value; keepPrompt(instructions, target);
    running = true; box.disabled = true; reset.disabled = true; go.disabled = true; track.hidden = false;
    // (What each changed entry was, to put back: an entry added beside one of another language goes again.)
    const before = new Map<string, Term | null>();
    let changed = 0, refused = 0, missing = 0, done = 0; let failed = '';
    const paint = () => { status.textContent = t('glossRetrProgress', { n: localDigits(done), total: localDigits(list.length) }); bar.style.width = `${Math.round((done / list.length) * 100)}%`; };
    paint();
    for (let i = 0; i < list.length && !stop; i += BATCH) {
      const part = list.slice(i, i + BATCH);
      let got: { from: string; to: string }[];
      try { got = await retranslateTerms(instructions, part.map((x) => ({ from: x.from, now: x.to, ...(x.kind ? { kind: x.kind } : {}) })), target); }
      catch (e) { failed = String((e as Error)?.message ?? e); break; }
      if (stop) break;   // (Stopped while it was asked: its answer is not used.)
      const all = terms().slice(); const left = [...part];
      for (const g of got) {
        const k = left.findIndex((x) => x.from.toLocaleLowerCase() === g.from.toLocaleLowerCase()); if (k < 0) continue;
        const e = left.splice(k, 1)[0]; if (!g.to) { missing++; continue; }
        if (scriptVerdict(g.to, tl) === 'bad') { refused++; continue; }
        const cur = all.find((y) => y.id === e.id); if (!cur) continue;
        const place = (y: Term) => (y.folder ?? '') === (cur.folder ?? '') && (y.book ?? '') === (cur.book ?? '');
        // (Its twin in this language, in the same place, changed; else the entry itself, when it is for this
        // language or mis-picked; else — a sound term of another language — a new one beside it.)
        const twin = all.find((y) => y.id !== cur.id && place(y) && termLang(y) === tl && y.from.toLocaleLowerCase() === cur.from.toLocaleLowerCase());
        const own = termLang(cur); const mine = !own || own === tl || misScripted(cur);
        const at = twin ?? (mine ? cur : null);
        if (at) {
          if (at.to === g.to && termLang(at) === tl && at.lang) continue;
          if (!before.has(at.id)) before.set(at.id, { ...at });
          all[all.indexOf(at)] = { ...at, to: g.to, lang: tl };
        } else { const id = newId(); before.set(id, null); all.push({ id, from: cur.from, to: g.to, lang: tl, ...(cur.kind ? { kind: cur.kind } : {}), ...(cur.book ? { book: cur.book } : {}), ...(cur.folder ? { folder: cur.folder } : {}) }); }
        changed++;
      }
      missing += left.length; done += part.length;
      saveTerms(all); o.changed?.(); paint();
    }
    running = false; cancel.disabled = false; cancel.textContent = t('close'); go.hidden = true;
    const restore = () => { let l = terms().slice(); for (const [id, prev] of before) { l = l.filter((y) => y.id !== id); if (prev) l.push(prev); } saveTerms(l); };
    if (before.size) o.undo?.(restore);
    const lines = [t('glossRetrDone', { n: localDigits(changed) }), ...(refused ? [t('glossRetrRefused', { n: localDigits(refused), lang: langLabel(target) })] : []), ...(missing && !failed && !stop ? [t('glossRetrMissing', { n: localDigits(missing) })] : [])];
    report.replaceChildren(...(failed ? [h('p', { class: 'gloss-retr-error', role: 'alert' }, t('glossRetrError', { why: failed.slice(0, 200) }))] : []), ...(stop && !failed ? [h('p', { class: 'hint' }, t('glossRetrStopped'))] : []),
      ...lines.map((l) => h('p', { class: 'gloss-retr-line' }, l)),
      ...(before.size ? [h('button', { type: 'button', class: 'btn tonal small gloss-retr-undo2', onclick: (ev: Event) => { restore(); o.changed?.(); o.undo?.(null); (ev.currentTarget as HTMLButtonElement).disabled = true; toast(t('glossRetrUndone')); } }, icon('undo'), t('glossRetrUndo'))] : []));
    if (failed) toast(t('glossRetrError', { why: failed.slice(0, 160) }), 'error', 6000);
  }
}
