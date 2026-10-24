// The PC look (Material 3 Expressive): in the desktop app, or a browser window wide enough with a mouse, the
// app gets a navigation rail at the side — the import button as an expressive FAB at its top, the places
// below it — dialogs instead of bottom sheets, a roomier library and keyboard shortcuts. Phones and tablets
// keep their own layout; the reader keeps the whole window.
import { h, icon } from './dom';
import { t, onLangChange } from '../i18n';
import { navigate, onRoute, parseRoute, type Route } from '../router';

const wide = matchMedia('(min-width: 1024px) and (pointer: fine)');
export const isPc = (): boolean => !!window.kurokawaDesktop || wide.matches;

let rail: HTMLElement | null = null;
let updateOpen: (() => void) | null = null;
function updateItem(): HTMLElement {
  const b = item('update', 'download', t('updateNow'), () => updateOpen?.());
  b.classList.add('rail-update'); b.hidden = !updateOpen;
  (b.querySelector('.rail-dot') as HTMLElement).hidden = false;
  return b;
}

/** Tell the library view to do something (it listens while it is shown). */
function ask(what: 'import' | 'search'): void {
  const send = () => window.dispatchEvent(new CustomEvent('kr:library', { detail: what }));
  if (parseRoute().name === 'library') send();
  else { navigate('/'); setTimeout(send, 120); }
}

function item(name: string, iconName: string, label: string, onClick: () => void, tip = label): HTMLButtonElement {
  return h('button', { type: 'button', class: 'rail-item', 'data-dest': name, title: tip, 'aria-label': tip, onclick: onClick },
    h('span', { class: 'rail-pill' }, icon(iconName), h('i', { class: 'rail-dot', hidden: true })), h('span', { class: 'rail-label' }, label)) as HTMLButtonElement;
}

function build(): HTMLElement {
  const nav = h('nav', { class: 'nav-rail', 'aria-label': t('appName') },
    h('div', { class: 'rail-brand' }, h('img', { src: '/icons/icon.svg', alt: '' })),
    h('button', { type: 'button', class: 'rail-fab', title: `${t('importBooks')} (Ctrl+O)`, 'aria-label': t('importBooks'), onclick: () => ask('import') }, icon('plus')),
    h('div', { class: 'rail-items' },
      item('library', 'books', t('library'), () => navigate('/')),
      item('search', 'search', t('railSearch'), () => ask('search'), `${t('searchBooks')} (Ctrl+Shift+F)`),
      item('notes', 'bookmark', t('railNotes'), () => navigate('/notes'), t('allNotes')),
      item('stats', 'chart', t('railStats'), () => void import('./stats').then((m) => m.showStats()), t('readingStats')),
      item('sync', 'cloud', t('railSync'), () => void import('./syncsheet').then((m) => m.syncSheet()), t('sync')),
    ),
    h('div', { class: 'rail-end' }, updateItem(), item('settings', 'settings', t('settings'), () => navigate('/settings'))));
  return nav;
}

function mark(r: Route): void {
  document.documentElement.classList.toggle('rail-off', r.name === 'read');
  rail?.querySelectorAll<HTMLElement>('.rail-item').forEach((b) => {
    const on = b.dataset.dest === r.name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

function apply(): void {
  const pc = isPc();
  document.documentElement.classList.toggle('pc', pc);
  if (pc && !rail) { rail = build(); document.body.prepend(rail); mark(parseRoute()); }
  if (!pc && rail) { rail.remove(); rail = null; }
}

/** Keyboard shortcuts on the PC: Ctrl+O import, Ctrl+Shift+F search all books, Ctrl+, settings. */
function onKey(e: KeyboardEvent): void {
  if (!isPc() || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, [contenteditable="true"]') && e.key !== ',') return;
  if (document.querySelector('.sheet')) return;
  const route = parseRoute().name;
  if (e.key.toLowerCase() === 'o' && !e.shiftKey && route !== 'read') { e.preventDefault(); ask('import'); }
  else if (e.key.toLowerCase() === 'f' && e.shiftKey && route !== 'read') { e.preventDefault(); ask('search'); }
  else if (e.key === ',') { e.preventDefault(); navigate('/settings'); }
}

export function initPcShell(): void {
  apply();
  wide.addEventListener('change', apply);
  onRoute(mark);
  onLangChange(() => { if (rail) { rail.remove(); rail = null; apply(); } });
  window.addEventListener('keydown', onKey);
}

/** A newer version is out: an Update place shows in the rail, above Settings, and opens the update dialog. */
export function railUpdate(open: () => void): void {
  updateOpen = open;
  const b = rail?.querySelector<HTMLElement>('[data-dest="update"]'); if (b) b.hidden = false;
}
