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
import { termsFor, addTerms, folders, linkedFolders, setLinked, namesTarget, type TermKind } from '../glossary';
import { getSettings, updateSettings } from '../settings';
import { aiSettingsSheet } from './aisettings';

export interface TranslatorHost {
  root: HTMLElement;                                   // reader root (the pill is appended here)
  scroll: HTMLElement;
  blocks(): { el: HTMLElement; bookId: string }[];      // blocks of what is currently shown
  chapters(): { label: string; bookId: string; blocks: HTMLElement[] }[];   // every chapter of every open book
  currentChapter(): number;
  onChapterChange(fn: () => void): void;
  bookTitle?(bookId: string): string | undefined;
}

const SKIP = new Set(['IMG', 'FIGURE', 'TABLE', 'HR', 'SVG', 'VIDEO', 'AUDIO', 'PRE', 'CODE']);
const KEEP = new Set(['I', 'EM', 'B', 'STRONG', 'U', 'SUP', 'SUB', 'A']);
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
/** The whole-book translations going on, by book: one at a time for a book, whichever reader started it. */
const aheadJobs = new Map<string, { cancel(): void; done: number; total: number }>();

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

export type Translator = { titles(bookId: string, labels: string[]): Promise<Record<string, string>>; toggleUi(): void; dispose(): void; hasTranslations(bookIds: string[]): Promise<boolean>; load(bookIds: string[]): Promise<void>; pairOf(el: HTMLElement, bookId: string): { orig: string; tr?: string }; target(): string };
export function attachTranslator(host: TranslatorHost): Translator {
  let on = false; let disposed = false;
  let pill: HTMLElement | null = null;
  let running = false, generation = 0;
  const originals = new WeakMap<HTMLElement, string>();
  const dirty = new Set<string>();
  let saveTimer = 0;
  let pending = 0, done = 0;

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
    const c = await cache(bookId); c[key] = tr;
    (await sourceIndex(bookId))[srcKey(plainOfText(sourceText))] = tr;
    scheduleSave(bookId);
  }
  function scheduleSave(bookId: string) {
    dirty.add(bookId);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { for (const id of dirty) { void db.setMeta(`tr:${id}`, caches.get(id) ?? {}); if (bySource.has(id)) void db.setMeta(`trs:${id}`, bySource.get(id)!); } dirty.clear(); }, 800);
  }

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
    const known = termsFor(bookId, getSettings().aiTarget).map((x) => x.from);
    const found = await suggestTerms(texts, known);
    const kind = (x?: string): TermKind => (x === 'person' || x === 'place' || x === 'group' ? x : 'term');
    const place = folder ? { folder } : namesTarget(bookId, host.bookTitle?.(bookId) ?? '');
    return addTerms(found.map((f) => ({ from: f.from, to: f.to, ...place, kind: kind(f.kind), auto: true, lang: getSettings().aiTarget })));
  }
  /** The whole book read for its names (Find names in the whole book): the chapters a few at a time — about
   *  20,000 characters to a request —, as a job that goes on in the background, its progress in the
   *  notification; the chapters already read for names skipped. */
  async function scanWholeBook(folder?: string): Promise<void> {
    if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; }
    const chapters = host.chapters(); const bookId = chapters[0]?.bookId; if (!bookId) return;
    const k = `glossScan:${bookId}`; const done = new Set((await db.getMeta<number[]>(k)) ?? []);
    const groups: { idx: number[]; texts: string[] }[] = []; let cur = { idx: [] as number[], texts: [] as string[] }; let size = 0;
    chapters.forEach((ch, i) => { if (done.has(i)) return; const tx = ch.blocks.map((el) => (originals.has(el) ? sourceOf(el) : plainOf(el)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1); const n = tx.reduce((a, x) => a + x.length, 0); if (!n) return; if (cur.idx.length && size + n > 20000) { groups.push(cur); cur = { idx: [], texts: [] }; size = 0; } cur.idx.push(i); cur.texts.push(...tx); size += n; });
    if (cur.idx.length) groups.push(cur);
    if (!groups.length) { toast(t('glossScanDone', { n: localDigits(0) })); return; }
    const title = host.bookTitle?.(bookId) ?? ''; let stop = false; let added = 0;
    const { runJob } = await import('../jobs');
    void runJob(t('glossScanJob', { book: title }), async (rep) => {
      for (let g = 0; g < groups.length && !stop; g++) {
        rep((g / groups.length) * 100, t('glossScanProgress', { n: localDigits(g), total: localDigits(groups.length), found: localDigits(added) }));
        try { added += await namesFrom(groups[g].texts.join('\n').slice(0, 24000).split('\n'), bookId, folder); await db.setMeta(k, [...((await db.getMeta<number[]>(k)) ?? []), ...groups[g].idx]); }
        catch (e) { if ((e as Error).name === 'QuotaError') throw e; console.warn('[kurokawa] scan', e); }
      }
      return stop ? null : { blob: new Blob([]), name: title };
    }, () => false, { quiet: true, cancel: () => { stop = true; }, doneText: () => t('glossScanDone', { n: localDigits(added) }) }).catch((e) => toast(String((e as Error).message ?? e), 'error', 6000));
  }
  /** The names of a chapter put in its book's glossary before it is translated (when chosen): the model lists the
   *  characters, places and terms it holds, those not there yet are added — once for each chapter. */
  async function autoGlossary(bookId: string, chapterIdx: number, blocks: HTMLElement[], quiet: boolean): Promise<void> {
    if (!getSettings().aiAutoGlossary || furi() || !aiReady()) return;
    const k = `glossScan:${bookId}`; const done = (await db.getMeta<number[]>(k)) ?? []; if (done.includes(chapterIdx)) return;
    const texts = blocks.map((el) => (originals.has(el) ? sourceOf(el) : plainOf(el)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1); if (!texts.length) return;
    try {
      const n = await namesFrom(texts, bookId);
      if (n && !quiet) toast(t('glossAutoAdded', { n: localDigits(n) }));
      await db.setMeta(k, [...((await db.getMeta<number[]>(k)) ?? []), chapterIdx]);
    } catch (e) { console.warn('[kurokawa] auto glossary', e); }
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
        const batch = batches.shift()!;
        try {
          const out = await translateBatch(batch.map((x) => x.text), batch[0]?.bookId, contextFor(batch[0].el, batch[0].bookId, order));
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
    if (getSettings().aiPrefetch === false || aheadBusy || [...aheadJobs.keys()].some((id) => host.chapters().some((c) => c.bookId === id))) return;
    const cur = host.currentChapter(); const next = host.chapters()[cur + 1]; if (!next) return;
    const mark = `${next.bookId}:${cur + 1}`; if (prefetched === mark) return; prefetched = mark;
    await translateAhead(cur + 1, cur + 1, null, null, () => undefined, true);
  }

  /* ---------- translate ahead: N chapters, a range, or the whole book ---------- */
  let aheadGen = 0; let aheadBusy = false;
  async function translateAhead(from: number, to: number, status: HTMLElement | null, bar: HTMLElement | null, onDone: () => void, quiet = false, force = false) {
    const chapters = host.chapters().slice(from, to + 1); const bookKey = chapters[0]?.bookId ?? '';
    if (!quiet && aheadJobs.has(bookKey)) { toast(t('trJobAlready'), 'info', 4000); onDone(); return; }
    const gen = quiet ? aheadGen : ++aheadGen; if (!quiet) aheadBusy = true;
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
    const stopIt = () => { aheadGen++; aheadBusy = false; aheadJobs.delete(bookKey); job.finish?.('cancel'); };
    const entry = { cancel: stopIt, done: 0, total };
    if (!quiet && total) aheadJobs.set(bookKey, entry);
    if (!quiet && total) {
      const title = host.bookTitle?.(chapters[0]?.bookId ?? '') ?? t('aiTranslate');
      const ended = new Promise<'ok' | 'cancel' | 'fail'>((res) => { job.finish = res; });
      void import('../jobs').then(({ runJob }) => runJob(t('trJobTitle', { book: title }), async (rep) => { job.report = rep; rep(0, t('trJobProgress', { n: localDigits(0), total: localDigits(total) })); const how = await ended; if (how === 'fail') throw new Error(t('trJobFailed')); return how === 'ok' ? { blob: new Blob([]), name: title } : null; }, () => false,
        { quiet: true, cancel: () => stopIt(), doneText: () => t('trJobDone', { book: title, n: localDigits(finished) }) })).catch(() => undefined);
    }
    const paintAhead = () => { entry.done = finished; job.report?.(total ? (finished / total) * 100 : 100, t('trJobProgress', { n: localDigits(finished), total: localDigits(total) })); if (status) status.textContent = t('translatingAhead', { n: finished, total }); if (bar) bar.style.width = total ? `${Math.round((finished / total) * 100)}%` : '100%'; };
    paintAhead();
    if (!total) { if (status) status.textContent = t('alreadyTranslated'); if (!quiet) aheadBusy = false; onDone(); return; }
    const batches = batchesOf(items);
    const worker = async () => {
      while (batches.length && gen === aheadGen) {
        const batch = batches.shift()!;
        try {
          if (getSettings().aiAutoGlossary) { for (const x of batch) { const ci = from + chapters.findIndex((c) => c.blocks === x.all); if (ci >= from) await autoGlossary(x.bookId, ci, x.all, true); } for (const x of batch) x.key = translationKey(x.text, x.bookId); if (gen !== aheadGen) return; }
          const first = batch[0]; const i = first.all.indexOf(first.el); const before = first.all.slice(Math.max(0, i - 2), i).map((e) => plainOf(e)).filter((x) => x.length > 1);
          const out = await translateBatch(batch.map((x) => x.text), first.bookId, { book: host.bookTitle?.(first.bookId), chapter: first.chapter, before });
          if (gen !== aheadGen) return;
          for (let i = 0; i < batch.length; i++) { const tr = out[i]?.trim(); if (!tr) continue; await remember(batch[i].bookId, batch[i].key, batch[i].text, tr); }
          finished += batch.length;
        } catch (err) { failed++; console.warn('[kurokawa] translate-ahead failed', err); if (failed === 1 && !quiet) toast(String((err as Error).message ?? err), 'error', 6000); if (failed > 3 || (err as Error).name === 'QuotaError') { batches.length = 0; } }
        paintAhead();
      }
    };
    await Promise.all(Array.from({ length: quiet ? 1 : Math.max(parallel(), 2) }, () => worker()));
    if (!quiet) { aheadBusy = false; if (aheadJobs.get(bookKey) === entry) aheadJobs.delete(bookKey); }
    job.finish?.(gen !== aheadGen ? 'cancel' : finished > 0 ? 'ok' : failed ? 'fail' : 'ok');
    if (gen !== aheadGen) return;
    if (quiet) return;
    if (status) status.textContent = failed ? t('translateAheadPartial', { n: finished, total }) : t('translateAheadDone', { n: finished });
    onDone();
    if (!quiet && from === 0 && to >= host.chapters().length - 1) void db.setMeta(`trWhole:${bookKey}`, true);
    if (on && !disposed) void run();   // the shown chapter picks up what is now cached
  }

  /** The translate-ahead controls (used in their own sheet and inside the AI settings sheet). */
  function aheadControls(): HTMLElement {
    const chapters = host.chapters();
    const cur = host.currentChapter();
    const num = (v: number, min: number, max: number) => h('input', { type: 'number', min: String(min), max: String(max), value: String(v), dir: 'ltr', style: { width: '5.5em' } }) as HTMLInputElement;
    const count = num(Math.min(5, chapters.length - cur), 1, chapters.length - cur);
    const fromI = num(cur + 1, 1, chapters.length), toI = num(Math.min(chapters.length, cur + 5), 1, chapters.length);
    const row = (...kids: (HTMLElement | string)[]) => h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, ...kids);
    const status = h('p', { class: 'src' }, t('translateAheadBody', { n: chapters.length }));
    const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
    let busy = false;
    const cancel = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => { const j = aheadJobs.get(chapters[0]?.bookId ?? ''); if (j) j.cancel(); else aheadGen++; busy = false; aheadBusy = false; cancel.hidden = true; status.textContent = t('cancelled'); } }, icon('close'), t('cancel'));
    // (A whole-book translation already going on for this book — from this reader or one closed since: its progress, and its Stop.)
    const running = aheadJobs.get(chapters[0]?.bookId ?? '');
    if (running) { busy = true; track.hidden = false; cancel.hidden = false; const tick = () => { if (!aheadJobs.has(chapters[0]?.bookId ?? '') || !status.isConnected) { if (status.isConnected && busy) { busy = false; cancel.hidden = true; status.textContent = t('translateAheadDone', { n: running.done }); } return; } status.textContent = t('translatingAhead', { n: running.done, total: running.total }); bar.style.width = `${Math.round((running.done / Math.max(1, running.total)) * 100)}%`; setTimeout(tick, 700); }; setTimeout(tick, 0); }
    const start = (from: number, to: number) => {
      if (busy) return;
      if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; }
      busy = true; track.hidden = false; cancel.hidden = false;
      void translateAhead(Math.max(0, from), Math.min(chapters.length - 1, to), status, bar, () => { busy = false; cancel.hidden = true; });
    };
    const btn = (label: string, fn: () => void) => h('button', { class: 'btn small tonal', type: 'button', onclick: fn }, label);
    return h('div', { class: 'tr-ahead' },
      h('h4', { class: 'upd-title', style: { marginTop: '14px' } }, t('translateAhead')),
      status, track,
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('nextChapters')), row(count, btn(t('translateSelected'), () => start(cur, cur + Number(count.value || 1) - 1)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('chapterRange')), row(fromI, '→', toI, btn(t('translateSelected'), () => start(Number(fromI.value) - 1, Number(toI.value) - 1)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('wholeBook')), row(btn(t('translateWholeBook'), () => start(0, chapters.length - 1)), cancel)),
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
      h('button', { type: 'button', class: 'btn tonal small', style: { marginTop: '8px' }, onclick: () => void suggestSheet() }, icon('define'), t('trSuggestTerms')));
  }
  /** Names and terms of the shown chapter proposed by the model, ticked to go into the glossary (this book's, or
   *  every book's), each rendering editable first. */
  async function suggestSheet() {
    if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); return; }
    const ch = host.chapters()[host.currentChapter()]; if (!ch) return;
    const sh = openSheet(t('trSuggestTerms'), t('close')); sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(h('p', { class: 'src' }, t('trSuggestBody', { lang: (() => { try { return new Intl.DisplayNames([getLang()], { type: 'language' }).of(getSettings().aiTarget) ?? langName(getSettings().aiTarget); } catch { return langName(getSettings().aiTarget); } })() })), h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    try {
      const texts = ch.blocks.map((el) => (originals.has(el) ? sourceOf(el) : plainOf(el)).replace(/<[^>]+>/g, '')).filter((x) => x.length > 1);
      const known = termsFor(ch.bookId, getSettings().aiTarget).map((x) => x.from);
      const found = await suggestTerms(texts, known);
      if (!sh.el.isConnected) return;
      if (!found.length) { sh.body.replaceChildren(h('p', { class: 'src' }, t('trSuggestNone'))); return; }
      const rows = found.map((f) => { const cb = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement; const to = h('input', { type: 'text', value: f.to, dir: 'auto', class: 'tr-term-to' }) as HTMLInputElement; return { f, cb, to, el: h('label', { class: 'tr-term' }, cb, h('span', { class: 'tr-term-from', dir: 'auto' }, f.from), h('span', { class: 'upd-arrow' }, icon('arrowRight')), to) }; });
      sh.body.replaceChildren(h('p', { class: 'src' }, t('trSuggestPick')), h('div', { class: 'tr-terms' }, ...rows.map((r) => r.el)));
      const add = (scope: { book?: string; folder?: string }) => { const n = addTerms(rows.filter((r) => r.cb.checked && r.to.value.trim()).map((r) => ({ from: r.f.from, to: r.to.value.trim(), kind: (['person', 'place', 'group'].includes(r.f.kind ?? '') ? r.f.kind : 'term') as TermKind, lang: getSettings().aiTarget, ...scope }))); sh.close(); toast(t('trTermsAdded', { n: localDigits(n) })); if (on) void run(); };
      // (Into this book's glossary, every book's, or a folder — one the book then uses.)
      const fs = folders();
      if (fs.length) sh.actions.append(pickButton(t('glossToFolder'), fs.map((f) => [f.id, f.name] as [string, string]), '', (id: string) => { setLinked(ch.bookId, [...linkedFolders(ch.bookId), id]); add({ folder: id }); }, t('close')));
      sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => add({}) }, t('trAddAllBooks')), h('button', { type: 'button', class: 'btn primary', onclick: () => add({ book: ch.bookId }) }, icon('check'), t('trAddThisBook')));
    } catch (e) { if (sh.el.isConnected) sh.body.replaceChildren(h('p', { class: 'src' }, String((e as Error).message ?? e))); }
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


  /* ---------- pill ---------- */
  let status: HTMLElement, toggleBtn: HTMLButtonElement;
  // (Waiting for the provider's per-minute limit: said on the bar, not as an error — it goes on by itself.)
  let waitSec = 0; const offWait = onAiWait((sec) => { waitSec = sec; paint(); });
  function paint() {
    if (!pill) return;
    if (waitSec > 0 && on) { status.textContent = t('trWaitingLimit', { s: localDigits(waitSec) }); return; }
    mini?.classList.toggle('on', on);
    toggleBtn.setAttribute('aria-pressed', String(on));
    toggleBtn.classList.toggle('on', on);
    pill.querySelector('.tr-mode')?.classList.toggle('on', getSettings().aiDisplay === 'bilingual');
    status.textContent = !on ? t('translatorOff') : running ? t('translating') + ` ${localDigits(done)}/${localDigits(pending)}` : pending ? t('translatedCount', { n: done, total: pending }) : t('translatorOn');
  }
  function setOn(v: boolean) {
    on = v; void isKept().then((k) => { if (k) void setKept(true); });   // (saved with the book: on or off is kept as it was left)
    if (on) void run(); else { generation++; running = false; restoreAll(); }
    paint();
  }
  function clearCache() { void (async () => { for (const { bookId } of host.blocks()) { bySource.set(bookId, {}); void db.setMeta(`trs:${bookId}`, {}); caches.set(bookId, {}); await db.setMeta(`tr:${bookId}`, {}); } restoreAll(); if (on) void run(); toast(t('done')); })(); }
  function moreSheet() {
    const sh = openSheet(t('aiTranslate'), t('close')); sh.body.style.fontFamily = 'var(--font-ui)';
    const row = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label));
    const autoCb = h('input', { type: 'checkbox', checked: !!getSettings().aiAutoGlossary, onchange: (e: Event) => { updateSettings({ aiAutoGlossary: (e.target as HTMLInputElement).checked }); if ((e.target as HTMLInputElement).checked && on) void run(); } }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'row tr-opt gloss-auto' }, h('span', { class: 'label' }, t('glossAuto'), h('small', { class: 'hint' }, t('glossAutoHint'))), autoCb));
    const keepCb = h('input', { type: 'checkbox', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; void setKept(v); markSaved(v); if (v) void navigator.storage?.persist?.().catch(() => undefined); if (v && !on) setOn(true); toast(v ? t('trKept') : t('trNotKept')); } }) as HTMLInputElement;
    void isKept().then((v) => { keepCb.checked = v; });
    sh.body.append(h('label', { class: 'row tr-opt gloss-auto' }, h('span', { class: 'label' }, t('trKeepBook'), h('small', { class: 'hint' }, t('trKeepBookHint'))), keepCb));
    sh.body.append(h('div', { class: 'dest-list' }, row('books', t('translateAhead'), () => aheadSheet()), row('define', t('trSuggestTerms'), () => void suggestSheet()), row('books', t('glossary'), () => void import('./glossarysheet').then((m) => { const id = host.chapters()[host.currentChapter()]?.bookId; m.glossarySheet(id ? { id, title: host.bookTitle?.(id) ?? '' } : undefined, { scan: (folder) => void scanWholeBook(folder) }); })), row('trash', t('clearTranslationCache'), () => clearCache()), row('settings', t('customize'), () => settingsSheet())));
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
    toggleBtn = h('button', { type: 'button', class: 'tr-toggle', 'aria-label': t('trTurnOnOff'), title: t('trTurnOnOff'), onclick: () => setOn(!on) }, icon('translate')) as HTMLButtonElement;
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

  host.onChapterChange(() => { if (on) void run(); });
  // (A book saved translated opens translated: once its chapters are there, the kept translations put in.)
  void (async () => {
    for (let i = 0; i < 20 && !disposed && !host.chapters().length; i++) await new Promise((r) => setTimeout(r, 300));
    const id = firstBook(); if (!id || disposed || on) return;
    const k = await db.getMeta<{ hidden?: boolean; on?: boolean }>(keepKey(id)); if (disposed || on) return;
    // (Not saved, but chapters of it translated before: the bar is there, the translation a tap away.)
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
    toggleUi() { if (pill && !pill.hidden) { hidePill(); return; } if (pill) { showPill(); return; } buildPill(); void (async () => { const id = firstBook(); const kept = !!id && (Object.keys(await sourceIndex(id)).length > 0 || Object.keys(await cache(id)).length > 0); if (aiReady() || kept) setOn(true); else settingsSheet(); })(); },
    dispose() { disposed = true; offWait(); generation++; pill?.remove(); pill = null; mini?.remove(); mini = null; window.clearTimeout(saveTimer); for (const id of dirty) void db.setMeta(`tr:${id}`, caches.get(id) ?? {}); },
  };

  function settingsSheet() { aiSettingsSheet(() => { if (pill && aiReady()) { if (!on) setOn(true); else void run(true); } }, h('div', null, optionControls(), aheadControls())); }
}
