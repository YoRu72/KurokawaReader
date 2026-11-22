// Add-ons, themes and wallpapers that arrive by themselves from the repository — no app update needed for them (one
// is asked for only when an entry says the app is too old: «needs the app update», and the app's own updater offers
// it). Checked at start (after the first paint, when the page is idle), when the app comes back to the foreground,
// and every 6 hours while it stays open — never more; one check at a time; not on a metered or data-saving connection
// when the platform says so; only while «Add-ons, themes and wallpapers: update by themselves» is on (on by default).
// «Check now» asks at once, whatever the setting. After updates: one quiet grouped notice; the list is in Settings.
import { getSettings, updateSettings } from './settings';

const LAST = 'kt.live.lastCheck';
export const EVERY_MS = 6 * 3600_000;
/** Back in the foreground: checked again only when the last check is at least this old. */
const FOREGROUND_MS = 30 * 60_000;
export interface LiveReport { at: number; addons: { id: string; name: string; from: string; to: string }[]; themes: { id: string; name: string; from: string; to: string }[]; scenes: { id: string; name: string; from: string; to: string }[]; waiting: string[]; failed: string[]; offline: boolean }

export const lastLiveCheck = (): number => { try { return Number(localStorage.getItem(LAST) ?? 0) || 0; } catch { return 0; } };
export const liveOn = (): boolean => getSettings().liveUpdates !== false;
/** The platform says the connection is metered or data saving is on (Chromium's Network Information API). */
export function metered(): boolean {
  const c = (navigator as unknown as { connection?: { saveData?: boolean; metered?: boolean } }).connection;
  return !!(c && (c.saveData || c.metered));
}
const isPc = () => document.documentElement.classList.contains('pc');

let running: Promise<LiveReport> | null = null;
/** One check (or the one already running). `manual`: «Check now» — the back-off and the setting set aside. */
export function runLiveCheck(manual = false): Promise<LiveReport> {
  if (running) return running;
  running = check(manual).finally(() => { running = null; });
  return running;
}
async function check(manual: boolean): Promise<LiveReport> {
  const rep: LiveReport = { at: Date.now(), addons: [], themes: [], scenes: [], waiting: [], failed: [], offline: false };
  // Add-ons.
  try {
    const ad = await import('./addons'); const r = await ad.readIndex(manual);
    if (r.fresh && r.data) { const u = await ad.autoUpdate(r.data); rep.addons = u.updated; rep.waiting = u.waiting; rep.failed = u.failed.map((f) => f.id); }
    else if (!r.fresh) rep.offline = true;
  } catch { rep.offline = true; }
  // Themes.
  try {
    const { readCatalog } = await import('./catalog'); const io = await import('./themeIo');
    const r = await readCatalog('themes/themes.json', io.checkThemeIndex, { auto: !manual });
    if (r.data) {
      if (!getSettings().seenThemes) updateSettings({ seenThemes: r.data.themes.map((e) => e.id) });
      if (r.fresh) rep.themes = await io.updateThemes(r.data);
    }
  } catch { /* next time */ }
  // Wallpapers (a computer's: the animated backgrounds are a computer's only).
  if (isPc()) try {
    const sc = await import('./theme/sceneRepo'); const r = await sc.readScenes(manual);
    if (r.data) {
      if (!getSettings().seenScenes) updateSettings({ seenScenes: r.data.scenes.map((e) => e.id) });
      if (r.fresh) rep.scenes = await sc.updateScenes(r.data);
    }
  } catch { /* next time */ }
  try { localStorage.setItem(LAST, String(rep.at)); } catch { /* no storage */ }
  if (rep.themes.length) { const { reloadThemePictures, applyChrome } = await import('./settings'); reloadThemePictures(); applyChrome(); }
  notice(rep);
  try { window.dispatchEvent(new CustomEvent('kt:live-checked', { detail: rep })); } catch { /* none */ }
  return rep;
}
/** One quiet notice for everything updated: «Updated: ⁨name⁩ 1.2 → 1.3, …». */
async function notice(rep: LiveReport): Promise<void> {
  const all = [...rep.addons, ...rep.themes, ...rep.scenes]; if (!all.length) return;
  const { t } = await import('./i18n'); const { toast } = await import('./ui/dom'); const { navigate } = await import('./router');
  const items = all.slice(0, 3).map((x) => t('liveItem', { name: x.name, from: x.from, to: x.to }));
  const more = all.length > 3 ? ` ${t('liveMore', { n: all.length - 3 })}` : '';
  toast(t('liveUpdated', { list: items.join(t('listSep')) + more }), 'info', 7000, { label: t('liveShow'), run: () => navigate(rep.addons.length ? '/settings/addons' : '/settings/appearance') });
}

let started = false; let timer = 0;
/** Starts the checks (main.ts, after the first paint). Returns the way to stop them (the tests). */
export function startLiveChecks(): () => void {
  if (started) return () => undefined; started = true;
  // (The next one 6 hours after the last check, whatever started it — never sooner.)
  const arm = (): void => { window.clearTimeout(timer); if (!started) return; const last = lastLiveCheck(); timer = window.setTimeout(onTimer, Math.max(60_000, (last ? last + EVERY_MS : Date.now() + EVERY_MS) - Date.now())); };
  const auto = (): void => {
    if (!liveOn() || metered() || !navigator.onLine) { arm(); return; }
    void runLiveCheck(false).catch(() => undefined).finally(arm);
  };
  // (A «Check now» in between moved the last check: the timer waits the rest of the 6 hours from it.)
  const onTimer = (): void => { if (Date.now() - lastLiveCheck() < EVERY_MS - 60_000) arm(); else auto(); };
  void import('./themeIo').then((m) => m.registerKeptThemes()).then(async (ids) => { if (ids.includes(getSettings().theme ?? '')) { const s = await import('./settings'); s.reloadThemePictures(); } }).catch(() => undefined);
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  // (A start soon after a check — a reload, a restart — waits for the timer instead: the catalogues were just read.)
  const start = (): void => { if (Date.now() - lastLiveCheck() < FOREGROUND_MS) arm(); else auto(); };
  const first = window.setTimeout(() => { if (idle) idle(start, { timeout: 10_000 }); else start(); }, 5000);
  const onVis = (): void => { if (document.visibilityState === 'visible' && Date.now() - lastLiveCheck() >= FOREGROUND_MS) auto(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { started = false; window.clearTimeout(first); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
}

/** The Updates card's rows for these: the switch, «Check now», when it was last checked. */
export function liveRows(toggle: (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => HTMLElement, h: (tag: string, attrs: Record<string, unknown> | null, ...kids: (Node | string | null)[]) => HTMLElement, t: (k: string, v?: Record<string, string | number>) => string, when: (ms: number) => string, icon: (n: string) => Node): HTMLElement[] {
  const status = h('p', { class: 'src live-last', 'aria-live': 'polite' }, lastLiveCheck() ? t('liveLast', { d: when(lastLiveCheck()) }) : t('liveNever'));
  const btn = h('button', { type: 'button', class: 'btn tonal small live-now', onclick: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true; status.textContent = t('checking');
    try {
      const r = await runLiveCheck(true); const n = r.addons.length + r.themes.length + r.scenes.length;
      status.textContent = [n ? t('liveUpdatedN', { n }) : r.offline ? t('liveOffline') : t('liveNothing'), t('liveLast', { d: when(lastLiveCheck()) })].join(' · ');
    } catch { status.textContent = t('liveOffline'); }
    b.disabled = false;
  } }, icon('refresh'), t('liveCheckNow'));
  return [toggle(t('liveAuto'), liveOn(), (v) => updateSettings({ liveUpdates: v }), t('liveAutoHint')), h('div', { class: 'row live-row' }, status, btn)];
}
