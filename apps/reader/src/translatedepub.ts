// A translated book saved as an EPUB. The translations are kept per paragraph (src/ui/translator.ts: by the paragraph's text, the
// provider, the model, the task, the language, the instructions and the glossary terms it holds); this reads the book once into the
// converter's own document (src/convert.ts), finds each paragraph's saved translation the way the reader does — the key of the same
// text for the language asked — and puts it in the paragraph's place (or above the original), then lets the converter's EPUB writer
// make the file. What the saved translation keeps of the formatting (italics, bold, sub/superscript, links) comes along; headings and
// lists, the paragraphs' structure, the pictures and the cover are the book's own. Ruby (furigana) and anything else of the original's
// markup inside a translated paragraph is not kept — it appears only in the «original beneath» part.
import { db, type Book } from './db';
import { readDocument, buildEpub, slug, type ConvDoc, type Chapter, type Progress } from './convert';
import { translationKey, legacyTranslationKey, langName } from './ai';
import { getSettings } from './settings';
import { t, getLang, isRtlText } from './i18n';
import { BLOCK_SELECTOR } from './formats/shared';
import { titlesOf, setTitles } from './booktitles';
import { applyTextRules, textRules } from './textrules';
import { applyTypography } from './ui/typography';
import { termsFor, kindOf, kindOrder } from './glossary';
import { styledText, styledNodes, linkUp, inTargetScript, isTitle, SKIP, REFLOWABLE, savedTranslations, savedLanguages, sourceKeyOf } from './ui/translator';

export type Contents = 'only' | 'both';
export type Missing = 'original' | 'leave';
export interface ExportOpts { lang: string; contents: Contents; missing: Missing; glossary: boolean }
/** How a chapter stands for a language: translated (some paragraph at least), not yet (it has text to translate and none is), or nothing to translate. */
export type ChapterState = 'done' | 'missing' | 'plain';
export interface Loaded { book: Book; doc: ConvDoc; saved: { tr: Record<string, string>; src: Record<string, string> }; langs: string[]; states: Map<string, ChapterState[]>; /** The document's chapters were consumed by making a file. */ used?: boolean }

/** Only a book the reader lays out can be made into a translated EPUB (not a PDF, a picture book, a deck…). */
export const exportable = (b: Pick<Book, 'format'>): boolean => REFLOWABLE.has(b.format);
const RTL_LANG = /^(ar|fa|ur|he|yi|ps|sd|ug|dv)(-|$)/i;
export const isRtlLang = (l: string): boolean => RTL_LANG.test(l);
/** A language's name in itself («العربية», «日本語»). */
export function autonym(code: string): string { try { return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? langName(code); } catch { return langName(code); } }
/** A language's name in the language of the interface. */
export function langLabel(code: string): string { try { return new Intl.DisplayNames([getLang()], { type: 'language' }).of(code) ?? langName(code); } catch { return langName(code); } }
/** The translated book's title: the shown title and the target language's name in brackets. */
export const titleFor = (book: Pick<Book, 'title'>, lang: string): string => `${book.title} (${autonym(lang)})`;
export const fileNameFor = (book: Pick<Book, 'title'>, lang: string): string => `${slug(book.title)} - ${lang}.epub`;

const stripTags = (x: string): string => { const d = document.createElement('div'); d.innerHTML = x; return (d.textContent ?? '').replace(/\s+/g, ' ').trim(); };

interface Ctx { bookId: string; lang: string; saved: { tr: Record<string, string>; src: Record<string, string> }; origLang?: string; contents: Contents; render: boolean }
interface Done { html: string; done: number; todo: number; title: string; titleTr?: string }

/** One chapter's paragraphs found in the saved translations; with `render`, the chapter written out with them in place. */
function processChapter(ch: Chapter, c: Ctx): Done {
  const s = getSettings(); const keep = s.aiKeepStyle !== false; const titlesMode = s.aiTitles ?? 'both'; const skipSame = s.aiSkipSame !== false;
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${ch.html}</body></html>`, 'text/html');
  // (The text as the reader has it when the translation is made — its text rules, then its typography when that is on — the keys are made of that text.)
  if (textRules().length) applyTextRules(doc.body, c.bookId);
  if (s.bookFormat || s.smartTypography) applyTypography(doc.body);
  const blocks = [...doc.body.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter((b) => !b.closest('table') || b.tagName === 'TD' || b.tagName === 'TH');
  const targetRtl = isRtlLang(c.lang); const out = new Set<Element>(); const handled = new Set<Element>();
  let done = 0, todo = 0; let titleTr: string | undefined;
  const inside = (el: Element): boolean => { for (let a = el.parentElement; a; a = a.parentElement) if (out.has(a)) return true; return false; };
  for (const el of blocks) {
    if (inside(el)) continue;
    if (SKIP.has(el.tagName) || el.querySelector('img, table, svg')) continue;
    const title = isTitle(el); if (title && titlesMode === 'original') continue;
    const text = keep ? styledText(el) : (el.textContent ?? '').replace(/\s+\n/g, '\n').trim();
    if (text.length < 2) continue;
    if (skipSame && inTargetScript(text.replace(/<[^>]+>/g, ''), c.lang)) continue;
    const tr = c.saved.tr[translationKey(text, c.bookId, c.lang)] ?? c.saved.tr[legacyTranslationKey(text, c.lang)];
    if (!tr) { todo++; continue; }
    done++; handled.add(el);
    if (title && titleTr === undefined && (el.textContent ?? '').trim() === ch.title.trim()) titleTr = stripTags(tr);
    if (!c.render) continue;
    out.add(el);
    const origHtml = el.innerHTML; const dir = isRtlText(tr.replace(/<[^>]+>/g, '')) ? 'rtl' : 'ltr';
    const own = el.getAttribute('dir') || (isRtlText(stripTags(origHtml)) ? 'rtl' : 'ltr'); const oLang = el.getAttribute('lang') || c.origLang;
    const line = (cls: string): HTMLElement => { const sp = document.createElement('span'); sp.className = `kr-tr-line kr-tr-out ${cls}`.trim(); sp.dir = dir; sp.lang = c.lang; sp.append(styledNodes(tr)); linkUp(sp, origHtml); return sp; };
    const orig = (plain: boolean): HTMLElement => { const sp = document.createElement('span'); sp.className = plain ? 'kr-tr-sub' : 'kr-tr-orig'; sp.dir = own; if (oLang) sp.lang = oLang; if (plain) sp.textContent = stripTags(origHtml); else sp.innerHTML = origHtml; return sp; };
    el.removeAttribute('lang');
    if (title && titlesMode === 'both') { el.replaceChildren(line('kr-tr-title'), orig(true)); el.setAttribute('dir', dir); el.classList.add('kr-translated', 'kr-tr-titled'); }
    else if (c.contents === 'both') { el.replaceChildren(line(''), orig(false)); el.setAttribute('dir', dir); el.classList.add('kr-translated', 'kr-bilingual'); }
    else { el.replaceChildren(styledNodes(tr)); linkUp(el, origHtml); el.setAttribute('dir', dir); el.setAttribute('lang', c.lang); el.classList.add('kr-translated', 'kr-tr-out'); }
  }
  if (c.render && done) {
    // (A paragraph left in the original inside a translated chapter keeps its own direction and language.)
    for (const el of blocks) {
      if (handled.has(el) || inside(el) || !(el.textContent ?? '').trim() || el.querySelector('img')) continue;
      if (!el.hasAttribute('dir')) el.setAttribute('dir', isRtlText(el.textContent ?? '') ? 'rtl' : 'ltr');
      if (c.origLang && !el.hasAttribute('lang')) el.setAttribute('lang', c.origLang);
    }
  }
  // (The contents' title: that of the heading translated, else what the contents' own titles were kept as for the language shown now.)
  if (titleTr === undefined && done && titlesMode !== 'original' && c.lang === s.aiTarget) { const k = c.saved.src[sourceKeyOf(ch.title)]; if (k) titleTr = stripTags(k); }
  return { html: c.render ? doc.body.innerHTML : '', done, todo, title: titlesMode === 'original' || !titleTr ? ch.title : titleTr, titleTr };
}

/** The book read once, and for each language that has saved translations how every chapter stands. */
export async function loadForExport(book: Book, progress: Progress): Promise<Loaded> {
  const file = await db.getFile(book.id); if (!file) throw new Error('missing');
  const doc = await readDocument(book, file, progress);
  const saved = await savedTranslations(book.id);
  const cand = new Set<string>([...(await savedLanguages(book.id)), getSettings().aiTarget].filter(Boolean));
  const states = new Map<string, ChapterState[]>(); const langs: string[] = [];
  if (getSettings().aiTask !== 'furigana' && Object.keys(saved.tr).length) {
    for (const lang of cand) {
      const st = doc.chapters.map((ch): ChapterState => { const r = processChapter(ch, { bookId: book.id, lang, saved, origLang: doc.lang, contents: 'only', render: false }); return r.done ? 'done' : r.todo ? 'missing' : 'plain'; });
      if (st.includes('done')) { states.set(lang, st); langs.push(lang); }
    }
  }
  return { book, doc, saved, langs, states };
}

/** The glossary's terms for the language, by kind: «original → rendering». */
async function glossaryChapter(bookId: string, lang: string, rtl: boolean): Promise<Chapter | null> {
  const list = termsFor(bookId, lang).filter((x) => x.from && x.to); if (!list.length) return null;
  const { kindLabel } = await import('./ui/glossarysheet');
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const by = new Map<ReturnType<typeof kindOf>, typeof list>(); for (const x of list) { const k = kindOf(x); (by.get(k) ?? by.set(k, []).get(k)!).push(x); }
  const title = t('teGlossTitle'); let html = `<h1>${esc(title)}</h1>`;
  for (const k of kindOrder([...by.keys()])) {
    html += `<h2>${esc(kindLabel(k))}</h2><ul>`;
    for (const x of by.get(k)!.sort((a, b) => a.from.localeCompare(b.from))) html += `<li><bdi>${esc(x.from)}</bdi> → <bdi lang="${esc(lang)}">${esc(x.to)}</bdi></li>`;
    html += '</ul>';
  }
  return { title, html, rtl, lang };
}

/** The translated book as a document for the EPUB writer. The loaded document's chapters are consumed (one at a time, so the book is
 *  not held twice): load again to make another. */
export async function assemble(l: Loaded, o: ExportOpts, progress: Progress, sig: { stop: boolean }): Promise<ConvDoc> {
  l.used = true;
  const { book, doc } = l; const rtl = isRtlLang(o.lang); const origLang = doc.lang || undefined; const chapters: Chapter[] = [];
  const total = doc.chapters.length; const uiDir = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  let first = true;
  const note = `<p class="kr-mt-note" lang="${esc(getLang())}" dir="${uiDir}"><small>${esc(t('teNote'))}</small></p>`;
  for (let i = 0; i < total; i++) {
    if (sig.stop) throw new Error('cancel');
    progress('build', 55 + Math.round((i / Math.max(1, total)) * 10));
    const ch = doc.chapters[i]; doc.chapters[i] = { title: '', html: '', rtl: false };
    const r = processChapter(ch, { bookId: book.id, lang: o.lang, saved: l.saved, origLang, contents: o.contents, render: true });
    const state: ChapterState = r.done ? 'done' : r.todo ? 'missing' : 'plain';
    if (state === 'missing' && o.missing === 'leave') continue;
    const out: Chapter = state === 'done' ? { title: r.title, html: r.html, rtl, lang: o.lang } : { title: ch.title, html: ch.html, rtl: ch.rtl, lang: origLang ?? 'und' };
    if (first) { out.html = note + out.html; first = false; }
    chapters.push(out);
  }
  if (o.glossary) { const g = await glossaryChapter(book.id, o.lang, rtl); if (g) chapters.push(g); }
  doc.chapters = [];
  const others = titlesOf(book);
  return { title: titleFor(book, o.lang), titles: others, author: book.author, lang: o.lang, rtl, description: t('teNote'), chapters, images: doc.images, fonts: new Map(), cover: doc.cover };
}

/** The whole export: the file, and (when asked) the book added to the library beside the source. */
export async function makeTranslatedEpub(l: Loaded, o: ExportOpts, progress: Progress, sig: { stop: boolean }): Promise<{ blob: Blob; name: string }> {
  const d = await assemble(l, o, progress, sig);
  if (sig.stop) throw new Error('cancel');
  progress('build', 70);
  const blob = await buildEpub(d, progress);
  return { blob, name: fileNameFor(l.book, o.lang) };
}

/** The translated file imported as a new book that sits beside its source (the same series and volume, the same shelf); nothing else of the
 *  source is copied — no highlights, no marks, no saved translations. Resolves to the new book's id. */
export async function addToLibrary(source: Book, blob: Blob, name: string, lang: string): Promise<string | undefined> {
  const { importFiles } = await import('./library');
  const added = await importFiles([new File([blob], name, { type: 'application/epub+zip' })]); const nb = added[0]; if (!nb) return undefined;
  const title = titleFor(source, lang);
  await db.updateBook(nb.id, (b) => {
    setTitles(b, [title, ...titlesOf(source)]);
    if (source.author) b.author = source.author;
    if (source.series) b.series = { ...source.series };
    if (source.folderId) b.folderId = source.folderId;
    b.language = lang;
  });
  return nb.id;
}
