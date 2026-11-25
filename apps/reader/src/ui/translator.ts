// Chapter translation with an AI model — works like a browser's page translator:
// a floating pill toggles it on and off instantly, paragraphs are translated in
// the order they come into view, results are cached per book so switching off
// and on again costs nothing, and the chapter can be re-translated or the cache
// cleared on demand. The translation stands in place of the text or under it
// (both at once, the original dimmed); italics and bold come through; each batch
// is sent with the book, the chapter and the lines before it, so names and tone
// carry on; paragraphs already in the target script are left alone; the next
// chapter is translated while this one is read; and names found in a chapter can
// be put in the glossary at a tap, so they are rendered the same everywhere.
import { h, icon, toast, openSheet, pickButton } from './dom';
import { t, isRtlText, localDigits, getLang } from '../i18n';
import { db } from '../db';
import { translateBatch, translationKey, legacyTranslationKey, aiReady, suggestTerms, langName, hash, onAiWait, type TrContext } from '../ai';
import { termsFor, addTerms, newNames, bookTerms, namesTarget, linkedFolders, terms as glossTerms, termLang, legacyLang, kindOf, kindOrder, hasGlossary, volDecision, volChoice, shareGlossary } from '../glossary';
import { getSettings, updateSettings } from '../settings';
import { aiSheet, setAiHooks, type AiHooks } from './aisheet';
import { askGather, gatherModeOf, bookAuto, setBookGather, askedKey, wasAsked, markAsked, sessionChoice, setSessionChoice, autoStopped, stopAuto, type GatherScope } from './gather';

export interface TranslatorHost {
  root: HTMLElement;                                   // reader root (the pill is appended here)
  scroll: HTMLElement;
  blocks(): { el: HTMLElement; bookId: string }[];      // blocks of what is currently shown
  chapters(): { label: string; bookId: string; blocks: HTMLElement[] }[];   // every chapter of every open book
  currentChapter(): number;
  onChapterChange(fn: () => void): void;
  bookTitle?(bookId: string): string | undefined;
  /** A book's language and format, as the library keeps them (for starting by itself: only a text in another language). */
  bookInfo?(bookId: string): { language?: string; format?: string } | undefined;
}
/** The formats that are text laid out by the reader (not pages, pictures, tables or sound): what may start translating by itself. */
export const REFLOWABLE = new Set(['epub', 'docx', 'txt', 'md', 'html', 'fb2', 'odt', 'mobi', 'shamela', 'webnovel']);

export const SKIP = new Set(['IMG', 'FIGURE', 'TABLE', 'HR', 'SVG', 'VIDEO', 'AUDIO', 'PRE', 'CODE']);
export const KEEP = new Set(['I', 'EM', 'B', 'STRONG', 'U', 'SUP', 'SUB', 'A']);
/** A heading or a title (what is translated with its original beneath, when chosen). */
export const isTitle = (el: Element): boolean => /^H[1-6]$/.test(el.tagName) || /(^|[\s_-])(title|heading|chapter-?name)([\s_-]|$)/i.test(el.className || '');
const escText = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
/** A paragraph's text with its italics, bold and the like kept as plain tags (ruby readings and other markup
 *  left out) — what the model is given when styles are kept. */
export function styledText(el: Element): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out += escText(n.nodeValue ?? ''); return; }
    if (n.nodeType !== 1) return; const e = n as Element; const tag = e.tagName.toUpperCase();
    if (tag === 'RT' || tag === 'RP' || tag === 'SCRIPT' || tag === 'STYLE') return;
    if (tag === 'BR') { out += '\n'; return; }
    const keep = KEEP.has(tag) && (e.textContent ?? '').trim() && (tag !== 'A' || e.hasAttribute('href'));
    if (keep) out += `<${tag.toLowerCase()}>`; e.childNodes.forEach(walk); if (keep) out += `</${tag.toLowerCase()}>`;
  };
  el.childNodes.forEach(walk);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '').replace(/^\s+/, '').replace(/<(\w+)>\s*<\/\1>/g, '');
}
/** A translation as nodes: the kept tags made elements again, anything else as text (never markup). */
export function styledNodes(text: string): DocumentFragment {
  const tpl = document.createElement('template'); tpl.innerHTML = text.replace(/\n/g, '<br>');
  const frag = document.createDocumentFragment();
  const copy = (n: Node, into: Node) => {
    if (n.nodeType === 3) { into.appendChild(document.createTextNode(n.nodeValue ?? '')); return; }
    if (n.nodeType !== 1) return; const e = n as Element; const tag = e.tagName.toUpperCase();
    if (tag === 'BR') { into.appendChild(document.createElement('br')); return; }
    const box = KEEP.has(tag) ? into.appendChild(document.createElement(tag.toLowerCase())) : into;
    e.childNodes.forEach((c) => copy(c, box));
  };
  tpl.content.childNodes.forEach((c) => copy(c, frag));
  return frag;
}
/** Whether a paragraph is already written in the target language's own script (Arabic for Arabic, Persian and
 *  Urdu; kana and Han for Japanese; Han for Chinese; Cyrillic for Russian) — then it is not sent. */
export function inTargetScript(text: string, target: string): boolean {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, ''); if (letters.length < 2) return false;
  const share = (re: RegExp) => (letters.match(re)?.length ?? 0) / letters.length;
  if (/^(ar|fa|ur)/.test(target)) return share(/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/g) > 0.8;
  if (target === 'ja') return share(/[\u3040-\u30ff]/g) > 0.15 && share(/[\u3040-\u30ff\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) > 0.8;
  if (/^zh/.test(target)) return share(/[\u4e00-\u9fff]/g) > 0.8 && share(/[\u3040-\u30ff]/g) === 0;
  if (target === 'ru') return share(/[\u0400-\u04ff]/g) > 0.8;
  return false;
}

// (The translations of each book, shared by every reader opened on it: a whole-book translation going on in the
// background after its reader was closed writes into the same record a reader opened again reads and saves.)
const caches = new Map<string, Record<string, string>>();   // bookId → key → translation
const bySource = new Map<string, Record<string, string>>();
/** What is kept of a book's translations, in hand and in the library: by key (the paragraph, the model, the language…) and by the
 *  original's text alone (the contents' titles) — read by the export of the translation (src/translatedepub.ts). */
export async function savedTranslations(bookId: string): Promise<{ tr: Record<string, string>; src: Record<string, string> }> {
  const tr = { ...((await db.getMeta<Record<string, string>>(`tr:${bookId}`)) ?? {}), ...(caches.get(bookId) ?? {}) };
  const src = { ...((await db.getMeta<Record<string, string>>(`trs:${bookId}`)) ?? {}), ...(bySource.get(bookId) ?? {}) };
  return { tr, src };
}
/** The key a title is kept under in the second record (the contents' titles). */
export const sourceKeyOf = (plain: string): string => hash(plain.replace(/\s+/g, ' ').trim());
/** The languages a book was translated into (noted when a translation is kept; older ones are found only for the language set now). */
export async function savedLanguages(bookId: string): Promise<string[]> { return Object.keys((await db.getMeta<Record<string, number>>(`trLangs:${bookId}`)) ?? {}); }
const langNoted = new Set<string>();
function noteLanguage(bookId: string, lang: string): void {
  const k = `${bookId}:${lang}`; if (!lang || langNoted.has(k)) return; langNoted.add(k);
  void db.updateMeta<Record<string, number>>(`trLangs:${bookId}`, (cur) => ({ ...(cur ?? {}), [lang]: Date.now() })).catch(() => langNoted.delete(k));
}
/** The whole-book translations going on, by book: one at a time for a book, whichever reader started it. */
const aheadJobs = new Map<string, { cancel(): void; done: number; total: number; bookId: string; label: string; from: number; to: number }>();
/** The paragraphs a job is translating right now (by key): another job — this chapter beside the whole book — leaves
 *  them to it and counts them done once they are kept, so nothing is translated twice. */
const inFlight = new Set<string>();

/** The links of the original given back to the translation: the n-th link of the translation takes the n-th
 *  link's address (and its other attributes); a paragraph that was one link whole, its tags lost by the model,
 *  becomes that link again — a contents page translated still takes you to each chapter. */
export function linkUp(out: Element, originalHtml: string): void {
  const tpl = document.createElement('template'); tpl.innerHTML = originalHtml;
  const src = Array.from(tpl.content.querySelectorAll('a[href]')); if (!src.length) return;
  const got = Array.from(out.querySelectorAll('a'));
  got.forEach((a, i) => { const o = src[Math.min(i, src.length - 1)]; for (const at of Array.from(o.attributes)) a.setAttribute(at.name, at.value); });
  if (!got.length) {
    const whole = (tpl.content.textContent ?? '').replace(/\s+/g, ' ').trim(); const only = src.length === 1 && (src[0].textContent ?? '').replace(/\s+/g, ' ').trim() === whole;
    if (only) { const a = document.createElement('a'); for (const at of Array.from(src[0].attributes)) a.setAttribute(at.name, at.value); a.append(...Array.from(out.childNodes)); out.append(a); }
  }
}

/** A book's translations in hand written to the library merged with what is kept there (the ones in hand win),
 *  and those kept that were not in hand taken into them. */
async function keepMerged(key: string, mem: Record<string, string> | undefined): Promise<void> {
  if (!mem) return;
  const all = await db.updateMeta<Record<string, string>>(key, (cur) => ({ ...(cur ?? {}), ...mem }));
  if (all) for (const [k, v] of Object.entries(all)) if (!(k in mem)) mem[k] = v;
}

export type Translator = { titles(bookId: string, labels: string[]): Promise<Record<string, string>>; toggleUi(): void; dispose(): void; hasTranslations(bookIds: string[]): Promise<boolean>; load(bookIds: string[]): Promise<void>; pairOf(el: HTMLElement, bookId: string): { orig: string; tr?: string }; target(): string };
export function attachTranslator(host: TranslatorHost): Translator {
  let on = false; let disposed = false;
  let pill: HTMLElement | null = null;
  let running = false, generation = 0;
  const originals = new WeakMap<HTMLElement, string>();
  const dirty = new Set<string>();
  let saveTimer = 0;
  let pending = 0, done = 0;
  // (Gathering the names before a translation: shown on the bar; a press of its button stops it.)
  let gathering = false; let gatherSig = { stop: false }; let autoStarted = false;

  async function cache(bookId: string): Promise<Record<string, string>> {
    let c = caches.get(bookId);
    if (!c) { c = (await db.getMeta<Record<string, string>>(`tr:${bookId}`)) ?? {}; caches.set(bookId, c); }
    return c;
  }
  // A second record of each book's translations, by the original text alone (not by the model or the
  // instructions that made them): what the search across languages reads, whatever the settings are now.
  async function sourceIndex(bookId: string): Promise<Record<string, string>> {
    let c = bySource.get(bookId);
    if (!c) { c = (await db.getMeta<Record<string, string>>(`trs:${bookId}`)) ?? {}; bySource.set(bookId, c); }
    return c;
  }
  const srcKey = (plain: string) => hash(plain.replace(/\s+/g, ' ').trim());
  const plainOfText = (x: string) => { const d = document.createElement('div'); d.innerHTML = x; return (d.textContent ?? '').replace(/\s+/g, ' ').trim(); };
  async function remember(bookId: string, key: string, sourceText: string, tr: string) {
    const c = await cache(bookId); c[key] = tr; if (!furi()) noteLanguage(bookId, getSettings().aiTarget);
    (await sourceIndex(bookId))[srcKey(plainOfText(sourceText))] = tr;
    scheduleSave(bookId);
  }
  function scheduleSave(bookId: string) {
    dirty.add(bookId);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 800);
  }
  // (Written over what is kept, not in its place: translations put there since this book's were read — restored
  // from a backup, or brought by sync — stay, and come into the ones in hand.)
  function flush() { for (const id of dirty) { void keepMerged(`tr:${id}`, caches.get(id)); void keepMerged(`trs:${id}`, bySource.get(id)); } dirty.clear(); }

  const plainOf = (el: HTMLElement) => (el.innerText ?? el.textContent ?? '').replace(/\s+\n/g, '\n').trim();
  const furi = () => getSettings().aiTask === 'furigana';
  const keepStyle = () => !furi() && getSettings().aiKeepStyle !== false;
  /** What is sent for a paragraph: its text — with its italics and bold when they are kept. */
  const textOf = (el: HTMLElement) => (keepStyle() ? styledText(el) : plainOf(el));
  const sourceOf = (el: HTMLElement) => { if (!originals.has(el)) return textOf(el); const d = document.createElement('div'); d.innerHTML = originals.get(el)!; return keepStyle() ? styledText(d) : (d.innerText ?? d.textContent ?? '').trim(); };
  const translations = new WeakMap<HTMLElement, string>();
  // (Each paragraph's own direction as the book set it, put back exactly: removing it let a paragraph take its
  // chapter's direction — Japanese laid out right to left, its full stops at the start of the lines.)
  const dirs = new WeakMap<HTMLElement, string | null>(); const langs = new WeakMap<HTMLElement, string | null>();
  const ownDir = (el: HTMLElement) => { const d = dirs.get(el); if (d) return d; const x = plainOfText(originals.get(el) ?? ''); return x ? (isRtlText(x) ? 'rtl' : 'ltr') : 'auto'; };
  const eligible = (el: HTMLElement) => { if (SKIP.has(el.tagName) || el.querySelector('img, table, svg')) return false; if (getSettings().aiTitles === 'original' && isTitle(el)) return false; const x = originals.has(el) ? sourceOf(el) : plainOf(el); if (x.length < 2) return false; if (furi()) return /[\u4e00-\u9fff]/.test(x); return !(getSettings().aiSkipSame !== false && inTargetScript(x.replace(/<[^>]+>/g, ''), getSettings().aiTarget)); };

  function apply(el: HTMLElement, translated: string) {
    if (!originals.has(el)) { originals.set(el, el.innerHTML); dirs.set(el, el.getAttribute('dir')); langs.set(el, el.getAttribute('lang')); }
    if (getSettings().aiTask === 'furigana') {
      // Only ruby markup may come back; everything else is escaped.
      const safe = translated.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
        .replace(/&lt;(\/?)(ruby|rt|rp)&gt;/g, '<$1$2>');
      el.innerHTML = safe;
      el.classList.add('kr-translated', 'kr-furigana');
      return;
    }
    translations.set(el, translated);
    const dir = isRtlText(translated.replace(/<[^>]+>/g, '')) ? 'rtl' : 'ltr';
    const target = getSettings().aiTarget || 'en'; const html = originals.get(el)!;
    // (The translation marked as in its own language: set in the reader's face for that script — the Arabic
    // one chosen, not the Japanese book's face.)
    const out = (cls: string) => { const sp = h('span', { class: `kr-tr-line kr-tr-out ${cls}`, dir, lang: target }, styledNodes(translated)); linkUp(sp, html); return sp; };
    const backLang = () => { const lg = langs.get(el); if (lg) el.setAttribute('lang', lg); else el.removeAttribute('lang'); };
    const origPlain = () => h('span', { class: 'kr-tr-sub', dir: ownDir(el), lang: langs.get(el) ?? undefined }, plainOfText(html));
    if (isTitle(el) && (getSettings().aiTitles ?? 'both') === 'both') {
      // A title: the translation, and the original under it, smaller.
      backLang(); el.replaceChildren(out('kr-tr-title'), origPlain()); el.classList.add('kr-translated', 'kr-tr-titled'); el.classList.remove('kr-bilingual'); el.setAttribute('dir', dir);
      return;
    }
    if (getSettings().aiDisplay === 'bilingual') {
      // Both: the original as it was (dimmed), the translation under it in a line of its own.
      el.innerHTML = html; el.setAttribute('dir', ownDir(el)); backLang();
      const orig = h('span', { class: 'kr-tr-orig' }); orig.append(...Array.from(el.childNodes)); el.append(orig);
      el.append(out(''));
      el.classList.add('kr-translated', 'kr-bilingual'); el.classList.remove('kr-tr-titled');
      return;
    }
    el.replaceChildren(styledNodes(translated)); linkUp(el, html); el.classList.remove('kr-bilingual', 'kr-tr-titled');
    el.classList.add('kr-translated', 'kr-tr-out');
    el.dir = dir; el.lang = target;
  }
  /** The way translations are shown changed: every translated paragraph shown the new way. */
  function reapply() { for (const { el } of host.blocks()) { const tr = translations.get(el); if (tr !== undefined && originals.has(el)) apply(el, tr); } }
  function restore(el: HTMLElement) {
    const o = originals.get(el);
    if (o === undefined) return;
    const d = ownDir(el); const lg = langs.get(el); el.innerHTML = o; el.classList.remove('kr-translated', 'kr-furigana', 'kr-bilingual', 'kr-tr-out', 'kr-tr-titled'); el.setAttribute('dir', d); if (lg) el.setAttribute('lang', lg); else el.removeAttribute('lang'); originals.delete(el); translations.delete(el); dirs.delete(el); langs.delete(el);
  }
  function restoreAll() { for (const { el } of host.blocks()) restore(el); }

  /** The context for a batch: the book, the chapter, and the two paragraphs before its first one. */
  function contextFor(el: HTMLElement, bookId: string, all: HTMLElement[]): TrContext {
    const i = all.indexOf(el); const before: string[] = [];
    for (let k = i - 1; k >= 0 && before.length < 2; k--) { const x = (originals.has(all[k]) ? sourceOf(all[k]) : plainOf(all[k])).replace(/<[^>]+>/g, ''); if (x.length > 1) before.unshift(x); }
    const ch = host.chapters()[host.currentChapter()];
    return { book: host.bookTitle?.(bookId), chapter: ch?.label, before };
  }
  const parallel = () => Math.max(1, Math.min(6, Math.round(getSettings().aiParallel ?? 2)));
  /** Batches of about 2,500 characters (twelve paragraphs at most) — for Gemini and Claude, which take long
   *  inputs well and whose free tiers count requests, 6,000 and thirty: fewer requests for a chapter. */
  function batchesOf<T extends { text: string }>(items: T[]): T[][] {
    const big = ['gemini', 'anthropic', 'openrouter'].includes(getSettings().aiProvider); const maxC = big ? 6000 : 2500, maxN = big ? 30 : 12;
    const out: T[][] = []; let cur: T[] = []; let size = 0;
    for (const it of items) { if (cur.length && (size + it.text.length > maxC || cur.length >= maxN)) { out.push(cur); cur = []; size = 0; } cur.push(it); size += it.text.length; }
    if (cur.length) out.push(cur); return out;
  }

  /** The names found in some text put in the book's glossary (or the folder chosen for it), none doubled; how many. */
  async function namesFrom(texts: string[], bookId: string, folder?: string): Promise<number> {
    // (The language asked for is the one the names are kept under, whatever is chosen while the model answers.)
    const target = getSettings().aiTarget;
    const known = termsFor(bookId, target).map((x) => x.from);
    const found = await suggestTerms(texts, known, target);
    if (found.refused) console.warn('[kurokawa] names not in the target script left out:', found.refused);
    for (const f of found) { const k = kindOf(f.kind); byKind.set(k, (byKind.get(k) ?? 0) + 1); }
    // (Nothing enters the glossary unasked: with «Add names on their own» off, they wait in «Names found».)
    if (!getSettings().aiAutoGlossary) { const { addWaiting } = await import('./namespanel'); addWaiting(bookId, found); return found.length; }
    const place = folder ? { folder } : namesTarget(bookId, host.bookTitle?.(bookId) ?? '');
    return addTerms(found.map((f) => ({ from: f.from, to: f.to, ...place, kind: kindOf(f.kind), auto: true, lang: target })));
  }
  // (What the whole book's reading found, by file — «Characters: 12 · Places: 4».)
  const byKind = new Map<string, number>();
  /** The chapters already read for names, for the language translated into now (a chapter read for its Arabic
   *  names is read again for its Japanese ones). The marks kept before languages were (one list for the book) count
   *  for the language the book's names were found in then. */
  const scanKey = (bookId: string) => `glossScan:${bookId}:${(getSettings().aiTarget || '').split('-')[0]}`;
  async function scannedFor(bookId: string): Promise<number[]> {
    const tl = (getSettings().aiTarget || '').split('-')[0];
    const now = (await db.getMeta<number[]>(scanKey(bookId))) ?? [];
    const old = (await db.getMeta<number[]>(`glossScan:${bookId}`)) ?? []; if (!old.length) return now;
    const linked = linkedFolders(bookId); const mine = glossTerms().filter((x) => x.auto && (x.book === bookId || (!!x.folder && linked.includes(x.folder))));
    const was = mine.length ? mine.some((x) => termLang(x) === tl) : legacyLang() === tl;
    return was ? [...new Set([...old, ...now])] : now;
  }
  /** The whole book read for its names (Find names in the whole book): the chapters a few at a time — about
   *  20,000 characters to a request —, as a job that goes on in the background, its progress in the
   *  notification; the chapters already read for names skipped. */
  async function scanWholeBook(folder?: string): Promise<void> {
    if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; }
    const chapters = host.chapters(); const bookId = chapters[0]?.bookId; if (!bookId) return;
    const k = scanKey(bookId); const done = new Set(await scannedFor(bookId));
    const groups: { idx: number[]; texts: string[] }[] = []; let cur = { idx: [] as number[], texts: [] as string[] }; let size = 0;
    chapters.forEach((ch, i) => { if (done.has(i)) return; const tx = ch.blocks.map((el) => (originals.has(el) ? sourceOf(el) : plainOf(el)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1); const n = tx.reduce((a, x) => a + x.length, 0); if (!n) return; if (cur.idx.length && size + n > 20000) { groups.push(cur); cur = { idx: [], texts: [] }; size = 0; } cur.idx.push(i); cur.texts.push(...tx); size += n; });
    if (cur.idx.length) groups.push(cur);
    if (!groups.length) { toast(t('glossScanDone', { n: localDigits(0) })); return; }
    const title = host.bookTitle?.(bookId) ?? ''; let stop = false; let added = 0; byKind.clear();
    const { runJob } = await import('../jobs');
    void runJob(t('glossScanJob', { book: title }), async (rep) => {
      for (let g = 0; g < groups.length && !stop; g++) {
        rep((g / groups.length) * 100, t('glossScanProgress', { n: localDigits(g), total: localDigits(groups.length), found: localDigits(added) }));
        try { added += await namesFrom(groups[g].texts.join('\n').slice(0, 24000).split('\n'), bookId, folder); await db.updateMeta<number[]>(k, (cur) => [...(cur ?? []), ...groups[g].idx]); }
        catch (e) { if ((e as Error).name === 'QuotaError') throw e; console.warn('[kurokawa] scan', e); }
      }
      return stop ? null : { blob: new Blob([]), name: title };
    }, () => false, { quiet: true, cancel: () => { stop = true; }, doneText: () => t('glossScanDone', { n: localDigits(added) }) + perFile() }).catch((e) => toast(String((e as Error).message ?? e), 'error', 6000));
  }
  const perFile = (): string => (byKind.size ? ' — ' + kindOrder([...byKind.keys()].map(kindOf)).map((k) => `${kindLabels?.(k) ?? k}: ${localDigits(byKind.get(k) ?? 0)}`).join(' · ') : '');
  let kindLabels: ((k: string) => string) | null = null; void import('./glossarysheet').then((m) => { kindLabels = m.kindLabel; });
  /** The names of a chapter put in its book's glossary before it is translated (when chosen): the model lists the
   *  characters, places and terms it holds, those not there yet are added — once for each chapter. */
  async function autoGlossary(bookId: string, chapterIdx: number, blocks: HTMLElement[], quiet: boolean): Promise<void> {
    if (!getSettings().aiAutoGlossary || furi() || !aiReady()) return;
    const k = scanKey(bookId); const done = await scannedFor(bookId); if (done.includes(chapterIdx)) return;
    const texts = blocks.map((el) => (originals.has(el) ? sourceOf(el) : plainOf(el)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1); if (!texts.length) return;
    try {
      const had = bookTerms(bookId).length > 0;
      const n = await namesFrom(texts, bookId);
      if (n && !quiet) toast(t(had ? 'gatherNew' : 'glossAutoAdded', { n: localDigits(n) }));
      await db.updateMeta<number[]>(k, (cur) => [...(cur ?? []), chapterIdx]);
    } catch (e) { console.warn('[kurokawa] auto glossary', e); }
  }
  /* ---------- gather the names first (the question, the gathering, what it found) ---------- */
  const textsOf = (blocks: HTMLElement[]) => blocks.map((el) => (originals.has(el) ? sourceOf(el) : plainOf(el)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1);
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
  /** Whether any paragraph of these chapters still has no translation kept (else there is nothing to translate, so nothing to ask). */
  async function hasWork(idxs: number[]): Promise<boolean> {
    const chs = host.chapters();
    for (const i of idxs) { const ch = chs[i]; if (!ch) continue; const c = await cache(ch.bookId); for (const el of ch.blocks) { if (!eligible(el)) continue; const text = sourceOf(el); if (!(c[translationKey(text, ch.bookId)] ?? c[legacyTranslationKey(text)])) return true; } }
    return false;
  }
  interface Gathered { ok: boolean; added: number; ids: string[]; hadTerms: boolean }
  /** The chapters' names found by the model and put in the book's glossary — only those it does not hold yet (by the one key
   *  of a name), the former volume's glossary included —; each chapter read is marked as scanned. */
  async function gatherFor(bookId: string, idxs: number[], sig: { stop: boolean }, report?: (i: number, n: number) => void): Promise<Gathered> {
    const hadTerms = bookTerms(bookId).length > 0; const before = new Set(glossTerms().map((x) => x.id));
    const target = getSettings().aiTarget; const k = scanKey(bookId); const done = new Set(await scannedFor(bookId)); const chs = host.chapters();
    const groups: { idx: number[]; texts: string[] }[] = []; let cur = { idx: [] as number[], texts: [] as string[] }; let size = 0;
    for (const i of idxs) {
      if (done.has(i) || !chs[i]) continue; const tx = textsOf(chs[i].blocks); const n = tx.reduce((a, x) => a + x.length, 0); if (!n) continue;
      if (cur.idx.length && size + n > 20000) { groups.push(cur); cur = { idx: [], texts: [] }; size = 0; } cur.idx.push(i); cur.texts.push(...tx); size += n;
    }
    if (cur.idx.length) groups.push(cur);
    let ok = true;
    for (let g = 0; g < groups.length && !sig.stop; g++) {
      report?.(g + 1, groups.length);
      try {
        const found = await suggestTerms(groups[g].texts.join('\n').slice(0, 24000).split('\n'), termsFor(bookId, target).map((x) => x.from), target);
        const fresh = newNames(found, bookId, target);
        if (fresh.length) { const place = namesTarget(bookId, host.bookTitle?.(bookId) ?? ''); addTerms(fresh.map((f) => ({ from: f.from, to: f.to, ...place, kind: kindOf(f.kind), auto: true, lang: target }))); }
        await db.updateMeta<number[]>(k, (c) => [...(c ?? []), ...groups[g].idx]);
      } catch (e) { console.warn('[kurokawa] gather names', e); ok = false; break; }
    }
    const ids = glossTerms().filter((x) => !before.has(x.id)).map((x) => x.id);
    return { ok: ok && !sig.stop, added: ids.length, ids, hadTerms };
  }
  /** What the gathering found, said once: «New terms added. Count: n» with a «Show» that opens the Glossary tab on the first of them
   *  (the first time a book gets terms: the older line); nothing new: said so — except where it ran quietly. */
  function reportGather(bookId: string, r: Gathered, quiet = false): void {
    if (!r.ok) return;
    if (r.added) { toast(t(r.hadTerms ? 'gatherNew' : 'glossAutoAdded', { n: localDigits(r.added) }), 'info', { ms: 8000, action: { label: t('gatherShow'), run: () => aiSheet({ tab: 'glossary', book: { id: bookId, title: host.bookTitle?.(bookId) ?? '' }, focusTerm: r.ids[0] }) } }); return; }
    if (!quiet) toast(t(r.hadTerms ? 'gatherNoNew' : 'trSuggestNone'));
  }
  const formerTitle = async (bookId: string): Promise<string | undefined> => {
    const v = volChoice(bookId); if (!v || v.choice === 'empty' || !v.from) return undefined;
    try { const { listBooks } = await import('../library'); return (await listBooks()).find((b) => b.id === v.from)?.title; } catch { return undefined; }
  };
  /** Before a translation of these chapters: the names gathered first, as the book's choice (else the setting) says — asked in a sheet,
   *  gathered by itself, or not at all. 'go': the translation goes on; 'gathered': it goes on and what was found was said; 'cancel':
   *  nothing starts. Never asks for a part already searched, a chapter asked about in this session, or while a translation runs. */
  async function beforeTranslate(from: number, to: number, whole: boolean): Promise<'go' | 'gathered' | 'cancel'> {
    const chs = host.chapters(); const bookId = chs[from]?.bookId ?? firstBook(); if (!bookId) return 'go';
    // (Nothing to gather with, or the translation's own path says what is missing: the no-key notice, the offline wait.)
    if (furi() || !aiReady() || navigator.onLine === false || getSettings().aiAutoGlossary || running || gathering) return 'go';
    const mode = await gatherModeOf(bookId); if (mode === 'never') return 'go';
    const idxs = whole ? range(0, chs.length - 1) : range(from, to); const scanned = new Set(await scannedFor(bookId));
    if (idxs.every((i) => scanned.has(i)) || !(await hasWork(idxs))) return 'go';
    const keys = [...idxs.map((i) => askedKey(bookId, i)), ...(whole ? [askedKey(bookId, '*')] : [])];
    let result: Gathered | null = null;
    if (mode === 'always' || sessionChoice(bookId) === 'gather') {
      result = await silentGather(bookId, idxs, false); return result?.ok ? 'gathered' : 'go';
    }
    if (whole ? wasAsked(askedKey(bookId, '*')) : idxs.every((i) => wasAsked(askedKey(bookId, i)))) return 'go';
    const ans = await askGather({
      scope: whole ? 'book' : 'chapter', chapters: idxs.length > 1 && !whole ? 'many' : 'one', both: !whole, volume: await formerTitle(bookId), local: getSettings().aiProvider === 'local',
      work: async (sc, rep, sg) => { gatherSig = sg; const r = await gatherFor(bookId, sc === 'book' ? range(0, chs.length - 1) : idxs, sg, rep); result = r; return r.ok; },
    });
    if (ans.answer === 'cancel') return 'cancel';
    for (const k of keys) markAsked(k);   // (asked once the question is answered — closed unanswered, it may be asked again)
    if (ans.answer === 'never') { await setBookGather(bookId, 'never'); setSessionChoice(bookId, 'skip'); return 'go'; }
    if (ans.answer === 'skip') { setSessionChoice(bookId, 'skip'); return 'go'; }
    setSessionChoice(bookId, 'gather'); const r = result as Gathered | null; if (r) reportGather(bookId, r); return r ? 'gathered' : 'go';
  }
  /** Gathering without a question: on the bar («Gathering the names…», its button stops it); what is found said when it is done. */
  async function silentGather(bookId: string, idxs: number[], quiet: boolean): Promise<Gathered | null> {
    if (gathering) return null; gathering = true; gatherSig = { stop: false }; paint();
    try {
      const r = await gatherFor(bookId, idxs, gatherSig, (i, n) => { gatherNote = n > 1 ? ` ${localDigits(i)}/${localDigits(n)}` : ''; paint(); });
      if (r.ok) reportGather(bookId, r, quiet); else if (!gatherSig.stop) toast(t('gatherFailed'), 'error', 5000);
      return r;
    } finally { gathering = false; gatherNote = ''; paint(); }
  }
  let gatherNote = '';
  /** A chapter moved on to while the translation is on: its names gathered first when the book is set to gather by itself (or its
   *  reader said «Gather» in this session) — never a question —, then the chapter translated. */
  async function advance(): Promise<void> {
    const cur = host.currentChapter(); const bookId = host.chapters()[cur]?.bookId;
    if (bookId && on && !gathering && !furi() && aiReady() && navigator.onLine !== false && !getSettings().aiAutoGlossary) {
      const mode = await gatherModeOf(bookId);
      if (mode === 'always' || (mode === 'ask' && sessionChoice(bookId) === 'gather')) {
        if (!(await scannedFor(bookId)).includes(cur) && await hasWork([cur])) await silentGather(bookId, [cur], true);
      }
    }
    if (on) void run();
  }
  /** Translate the shown chapter: cached paragraphs appear at once, the rest in view order. */
  async function run(force = false) {
    const gen = ++generation;
    { const cur = host.currentChapter(); const ch = host.chapters()[cur]; if (ch && getSettings().aiAutoGlossary && on && aiReady() && navigator.onLine !== false) { running = true; paint(); await autoGlossary(ch.bookId, cur, ch.blocks, false); running = false; if (gen !== generation) return; } }
    const list = host.blocks().filter((b) => eligible(b.el));
    // visible first, then by distance from the viewport
    const sr = host.scroll.getBoundingClientRect();
    const dist = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.bottom < sr.top ? sr.top - r.bottom + 100000 : r.top > sr.bottom ? r.top - sr.bottom : 0; };
    list.sort((a, b) => dist(a.el) - dist(b.el));
    pending = list.length; done = 0; paint();
    const todo: { el: HTMLElement; bookId: string; text: string; key: string }[] = [];
    for (const b of list) {
      const text = sourceOf(b.el);
      const key = translationKey(text, b.bookId);
      const c = await cache(b.bookId);
      const had = c[key] ?? c[legacyTranslationKey(text)];
      if (!force && had) { apply(b.el, had); done++; continue; }
      if (force) restore(b.el);
      todo.push({ el: b.el, bookId: b.bookId, text, key });
    }
    paint();
    if (!todo.length) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { paint(); return; }   // (offline: what is kept is shown, the rest waits)
    // (No translator set up — say a book translated before, its key since removed —: what is kept is shown; asked
    // for a key only when nothing at all was kept for this chapter.)
    if (!aiReady()) { if (!done) { toast(t('aiNeedsKey'), 'error', 4000); settingsSheet(); } return; }
    running = true; paint();
    // Batches in view order (the nearest first); within one, the paragraphs in reading order, so the context
    // given with it — the lines before its first — is the right one.
    const order = host.blocks().map((b) => b.el);
    const batches = batchesOf(todo).map((b) => b.sort((x, y) => order.indexOf(x.el) - order.indexOf(y.el)));
    let failed = 0;
    const worker = async () => {
      while (batches.length && gen === generation && on) {
        // (Paragraphs a background job translates now are left to it: shown when it keeps them.)
        const batch = batches.shift()!.filter((x) => !inFlight.has(x.key)); if (!batch.length) continue;
        for (const x of batch) inFlight.add(x.key);
        try {
          let out: string[];
          try { out = await translateBatch(batch.map((x) => x.text), batch[0]?.bookId, contextFor(batch[0].el, batch[0].bookId, order)); } finally { for (const x of batch) inFlight.delete(x.key); }
          if (gen !== generation || !on) return;
          for (let i = 0; i < batch.length; i++) {
            const tr = out[i]?.trim(); if (!tr) continue;
            await remember(batch[i].bookId, batch[i].key, batch[i].text, tr);
            apply(batch[i].el, tr); done++;
          }
        } catch (err) { failed++; console.warn('[kurokawa] translate failed', err); if (failed === 1) toast(String((err as Error).message ?? err), 'error', 6000); if (failed > 3 || (err as Error).name === 'QuotaError') { batches.length = 0; break; } }
        paint();
      }
    };
    await Promise.all(Array.from({ length: parallel() }, () => worker()));
    running = false; paint();
    if (gen === generation && on && !failed) void prefetchNext();
  }
  /** The next chapter translated while this one is read (quietly; nothing shown until it is opened). */
  let prefetched = '';
  async function prefetchNext() {
    if (getSettings().aiPrefetch === false || aheadBusy || [...aheadJobs.values()].some((j) => host.chapters().some((c) => c.bookId === j.bookId))) return;
    const cur = host.currentChapter(); const next = host.chapters()[cur + 1]; if (!next) return;
    const mark = `${next.bookId}:${cur + 1}`; if (prefetched === mark) return; prefetched = mark;
    await translateAhead(cur + 1, cur + 1, null, null, () => undefined, true);
  }

  /* ---------- translate ahead: N chapters, a range, or the whole book ---------- */
  let aheadGen = 0; let aheadBusy = false;
  async function translateAhead(from: number, to: number, status: HTMLElement | null, bar: HTMLElement | null, onDone: () => void, quiet = false, force = false) {
    const chapters = host.chapters().slice(from, to + 1); const bookKey = chapters[0]?.bookId ?? '';
    // (Each job its own: this chapter, a range and the whole book can go on side by side, each with its own progress
    // and its own Stop — the same range twice is refused.)
    const jobKey = `${bookKey}:${from}-${to}`;
    if (!quiet && aheadJobs.has(jobKey)) { toast(t('trJobAlready'), 'info', 4000); onDone(); return; }
    const gen = aheadGen; let stopped = false; const alive = () => (quiet ? gen === aheadGen : !stopped);
    if (!quiet) aheadBusy = true;
    const items: { bookId: string; text: string; key: string; el: HTMLElement; chapter: string; all: HTMLElement[] }[] = [];
    const seen = new Set<string>();
    for (const ch of chapters) for (const el of ch.blocks) {
      if (!eligible(el)) continue;
      const text = sourceOf(el);
      const key = translationKey(text, ch.bookId);
      if (seen.has(key)) continue; seen.add(key);
      const c = await cache(ch.bookId);
      if (force || !(c[key] ?? c[legacyTranslationKey(text)])) items.push({ bookId: ch.bookId, text, key, el, chapter: ch.label, all: ch.blocks });
    }
    const total = items.length; let finished = 0, failed = 0;
    // (A range or the whole book goes on as a job: in the background, out of the reader too, its progress in a
    // notification — the book read meanwhile. Stopped from the jobs list or the sheet.)
    const job: { report?: (pct: number, text?: string) => void; finish?: (how: 'ok' | 'cancel' | 'fail') => void } = {};
    const one = from === to; const allBook = from === 0 && to >= host.chapters().length - 1;
    const label = one ? (chapters[0]?.label || t('trThisChapter')) : allBook ? t('wholeBook') : `${localDigits(from + 1)}–${localDigits(to + 1)}`;
    const stopIt = () => { stopped = true; aheadJobs.delete(jobKey); aheadBusy = aheadJobs.size > 0; job.finish?.('cancel'); };
    const entry = { cancel: stopIt, done: 0, total, bookId: bookKey, label, from, to };
    if (!quiet && total) aheadJobs.set(jobKey, entry);
    if (!quiet && total) {
      const book = host.bookTitle?.(chapters[0]?.bookId ?? '') ?? t('aiTranslate'); const title = one ? `${label} · ${book}` : allBook ? book : `${book} · ${label}`;
      const ended = new Promise<'ok' | 'cancel' | 'fail'>((res) => { job.finish = res; });
      void import('../jobs').then(({ runJob }) => runJob(t('trJobTitle', { book: title }), async (rep) => { job.report = rep; rep(0, t('trJobProgress', { n: localDigits(0), total: localDigits(total) })); const how = await ended; if (how === 'fail') throw new Error(t('trJobFailed')); return how === 'ok' ? { blob: new Blob([]), name: title } : null; }, () => false,
        { quiet: true, cancel: () => stopIt(), doneText: () => t('trJobDone', { book: title, n: localDigits(finished) }) })).catch(() => undefined);
    }
    const paintAhead = () => { entry.done = finished; job.report?.(total ? (finished / total) * 100 : 100, t('trJobProgress', { n: localDigits(finished), total: localDigits(total) })); if (status) status.textContent = t('translatingAhead', { n: finished, total }); if (bar) bar.style.width = total ? `${Math.round((finished / total) * 100)}%` : '100%'; };
    paintAhead();
    if (!total) { if (status) status.textContent = t('alreadyTranslated'); if (!quiet) aheadBusy = false; onDone(); return; }
    const batches = batchesOf(items);
    const worker = async () => {
      while (batches.length && alive()) {
        let batch = batches.shift()!;
        try {
          if (getSettings().aiAutoGlossary) { for (const x of batch) { const ci = from + chapters.findIndex((c) => c.blocks === x.all); if (ci >= from) await autoGlossary(x.bookId, ci, x.all, true); } for (const x of batch) x.key = translationKey(x.text, x.bookId); if (!alive()) return; }
          // (What another job translates now, or kept since this one was planned, is left out and counted done.)
          if (!force) { const c = await cache(batch[0].bookId); const left = batch.filter((x) => !inFlight.has(x.key) && !c[x.key]); finished += batch.length - left.length; batch = left; if (!batch.length) { paintAhead(); continue; } }
          for (const x of batch) inFlight.add(x.key);
          const first = batch[0]; const i = first.all.indexOf(first.el); const before = first.all.slice(Math.max(0, i - 2), i).map((e) => (originals.has(e) ? sourceOf(e) : plainOf(e)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1);
          let out: string[];
          try { out = await translateBatch(batch.map((x) => x.text), first.bookId, { book: host.bookTitle?.(first.bookId), chapter: first.chapter, before }); }
          finally { for (const x of batch) inFlight.delete(x.key); }
          if (!alive()) return;
          for (let i = 0; i < batch.length; i++) { const tr = out[i]?.trim(); if (!tr) continue; await remember(batch[i].bookId, batch[i].key, batch[i].text, tr); }
          finished += batch.length;
        } catch (err) { failed++; console.warn('[kurokawa] translate-ahead failed', err); if (failed === 1 && !quiet) toast(String((err as Error).message ?? err), 'error', 6000); if (failed > 3 || (err as Error).name === 'QuotaError') { batches.length = 0; } }
        paintAhead();
      }
    };
    await Promise.all(Array.from({ length: quiet ? 1 : Math.max(parallel(), 2) }, () => worker()));
    if (!quiet) { if (aheadJobs.get(jobKey) === entry) aheadJobs.delete(jobKey); aheadBusy = aheadJobs.size > 0; }
    job.finish?.(!alive() ? 'cancel' : finished > 0 ? 'ok' : failed ? 'fail' : 'ok');
    if (!alive()) return;
    if (quiet) return;
    if (status) status.textContent = failed ? t('translateAheadPartial', { n: finished, total }) : t('translateAheadDone', { n: finished });
    onDone();
    if (!quiet && from === 0 && to >= host.chapters().length - 1) void db.setMeta(`trWhole:${bookKey}`, true);
    if (on && !disposed) void run();   // the shown chapter picks up what is now cached
  }

  /** The translate-ahead controls (used in their own sheet and inside the AI settings sheet). */
  function aheadControls(): HTMLElement {
    const chapters = host.chapters();
    const cur = host.currentChapter(); const bookId = chapters[0]?.bookId ?? '';
    const num = (v: number, min: number, max: number) => h('input', { type: 'number', min: String(min), max: String(max), value: String(v), dir: 'ltr', style: { width: '5.5em' } }) as HTMLInputElement;
    const count = num(Math.min(5, chapters.length - cur), 1, chapters.length - cur);
    const fromI = num(cur + 1, 1, chapters.length), toI = num(Math.min(chapters.length, cur + 5), 1, chapters.length);
    const row = (...kids: (HTMLElement | string)[]) => h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, ...kids);
    const status = h('p', { class: 'src' }, t('translateAheadBody', { n: chapters.length }));
    // (The jobs of this book going on — this chapter, a range, the whole book, each in the background, from this
    // reader or one closed since —: each its own line, its own progress and its own Stop.)
    const jobsBox = h('div', { class: 'tr-jobs' });
    const drawJobs = () => {
      const mine = [...aheadJobs.values()].filter((j) => j.bookId === bookId);
      jobsBox.replaceChildren(...mine.map((j) => h('div', { class: 'tr-job' },
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, h('span', { class: 'grow', dir: 'auto' }, `${j.label} — ${t('translatingAhead', { n: j.done, total: j.total })}`),
          h('button', { class: 'btn small', type: 'button', onclick: () => { j.cancel(); drawJobs(); } }, icon('close'), t('cancel'))),
        h('div', { class: 'progress-bar' }, h('span', { style: { width: `${Math.round((j.done / Math.max(1, j.total)) * 100)}%` } })))));
    };
    let shownOnce = false; const loop = () => { if (jobsBox.isConnected) shownOnce = true; else if (shownOnce) return; drawJobs(); setTimeout(loop, 700); }; loop();
    const start = (from: number, to: number) => {
      if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; }
      const f = Math.max(0, from), l = Math.min(chapters.length - 1, to);
      // (The names first, when the book asks for it — «Gather, then translate» —; closed without an answer, nothing starts.)
      void (async () => {
        const r = await beforeTranslate(f, l, f === 0 && l >= chapters.length - 1); if (r === 'cancel' || disposed) return;
        void translateAhead(f, l, status, null, () => drawJobs());
        setTimeout(drawJobs, 150); if (r === 'go') toast(t('trInBackground'), 'info', 3000);
      })();
    };
    const btn = (label: string, fn: () => void) => h('button', { class: 'btn small tonal', type: 'button', onclick: fn }, label);
    return h('div', { class: 'tr-ahead' },
      h('h4', { class: 'upd-title', style: { marginTop: '14px' } }, t('translateAhead')),
      status, jobsBox,
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('trThisChapter')), row(btn(t('trThisChapterGo'), () => start(cur, cur)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('nextChapters')), row(count, btn(t('translateSelected'), () => start(cur, cur + Number(count.value || 1) - 1)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('chapterRange')), row(fromI, '→', toI, btn(t('translateSelected'), () => start(Number(fromI.value) - 1, Number(toI.value) - 1)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('wholeBook')), row(btn(t('translateWholeBook'), () => start(0, chapters.length - 1)))),
    );
  }

  /** The translator's own options: how translations are shown, and what goes with each request. */
  function optionControls(): HTMLElement {
    const s = getSettings();
    const sw = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => { const cb = h('input', { type: 'checkbox', checked: on, onchange: () => set(cb.checked) }) as HTMLInputElement; return h('label', { class: 'row tr-opt' }, h('span', { class: 'label' }, label, hint ? h('small', { class: 'hint' }, hint) : null), h('span', { class: 'switch' }, cb, h('i'))); };
    const par = h('input', { type: 'number', min: '1', max: '6', value: String(s.aiParallel ?? 2), dir: 'ltr', style: { width: '5em' }, onchange: () => updateSettings({ aiParallel: Math.max(1, Math.min(6, Number(par.value) || 2)) }) }) as HTMLInputElement;
    return h('div', { class: 'tr-options' },
      h('h4', { class: 'upd-title', style: { marginTop: '14px' } }, t('trOptions')),
      sw(t('trBilingual'), s.aiDisplay === 'bilingual', (v) => { updateSettings({ aiDisplay: v ? 'bilingual' : 'replace' }); reapply(); paint(); }, t('trBilingualHint')),
      h('div', { class: 'tr-opt tr-titles' }, h('span', { class: 'label' }, t('trTitles'), h('small', { class: 'hint' }, t('trTitlesHint'))),
        h('div', { class: 'segmented small', role: 'radiogroup' }, ...([['both', t('trTitlesBoth')], ['translation', t('trTitlesTr')], ['original', t('trTitlesOrig')]] as ['both' | 'translation' | 'original', string][]).map(([k, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String((s.aiTitles ?? 'both') === k), onclick: (e: Event) => { updateSettings({ aiTitles: k }); const g = (e.currentTarget as HTMLElement).parentElement!; g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget))); for (const { el } of host.blocks()) if (isTitle(el)) restore(el); if (on) void run(); } }, l)))),
      sw(t('trContext'), s.aiContext !== false, (v) => updateSettings({ aiContext: v }), t('trContextHint')),
      sw(t('trKeepStyle'), s.aiKeepStyle !== false, (v) => updateSettings({ aiKeepStyle: v })),
      sw(t('trSkipSame'), s.aiSkipSame !== false, (v) => updateSettings({ aiSkipSame: v }), t('trSkipSameHint')),
      sw(t('trPrefetch'), s.aiPrefetch !== false, (v) => updateSettings({ aiPrefetch: v }), t('trPrefetchHint')),
      h('div', { class: 'row tr-opt' }, h('span', { class: 'label' }, t('trParallel'), h('small', { class: 'hint' }, t('trParallelHint'))), par),
      h('button', { type: 'button', class: 'btn tonal small', style: { marginTop: '8px' }, onclick: () => aiSheet({ tab: 'names' }) }, icon('define'), t('trSuggestTerms')));
  }
  const langLabel = (c: string) => { try { return new Intl.DisplayNames([getLang()], { type: 'language' }).of(c) ?? langName(c); } catch { return langName(c); } };
  /** The names and terms of the shown chapter, proposed by the model (for «Names found»). */
  async function findNames(): Promise<Awaited<ReturnType<typeof suggestTerms>>> {
    if (!aiReady()) throw new Error(t('aiNeedsKey'));
    const ch = host.chapters()[host.currentChapter()]; if (!ch) return Object.assign([], { refused: 0 });
    const texts = ch.blocks.map((el) => (originals.has(el) ? sourceOf(el) : plainOf(el)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1);
    const target = getSettings().aiTarget;
    return suggestTerms(texts, termsFor(ch.bookId, target).map((x) => x.from), target);
  }
  /** The kept translation of a paragraph, shown or not. */
  /** Saved with the book: it opens translated every time — from the translations kept on this device, offline
   *  too — until the translation is turned off; the bar's state (shown or folded away) kept with it. */
  const keepKey = (id: string) => `trKeep:${id}`;
  const firstBook = () => host.chapters()[0]?.bookId ?? host.blocks()[0]?.bookId ?? '';
  async function setKept(v: boolean) { const id = firstBook(); if (!id) return; if (v) await db.setMeta(keepKey(id), { hidden: !!pill?.hidden, on }); else await db.setMeta(keepKey(id), null); }
  /** The pill's Save: the translation kept with the book (and the device asked to keep the app's storage, so the
   *  system does not clear it), or no longer. */
  async function toggleSaved() {
    const v = !(await isKept()); await setKept(v); if (v && !on) setOn(true);
    if (v) void navigator.storage?.persist?.().catch(() => undefined);
    markSaved(v); toast(v ? t('trKept') : t('trNotKept'));
  }
  function markSaved(v: boolean) { const b = pill?.querySelector('.tr-save'); if (b) { b.setAttribute('aria-pressed', String(v)); b.classList.toggle('on', v); } }
  async function isKept(): Promise<boolean> { const id = firstBook(); return !!id && !!(await db.getMeta(keepKey(id))); }
  function aheadSheet() {
    const sh = openSheet(t('translateAhead'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    const c = aheadControls(); c.querySelector('h4')?.remove();
    sh.body.append(c);
  }


  // (Lent to the AI sheet: this book, its names found, its whole reading, its saved translations.)
  setAiHooks({
    get bookId() { return firstBook(); }, title: () => host.bookTitle?.(firstBook()) ?? '',
    findNames, scan: (folder) => void scanWholeBook(folder),
    cacheCount: async () => { let n = 0; for (const id of new Set([firstBook(), ...host.blocks().map((b) => b.bookId)].filter(Boolean))) n += Object.keys({ ...((await db.getMeta<Record<string, string>>(`tr:${id}`)) ?? {}), ...(caches.get(id) ?? {}) }).length; return n; },
    clearCache: () => clearCache(), isKept, setKept: (v) => { void setKept(v); markSaved(v); if (v) void navigator.storage?.persist?.().catch(() => undefined); if (v && !on) setOn(true); toast(v ? t('trKept') : t('trNotKept')); },
    options: () => h('div', null, optionControls(), aheadControls()), added: () => { if (on) void run(); },
    // (The export's «Translate them first»: the whole book, through the same question about the names as any start by hand.)
    translateWhole: () => {
      if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; }
      const last = host.chapters().length - 1; if (last < 0) return;
      void (async () => { const r = await beforeTranslate(0, last, true); if (r === 'cancel' || disposed) return; void translateAhead(0, last, null, null, () => undefined); if (r === 'go') toast(t('trInBackground'), 'info', 3000); })();
    },
  } as AiHooks);
  /** A former volume's glossary, once, when the translation is first turned on for a book with none: taken by itself
   *  (the same series, «Automatically»: a notice with Undo), or offered in the Glossary tab. */
  async function formerVolume(allowAsk = true): Promise<boolean> {
    const id = firstBook(); if (!id || hasGlossary(id) || volChoice(id)) return false;
    const k = 'kr.glossaryVolSeen'; let seen: string[] = []; try { seen = JSON.parse(localStorage.getItem(k) ?? '[]') as string[]; } catch { /* none */ }
    if (seen.includes(id)) return false;
    const { listBooks } = await import('../library'); const all = (await listBooks()).filter((b) => b.format !== 'series').map((b) => ({ id: b.id, title: b.title, ...(b.titles?.length ? { others: b.titles.filter((x) => x !== b.title) } : {}), ...(b.series?.name ? { series: { name: b.series.name, index: b.series.index } } : {}) }));
    const me = all.find((b) => b.id === id); if (!me || disposed) return false;
    const d = volDecision(me, all, getSettings().aiVolGlossary ?? 'auto');
    // (Starting by itself never opens a sheet: a glossary to choose among is offered the first time the reader turns the translation on.)
    if (d.kind === 'ask' && !allowAsk) return false;
    try { localStorage.setItem(k, JSON.stringify([...seen, id].slice(-500))); } catch { /* full */ }
    if (d.kind === 'auto') { const und = shareGlossary(id, d.cand, true); const { offerUndo } = await import('./undo'); offerUndo(t('glossVolUsing', { title: `\u2068${d.cand.title}\u2069` }), () => und(), () => { shareGlossary(id, d.cand, true); }); if (on) void run(); return false; }
    if (d.kind === 'ask') { aiSheet({ tab: 'glossary' }); return true; }
    return false;
  }

  /* ---------- pill ---------- */
  let status: HTMLElement, toggleBtn: HTMLButtonElement;
  // (Waiting for the provider's per-minute limit: said on the bar, not as an error — it goes on by itself.)
  let waitSec = 0; const offWait = onAiWait((sec) => { waitSec = sec; paint(); });
  function paint() {
    if (!pill) return;
    if (gathering) { status.textContent = t('gatherWorking') + gatherNote; toggleBtn.setAttribute('aria-pressed', 'true'); toggleBtn.classList.add('on'); return; }
    if (waitSec > 0 && on) { status.textContent = t('trWaitingLimit', { s: localDigits(waitSec) }); return; }
    mini?.classList.toggle('on', on);
    toggleBtn.setAttribute('aria-pressed', String(on));
    toggleBtn.classList.toggle('on', on);
    pill.querySelector('.tr-mode')?.classList.toggle('on', getSettings().aiDisplay === 'bilingual');
    status.textContent = !on ? t('translatorOff') : running ? t('translating') + ` ${localDigits(done)}/${localDigits(pending)}` : pending ? t('translatedCount', { n: done, total: pending }) : t('translatorOn');
  }
  function setOn(v: boolean) {
    if (v && !on) void formerVolume(!autoStarted);
    on = v; void isKept().then((k) => { if (k) void setKept(true); });   // (saved with the book: on or off is kept as it was left)
    if (on) void run(); else { generation++; running = false; restoreAll(); if (autoStarted) { autoStarted = false; stopAuto(firstBook()); } }
    paint();
  }
  /** The translation turned on by the reader (the bar's button, the Translation tab's «Done»): a former volume's glossary looked at first, then — asked or
   *  by itself, as the book is set — the names gathered; cancelled in the question, nothing starts. */
  async function startUser(): Promise<void> {
    const offered = await formerVolume(true); if (disposed || on) return;
    if (!offered) { const cur = host.currentChapter(); if ((await beforeTranslate(cur, cur, false)) === 'cancel' || disposed || on) return; }
    setOn(true);
  }
  /** The bar's button: on (asking first), off, or — while the names are being gathered — stop. */
  function pressToggle(): void {
    if (gathering) { gatherSig.stop = true; if (autoStarted) { autoStarted = false; stopAuto(firstBook()); } return; }
    if (on) setOn(false); else void startUser();
  }
  // Clearing the saved translations costs time — and, with a paid service, money — to undo by translating again: asked
  // first (how many), then kept until the snackbar's time is over; its Undo brings them back as they were.
  function clearCache() { void (async () => {
    const ids = [...new Set(host.blocks().map((b) => b.bookId))];
    let n = 0; for (const id of ids) n += Object.keys({ ...((await db.getMeta<Record<string, string>>(`tr:${id}`)) ?? {}), ...(caches.get(id) ?? {}) }).length;
    if (!n) { toast(t('done')); return; }
    if (!confirm(t('trCacheClearAsk', { n: localDigits(n) }))) return;
    const kept = new Map(ids.map((id) => [id, { tr: caches.get(id), src: bySource.get(id) }]));
    for (const id of ids) { bySource.set(id, {}); caches.set(id, {}); }
    restoreAll();
    let gone = false;
    const { offerUndo } = await import('./undo');
    offerUndo(t('trCacheCleared', { n: localDigits(n) }), () => { for (const [id, k] of kept) { if (k.tr) caches.set(id, k.tr); else caches.delete(id); if (k.src) bySource.set(id, k.src); else bySource.delete(id); } if (on) void run(); }, undefined, {
      alive: () => !gone, ms: 8000,
      onEnd: (undone) => { if (undone) return; gone = true; void (async () => { for (const id of ids) { await db.setMeta(`trs:${id}`, {}); await db.setMeta(`tr:${id}`, {}); } if (on) void run(); })(); },
    });
  })(); }
  function moreSheet() {
    const sh = openSheet(t('aiTranslate'), t('close')); sh.body.style.fontFamily = 'var(--font-ui)';
    const row = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label));
    // (The glossary, the names found and the saved translations are the AI sheet's tabs.)
    sh.body.append(h('div', { class: 'dest-list' }, row('books', t('translateAhead'), () => aheadSheet()), row('define', t('glossary'), () => aiSheet({ tab: 'glossary' })), row('user', t('aiTabNames'), () => aiSheet({ tab: 'names' })), row('download', t('aiTabSaved'), () => aiSheet({ tab: 'saved' })), row('trash', t('clearTranslationCache'), () => clearCache()), row('settings', t('customize'), () => settingsSheet())));
  }
  // (The bar hidden keeps the translation: it folds into a small button, the bar back at a tap. Turning the
  // translation off is the bar's first button; its X only hides the bar.)
  let mini: HTMLElement | null = null;
  function hidePill() { if (!pill) return; pill.hidden = true; void isKept().then((k) => { if (k) void setKept(true); }); if (!mini) { mini = h('button', { type: 'button', class: 'tr-mini' + (on ? ' on' : ''), title: t('trShowBar'), 'aria-label': t('trShowBar'), onclick: () => showPill() }, icon('translate')); host.root.appendChild(mini); } }
  function showPill() { mini?.remove(); mini = null; if (pill) { pill.hidden = false; paint(); } else buildPill(); void isKept().then((k) => { if (k) void setKept(true); }); }
  /** Translated again: this chapter, some chapters, or the whole book (offered as «again» once it was translated whole). */
  function retrySheet() {
    const sh = openSheet(t('retranslate'), t('close')); sh.body.style.fontFamily = 'var(--font-ui)';
    const chapters = host.chapters(); const cur = host.currentChapter(); const bookId = chapters[cur]?.bookId ?? '';
    const row = (ic: string, label: string, sub: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: fn }, icon(ic), h('span', { class: 'grow' }, h('span', null, label), h('small', { class: 'src', style: { display: 'block', margin: '0' } }, sub)));
    const status = h('p', { class: 'src' }); const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
    const go = (from: number, to: number) => { if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; } track.hidden = false; void translateAhead(Math.max(0, from), Math.min(chapters.length - 1, to), status, bar, () => undefined, false, true); };
    const num = (v: number) => h('input', { type: 'number', min: '1', max: String(chapters.length), value: String(v), dir: 'ltr', style: { width: '5.5em' } }) as HTMLInputElement;
    const fromI = num(cur + 1), toI = num(Math.min(chapters.length, cur + 3));
    const range = h('div', { class: 'row', hidden: true, style: { gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, h('span', null, t('fromChapter')), fromI, h('span', null, t('toChapter')), toI,
      h('button', { type: 'button', class: 'btn small tonal', onclick: () => go(Number(fromI.value) - 1, Number(toI.value) - 1) }, t('retranslate')));
    const whole = row('books', t('trRedoWhole'), t('trRedoWholeHint', { n: localDigits(chapters.length) }), () => { if (confirm(t('trRedoWholeAsk'))) { sh.close(); void translateAhead(0, chapters.length - 1, null, null, () => undefined, false, true); } });
    whole.hidden = true; void db.getMeta<boolean>(`trWhole:${bookId}`).then((w) => { whole.hidden = false; if (!w) { whole.querySelector('.grow > span')!.textContent = t('trWholeBook'); } });
    sh.body.append(h('div', { class: 'dest-list' },
      row('rotate', t('trRedoChapter'), chapters[cur]?.label ?? '', () => { sh.close(); if (!on) setOn(true); else void run(true); }),
      row('toc', t('trRedoChapters'), t('trRedoChaptersHint'), () => { range.hidden = !range.hidden; }),
      whole), range, track, status);
  }
  function buildPill() {
    toggleBtn = h('button', { type: 'button', class: 'tr-toggle', 'aria-label': t('trTurnOnOff'), title: t('trTurnOnOff'), onclick: () => pressToggle() }, icon('translate')) as HTMLButtonElement;
    status = h('span', { class: 'tr-status' });
    pill = h('div', { class: 'tr-pill', role: 'toolbar', 'aria-label': t('aiTranslate') },
      toggleBtn, status,
      h('button', { type: 'button', class: 'tr-mode', title: t('trBilingual'), 'aria-label': t('trBilingual'), onclick: () => { updateSettings({ aiDisplay: getSettings().aiDisplay === 'bilingual' ? 'replace' : 'bilingual' }); reapply(); paint(); toast(getSettings().aiDisplay === 'bilingual' ? t('trShownBoth') : t('trShownReplace')); } }, icon('eye')),
      h('button', { type: 'button', class: 'tr-save', title: t('trKeepBook'), 'aria-label': t('trKeepBook'), 'aria-pressed': 'false', onclick: () => void toggleSaved() }, icon('download')),
      h('button', { type: 'button', title: t('retranslate'), 'aria-label': t('retranslate'), onclick: () => retrySheet() }, icon('rotate')),
      // (The rest in one menu, so the bar fits a phone's width: translating ahead, names for the glossary, clearing.)
      h('button', { type: 'button', title: t('more'), 'aria-label': t('more'), onclick: () => moreSheet() }, icon('more')),
      h('button', { type: 'button', title: t('trHideBar'), 'aria-label': t('trHideBar'), onclick: () => hidePill() }, icon('chevronDown')),
    );
    host.root.appendChild(pill);
    paint(); void isKept().then(markSaved);
  }

  /** A book opened with «Start translating by itself» (the setting, or the book's own «Always»): the chapter shown is translated as if the bar's button
   *  had been pressed — only with a working service and a connection where it needs one, a text in another language than the target,
   *  laid out by the reader, and no «Never» for this book or Stop in this session. The names are gathered first (quietly, never asked)
   *  when that is on and the book is not set to «Don't gather». The same scheduler as ever: later chapters follow as they do after
   *  the bar's button. */
  async function autoStart(id: string): Promise<boolean> {
    const s = getSettings(); const own = await bookAuto(id);
    if (disposed || own === 'never' || (own === 'follow' && !s.aiAutoStart) || autoStopped(id) || !aiReady()) return false;
    const local = s.aiProvider === 'local' && s.localEngine === 'device';
    if (!local && navigator.onLine === false) return false;
    const info = host.bookInfo?.(id); if (info?.format && !REFLOWABLE.has(info.format)) return false;
    const cur = host.currentChapter(); const ch = host.chapters()[cur]; if (!ch || furi()) return false;
    const base = (x?: string) => (x ?? '').trim().split(/[-_]/)[0].toLowerCase();
    if (info?.language && base(info.language) === base(s.aiTarget)) return false;
    if (!ch.blocks.some((el) => eligible(el))) return false;
    autoStarted = true; if (!pill) buildPill(); paint();
    await formerVolume(false); if (disposed || autoStopped(id)) return true;
    if (s.aiAutoGather !== false && !s.aiAutoGlossary && (await gatherModeOf(id)) !== 'never' && !(await scannedFor(id)).includes(cur) && await hasWork([cur])) await silentGather(id, [cur], false);
    if (disposed || autoStopped(id) || on) return true;
    setOn(true); return true;
  }

  host.onChapterChange(() => { if (on) void advance(); });
  // (A book saved translated opens translated: once its chapters are there, the kept translations put in.)
  void (async () => {
    for (let i = 0; i < 20 && !disposed && !host.chapters().length; i++) await new Promise((r) => setTimeout(r, 300));
    const id = firstBook(); if (!id || disposed || on) return;
    const k = await db.getMeta<{ hidden?: boolean; on?: boolean }>(keepKey(id)); if (disposed || on) return;
    // (Not saved, but chapters of it translated before: the bar is there, the translation a tap away.)
    if (!k && await autoStart(id)) return;
    if (!k) { if (!pill && (Object.keys(await sourceIndex(id)).length || Object.keys(await cache(id)).length) && !disposed) buildPill(); return; }
    buildPill(); if (k.hidden || k.on === false) hidePill(); if (k.on !== false) setOn(true); else paint();
  })();

  return {
    /** Whether any of these books has translations kept (the search then offers both languages). */
    async hasTranslations(bookIds: string[]) { for (const id of bookIds) { if (Object.keys(await sourceIndex(id)).length || Object.keys(await cache(id)).length) return true; } return false; },
    /** Loads the books' translations, for pairOf. */
    async load(bookIds: string[]) { for (const id of bookIds) { await sourceIndex(id); await cache(id); } },
    /** A paragraph's original text and its translation when there is one (shown now, or kept from before). */
    pairOf(el: HTMLElement, bookId: string): { orig: string; tr?: string } {
      const orig = originals.has(el) ? plainOfText(originals.get(el)!) : plainOf(el).replace(/\s+/g, ' ').trim();
      if (!orig || furi()) return { orig };
      const shown = translations.get(el);
      const tr = shown ?? bySource.get(bookId)?.[srcKey(orig)] ?? caches.get(bookId)?.[translationKey(sourceOf(el), bookId)] ?? caches.get(bookId)?.[legacyTranslationKey(sourceOf(el))];
      return { orig, tr: tr ? plainOfText(tr) : undefined };
    },
    target: () => getSettings().aiTarget,
    /** The contents' titles translated (while the translation is on, unless titles are left as they are): those
     *  kept already at once, the others asked for in one request and kept. */
    async titles(bookId: string, labels: string[]) {
      const out: Record<string, string> = {}; if (!on || furi() || getSettings().aiTitles === 'original') return out;
      const idx = await sourceIndex(bookId); const missing: string[] = [];
      for (const l of labels) { const tr = idx[srcKey(l)]; if (tr) out[l] = plainOfText(tr); else if (l.trim().length > 1 && !inTargetScript(l, getSettings().aiTarget)) missing.push(l); }
      if (missing.length && aiReady() && navigator.onLine !== false) {
        try { const uniq = [...new Set(missing)].slice(0, 200); const got = await translateBatch(uniq, bookId, { book: host.bookTitle?.(bookId) });
          uniq.forEach((l, i) => { const tr = got[i]?.trim(); if (tr) { idx[srcKey(l)] = tr; out[l] = plainOfText(tr); } }); scheduleSave(bookId);
        } catch { /* the titles stay as they are */ }
      }
      return out;
    },
    // (The toolbar's button: the bar shown or hidden — the translation stays; the first time, turned on.)
    toggleUi() { if (pill && !pill.hidden) { hidePill(); return; } if (pill) { showPill(); return; } buildPill(); void (async () => { const id = firstBook(); const kept = !!id && (Object.keys(await sourceIndex(id)).length > 0 || Object.keys(await cache(id)).length > 0); if (kept) setOn(true); else if (aiReady()) void startUser(); else settingsSheet(); })(); },
    dispose() { disposed = true; gatherSig.stop = true; setAiHooks(null); offWait(); generation++; pill?.remove(); pill = null; mini?.remove(); mini = null; window.clearTimeout(saveTimer); flush(); },
  };

  function settingsSheet() { aiSheet({ tab: 'translation', onDone: () => { if (pill && aiReady()) { if (!on) void startUser(); else void run(true); } }, extra: h('div', null, optionControls(), aheadControls()) }); }
}
