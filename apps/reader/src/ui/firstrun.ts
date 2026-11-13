// The first-run screen of the computer app's Tauri build (stage R6b): one page, shown once over the library at the
// first start — the interface's language, its look (system / light / dark), «Your library from the previous version»
// (stage R6a's hand-over: when the previous version left one, this screen carries its offer — the count, the size,
// where the old data stays, «Bring it now» with its progress: ui/handoversheet.ts handoverOffer; never a second
// screen —; else a button that looks for one), and opening books with the
// app (the system's default-apps page, where the system lets an app ask for it: Windows and macOS; the installers
// register the kinds of file themselves). Everything here is also in Settings; «Start reading» (or Escape) closes it
// for good. Not shown under the self-test or the engine test (their own profiles), nor in an automated browser.
import { h, icon } from './dom';
import type { Found } from '../handover';
import { t, LANGS, getLang, setLangPref, onLangChange, type Lang } from '../i18n';
import { getSettings, updateSettings } from '../settings';

const DONE = 'kr.firstrun.done';

/** Whether this start is the first of the Tauri build in this profile (and no test is driving it). */
export function shouldShowFirstRun(): boolean {
  const w = window as unknown as { __KR_SHELL__?: string; __KR_SELFTEST__?: unknown; __KR_ENGINETEST__?: unknown; __KR_UPDATETEST_STARTED__?: unknown };
  if (w.__KR_SHELL__ !== 'tauri' || w.__KR_SELFTEST__ || w.__KR_ENGINETEST__ || w.__KR_UPDATETEST_STARTED__) return false;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
  try { return !localStorage.getItem(DONE); } catch { return false; }
}

type Desk = { platform?: string; openDefaultApps?(): Promise<boolean> };

/** The Tauri build's start: the first-run screen once — carrying the hand-over's offer when there is one —, else the
 *  hand-over's offer alone when there is one (ui/handoversheet.ts). ONE screen either way. */
export async function startScreens(): Promise<void> {
  const hs = () => import('./handoversheet');
  if (shouldShowFirstRun()) {
    const el = showFirstRun();
    // (Looked for after the screen is up — it never waits on it —, and put in its tile when there is one to offer.)
    const f = await hs().then((m) => m.handoverToOffer()).catch(() => null);
    if (f && el.isConnected) (el as FirstRunEl).__offer?.(f, true);
    return;
  }
  // (As before the screens were one: a moment after the start, out of its way.)
  await new Promise((r) => setTimeout(r, 1500));
  await hs().then((m) => m.handoverAtStart()).catch(() => undefined);
}

type FirstRunEl = HTMLElement & { __offer?: (f: Found, atStart: boolean) => void };

/** The screen, over whatever is under it; → its element. `find`: how «Bring my library» looks for a hand-over (the
 *  shell's window.kurokawaHandover by default). */
export function showFirstRun(o: { find?: () => Promise<Found | null> } = {}): HTMLElement {
  document.querySelector('.firstrun')?.remove();
  const desk = window.kurokawaDesktop as Desk | undefined;
  const el: FirstRunEl = h('div', { class: 'firstrun', role: 'dialog', 'aria-modal': 'true' });
  let laterSaid = false;
  // (The library's tile: idle → looking → none, or the hand-over's offer — its own states from there on.)
  let bring: { state: 'idle' | 'busy' | 'none' } | { state: 'offer'; f: Found; atStart: boolean } = { state: 'idle' };
  let offerTile: HTMLElement | null = null; let restoring = false; let restored = false;
  const close = (reload = false) => {
    if (restoring) return;
    try { localStorage.setItem(DONE, String(Date.now())); } catch { /* private mode: shown again next time */ }
    off(); window.removeEventListener('keydown', onKey, true);
    if (reload) { location.reload(); return; }
    el.classList.add('leaving'); setTimeout(() => el.remove(), 220);
    // (Brought over and then closed some other way than «Continue»: the page takes up what came all the same.)
    if (restored) setTimeout(() => location.reload(), 240);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && el.isConnected && !document.querySelector('.sheet')) { e.preventDefault(); e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);

  const seg = <T extends string>(label: string, opts: [T, string][], value: T, on: (v: T) => void, dirAuto = false) =>
    h('div', { class: 'fr-field' }, h('span', { class: 'fr-label' }, label),
      h('div', { class: 'segmented fr-seg', role: 'radiogroup', 'aria-label': label }, ...opts.map(([id, text]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === value), 'aria-pressed': String(id === value), dir: dirAuto ? 'auto' : undefined, onclick: () => on(id) }, text))));

  /** The hand-over's offer in the tile (made once: its progress and result survive a change of look; a change of
   *  language re-renders the rest of the screen around it). */
  const offer = (b: { f: Found; atStart: boolean }): HTMLElement => {
    if (offerTile) return offerTile;
    const text = h('div', { class: 'fr-tile-text' }, h('b', null, t('frBringTitle')));
    const actions = h('div', { class: 'fr-tile-actions' });
    offerTile = h('section', { class: 'fr-tile fr-offer' }, h('span', { class: 'fr-tile-icon' }, icon('library')), text, actions);
    const tile = offerTile;
    const f = b.f;
    if (!f.found || !f.marker || !f.dir) return tile;
    void import('./handoversheet').then((m) => m.handoverOffer({ ...f, found: true, marker: f.marker!, dir: f.dir! }, {
      root: tile, body: text, actions, atStart: b.atStart,
      onBusy: (busy) => { restoring = busy; for (const x of el.querySelectorAll<HTMLButtonElement>('.fr-start, .fr-seg button')) x.disabled = busy; },
      onDone: () => { restored = true; tile.classList.add('ok'); try { localStorage.setItem(DONE, String(Date.now())); } catch { /* private mode */ } },
      // («Not now»: the tile says where to find it later; the screen stays.)
      onLater: () => { offerTile = null; bring = { state: 'none' }; laterSaid = true; render(); },
      // («Continue»: the screen goes and the page reloads with the settings and library that came.)
      onContinue: () => close(true),
    }));
    return tile;
  };

  const render = () => {
    const s = getSettings();
    const bringText = bring.state === 'busy' ? t('frBringBusy') : bring.state === 'none' ? (laterSaid ? t('handoverLaterHint') : t('frBringNone')) : t('frBringBody');
    const canDefault = !!desk?.openDefaultApps && (desk.platform === 'win32' || desk.platform === 'darwin');
    el.replaceChildren(h('div', { class: 'fr-card' },
      h('div', { class: 'fr-hero' },
        h('div', { class: 'upd-badge fr-badge' }, h('img', { src: 'icons/icon.svg', alt: '', 'data-brand': '' })),
        h('div', { class: 'fr-hero-text' }, h('h1', null, t('frWelcome')), h('p', null, t('frSub')))),
      seg<Lang>(t('language'), LANGS.map(([c, n]) => [c, n]), getLang(), (v) => { setLangPref(v); }, true),
      seg<'system' | 'light' | 'dark'>(t('appearance'), [['system', t('uiSystem')], ['light', t('uiLight')], ['dark', t('uiDark')]], s.uiMode === 'light' || s.uiMode === 'dark' ? s.uiMode : 'system', (v) => { updateSettings({ uiMode: v }); render(); }),
      bring.state === 'offer' ? offer(bring) : h('section', { class: 'fr-tile' },
        h('span', { class: 'fr-tile-icon' }, icon('library')),
        h('div', { class: 'fr-tile-text' }, h('b', null, t('frBringTitle')), h('p', { 'aria-live': 'polite' }, bringText)),
        bring.state === 'idle' || (bring.state === 'none' && laterSaid) ? h('button', { type: 'button', class: 'btn tonal small fr-bring', onclick: () => void doBring() }, icon('download'), t('frBringBtn')) : null),
      canDefault ? h('section', { class: 'fr-tile' },
        h('span', { class: 'fr-tile-icon' }, icon('books')),
        h('div', { class: 'fr-tile-text' }, h('b', null, t('frDefaultTitle')), h('p', null, t('frDefaultBody'))),
        h('button', { type: 'button', class: 'btn outlined small fr-default', onclick: () => { void desk!.openDefaultApps!().catch(() => false); } }, icon('external'), t('frDefaultBtn'))) : null,
      h('div', { class: 'fr-actions' }, h('button', { type: 'button', class: 'btn primary large fr-start', disabled: restoring, onclick: () => close() }, t('frStart'), icon('arrowRight')))));
  };
  /** «Bring my library»: the hand-over looked for (also one not offered at the start: declined before, or brought
   *  into this profile already — it then merges); its offer in the tile, or «none found». */
  const doBring = async () => {
    bring = { state: 'busy' }; laterSaid = false; render();
    let f: Found | null = null;
    try {
      if (o.find) f = await o.find();
      else { const a = (window as unknown as { kurokawaHandover?: { find?(): Promise<Found> } }).kurokawaHandover; f = a?.find ? await a.find() : null; }
    } catch { f = null; }
    bring = f?.found ? { state: 'offer', f, atStart: false } : { state: 'none' }; render();
  };
  el.__offer = (f, atStart) => { if (bring.state === 'offer' || !f.found) return; bring = { state: 'offer', f, atStart }; render(); };
  const off = onLangChange(() => render());
  render();
  document.body.append(el);
  requestAnimationFrame(() => (el.querySelector('.fr-start') as HTMLElement | null)?.focus());
  return el;
}
