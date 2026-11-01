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
import { h, icon, toast, openSheet } from './dom';
import { t, isRtlText, localDigits, getLang } from '../i18n';
import { db } from '../db';
import { translateBatch, translationKey, aiReady, suggestTerms, langName, hash, onAiWait, type TrContext } from '../ai';
import { terms, saveTerms } from '../glossary';
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
const KEEP = new Set(['I', 'EM', 'B', 'STRONG', 'U', 'SUP', 'SUB']);
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
    const keep = KEEP.has(tag) && (e.textContent ?? '').trim();
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

export type Translator = { toggleUi(): void; dispose(): void; hasTranslations(bookIds: string[]): Promise<boolean>; load(bookIds: string[]): Promise<void>; pairOf(el: HTMLElement, bookId: string): { orig: string; tr?: string }; target(): string };
export function attachTranslator(host: TranslatorHost): Translator {
  let on = false;
  let pill: HTMLElement | null = null;
  let running = false, generation = 0;
  const originals = new WeakMap<HTMLElement, string>();
  const caches = new Map<string, Record<string, string>>();   // bookId → key → translation
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
  const bySource = new Map<string, Record<string, string>>();
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
  const eligible = (el: HTMLElement) => { if (SKIP.has(el.tagName) || el.querySelector('img, table, svg')) return false; const x = originals.has(el) ? sourceOf(el) : plainOf(el); if (x.length < 2) return false; if (furi()) return /[\u4e00-\u9fff]/.test(x); return !(getSettings().aiSkipSame !== false && inTargetScript(x.replace(/<[^>]+>/g, ''), getSettings().aiTarget)); };

  function apply(el: HTMLElement, translated: string) {
    if (!originals.has(el)) originals.set(el, el.innerHTML);
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
    if (getSettings().aiDisplay === 'bilingual') {
      // Both: the original as it was (dimmed), the translation under it in a line of its own.
      el.innerHTML = originals.get(el)!; el.removeAttribute('dir');
      const orig = h('span', { class: 'kr-tr-orig' }); orig.append(...Array.from(el.childNodes)); el.append(orig);
      el.append(h('span', { class: 'kr-tr-line', dir }, styledNodes(translated)));
      el.classList.add('kr-translated', 'kr-bilingual');
      return;
    }
    el.replaceChildren(styledNodes(translated)); el.classList.remove('kr-bilingual');
    el.classList.add('kr-translated');
    el.dir = dir;
  }
  /** The way translations are shown changed: every translated paragraph shown the new way. */
  function reapply() { for (const { el } of host.blocks()) { const tr = translations.get(el); if (tr !== undefined && originals.has(el)) apply(el, tr); } }
  function restore(el: HTMLElement) {
    const o = originals.get(el);
    if (o === undefined) return;
    el.innerHTML = o; el.classList.remove('kr-translated', 'kr-furigana', 'kr-bilingual'); el.removeAttribute('dir'); originals.delete(el); translations.delete(el);
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

  /** Translate the shown chapter: cached paragraphs appear at once, the rest in view order. */
  async function run(force = false) {
    const gen = ++generation;
    const list = host.blocks().filter((b) => eligible(b.el));
    // visible first, then by distance from the viewport
    const sr = host.scroll.getBoundingClientRect();
    const dist = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.bottom < sr.top ? sr.top - r.bottom + 100000 : r.top > sr.bottom ? r.top - sr.bottom : 0; };
    list.sort((a, b) => dist(a.el) - dist(b.el));
    pending = list.length; done = 0; paint();
    const todo: { el: HTMLElement; bookId: string; text: string; key: string }[] = [];
    for (const b of list) {
      const text = sourceOf(b.el);
      const key = translationKey(text);
      const c = await cache(b.bookId);
      if (!force && c[key]) { apply(b.el, c[key]); done++; continue; }
      if (force) restore(b.el);
      todo.push({ el: b.el, bookId: b.bookId, text, key });
    }
    paint();
    if (!todo.length) return;
    if (!aiReady()) { toast(t('aiNeedsKey'), 'error', 4000); settingsSheet(); return; }
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
    if (getSettings().aiPrefetch === false || aheadBusy) return;
    const cur = host.currentChapter(); const next = host.chapters()[cur + 1]; if (!next) return;
    const mark = `${next.bookId}:${cur + 1}`; if (prefetched === mark) return; prefetched = mark;
    await translateAhead(cur + 1, cur + 1, null, null, () => undefined, true);
  }

  /* ---------- translate ahead: N chapters, a range, or the whole book ---------- */
  let aheadGen = 0; let aheadBusy = false;
  async function translateAhead(from: number, to: number, status: HTMLElement | null, bar: HTMLElement | null, onDone: () => void, quiet = false) {
    const gen = quiet ? aheadGen : ++aheadGen; if (!quiet) aheadBusy = true;
    const chapters = host.chapters().slice(from, to + 1);
    const items: { bookId: string; text: string; key: string; el: HTMLElement; chapter: string; all: HTMLElement[] }[] = [];
    const seen = new Set<string>();
    for (const ch of chapters) for (const el of ch.blocks) {
      if (!eligible(el)) continue;
      const text = sourceOf(el);
      const key = translationKey(text);
      if (seen.has(key)) continue; seen.add(key);
      const c = await cache(ch.bookId);
      if (!c[key]) items.push({ bookId: ch.bookId, text, key, el, chapter: ch.label, all: ch.blocks });
    }
    const total = items.length; let finished = 0, failed = 0;
    const paintAhead = () => { if (status) status.textContent = t('translatingAhead', { n: finished, total }); if (bar) bar.style.width = total ? `${Math.round((finished / total) * 100)}%` : '100%'; };
    paintAhead();
    if (!total) { if (status) status.textContent = t('alreadyTranslated'); if (!quiet) aheadBusy = false; onDone(); return; }
    const batches = batchesOf(items);
    const worker = async () => {
      while (batches.length && gen === aheadGen) {
        const batch = batches.shift()!;
        try {
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
    if (!quiet) aheadBusy = false;
    if (gen !== aheadGen) return;
    if (quiet) return;
    if (status) status.textContent = failed ? t('translateAheadPartial', { n: finished, total }) : t('translateAheadDone', { n: finished });
    onDone();
    if (on) void run();   // the shown chapter picks up what is now cached
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
    const cancel = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => { aheadGen++; busy = false; aheadBusy = false; cancel.hidden = true; status.textContent = t('cancelled'); } }, icon('close'), t('cancel'));
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
      const known = terms().filter((x) => !x.book || x.book === ch.bookId).map((x) => x.from);
      const found = await suggestTerms(texts, known);
      if (!sh.el.isConnected) return;
      if (!found.length) { sh.body.replaceChildren(h('p', { class: 'src' }, t('trSuggestNone'))); return; }
      const rows = found.map((f) => { const cb = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement; const to = h('input', { type: 'text', value: f.to, dir: 'auto', class: 'tr-term-to' }) as HTMLInputElement; return { f, cb, to, el: h('label', { class: 'tr-term' }, cb, h('span', { class: 'tr-term-from', dir: 'auto' }, f.from), h('span', { class: 'upd-arrow' }, icon('arrowRight')), to) }; });
      sh.body.replaceChildren(h('p', { class: 'src' }, t('trSuggestPick')), h('div', { class: 'tr-terms' }, ...rows.map((r) => r.el)));
      const add = (book?: string) => { const list = terms().slice(); let n = 0; for (const r of rows) if (r.cb.checked && r.to.value.trim()) { list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, from: r.f.from, to: r.to.value.trim(), ...(book ? { book } : {}) }); n++; } saveTerms(list); sh.close(); toast(t('trTermsAdded', { n: localDigits(n) })); if (on) void run(true); };
      sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => add() }, t('trAddAllBooks')), h('button', { type: 'button', class: 'btn primary', onclick: () => add(ch.bookId) }, icon('check'), t('trAddThisBook')));
    } catch (e) { if (sh.el.isConnected) sh.body.replaceChildren(h('p', { class: 'src' }, String((e as Error).message ?? e))); }
  }

  function aheadSheet() {
    const sh = openSheet(t('translateAhead'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    const c = aheadControls(); c.querySelector('h4')?.remove();
    sh.body.append(c);
  }

  function htmlToText(html: string): string { const d = document.createElement('div'); d.innerHTML = html; return (d.innerText ?? d.textContent ?? '').trim(); }

  /* ---------- pill ---------- */
  let status: HTMLElement, toggleBtn: HTMLButtonElement;
  // (Waiting for the provider's per-minute limit: said on the bar, not as an error — it goes on by itself.)
  let waitSec = 0; const offWait = onAiWait((sec) => { waitSec = sec; paint(); });
  function paint() {
    if (!pill) return;
    if (waitSec > 0 && on) { status.textContent = t('trWaitingLimit', { s: localDigits(waitSec) }); return; }
    toggleBtn.setAttribute('aria-pressed', String(on));
    toggleBtn.classList.toggle('on', on);
    pill.querySelector('.tr-mode')?.classList.toggle('on', getSettings().aiDisplay === 'bilingual');
    status.textContent = !on ? t('translatorOff') : running ? t('translating') + ` ${localDigits(done)}/${localDigits(pending)}` : pending ? t('translatedCount', { n: done, total: pending }) : t('translatorOn');
  }
  function setOn(v: boolean) {
    on = v;
    if (on) void run(); else { generation++; running = false; restoreAll(); }
    paint();
  }
  function buildPill() {
    toggleBtn = h('button', { type: 'button', class: 'tr-toggle', 'aria-label': t('aiTranslate'), onclick: () => setOn(!on) }, icon('translate')) as HTMLButtonElement;
    status = h('span', { class: 'tr-status' });
    pill = h('div', { class: 'tr-pill', role: 'toolbar', 'aria-label': t('aiTranslate') },
      toggleBtn, status,
      h('button', { type: 'button', class: 'tr-mode', title: t('trBilingual'), 'aria-label': t('trBilingual'), onclick: () => { updateSettings({ aiDisplay: getSettings().aiDisplay === 'bilingual' ? 'replace' : 'bilingual' }); reapply(); paint(); toast(getSettings().aiDisplay === 'bilingual' ? t('trShownBoth') : t('trShownReplace')); } }, icon('eye')),
      h('button', { type: 'button', title: t('retranslate'), 'aria-label': t('retranslate'), onclick: () => { if (!on) setOn(true); else void run(true); } }, icon('rotate')),
      h('button', { type: 'button', title: t('clearTranslationCache'), 'aria-label': t('clearTranslationCache'), onclick: async () => { for (const { bookId } of host.blocks()) { bySource.set(bookId, {}); void db.setMeta(`trs:${bookId}`, {}); caches.set(bookId, {}); await db.setMeta(`tr:${bookId}`, {}); } restoreAll(); if (on) void run(); toast(t('done')); } }, icon('trash')),
      h('button', { type: 'button', title: t('translateAhead'), 'aria-label': t('translateAhead'), onclick: () => aheadSheet() }, icon('books')),
      h('button', { type: 'button', title: t('customize'), 'aria-label': t('customize'), onclick: () => settingsSheet() }, icon('settings')),
      h('button', { type: 'button', title: t('close'), 'aria-label': t('close'), onclick: () => { setOn(false); pill?.remove(); pill = null; } }, icon('close')),
    );
    host.root.appendChild(pill);
    paint();
  }

  host.onChapterChange(() => { if (on) void run(); });

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
      const tr = shown ?? bySource.get(bookId)?.[srcKey(orig)] ?? caches.get(bookId)?.[translationKey(sourceOf(el))];
      return { orig, tr: tr ? plainOfText(tr) : undefined };
    },
    target: () => getSettings().aiTarget,
    toggleUi() { if (pill) { setOn(false); pill.remove(); pill = null; return; } buildPill(); if (aiReady()) setOn(true); else settingsSheet(); },
    dispose() { offWait(); generation++; pill?.remove(); pill = null; window.clearTimeout(saveTimer); for (const id of dirty) void db.setMeta(`tr:${id}`, caches.get(id) ?? {}); },
  };

  function settingsSheet() { aiSettingsSheet(() => { if (pill && aiReady()) { if (!on) setOn(true); else void run(true); } }, h('div', null, optionControls(), aheadControls())); }
}
