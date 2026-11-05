// The «Discover» pages' building blocks (Anime and TV): a hero carousel of wide pictures that turns by itself, rails
// that scroll sideways under a heading (with arrows on a computer), poster cards with a badge at the top — a rank, «new
// episode» — and a line of facts at the bottom, picture tiles with a big label (genres, seasons, decades, studios), and
// «continue watching» cards with their bar. Each rail is drawn at once with grey placeholders and filled when its
// data comes, so the page never waits on its slowest row.
import { h, icon } from './dom';
import { t } from '../i18n';

export interface HeroItem { image?: string; logo?: string; title: string; facts: string[]; chips?: string[]; text?: string; color?: string; onClick: () => void; action?: { label: string; icon: string; run: () => void } }
export interface PosterItem { image?: string; title: string; sub?: string; badge?: string; badgeKind?: 'rank' | 'new' | 'live' | 'soon' | 'plain'; overlay?: string; color?: string; onClick: () => void }
export interface TileItem { image?: string; label: string; sub?: string; color?: string; onClick: () => void }
export interface ContinueItem { image?: string; title: string; line?: string; chip?: string; progress?: number; onClick: () => void }

const img = (src: string | undefined, cls = '') => (src ? h('img', { class: cls, src, alt: '', loading: 'lazy', decoding: 'async', onerror: (e: Event) => { (e.target as HTMLElement).remove(); } }) : null);
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion'); } catch { return false; } };

/** The hero: wide pictures, one at a time, turned by a swipe, the dots, or by itself every seven seconds. */
export function hero(items: HeroItem[]): HTMLElement {
  const track = h('div', { class: 'dc-hero-track' });
  const dots = h('div', { class: 'dc-hero-dots' });
  const el = h('section', { class: 'dc-hero', 'aria-roledescription': 'carousel' }, track, dots);
  if (!items.length) { el.classList.add('skeleton'); return el; }
  items.forEach((it, i) => {
    track.append(h('div', { class: 'dc-hero-slide', role: 'group', 'aria-label': it.title, style: it.color ? { '--dc-tint': it.color } : undefined, onclick: it.onClick },
      img(it.image, 'dc-hero-img'), h('div', { class: 'dc-hero-shade' }),
      h('div', { class: 'dc-hero-text' },
        it.logo ? h('img', { class: 'dc-hero-logo', src: it.logo, alt: it.title, onerror: (e: Event) => { (e.target as HTMLElement).replaceWith(h('h2', { class: 'dc-hero-title', dir: 'auto' }, it.title)); } }) : h('h2', { class: 'dc-hero-title', dir: 'auto' }, it.title),
        it.facts.length ? h('p', { class: 'dc-hero-facts' }, ...it.facts.flatMap((f, k) => (k ? [h('span', { class: 'dot' }, '•'), h('span', { dir: 'auto' }, f)] : [h('span', { dir: 'auto' }, f)]))) : null,
        it.chips?.length ? h('p', { class: 'dc-hero-chips' }, ...it.chips.map((c) => h('span', { class: 'dc-chip' }, c))) : null,
        it.text ? h('p', { class: 'dc-hero-desc', dir: 'auto' }, it.text) : null,
        it.action ? h('button', { type: 'button', class: 'btn primary small dc-hero-btn', onclick: (e: Event) => { e.stopPropagation(); it.action!.run(); } }, icon(it.action.icon), it.action.label) : null)));
    dots.append(h('button', { type: 'button', class: 'dc-dot' + (i === 0 ? ' on' : ''), 'aria-label': `${i + 1} / ${items.length}`, onclick: () => go(i) }));
  });
  let at = 0; let touched = 0;
  const rtl = () => getComputedStyle(el).direction === 'rtl';
  const go = (i: number, smooth = true) => { at = (i + items.length) % items.length; track.scrollTo({ left: (rtl() ? -1 : 1) * at * track.clientWidth, behavior: smooth && !reduced() ? 'smooth' : 'auto' }); mark(); };
  const mark = () => [...dots.children].forEach((d, k) => d.classList.toggle('on', k === at));
  track.addEventListener('scroll', () => { const w = track.clientWidth || 1; const i = Math.round(Math.abs(track.scrollLeft) / w); if (i !== at) { at = i; mark(); } }, { passive: true });
  track.addEventListener('pointerdown', () => { touched = Date.now(); }, { passive: true });
  // (Turning by itself — not while a finger was on it a moment ago, nor when motion is to be reduced, nor once the page is gone.)
  const timer = window.setInterval(() => { if (!el.isConnected) { window.clearInterval(timer); return; } if (reduced() || Date.now() - touched < 12000 || document.hidden) return; go(at + 1); }, 7000);
  return el;
}

/** A rail: a heading (an icon, a title, «see all»), then the row itself, scrolling sideways. Returns the rail and a
 *  `fill` that puts the cards in (an empty list hides the rail). */
export function rail(title: string, ic?: string, opts: { seeAll?: () => void; kind?: 'poster' | 'tile' | 'wide' | 'square' | 'cont'; count?: number } = {}): { el: HTMLElement; fill: (cards: HTMLElement[]) => void; fail: (msg: string) => void } {
  const kind = opts.kind ?? 'poster';
  const row = h('div', { class: `dc-row dc-k-${kind}` }, ...Array.from({ length: opts.count ?? 8 }, () => h('div', { class: 'dc-ph' })));
  const scrollBy = (dir: number) => { const rtl = getComputedStyle(row).direction === 'rtl'; row.scrollBy({ left: (rtl ? -dir : dir) * row.clientWidth * 0.85, behavior: reduced() ? 'auto' : 'smooth' }); };
  const head = h('div', { class: 'dc-head' }, ic ? h('span', { class: 'dc-head-ic' }, icon(ic)) : null, h('h3', { class: 'dc-title' }, title), h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'icon-btn dc-arrow pc-only', 'aria-label': t('previous'), onclick: () => scrollBy(-1) }, icon('chevronLeft')),
    h('button', { type: 'button', class: 'icon-btn dc-arrow pc-only', 'aria-label': t('next'), onclick: () => scrollBy(1) }, icon('chevronRight')),
    opts.seeAll ? h('button', { type: 'button', class: 'btn text small dc-all', onclick: opts.seeAll }, t('seeAll')) : null);
  const el = h('section', { class: 'dc-rail' }, head, row);
  return { el, fill: (cards) => { if (!cards.length) { el.hidden = true; return; } el.hidden = false; row.replaceChildren(...cards); }, fail: (msg) => { row.replaceChildren(h('p', { class: 'empty small dc-fail' }, msg)); } };
}

/** A poster: the picture, a badge at its top, a dim line of facts over its foot, the title and a line under it. */
export function poster(p: PosterItem): HTMLElement {
  return h('button', { type: 'button', class: 'dc-poster', style: p.color ? { '--cover-color': p.color } : undefined, onclick: p.onClick },
    h('span', { class: 'dc-poster-pic' }, img(p.image) ?? icon('film'), p.badge ? h('span', { class: `dc-badge k-${p.badgeKind ?? 'plain'}` }, p.badge) : null, p.overlay ? h('span', { class: 'dc-overlay' }, p.overlay) : null),
    h('span', { class: 'dc-poster-title', dir: 'auto' }, p.title), p.sub ? h('span', { class: 'dc-poster-sub' }, p.sub) : null);
}
/** A picture tile with a big label (genres, seasons, decades) — `square` for the studios. */
export function tile(x: TileItem, square = false): HTMLElement {
  return h('button', { type: 'button', class: 'dc-tile' + (square ? ' square' : ''), style: x.color ? { '--dc-tint': x.color } : undefined, onclick: x.onClick },
    img(x.image, 'dc-tile-img'), h('span', { class: 'dc-tile-shade' }), h('span', { class: 'dc-tile-text' }, h('b', { class: 'dc-tile-label', dir: 'auto' }, x.label), x.sub ? h('small', { dir: 'auto' }, x.sub) : null));
}
/** A wide «continue watching» card: the picture, a chip at its corner, the episode, the title, its bar. */
export function continueCard(c: ContinueItem): HTMLElement {
  return h('button', { type: 'button', class: 'dc-cont', onclick: c.onClick },
    img(c.image, 'dc-cont-img'), h('span', { class: 'dc-tile-shade' }), c.chip ? h('span', { class: 'dc-badge k-plain dc-cont-chip' }, c.chip) : null,
    h('span', { class: 'dc-cont-text' }, c.line ? h('small', { dir: 'auto' }, c.line) : null, h('b', { dir: 'auto' }, c.title)),
    c.progress !== undefined ? h('span', { class: 'dc-cont-bar' }, h('i', { style: { width: `${Math.max(2, Math.min(100, Math.round(c.progress * 100)))}%` } })) : null);
}
/** A colour from a name, the same each time (a tile with no picture yet). */
export function hueOf(s: string): string { let n = 0; for (const ch of s) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${n % 360} 45% 32%)`; }
