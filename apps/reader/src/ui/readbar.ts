// The reading bar (the status line, Moon+'s): a thin line at the foot of the page with what the reader chose to see
// there — the chapter, the page in it, pages and time left, the percentages, the clock, the battery, the book's title —
// each at the start, the centre or the end of the line, in the order chosen (src/ui/placeditems.ts). Shown or hidden
// as set (off by default), and kept or hidden with the rest of the chrome in immersive reading, as set.
//
// The bar only writes what it is given: the reader works the numbers out (views/reader.ts, from sizes it already
// knows), and the bar puts each one in its place, touching the page only where a text changed.
import { h } from './dom';
import { t, localDigits, formatPercent, formatClock, countPages, countMinutes } from '../i18n';
import type { Strings } from '../i18n/en';
import { getSettings, onSettingsChange, DEFAULT_STATUS_ITEMS, type VisualSettings } from '../settings';
import { normalizePlaced, placedGroups, type PlacedItem } from './placeditems';

export type BarItem = 'chapter' | 'title' | 'page' | 'chapterLeft' | 'chapterPct' | 'bookPage' | 'bookLeft' | 'bookPct' | 'timeChapter' | 'timeBook' | 'clock' | 'battery';
/** Each item's name in the editor. */
export const BAR_ITEM_LABEL: Record<BarItem, keyof Strings> = {
  chapter: 'barItemChapter', title: 'barItemTitle', page: 'barItemPage', chapterLeft: 'barItemChapterLeft', chapterPct: 'barItemChapterPct',
  bookPage: 'barItemBookPage', bookLeft: 'barItemBookLeft', bookPct: 'barItemBookPct', timeChapter: 'barItemTimeChapter', timeBook: 'barItemTimeBook',
  clock: 'barItemClock', battery: 'barItemBattery',
};

/** What the reader knows now. A number left out is not known (yet): its item shows nothing. */
export interface BarValues {
  chapter?: string; title?: string;
  /** The page (one screen of text) in the chapter, and the chapter's pages. */
  page?: number; pages?: number;
  /** The page in the book and the book's pages; `bookApprox` when they are reckoned from the text's length (a flowing
   *  book's other chapters are not laid out), not counted. */
  bookPage?: number; bookPages?: number; bookApprox?: boolean;
  bookPct?: number; chapterPct?: number;
  /** Minutes left, at the reader's own pace. */
  minsChapter?: number; minsBook?: number;
}

/** The bar's numbers are read with the text, as words are: in the Arabic interface they take the digits of its prose
 *  (١٢٣ by default; 123 when Western digits are chosen throughout — Settings → digits), as the Performance page's do. */
const CTX = 'prose' as const;
const num = (n: number): string => localDigits(n, CTX);
const minutes = (m: number): string => (m < 60 ? countMinutes(m) : t('hoursMinutes', { h: Math.floor(m / 60), m: m % 60 }));

/** The items as set, made whole (one added in a later version comes in off). */
export function barItems(s: VisualSettings = getSettings()): PlacedItem[] { return normalizePlaced(s.statusItems, DEFAULT_STATUS_ITEMS); }

/** The text of one item from the values (empty: nothing to show). */
export function barText(id: BarItem, v: BarValues, now: Date = new Date(), battery: number | null = null): string {
  switch (id) {
    case 'chapter': return v.chapter ?? '';
    case 'title': return v.title ?? '';
    case 'page': return v.page && v.pages ? `${num(v.page)} / ${num(v.pages)}` : '';
    case 'chapterLeft': { if (!v.page || !v.pages) return ''; const n = v.pages - v.page; return n > 0 ? t('barChapterLeft', { n: countPages(n) }) : t('barChapterLast'); }
    case 'chapterPct': return v.chapterPct === undefined ? '' : t('barChapterPct', { p: formatPercent(v.chapterPct, CTX) });
    case 'bookPage': return v.bookPage && v.bookPages ? `${v.bookApprox ? '≈' : ''}${num(v.bookPage)} / ${num(v.bookPages)}` : '';
    case 'bookLeft': { if (!v.bookPage || !v.bookPages) return ''; const n = v.bookPages - v.bookPage; return n > 0 ? t('barBookLeft', { n: (v.bookApprox ? '≈' : '') + countPages(n) }) : t('barBookLast'); }
    case 'bookPct': return v.bookPct === undefined ? '' : formatPercent(v.bookPct, CTX);
    case 'timeChapter': return v.minsChapter ? t('barTimeChapter', { t: minutes(v.minsChapter) }) : '';
    case 'timeBook': return v.minsBook ? t('barTimeBook', { t: minutes(v.minsBook) }) : '';
    case 'clock': return formatClock(now, CTX);
    case 'battery': return battery === null ? '' : formatPercent(battery, CTX);
  }
}

export interface ReadBar {
  el: HTMLElement;
  /** New values (only what changed is written). */
  set(v: BarValues): void;
  /** Whether an item is on the bar now (shown, and switched on) — so what no one sees is not worked out. */
  wants(id: BarItem): boolean;
}

/** The bar, and its classes on the reader's view: `rb-on` while it is shown, `rb-imm` while it stays in immersive
 *  reading (the styles keep the text above it — reader.css). */
export function createReadBar(view: HTMLElement, onDispose: (fn: () => void) => void): ReadBar {
  const groups = { start: h('div', { class: 'rb-start' }), center: h('div', { class: 'rb-center' }), end: h('div', { class: 'rb-end' }) };
  const el = h('div', { class: 'read-status', 'aria-label': t('readingBar') }, groups.start, groups.center, groups.end);
  let spans = new Map<BarItem, HTMLElement>();
  let values: BarValues = {}; let battery: number | null = null; let shown = false;
  const paint = (id: BarItem) => {
    const sp = spans.get(id); if (!sp) return;
    const text = barText(id, values, new Date(), battery);
    if (sp.textContent !== text) sp.textContent = text;
    const empty = !text; if (sp.hidden !== empty) sp.hidden = empty;
  };
  const build = (s: VisualSettings) => {
    shown = s.showStatusLine;
    el.hidden = !shown;
    view.classList.toggle('rb-on', shown);
    view.classList.toggle('rb-imm', s.statusImmersive);
    const g = placedGroups(barItems(s));
    const key = JSON.stringify(g);
    if (el.dataset.layout !== key) {
      el.dataset.layout = key;
      spans = new Map();
      for (const place of ['start', 'center', 'end'] as const) groups[place].replaceChildren(...g[place].map((id) => {
        const sp = h('span', { class: `rb-item rb-${id}`, dataset: { item: id }, dir: id === 'chapter' || id === 'title' ? 'auto' : null, title: t(BAR_ITEM_LABEL[id as BarItem]) });
        spans.set(id as BarItem, sp); return sp;
      }));
      el.dataset.centre = String(g.center.length > 0);
    }
    if (shown) spans.forEach((_, id) => paint(id));
  };
  build(getSettings());
  onDispose(onSettingsChange(build));
  // The clock, each quarter-minute; the battery, when it changes (where the device tells it — not every WebView does).
  const tick = window.setInterval(() => { if (shown) paint('clock'); }, 15000); onDispose(() => window.clearInterval(tick));
  (navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener(t: string, f: () => void): void }> }).getBattery?.()
    .then((b) => { const on = () => { battery = Math.round(b.level * 100); paint('battery'); }; on(); b.addEventListener('levelchange', on); }).catch(() => undefined);
  return {
    el,
    set(v) { values = v; if (shown) spans.forEach((_, id) => { if (id !== 'clock' && id !== 'battery') paint(id); }); },
    wants: (id) => shown && spans.has(id),
  };
}
