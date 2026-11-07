// A post's photos and videos read in the Add sheet itself, as soon as its link is there («auto-grab»): an X post,
// Bluesky, Reddit, a Telegram message — read by the app's own reader, at full quality —, or a gallery the computer's
// gallery-dl knows. Each with its picture, its kind and a tick, all ticked at first; «Download» adds the ones ticked.
// A post with nothing to list leaves the sheet as it was (the Video add-on's panel, «Show them»).
import { h, icon } from '../ui/dom';
import { t, localDigits } from '../i18n';

export interface PostPick { href: string; text?: string; name?: string; viaVideo?: boolean }
interface Item extends PostPick { thumb?: string; kind: 'image' | 'video' | 'gif' }

export interface PostPanel {
  el: HTMLElement;
  /** Reads the link's post (a later link replaces an earlier one); true when it had something to list. */
  read(u: string | null): Promise<boolean>;
  /** The ticked ones, or null when there is no post here. */
  picks(): PostPick[] | null;
}

export function postPanel(onChange: () => void): PostPanel {
  const el = h('div', { class: 'post-panel', hidden: true });
  let items: Item[] = []; const on = new Set<number>(); let token = 0; let shown = false;
  const count = h('span', { class: 'post-count' });
  const all = h('button', { type: 'button', class: 'btn text small', onclick: () => { if (on.size === items.length) on.clear(); else items.forEach((_, i) => on.add(i)); paint(); } }) as HTMLButtonElement;
  const grid = h('div', { class: 'post-grid' });
  const paint = () => {
    count.textContent = t('postPicked', { n: localDigits(on.size), total: localDigits(items.length) });
    all.textContent = on.size === items.length ? t('postSelectNone') : t('postSelectAll'); all.hidden = items.length < 2;
    grid.querySelectorAll<HTMLElement>('.post-tile').forEach((x, i) => { x.classList.toggle('on', on.has(i)); x.setAttribute('aria-pressed', String(on.has(i))); });
    onChange();
  };
  const tile = (x: Item, i: number) => h('button', { type: 'button', class: 'post-tile', title: x.text || x.name || '', onclick: () => { if (on.has(i)) on.delete(i); else on.add(i); paint(); } },
    x.thumb || x.kind === 'image' ? h('img', { src: x.thumb || x.href, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: Event) => { (e.target as HTMLElement).replaceWith(icon(x.kind === 'image' ? 'image' : 'film')); } }) : icon('film'),
    x.kind !== 'image' ? h('span', { class: 'post-kind' }, icon(x.kind === 'gif' ? 'images' : 'play'), x.kind === 'gif' ? 'GIF' : t('videoKind')) : null,
    h('span', { class: 'post-tick' }, icon('check')));
  const show = (title: string, list: Item[]) => {
    items = list; on.clear(); list.forEach((_, i) => on.add(i)); shown = list.length > 0;
    el.hidden = !shown; if (!shown) { el.replaceChildren(); onChange(); return; }
    grid.replaceChildren(...list.map(tile));
    el.replaceChildren(h('div', { class: 'post-head' }, icon('images'), h('div', { class: 'grow' }, h('b', null, t('postFromThis')), title ? h('small', { dir: 'auto' }, title) : null), all), grid, h('p', { class: 'post-foot hint' }, count));
    paint();
  };
  const read = async (u: string | null): Promise<boolean> => {
    const my = ++token; items = []; on.clear(); shown = false; el.hidden = true; el.replaceChildren(); onChange();
    if (!u) return false;
    const S = await import('../downloads/social'); const G = await import('../downloads/galleries');
    const social = !!S.socialOf(u); const gal = !social && G.galleryOf(u);
    if (!social && !gal) return false;
    el.hidden = false; el.replaceChildren(h('div', { class: 'post-head loading' }, h('span', { class: 'spinner small' }), h('span', null, t('grabSocial'))));
    try {
      let title = ''; let list: Item[] = [];
      if (social) { const p = await S.socialPost(u); if (p) { title = [p.author, p.title].filter(Boolean).join(' · '); list = p.items.map((x) => ({ href: x.href, text: x.text, name: x.name, thumb: x.thumb, kind: x.kind, viaVideo: x.viaVideo })); } }
      else { const g = await G.gallery(u); title = g.title; list = g.items.map((x) => ({ href: x.href, text: x.text, name: x.name, thumb: x.thumb, kind: x.kind === 'image' ? 'image' : 'video' })); }
      if (my !== token) return false;
      show(title, list); return list.length > 0;
    } catch { if (my === token) { el.hidden = true; el.replaceChildren(); onChange(); } return false; }
  };
  return { el, read, picks: () => (shown ? items.filter((_, i) => on.has(i)) : null) };
}
