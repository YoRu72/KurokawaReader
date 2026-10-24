// Search across the library: a word or phrase in many books at once. Which books (all, a folder, tags, kinds,
// or hand-picked), how to match (exact phrase, all words on the page, any word; whole words; letters exactly
// or as the in-book search does — harakat and letter variants aside), and the results grouped by book, each
// opening the book at its place.
import { h, icon, openSheet, toast } from './dom';
import { t, localDigits, getLang, arCount } from '../i18n';
import { navigate } from '../router';
import type { Book, Folder } from '../db';
import { coverUrl } from '../library';
import { searchable, unitsOf, searchUnits, setJump, setReturn, type Mode, type Options, type BookResult, type Return } from '../booksearch';

type Scope = { kind: 'all' } | { kind: 'folder'; id: string } | { kind: 'picked'; ids: Set<string>; leaveOut: boolean };
const KEY = 'kr.libsearch';
type Saved = { mode: Mode; wholeWord: boolean; exact: boolean; formats: string[]; noFormats: string[]; tags: string[]; noTags: string[]; recent: string[] };
const DEF: Saved = { mode: 'phrase', wholeWord: false, exact: false, formats: [], noFormats: [], tags: [], noTags: [], recent: [] };
const load = (): Saved => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>) }; } catch { return { ...DEF }; } };
const save = (s: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } };

const FORMAT_LABEL: Record<string, string> = { pdf: 'PDF', epub: 'EPUB', docx: 'Word', odt: 'ODT', fb2: 'FB2', txt: 'TXT', md: 'Markdown', html: 'HTML', mobi: 'Kindle', xlsx: 'Excel', csv: 'CSV', pptx: 'PowerPoint' };

/** "12 results in 3 books" — in Arabic with each noun counted as the grammar has it, the books after «في» genitive:
 *  «نتيجةٌ واحدة في كتابٍ واحد»، «١٠ نتائج في كتابين»، «١٢ نتيجةً في ٣ كتب». */
function foundText(found: number, books: number): string {
  if (getLang() !== 'ar') return t('foundInBooks', { n: localDigits(found), books: localDigits(books) });
  const res = arCount(found, { one: 'نتيجةٌ واحدة', two: 'نتيجتان', few: 'نتائج', many: 'نتيجةً', hundred: 'نتيجةٍ' });
  const bk = arCount(books, { one: 'كتابٍ واحد', two: 'كتابين', few: 'كتب', many: 'كتابًا', hundred: 'كتابٍ' });
  return `${res} في ${bk}`;
}
function skippedText(n: number): string {
  if (getLang() !== 'ar') return t('skippedBooks', { n: localDigits(n) });
  return `لم يُبحث في ${arCount(n, { one: 'كتابٍ واحد', two: 'كتابين', few: 'كتب', many: 'كتابًا', hundred: 'كتابٍ' })}`;
}

export function librarySearchSheet(books: Book[], folders: Folder[], activeFolder?: string | null, back?: Return): void {
  const sh = openSheet(t('searchBooks'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.el.classList.add('libsearch-sheet');
  const st = load();
  const pool = books.filter(searchable);
  let scope: Scope = back ? (back.scope.kind === 'picked' ? { kind: 'picked', ids: new Set(back.scope.ids), leaveOut: back.scope.leaveOut } : back.scope) : activeFolder ? { kind: 'folder', id: activeFolder } : { kind: 'all' };
  // How many hits each book's list shows (kept for coming back from a result).
  const shownOf = new Map<string, number>(Object.entries(back?.shown ?? {}));
  // Kinds and tags: each left alone, kept to (only these), or left out — a tap goes through the three.
  const formats = new Map<string, 'in' | 'out'>([...st.formats.map((f): [string, 'in'] => [f, 'in']), ...st.noFormats.map((f): [string, 'out'] => [f, 'out'])].filter(([f]) => pool.some((b) => b.format === f)));
  const tags = new Map<string, 'in' | 'out'>([...st.tags.map((x): [string, 'in'] => [x, 'in']), ...st.noTags.map((x): [string, 'out'] => [x, 'out'])]);
  const cycle = (m: Map<string, 'in' | 'out'>, k: string) => { const v = m.get(k); if (!v) m.set(k, 'in'); else if (v === 'in') m.set(k, 'out'); else m.delete(k); };
  const persist = () => { st.formats = [...formats].filter(([, v]) => v === 'in').map(([k]) => k); st.noFormats = [...formats].filter(([, v]) => v === 'out').map(([k]) => k); st.tags = [...tags].filter(([, v]) => v === 'in').map(([k]) => k); st.noTags = [...tags].filter(([, v]) => v === 'out').map(([k]) => k); save(st); };
  const triChip = (state: 'in' | 'out' | undefined, label: HTMLElement, fn: () => void, ic?: string) => h('button', { type: 'button', class: 'chip small tri' + (state === 'in' ? ' on' : state === 'out' ? ' out' : ''), title: state === 'in' ? t('filterOnly') : state === 'out' ? t('filterExclude') : t('filterAny'), 'aria-pressed': state === 'in' ? 'true' : state === 'out' ? 'mixed' : 'false', onclick: fn }, state === 'in' ? icon('check') : state === 'out' ? icon('minus') : ic ? icon(ic) : null, label);
  let token = { cancelled: false };

  // Query
  const input = h('input', { type: 'search', class: 'ls-input', placeholder: t('searchBooksPlaceholder'), 'aria-label': t('searchBooks'), dir: 'auto', enterkeyhint: 'search' }) as HTMLInputElement;
  const go = h('button', { type: 'button', class: 'btn primary ls-go', onclick: () => void run() }, icon('search'), h('span', null, t('search')));
  const stop = h('button', { type: 'button', class: 'btn tonal ls-go', hidden: true, onclick: () => { token.cancelled = true; } }, icon('stop'), h('span', null, t('cancel')));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } });
  const recent = h('div', { class: 'chip-row wrap ls-recent' });
  const drawRecent = () => recent.replaceChildren(...st.recent.slice(0, 8).map((q) => h('button', { type: 'button', class: 'chip small', dir: 'auto', onclick: () => { input.value = q; void run(); } }, icon('clock'), h('span', null, q))));
  drawRecent();

  // How to match
  const seg = h('div', { class: 'segmented ls-mode', role: 'radiogroup', 'aria-label': t('searchMatch') });
  const drawSeg = () => seg.replaceChildren(...([['phrase', t('matchPhrase')], ['all', t('matchAll')], ['any', t('matchAny')]] as [Mode, string][]).map(([m, l]) => h('button', { type: 'button', role: 'radio', 'aria-pressed': String(st.mode === m), 'aria-checked': String(st.mode === m), onclick: () => { st.mode = m; save(st); drawSeg(); } }, l)));
  drawSeg();
  const toggle = (label: string, key: 'wholeWord' | 'exact') => {
    const mark = icon('check');
    const b = h('button', { type: 'button', class: 'chip small' + (st[key] ? ' on' : ''), 'aria-pressed': String(st[key]), onclick: () => { st[key] = !st[key]; save(st); sync(); } }, mark, h('span', null, label));
    const sync = () => { b.classList.toggle('on', st[key]); b.setAttribute('aria-pressed', String(st[key])); (mark as unknown as HTMLElement).style.display = st[key] ? '' : 'none'; };
    sync();
    return b;
  };

  // Which books
  const scopeRow = h('div', { class: 'chip-row wrap' });
  const drawScope = () => {
    const chip = (on: boolean, label: string, fn: () => void, ic?: string) => h('button', { type: 'button', class: 'chip small' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, ic ? icon(ic) : null, h('span', { dir: 'auto' }, label));
    scopeRow.replaceChildren(
      chip(scope.kind === 'all', t('allBooksN', { n: localDigits(pool.length) }), () => { scope = { kind: 'all' }; drawScope(); }, 'books'),
      ...folders.filter((f) => pool.some((b) => b.folderId === f.id)).map((f) => chip(scope.kind === 'folder' && scope.id === f.id, f.name, () => { scope = { kind: 'folder', id: f.id }; drawScope(); }, 'folder')),
      chip(scope.kind === 'picked', scope.kind === 'picked' ? t(scope.leaveOut ? 'leftOutBooksN' : 'chosenBooksN', { n: localDigits(scope.ids.size) }) : t('chooseBooks'), () => pickBooks(), 'grid'));
  };
  const fmtRow = h('div', { class: 'chip-row wrap' });
  const drawFormats = () => {
    const present = [...new Set(pool.map((b) => b.format))];
    fmtRow.replaceChildren(...present.map((f) => triChip(formats.get(f), h('span', { dir: 'ltr' }, `${FORMAT_LABEL[f] ?? f.toUpperCase()} · ${localDigits(pool.filter((b) => b.format === f).length)}`), () => { cycle(formats, f); persist(); drawFormats(); })));
  };
  const allTags = [...new Set(pool.flatMap((b) => b.tags ?? []))].sort();
  const tagRow = h('div', { class: 'chip-row wrap' });
  const drawTags = () => tagRow.replaceChildren(...allTags.map((tg) => triChip(tags.get(tg), h('span', { dir: 'auto' }, tg), () => { cycle(tags, tg); persist(); drawTags(); }, 'tag')));
  drawScope(); drawFormats(); drawTags();

  const pickBooks = () => {
    const chosen = new Set(scope.kind === 'picked' ? scope.ids : []);
    let leaveOut = scope.kind === 'picked' && scope.leaveOut;
    const p = openSheet(t('chooseBooks'), t('close'), { stack: true }); p.body.style.fontFamily = 'var(--font-ui)';
    const how = h('div', { class: 'segmented' });
    const drawHow = () => how.replaceChildren(...([[false, t('searchOnlyThese')], [true, t('leaveTheseOut')]] as [boolean, string][]).map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(leaveOut === v), onclick: () => { leaveOut = v; drawHow(); } }, l)));
    drawHow();
    const filter = h('input', { type: 'search', placeholder: t('searchPlaceholder'), dir: 'auto' }) as HTMLInputElement;
    const list = h('div', { class: 'dest-list' });
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      list.replaceChildren(...pool.filter((b) => !q || b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q)).map((b) => h('label', { class: 'dest-row' },
        h('input', { type: 'checkbox', checked: chosen.has(b.id), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(b.id); else chosen.delete(b.id); } }),
        h('span', { class: 'name' }, h('bdi', null, b.title), h('small', null, ` · ${FORMAT_LABEL[b.format] ?? b.format}`)))));
    };
    filter.addEventListener('input', draw); draw();
    p.body.append(how, filter, list);
    p.actions.append(h('button', { class: 'btn small', type: 'button', onclick: () => { chosen.clear(); draw(); } }, t('clearSelection')),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => { p.close(); scope = chosen.size ? { kind: 'picked', ids: chosen, leaveOut } : { kind: 'all' }; drawScope(); } }, icon('check'), t('done')));
  };

  const filters = h('details', { class: 'ls-filters' },
    h('summary', null, icon('sort'), h('span', null, t('searchFilters'))),
    h('div', { class: 'ls-field' }, h('span', { class: 'label' }, t('searchMatch')), seg, h('div', { class: 'chip-row wrap' }, toggle(t('wholeWords'), 'wholeWord'), toggle(t('matchMarks'), 'exact'))),
    h('div', { class: 'ls-field' }, h('span', { class: 'label' }, t('searchIn')), scopeRow),
    h('div', { class: 'ls-field' }, h('span', { class: 'label' }, t('filterFormats')), fmtRow, h('span', { class: 'hint' }, t('filterTriHint'))),
    ...(allTags.length ? [h('div', { class: 'ls-field' }, h('span', { class: 'label' }, t('tags')), tagRow)] : []));
  if (st.wholeWord || st.exact || st.mode !== 'phrase' || formats.size || tags.size) filters.open = true;

  const status = h('p', { class: 'src ls-status' });
  const bar = h('div', { class: 'progress-bar', hidden: true }, h('span'));
  const results = h('div', { class: 'ls-results' });
  sh.body.append(h('div', { class: 'ls-bar' }, input, go, stop), recent, filters, status, bar, results);
  if (back) {
    // Back from a result: the same search again (the books' text is kept, so it is quick), and the list
    // scrolled to where it was.
    input.value = back.q;
    void run().then(() => { sh.body.scrollTop = back.scroll; });
  } else setTimeout(() => input.focus(), 60);

  function targets(): Book[] {
    let list = pool;
    if (scope.kind === 'folder') { const id = scope.id; list = list.filter((b) => b.folderId === id); }
    if (scope.kind === 'picked') { const ids = scope.ids, out = scope.leaveOut; list = list.filter((b) => ids.has(b.id) !== out); }
    const fin = [...formats].filter(([, v]) => v === 'in').map(([k]) => k), fout = [...formats].filter(([, v]) => v === 'out').map(([k]) => k);
    if (fin.length) list = list.filter((b) => fin.includes(b.format));
    if (fout.length) list = list.filter((b) => !fout.includes(b.format));
    const tin = [...tags].filter(([, v]) => v === 'in').map(([k]) => k), tout = [...tags].filter(([, v]) => v === 'out').map(([k]) => k);
    if (tin.length) list = list.filter((b) => (b.tags ?? []).some((tg) => tin.includes(tg)));
    if (tout.length) list = list.filter((b) => !(b.tags ?? []).some((tg) => tout.includes(tg)));
    return list;
  }

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { status.textContent = t('searchTooShort'); return; }
    token.cancelled = true; token = { cancelled: false }; const my = token;
    st.recent = [q, ...st.recent.filter((x) => x !== q)].slice(0, 12); save(st); drawRecent();
    const list = targets();
    const opts: Options = { mode: st.mode, wholeWord: st.wholeWord, exact: st.exact };
    results.replaceChildren(); go.hidden = true; if (!back || q !== back.q) shownOf.clear(); stop.hidden = false; bar.hidden = false;
    const fill = bar.firstElementChild as HTMLElement;
    let found = 0, inBooks = 0; const skipped: string[] = [];
    for (let i = 0; i < list.length && !my.cancelled; i++) {
      const b = list[i];
      status.textContent = t('searchingBook', { n: localDigits(i + 1), total: localDigits(list.length), title: b.title });
      fill.style.width = `${(i / list.length) * 100}%`;
      const units = await unitsOf(b, (n, total) => { if (!my.cancelled) { status.textContent = t('readingBookPages', { title: b.title, n: localDigits(n), total: localDigits(total) }); fill.style.width = `${((i + n / total) / list.length) * 100}%`; } });
      if (my.cancelled) break;
      if (typeof units === 'string') { skipped.push(units === 'protected' ? t('protectedBook', { title: b.title }) : b.title); continue; }
      const r = searchUnits(units, q, opts);
      if (!r.total) continue;
      found += r.total; inBooks++;
      results.append(group({ book: b, hits: r.hits, total: r.total }, q));
      await new Promise((res) => setTimeout(res, 0));
    }
    fill.style.width = '100%'; go.hidden = false; stop.hidden = true; setTimeout(() => { bar.hidden = true; }, 400);
    status.textContent = (my.cancelled ? `${t('cancelled')} · ` : '') + (found ? foundText(found, inBooks) : t('noResults')) + (skipped.length ? ` · ${skippedText(skipped.length)}` : '');
    if (skipped.length) status.title = skipped.join('\n');
  }

  /** One book's results: its cover, title and count, then its hits (more on request). */
  function group(r: BookResult, q: string): HTMLElement {
    const cover = coverUrl(r.book);
    const list = h('ol', { class: 'ls-hits' });
    const SHOW = 8; let shown = 0; const want = shownOf.get(r.book.id) ?? SHOW;
    const more = h('button', { type: 'button', class: 'btn small tonal ls-more' });
    const drawMore = () => {
      for (const hit of r.hits.slice(shown, shown + (shown ? 40 : SHOW))) {
        list.append(h('li', null, h('button', { type: 'button', class: 'ls-hit', onclick: () => {
          setJump({ id: r.book.id, q, unit: hit.unit, nth: hit.nth, pdf: r.book.format === 'pdf' });
          setReturn({ q, scope: scope.kind === 'picked' ? { kind: 'picked', ids: [...scope.ids], leaveOut: scope.leaveOut } : scope, scroll: sh.body.scrollTop, shown: Object.fromEntries(shownOf) });
          sh.close(); navigate(`/read/${r.book.id}`);
        } },
          h('span', { class: 'ls-where' }, r.book.format === 'pdf' ? t('pageN', { n: localDigits(hit.label) }) : h('bdi', null, hit.label)),
          h('span', { class: 'ls-ctx', dir: 'auto' }, hit.before, h('mark', null, hit.match), hit.after))));
      }
      shown = Math.min(r.hits.length, shown + (shown ? 40 : SHOW));
      shownOf.set(r.book.id, shown);
      more.hidden = shown >= r.hits.length;
      const left = r.hits.length - shown;
      more.textContent = getLang() === 'ar' ? `عرض ${arCount(left, { one: 'نتيجةٍ أخرى', two: 'نتيجتين أخريين', few: 'نتائج أخرى', many: 'نتيجةً أخرى', hundred: 'نتيجةٍ أخرى' })}` : t('showMoreN', { n: localDigits(left) });
    };
    more.addEventListener('click', drawMore);
    drawMore();
    while (shown < Math.min(want, r.hits.length)) drawMore();
    const head = h('summary', { class: 'ls-book' },
      cover ? h('img', { class: 'ls-cover', src: cover, alt: '' }) : h('span', { class: 'ls-cover blank' }, icon('books')),
      h('span', { class: 'ls-title' }, h('b', { dir: 'auto' }, r.book.title), h('small', null, `${FORMAT_LABEL[r.book.format] ?? r.book.format}${r.book.author ? ' · ' : ''}`, r.book.author ? h('bdi', null, r.book.author) : '')),
      h('span', { class: 'ls-count' }, localDigits(r.total > r.hits.length ? `${r.hits.length}+` : String(r.total))));
    const el = h('details', { class: 'ls-group', open: true }, head, list, more);
    return el;
  }
  void toast;
}
