// Chapter translation with an AI model — works like a browser's page translator:
// a floating pill toggles it on and off instantly, paragraphs are translated in
// the order they come into view, results are cached per book so switching off
// and on again costs nothing, and the chapter can be re-translated or the cache
// cleared on demand.
import { h, icon, toast, openSheet } from './dom';
import { t, isRtlText, localDigits } from '../i18n';
import { db } from '../db';
import { translateBatch, translationKey, aiReady } from '../ai';
import { getSettings } from '../settings';
import { aiSettingsSheet } from './aisettings';

export interface TranslatorHost {
  root: HTMLElement;                                   // reader root (the pill is appended here)
  scroll: HTMLElement;
  blocks(): { el: HTMLElement; bookId: string }[];      // blocks of what is currently shown
  chapters(): { label: string; bookId: string; blocks: HTMLElement[] }[];   // every chapter of every open book
  currentChapter(): number;
  onChapterChange(fn: () => void): void;
}

const SKIP = new Set(['IMG', 'FIGURE', 'TABLE', 'HR', 'SVG', 'VIDEO', 'AUDIO', 'PRE', 'CODE']);

export function attachTranslator(host: TranslatorHost): { toggleUi(): void; dispose(): void } {
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
  function scheduleSave(bookId: string) {
    dirty.add(bookId);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { for (const id of dirty) void db.setMeta(`tr:${id}`, caches.get(id) ?? {}); dirty.clear(); }, 800);
  }

  const textOf = (el: HTMLElement) => (el.innerText ?? el.textContent ?? '').replace(/\s+\n/g, '\n').trim();
  const eligible = (el: HTMLElement) => !SKIP.has(el.tagName) && !el.querySelector('img, table, svg') && textOf(el).length >= 2 && (getSettings().aiTask !== 'furigana' || /[\u4e00-\u9fff]/.test(textOf(el)));

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
    el.textContent = translated;
    el.classList.add('kr-translated');
    el.dir = isRtlText(translated) ? 'rtl' : 'ltr';
  }
  function restore(el: HTMLElement) {
    const o = originals.get(el);
    if (o === undefined) return;
    el.innerHTML = o; el.classList.remove('kr-translated', 'kr-furigana'); el.removeAttribute('dir'); originals.delete(el);
  }
  function restoreAll() { for (const { el } of host.blocks()) restore(el); }

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
      const text = originals.has(b.el) ? htmlToText(originals.get(b.el)!) : textOf(b.el);
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
    // batches of ~2500 characters, two in flight
    const batches: typeof todo[] = [];
    let cur: typeof todo = []; let size = 0;
    for (const item of todo) { if (cur.length && (size + item.text.length > 2500 || cur.length >= 12)) { batches.push(cur); cur = []; size = 0; } cur.push(item); size += item.text.length; }
    if (cur.length) batches.push(cur);
    let failed = 0;
    const worker = async () => {
      while (batches.length && gen === generation && on) {
        const batch = batches.shift()!;
        try {
          const out = await translateBatch(batch.map((x) => x.text));
          if (gen !== generation || !on) return;
          for (let i = 0; i < batch.length; i++) {
            const tr = out[i]?.trim(); if (!tr) continue;
            const c = await cache(batch[i].bookId); c[batch[i].key] = tr; scheduleSave(batch[i].bookId);
            apply(batch[i].el, tr); done++;
          }
        } catch (err) { failed++; console.warn('[kurokawa] translate failed', err); if (failed === 1) toast(String((err as Error).message ?? err), 'error', 5000); if (failed > 3) break; }
        paint();
      }
    };
    await Promise.all([worker(), worker()]);
    running = false; paint();
  }

  /* ---------- translate ahead: N chapters, a range, or the whole book ---------- */
  let aheadGen = 0;
  async function translateAhead(from: number, to: number, status: HTMLElement, bar: HTMLElement, onDone: () => void) {
    const gen = ++aheadGen;
    const chapters = host.chapters().slice(from, to + 1);
    const items: { bookId: string; text: string; key: string }[] = [];
    const seen = new Set<string>();
    for (const ch of chapters) for (const el of ch.blocks) {
      if (!eligible(el)) continue;
      const text = originals.has(el) ? htmlToText(originals.get(el)!) : textOf(el);
      const key = translationKey(text);
      if (seen.has(key)) continue; seen.add(key);
      const c = await cache(ch.bookId);
      if (!c[key]) items.push({ bookId: ch.bookId, text, key });
    }
    const total = items.length; let finished = 0, failed = 0;
    const paintAhead = () => { status.textContent = t('translatingAhead', { n: finished, total }); bar.style.width = total ? `${Math.round((finished / total) * 100)}%` : '100%'; };
    paintAhead();
    if (!total) { status.textContent = t('alreadyTranslated'); onDone(); return; }
    const batches: typeof items[] = []; let cur: typeof items = []; let size = 0;
    for (const it of items) { if (cur.length && (size + it.text.length > 2500 || cur.length >= 12)) { batches.push(cur); cur = []; size = 0; } cur.push(it); size += it.text.length; }
    if (cur.length) batches.push(cur);
    const worker = async () => {
      while (batches.length && gen === aheadGen) {
        const batch = batches.shift()!;
        try {
          const out = await translateBatch(batch.map((x) => x.text));
          if (gen !== aheadGen) return;
          for (let i = 0; i < batch.length; i++) { const tr = out[i]?.trim(); if (!tr) continue; const c = await cache(batch[i].bookId); c[batch[i].key] = tr; scheduleSave(batch[i].bookId); }
          finished += batch.length;
        } catch (err) { failed++; console.warn('[kurokawa] translate-ahead failed', err); if (failed === 1) toast(String((err as Error).message ?? err), 'error', 5000); if (failed > 3) { batches.length = 0; } }
        paintAhead();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (gen !== aheadGen) return;
    status.textContent = failed ? t('translateAheadPartial', { n: finished, total }) : t('translateAheadDone', { n: finished });
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
    const cancel = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => { aheadGen++; busy = false; cancel.hidden = true; status.textContent = t('cancelled'); } }, icon('close'), t('cancel'));
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

  function aheadSheet() {
    const sh = openSheet(t('translateAhead'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    const c = aheadControls(); c.querySelector('h4')?.remove();
    sh.body.append(c);
  }

  function htmlToText(html: string): string { const d = document.createElement('div'); d.innerHTML = html; return (d.innerText ?? d.textContent ?? '').trim(); }

  /* ---------- pill ---------- */
  let status: HTMLElement, toggleBtn: HTMLButtonElement;
  function paint() {
    if (!pill) return;
    toggleBtn.setAttribute('aria-pressed', String(on));
    toggleBtn.classList.toggle('on', on);
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
      h('button', { type: 'button', title: t('retranslate'), 'aria-label': t('retranslate'), onclick: () => { if (!on) setOn(true); else void run(true); } }, icon('rotate')),
      h('button', { type: 'button', title: t('clearTranslationCache'), 'aria-label': t('clearTranslationCache'), onclick: async () => { for (const { bookId } of host.blocks()) { caches.set(bookId, {}); await db.setMeta(`tr:${bookId}`, {}); } restoreAll(); if (on) void run(); toast(t('done')); } }, icon('trash')),
      h('button', { type: 'button', title: t('translateAhead'), 'aria-label': t('translateAhead'), onclick: () => aheadSheet() }, icon('books')),
      h('button', { type: 'button', title: t('customize'), 'aria-label': t('customize'), onclick: () => settingsSheet() }, icon('settings')),
      h('button', { type: 'button', title: t('close'), 'aria-label': t('close'), onclick: () => { setOn(false); pill?.remove(); pill = null; } }, icon('close')),
    );
    host.root.appendChild(pill);
    paint();
  }

  host.onChapterChange(() => { if (on) void run(); });

  return {
    toggleUi() { if (pill) { setOn(false); pill.remove(); pill = null; return; } buildPill(); if (aiReady()) setOn(true); else settingsSheet(); },
    dispose() { generation++; pill?.remove(); pill = null; window.clearTimeout(saveTimer); for (const id of dirty) void db.setMeta(`tr:${id}`, caches.get(id) ?? {}); },
  };

  function settingsSheet() { aiSettingsSheet(() => { if (pill && aiReady()) { if (!on) setOn(true); else void run(true); } }, aheadControls()); }
}
