// The window's title bar, the app's own, where the desktop shell has the page draw all of it — its buttons too (the
// Tauri shell: desktop-tauri/bridge.js → src-tauri/src/titlebar.rs; Electron's keeps the system's buttons over its
// bar, ui/titlebar.ts). Material 3 Expressive, in the colours of whatever theme is on (the sidebar's surface in the
// library, the page's own colour in the reader): the app's icon and name at the start, the rest of the strip to drag
// the window by (a double-click maximises or restores it), and at the end minimise, maximise / restore and close —
// rounded state layers on hover and press, close turned the error colour, each a button with its name for a screen
// reader and the keyboard. The bar follows the interface's direction: right to left, its buttons are at the left, as
// Windows has them in a right-to-left language. On a Mac the system's three lights stay (the shell's overlay title
// bar) with room kept for them; the page draws no buttons there. Hidden in full screen and in immersive reading (a
// mouse at the very top shows it for a moment). Transparent (a setting): no surface of its own — the buttons float
// over the top of the page, whose own top bars keep room for them, and any free spot of the top strip drags the
// window. The system's frame (a setting): no bar here at all.
import { getSettings, onSettingsChange, type VisualSettings } from '../settings';
import { t, onLangChange } from '../i18n';
import { brandIcon } from './brandIcon';

/** What the shell answers and tells (titlebar.rs's state): the bar in force (`own`), the one asked for (`wanted`: on
 *  a Mac a change waits for the next start), and the window's state. */
export interface WinState { platform: string; height: number; own: boolean; wanted?: boolean; controls?: 'own' | 'system'; maximized?: boolean; fullscreen?: boolean; focused?: boolean }
export type WinAct = 'minimize' | 'maximize' | 'close' | 'drag';
export interface WinBridge {
  titleBar?(o?: { own?: boolean; act?: WinAct }): Promise<WinState | null>;
  onTitleBarState?(cb: (s: Partial<WinState>) => void): () => void;
}

const SVG = 'http://www.w3.org/2000/svg';
// (12 × 12, lines on half pixels so they stay sharp at 100 %: a dash, a rounded square, two of them, a cross.)
const GLYPHS = {
  min: '<path d="M2 6.5h8"/>',
  max: '<rect x="1.5" y="1.5" width="9" height="9" rx="2.6"/>',
  restore: '<rect x="1.5" y="3.5" width="7" height="7" rx="2.1"/><path d="M3.6 1.5h4.8a2.1 2.1 0 0 1 2.1 2.1v4.8"/>',
  close: '<path d="M2.25 2.25l7.5 7.5M9.75 2.25l-7.5 7.5"/>',
} as const;
function glyph(k: keyof typeof GLYPHS, cls = ''): SVGSVGElement {
  const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('aria-hidden', 'true'); if (cls) s.setAttribute('class', cls);
  s.innerHTML = GLYPHS[k]; return s;
}
// (What a press in the transparent bar's strip must leave to the page: anything that does something.)
const LIVE = 'button, a[href], input, select, textarea, label, summary, video, audio, [role="button"], [role="tab"], [role="slider"], [role="menuitem"], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), .rail-item, .kr-winbar .wb-controls';

let state: WinState | null = null;
/** The bar's state now (null: not this shell, or not started). */
export const winState = (): WinState | null => state;
/** A change of bar asked for that waits for the next start (a Mac's window cannot change its kind of title bar). */
export const titleBarWaits = (): boolean => !!state && state.wanted !== undefined && state.wanted !== state.own;

export function startWinBar(bridge: WinBridge | undefined): void {
  if (!bridge?.titleBar || location.hash.startsWith('#/mini')) return;
  const root = document.documentElement;
  const act = (a: WinAct): void => { void Promise.resolve(bridge.titleBar!({ act: a })).then((s) => { if (s) take(s); }).catch(() => undefined); };

  const logo = document.createElement('img'); logo.alt = ''; logo.setAttribute('data-brand', ''); logo.src = brandIcon() || 'icons/icon.svg';
  const name = document.createElement('span'); name.className = 'wb-name'; name.dir = 'auto';
  const brand = document.createElement('div'); brand.className = 'wb-brand'; brand.append(logo, name);
  const button = (cls: string, ...g: SVGSVGElement[]): HTMLButtonElement => { const b = document.createElement('button'); b.type = 'button'; b.className = `wb-btn ${cls}`; b.append(...g); return b; };
  const bMin = button('wb-min', glyph('min'));
  const bMax = button('wb-max', glyph('max', 'g-max'), glyph('restore', 'g-restore'));
  const bClose = button('wb-close', glyph('close'));
  bMin.addEventListener('click', () => act('minimize'));
  bMax.addEventListener('click', () => act('maximize'));
  bClose.addEventListener('click', () => act('close'));
  const controls = document.createElement('div'); controls.className = 'wb-controls'; controls.setAttribute('role', 'group'); controls.append(bMin, bMax, bClose);
  const bar = document.createElement('div'); bar.className = 'kr-winbar'; bar.append(brand, controls);
  const words = (): void => {
    name.textContent = t('appName'); controls.setAttribute('aria-label', t('winControls'));
    const lab = (b: HTMLElement, s: string) => { b.title = s; b.setAttribute('aria-label', s); };
    lab(bMin, t('winMinimize')); lab(bMax, state?.maximized ? t('winRestore') : t('winMaximize')); lab(bClose, t('winClose'));
  };

  // Dragging: a press on the bar's free space (or, transparent, on a free spot of the top strip) moves the window; a
  // double-click maximises or restores it — on the second press, as Windows does (a Mac on the second release, if
  // the mouse has not moved, as it does).
  let macTwice: [number, number] | null = null;
  const free = (e: MouseEvent): boolean => {
    if (e.button !== 0 || !state?.own || (root.classList.contains('wb-hide') && !root.classList.contains('wb-peek'))) return false;
    const el = e.target as Element | null;
    if (bar.contains(el)) return !controls.contains(el);
    if (!root.classList.contains('wb-clear') || e.clientY >= (state.height || 32)) return false;
    return !el?.closest?.(LIVE) && !document.querySelector('.sheet, .scrim.open, dialog[open]');
  };
  document.addEventListener('mousedown', (e) => {
    if (!free(e)) return;
    if (e.detail === 2 && state?.platform === 'darwin') { macTwice = [e.clientX, e.clientY]; return; }
    if (e.detail > 2) return;
    e.preventDefault();
    act(e.detail === 2 ? 'maximize' : 'drag');
  }, true);
  document.addEventListener('mouseup', (e) => {
    const at = macTwice; macTwice = null;
    if (at && e.detail === 2 && Math.abs(e.clientX - at[0]) < 4 && Math.abs(e.clientY - at[1]) < 4) act('maximize');
  }, true);

  // Hidden in full screen and immersive reading; there, a mouse at the window's very top shows it until it leaves.
  let readerBg = ''; let readerFg = '';
  const look = (): void => {
    const rv = document.querySelector<HTMLElement>('.reader-view');
    const imm = !!rv?.classList.contains('immersive');
    const full = !!state?.fullscreen || !!document.fullscreenElement;
    root.classList.toggle('wb-hide', imm || full);
    if (!imm || full) root.classList.remove('wb-peek');
    // (In the reader the bar takes the page's colour, as the reader's own top bar does.)
    const bg = rv?.style.getPropertyValue('--chrome-bg').trim() ?? ''; const fg = rv?.style.getPropertyValue('--chrome-fg').trim() ?? '';
    if (bg !== readerBg || fg !== readerFg) {
      readerBg = bg; readerFg = fg;
      if (bg) bar.style.setProperty('--wb-bg', bg); else bar.style.removeProperty('--wb-bg');
      if (fg) bar.style.setProperty('--wb-fg', fg); else bar.style.removeProperty('--wb-fg');
    }
  };
  let queued = 0;
  const soon = (): void => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; look(); room(); }); };
  document.addEventListener('mousemove', (e) => { if (e.clientY <= 2 && root.classList.contains('wb-hide') && !root.classList.contains('wb-peek') && !state?.fullscreen && !document.fullscreenElement) root.classList.add('wb-peek'); }, { passive: true });
  bar.addEventListener('mouseleave', () => root.classList.remove('wb-peek'));
  document.addEventListener('fullscreenchange', soon);

  // The room the page keeps for the buttons in the transparent bar: at the interface's end for the app's own, at the
  // window's left for a Mac's lights.
  const room = (): void => {
    const mac = state?.platform === 'darwin';
    const rtl = getComputedStyle(root).direction === 'rtl';
    const w = mac ? 78 : Math.round(controls.getBoundingClientRect().width || 138) + 6;
    root.style.setProperty('--wb-start', `${mac && !rtl ? w : 0}px`);
    root.style.setProperty('--wb-end', `${mac ? (rtl ? w : 0) : w}px`);
  };

  const paint = (s: VisualSettings = getSettings()): void => {
    if (!state?.own) {
      bar.remove();
      root.classList.remove('winbar', 'wb-mac', 'wb-clear', 'wb-named', 'wb-maxed', 'wb-blur', 'wb-hide', 'wb-peek');
      return;
    }
    const mac = state.platform === 'darwin';
    root.style.setProperty('--wb-h', `${state.height || (mac ? 28 : 32)}px`);
    root.classList.add('winbar');
    root.classList.toggle('wb-mac', mac);
    root.classList.toggle('wb-clear', !!s.titleBarClear);
    root.classList.toggle('wb-named', s.titleBarName !== false && !s.titleBarClear);
    root.classList.toggle('wb-maxed', !!state.maximized);
    root.classList.toggle('wb-blur', state.focused === false);
    if (!bar.isConnected) root.append(bar);
    words(); look(); room();
  };
  const take = (s: Partial<WinState>): void => { state = { ...(state ?? { platform: '', height: 32, own: false }), ...s }; paint(); };

  // The bar asked for (the setting) told to the shell at the start and at each change; the shell answers what is in force.
  let kind = getSettings().titleBarKind;
  const ask = (): void => {
    void Promise.resolve(bridge.titleBar!({ own: kind !== 'system' })).then((s) => {
      if (s && typeof s === 'object' && typeof s.own === 'boolean') take(s);
    }).catch(() => undefined);
  };
  ask();
  bridge.onTitleBarState?.((s) => { if (s && typeof s === 'object') take(s); });
  onSettingsChange((s) => { if (s.titleBarKind !== kind) { kind = s.titleBarKind; ask(); } else if (state) paint(s); });
  onLangChange(() => { if (state) { words(); soon(); } });
  window.addEventListener('hashchange', soon);
  window.addEventListener('resize', soon, { passive: true });
  new MutationObserver(soon).observe(root, { attributes: true, attributeFilter: ['dir', 'lang'] });
  const app = document.getElementById('app') ?? document.body;
  new MutationObserver(soon).observe(app, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
}
