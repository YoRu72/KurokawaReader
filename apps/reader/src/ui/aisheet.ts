// The AI sheet: one sheet, tabs on top — «Translation» (the service, its model, the language and instructions),
// «Glossary» (the open book's glossary as a folder of files), «Names found» (the names the model proposes, each
// accepted, changed or rejected) and «Saved translations» (what is kept for this book). Every way in lands on its
// tab of this same sheet; the tabs switch without closing it, each keeping its state and its scroll.
import { h, icon, openSheet } from './dom';
import { t, localDigits } from '../i18n';
import type { Found } from '../ai';

export type AiTab = 'translation' | 'glossary' | 'names' | 'saved';
export const AI_TABS: AiTab[] = ['translation', 'glossary', 'names', 'saved'];

/** What the open book's translator lends the sheet (src/ui/translator.ts): its book, the names found, the whole
 *  book read for names, the translations kept. Absent when no book is being translated. */
export interface AiHooks {
  bookId: string;
  title(): string;
  findNames(): Promise<Found[] & { refused: number }>;
  scan(folder?: string): void;
  cacheCount(): Promise<number>;
  clearCache(): void;
  isKept(): Promise<boolean>;
  setKept(v: boolean): void;
  options(): HTMLElement;
  /** Names accepted: the chapter translated again with them. */
  added(): void;
}
let hooks: AiHooks | null = null;
export const setAiHooks = (x: AiHooks | null): void => { hooks = x; };
export const aiHooks = (): AiHooks | null => hooks;

// (The tab last open, for this session.)
let lastTab: AiTab = 'translation';
interface Open { el: HTMLElement; show(tab: AiTab): void; addFrom(text: string): void; bookId?: string }
let current: Open | null = null;

export interface AiSheetOpts { tab?: AiTab; book?: { id: string; title: string }; addFrom?: string; onDone?: () => void; extra?: HTMLElement }

/** Opens the sheet on a tab (or brings the open one there). */
export function aiSheet(o: AiSheetOpts = {}): void {
  const book = o.book ?? (hooks ? { id: hooks.bookId, title: hooks.title() } : undefined);
  if (current && current.el.isConnected && current.bookId === book?.id && !o.extra) { current.show(o.tab ?? lastTab); if (o.addFrom) current.addFrom(o.addFrom); return; }
  const sh = openSheet(t('aiTranslate'), t('close'), { onClose: () => { if (current?.el === sh.el) current = null; offSwipe(); } });
  sh.el.classList.add('ai-sheet', 'gloss-sheet');
  sh.body.style.fontFamily = 'var(--font-ui)';
  const rtl = () => document.documentElement.dir === 'rtl';
  const names: Record<AiTab, string> = { translation: t('aiTabTranslation'), glossary: t('aiTabGlossary'), names: t('aiTabNames'), saved: t('aiTabSaved') };
  const ICONS: Record<AiTab, string> = { translation: 'translate', glossary: 'define', names: 'user', saved: 'download' };
  const uid = Math.random().toString(36).slice(2, 7);
  const tabs = new Map<AiTab, HTMLButtonElement>(); const panels = new Map<AiTab, HTMLElement>(); const scrolls = new Map<AiTab, number>();
  const acts = new Map<AiTab, HTMLElement[]>(); const built = new Set<AiTab>();
  const row = h('div', { class: 'ai-tabs', role: 'tablist', 'aria-label': t('aiTranslate') });
  for (const k of AI_TABS) {
    const b = h('button', { type: 'button', role: 'tab', id: `ai-tab-${k}-${uid}`, class: 'ai-tab', 'aria-controls': `ai-panel-${k}-${uid}`, 'aria-selected': 'false', tabindex: '-1', dataset: { tab: k }, onclick: () => show(k) }, icon(ICONS[k]), h('span', null, names[k])) as HTMLButtonElement;
    tabs.set(k, b); row.append(b);
    const p = h('div', { class: 'ai-panel', role: 'tabpanel', id: `ai-panel-${k}-${uid}`, 'aria-labelledby': b.id, dataset: { tab: k }, hidden: true }); panels.set(k, p); sh.body.append(p);
  }
  // (Arrow keys move along the tabs — in the reading direction —, Home and End to the ends.)
  row.addEventListener('keydown', (e) => {
    const i = AI_TABS.indexOf(cur); let j = -1;
    if (e.key === 'ArrowRight') j = rtl() ? i - 1 : i + 1; else if (e.key === 'ArrowLeft') j = rtl() ? i + 1 : i - 1; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = AI_TABS.length - 1;
    if (j < 0 && e.key !== 'Home') return; e.preventDefault(); const k = AI_TABS[(j + AI_TABS.length) % AI_TABS.length]; show(k); tabs.get(k)!.focus();
  });
  // The tab row stays above the panels (it does not scroll with them); «Done» and the close button stay where they are.
  sh.el.insertBefore(row, sh.body);
  const tabActs = h('div', { class: 'ai-tab-acts' });
  const done = h('button', { class: 'btn small primary ai-done', type: 'button', onclick: () => { sh.close(); o.onDone?.(); } }, icon('check'), t('done'));
  sh.actions.append(tabActs, done);

  let glossary: { addFrom(text: string): void; refresh(): void } | null = null;
  function build(k: AiTab): void {
    if (built.has(k)) return; built.add(k); const p = panels.get(k)!;
    if (k === 'translation') {
      void import('./aisettings').then((m) => { p.append(m.translationPanel(o.extra ?? hooks?.options(), () => show('glossary'))); });
    } else if (k === 'glossary') {
      void import('./glossarysheet').then((m) => {
        const g = m.glossaryPanel(book, { scan: hooks && book && hooks.bookId === book.id ? (f) => { sh.close(); hooks!.scan(f); } : undefined, toNames: () => show('names') });
        glossary = g; p.append(g.el); acts.set('glossary', g.actions); if (cur === 'glossary') paintActs();
        if (pendingAdd) { g.addFrom(pendingAdd); pendingAdd = ''; }
      });
    } else if (k === 'names') {
      void import('./namespanel').then((m) => { const n = m.namesPanel(book, () => { glossary?.refresh(); }); p.append(n.el); acts.set('names', n.actions); if (cur === 'names') paintActs(); });
    } else savedPanel(p);
  }
  function paintActs(): void { tabActs.replaceChildren(...(acts.get(cur) ?? [])); sh.actions.classList.toggle('one', !(acts.get(cur) ?? []).length); }
  let cur: AiTab = o.tab ?? lastTab; let pendingAdd = o.addFrom ?? '';
  function show(k: AiTab): void {
    if (panels.get(cur) && !panels.get(cur)!.hidden) scrolls.set(cur, sh.body.scrollTop);
    cur = k; lastTab = k; build(k);
    for (const [x, b] of tabs) { const on = x === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle('on', on); panels.get(x)!.hidden = !on; }
    sh.body.scrollTop = scrolls.get(k) ?? 0;
    tabs.get(k)!.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    paintActs();
    if (k === 'glossary') glossary?.refresh();
  }
  // Swiped aside on a touch screen: the next tab or the one before (in the reading direction). Not from a field, a
  // row of chips or anything else that scrolls sideways.
  let sx = 0, sy = 0, st = 0, track = false;
  const down = (e: PointerEvent) => { if (e.pointerType !== 'touch') return; const tg = e.target as HTMLElement; track = !tg.closest('input, textarea, select, .chip-row, .ai-tabs, .gloss-langs, [contenteditable]'); sx = e.clientX; sy = e.clientY; st = Date.now(); };
  const up = (e: PointerEvent) => {
    if (!track || e.pointerType !== 'touch') return; track = false;
    const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2 || Date.now() - st > 700) return;
    const i = AI_TABS.indexOf(cur); const next = (dx < 0) !== rtl() ? i + 1 : i - 1; if (next >= 0 && next < AI_TABS.length) show(AI_TABS[next]);
  };
  sh.body.addEventListener('pointerdown', down); sh.body.addEventListener('pointerup', up);
  const offSwipe = () => { sh.body.removeEventListener('pointerdown', down); sh.body.removeEventListener('pointerup', up); };
  current = { el: sh.el, bookId: book?.id, show, addFrom: (text) => { if (glossary) glossary.addFrom(text); else pendingAdd = text; show('glossary'); } };
  show(cur);

  /* ---------- «Saved translations»: this book's, kept with it or not, cleared with Undo ---------- */
  function savedPanel(p: HTMLElement): void {
    const hk = hooks && book && hooks.bookId === book.id ? hooks : null;
    if (!hk) { p.append(h('p', { class: 'src ai-empty' }, t('aiOpenBook'))); return; }
    const count = h('p', { class: 'ai-saved-count' }, '…');
    const paint = () => void hk.cacheCount().then((n) => { count.textContent = t('trSavedCount', { n: localDigits(n) }); });
    const cb = h('input', { type: 'checkbox', onchange: () => hk.setKept(cb.checked) }) as HTMLInputElement;
    void hk.isKept().then((v) => { cb.checked = v; });
    p.append(h('div', { class: 'ai-saved' }, icon('download'), count),
      h('label', { class: 'row tr-opt gloss-auto' }, h('span', { class: 'label' }, t('trKeepBook'), h('small', { class: 'hint' }, t('trKeepBookHint'))), h('span', { class: 'switch' }, cb, h('i'))),
      h('button', { type: 'button', class: 'btn tonal small ai-clear', onclick: () => { hk.clearCache(); setTimeout(paint, 600); } }, icon('trash'), t('clearTranslationCache')));
    paint();
  }
}
/** The open sheet's tab (tests, and a button inside one tab that leads to another). */
export const aiSheetTab = (): AiTab | null => (current?.el.isConnected ? lastTab : null);
