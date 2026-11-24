// The entry of a glossary name, as a small card beside the name in the text (a tap or a click on it; or «In the glossary»
// in a selection's menu): the original and its rendering in the language in use, what it names, its other renderings
// and the ones kept for other languages, the note, the folder it comes from; Edit (the glossary tab, the row focused),
// Copy and — for a Japanese or Chinese original, when the offline dictionary is there — Dictionary.
// One card at a time. It closes on a tap outside, Esc, a scroll (a page turn) and a resize.
import { h, icon, iconButton, toast } from './dom';
import { t } from '../i18n';
import { getSettings } from '../settings';
import { folders, termLang, type Term } from '../glossary';
import type { NameEntry } from '../glossmatch';
import { mainTerm, sameName } from './glossentry';
import { kindIcon, kindLabel, langLabel } from './glossarysheet';
import { copyText } from './share';

export interface CardOpts {
  /** Where the name stands on the screen (its line boxes): the card goes beside it, never over it. */
  rects: DOMRect[];
  bookId: string; title: string; language?: string;
  /** Called once the card is gone, however it went. */
  onClose?: () => void;
}
const iso = (x: string): string => `⁨${x}⁩`;
let open: { el: HTMLElement; close: () => void } | null = null;
export const glossCardOpen = (): boolean => !!open?.el.isConnected;
export function closeGlossCard(): void { open?.close(); }

/** Where a term comes from: its folder's name, its book's title, or «Every book». */
export function placeOf(x: Term, title: string): string {
  if (x.folder) return folders().find((f) => f.id === x.folder)?.name ?? title;
  return x.book ? title : t('glossEveryBook');
}

export function openGlossCard(entry: NameEntry, o: CardOpts): void {
  closeGlossCard();
  const all = sameName(entry, o.bookId); const main = mainTerm(all);
  const mainLang = termLang(main);
  const others = all.filter((x) => x !== main && termLang(x) !== mainLang);
  const alts = [...new Set([...(main.alts ?? []), ...all.filter((x) => x !== main && termLang(x) === mainLang).flatMap((x) => [x.to, ...(x.alts ?? [])])])].filter((a) => a && a !== main.to);
  const row = (label: string, ...kids: (string | Node)[]): HTMLElement => h('div', { class: 'gc-row' }, h('span', { class: 'gc-label' }, label), h('span', { class: 'gc-val', dir: 'auto' }, ...kids));
  const close = (): void => { off(); el.remove(); if (open?.el === el) open = null; o.onClose?.(); };
  const edit = h('button', { type: 'button', class: 'btn tonal gc-edit', onclick: () => { close(); void import('./aisheet').then((m) => m.aiSheet({ tab: 'glossary', book: { id: o.bookId, title: o.title }, focusTerm: main.id })); } }, icon('pen'), t('edit'));
  const copy = h('button', { type: 'button', class: 'btn tonal gc-copy', onclick: () => { void copyText(`${main.from} = ${main.to}`).then(() => toast(t('copied'))); } }, icon('copy'), t('glossCardCopy'));
  const dict = h('button', { type: 'button', class: 'btn tonal gc-dict', hidden: true }, icon('define'), t('glossCardDict')) as HTMLButtonElement;
  const el = h('div', { class: 'gloss-card', role: 'dialog', 'aria-label': t('glossCardLabel'), tabindex: '-1', dataset: { id: main.id } },
    h('div', { class: 'gc-head' }, h('span', { class: 'gc-kind' }, icon(kindIcon(main.kind ?? 'term')), h('span', { dir: 'auto' }, kindLabel(main.kind ?? 'term'))),
      iconButton('close', t('close'), () => close())),
    h('div', { class: 'gc-names' }, h('bdi', { class: 'gc-from', lang: o.language || undefined }, main.from), h('span', { class: 'gc-arrow', 'aria-hidden': 'true' }, icon('chevronRight')), h('bdi', { class: 'gc-to', lang: mainLang || undefined }, main.to)),
    ...(alts.length ? [row(t('glossAlts'), alts.map((a) => iso(a)).join(document.documentElement.lang === 'ar' ? '، ' : ', '))] : []),
    ...(others.length ? [row(t('glossCardOther'), ...others.flatMap((x, i) => [i ? h('br') : '', h('span', { class: 'gc-lang' }, `${termLang(x) ? langLabel(termLang(x)) : t('glossLangUnset')}: `), h('bdi', null, x.to)]))] : []),
    ...(main.note ? [h('p', { class: 'gc-note', dir: 'auto' }, main.note)] : []),
    h('div', { class: 'gc-folder' }, icon('folder'), h('span', { dir: 'auto' }, t('glossCardFrom', { x: iso(placeOf(main, o.title)) }))),
    h('div', { class: 'gc-actions' }, edit, copy, dict));
  document.body.append(el);
  // (Dictionary: only for a Japanese or Chinese original, and when the offline dictionary is on the device.)
  const kind: 'ja' | 'zh' | null = /[぀-ヿ]/.test(main.from) ? 'ja' : /[㐀-鿿]/.test(main.from) ? (/^ja/i.test(o.language ?? '') ? 'ja' : 'zh') : null;
  if (kind) void import('../readingdict').then(async (m) => { let s = m.getDictState(kind); if (s.phase === 'unknown') s = await m.refreshDictState(kind); if (s.phase === 'ready' && el.isConnected) { dict.hidden = false; dict.onclick = () => { close(); void import('./lookup').then((l) => l.showReadings(main.from, o.language)); }; } }).catch(() => undefined);
  place(el, o.rects);
  const outside = (e: Event): void => { if (!el.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const away = (e: Event): void => { if (!el.contains(e.target as Node)) close(); };
  const resize = (): void => close();
  document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', key, true); window.addEventListener('scroll', away, true); window.addEventListener('resize', resize);
  const off = (): void => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', resize); };
  open = { el, close };
  // (Focus on the card, so Tab reaches its buttons; the page does not scroll for it.)
  try { el.focus({ preventScroll: true }); } catch { /* old engines */ }
}

/** The card beside the name: under it, or over it when there is no room under; across, centred on it and kept on the screen. */
function place(el: HTMLElement, rects: DOMRect[]): void {
  const vw = innerWidth, vh = innerHeight, pad = 8, gap = 8;
  const r = rects.length ? { left: Math.min(...rects.map((x) => x.left)), right: Math.max(...rects.map((x) => x.right)), top: Math.min(...rects.map((x) => x.top)), bottom: Math.max(...rects.map((x) => x.bottom)) } : { left: vw / 2, right: vw / 2, top: vh / 2, bottom: vh / 2 };
  el.style.maxWidth = `${Math.min(380, vw - pad * 2)}px`; el.style.left = '0px'; el.style.top = '0px'; el.style.maxHeight = '';
  const w = el.offsetWidth; let hh = el.offsetHeight;
  const below = vh - r.bottom - gap - pad, above = r.top - gap - pad;
  const under = hh <= below || (hh > above && below >= above);
  const room = under ? below : above;
  if (hh > room) { el.style.maxHeight = `${Math.max(120, room)}px`; hh = el.offsetHeight; }
  const top = under ? r.bottom + gap : r.top - gap - hh;
  const x = Math.max(pad, Math.min(vw - w - pad, (r.left + r.right) / 2 - w / 2));
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(Math.max(pad, top))}px`;
}
