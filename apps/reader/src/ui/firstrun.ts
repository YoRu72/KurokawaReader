// The first-run screen of the computer app's Tauri build (stage R6b): one page, shown once over the library at the
// first start — the interface's language, its look (system / light / dark), «Bring my library from the previous
// version» (src/handover.ts — stage R6a's —, never touching the earlier version's data), and opening books with the
// app (the system's default-apps page, where the system lets an app ask for it: Windows and macOS; the installers
// register the kinds of file themselves). Everything here is also in Settings; «Start reading» (or Escape) closes it
// for good. Not shown under the self-test or the engine test (their own profiles), nor in an automated browser.
import { h, icon } from './dom';
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

/** The screen, over whatever is under it; → its element. */
export function showFirstRun(o: { restore?: () => Promise<{ ok: boolean; none?: boolean; reason?: string }> } = {}): HTMLElement {
  document.querySelector('.firstrun')?.remove();
  const desk = window.kurokawaDesktop as Desk | undefined;
  const el = h('div', { class: 'firstrun', role: 'dialog', 'aria-modal': 'true' });
  let bring: { state: 'idle' | 'busy' | 'done' | 'none' | 'failed'; reason?: string } = { state: 'idle' };
  const close = () => {
    try { localStorage.setItem(DONE, String(Date.now())); } catch { /* private mode: shown again next time */ }
    off(); window.removeEventListener('keydown', onKey, true);
    el.classList.add('leaving'); setTimeout(() => el.remove(), 220);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && el.isConnected) { e.preventDefault(); e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);

  const seg = <T extends string>(label: string, opts: [T, string][], value: T, on: (v: T) => void, dirAuto = false) =>
    h('div', { class: 'fr-field' }, h('span', { class: 'fr-label' }, label),
      h('div', { class: 'segmented fr-seg', role: 'radiogroup', 'aria-label': label }, ...opts.map(([id, text]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === value), 'aria-pressed': String(id === value), dir: dirAuto ? 'auto' : undefined, onclick: () => on(id) }, text))));

  const render = () => {
    const s = getSettings();
    const bringText = bring.state === 'busy' ? t('frBringBusy') : bring.state === 'done' ? t('frBringDone') : bring.state === 'none' ? t('frBringNone') : bring.state === 'failed' ? t('frBringFailed', { r: bring.reason || '—' }) : t('frBringBody');
    const canDefault = !!desk?.openDefaultApps && (desk.platform === 'win32' || desk.platform === 'darwin');
    el.replaceChildren(h('div', { class: 'fr-card' },
      h('div', { class: 'fr-hero' },
        h('div', { class: 'upd-badge fr-badge' }, h('img', { src: 'icons/icon.svg', alt: '', 'data-brand': '' })),
        h('div', { class: 'fr-hero-text' }, h('h1', null, t('frWelcome')), h('p', null, t('frSub')))),
      seg<Lang>(t('language'), LANGS.map(([c, n]) => [c, n]), getLang(), (v) => { setLangPref(v); }, true),
      seg<'system' | 'light' | 'dark'>(t('appearance'), [['system', t('uiSystem')], ['light', t('uiLight')], ['dark', t('uiDark')]], s.uiMode === 'light' || s.uiMode === 'dark' ? s.uiMode : 'system', (v) => { updateSettings({ uiMode: v }); render(); }),
      h('section', { class: 'fr-tile' + (bring.state === 'done' ? ' ok' : bring.state === 'failed' ? ' bad' : '') },
        h('span', { class: 'fr-tile-icon' }, icon(bring.state === 'done' ? 'check' : 'library')),
        h('div', { class: 'fr-tile-text' }, h('b', null, t('frBringTitle')), h('p', { 'aria-live': 'polite' }, bringText)),
        bring.state === 'idle' || bring.state === 'failed' ? h('button', { type: 'button', class: 'btn tonal small fr-bring', onclick: () => void doBring() }, icon('download'), t('frBringBtn')) : null),
      canDefault ? h('section', { class: 'fr-tile' },
        h('span', { class: 'fr-tile-icon' }, icon('books')),
        h('div', { class: 'fr-tile-text' }, h('b', null, t('frDefaultTitle')), h('p', null, t('frDefaultBody'))),
        h('button', { type: 'button', class: 'btn outlined small fr-default', onclick: () => { void desk!.openDefaultApps!().catch(() => false); } }, icon('external'), t('frDefaultBtn'))) : null,
      h('div', { class: 'fr-actions' }, h('button', { type: 'button', class: 'btn primary large fr-start', onclick: close }, t('frStart'), icon('arrowRight')))));
  };
  const doBring = async () => {
    bring = { state: 'busy' }; render();
    try {
      const r = await (o.restore ?? (await import('../handover')).restore)();
      bring = r.ok ? { state: 'done' } : r.none ? { state: 'none' } : { state: 'failed', reason: r.reason };
    } catch (e) { bring = { state: 'failed', reason: String((e as Error)?.message ?? e) }; }
    render();
  };
  const off = onLangChange(() => render());
  render();
  document.body.append(el);
  requestAnimationFrame(() => (el.querySelector('.fr-start') as HTMLElement | null)?.focus());
  return el;
}
