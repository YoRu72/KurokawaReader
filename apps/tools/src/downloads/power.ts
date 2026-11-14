// When the downloads may run: on Wi-Fi only (Android: held on mobile data, resumed on Wi-Fi), not on a low battery
// (Android: held at 15 % or less, resumed when charging or past 20 %); on a computer, the computer kept awake while
// they run, and what it does when they are all done (nothing, quit the app, sleep, shut down).
import { getSettings, updateSettings } from '../settings';
import { ktPlugin, nativePlatform } from '../native';
import { t } from '../i18n';

/** The interface's words for the shell's tray menu and a Mac's menu bar (the Tauri shell's desktop.rs). */
function deskLabels(): Record<string, string | boolean> {
  return { app: t('appName'), quit: t('trayQuit'), about: t('menuAbout'), hide: t('menuHide'), hideOthers: t('menuHideOthers'), showAll: t('menuShowAll'), quitApp: t('menuQuit'),
    file: t('menuFile'), closeWindow: t('menuCloseWindow'), edit: t('menuEdit'), undo: t('menuUndo'), redo: t('menuRedo'), cut: t('menuCut'), copy: t('menuCopy'), paste: t('menuPaste'), selectAll: t('menuSelectAll'),
    view: t('menuView'), fullscreen: t('menuFullscreen'), window: t('menuWindow'), minimize: t('menuMinimize'), zoom: t('menuZoom'),
    // (Stage P7: the in-app browser's bar.)
    browserBack: t('browserBarBack'), browserForward: t('browserBarForward'), browserReload: t('browserBarReload'), browserAddress: t('browserBarAddress'),
    browserGrab: t('browserBarGrab'), browserCopy: t('browserBarCopy'), browserExternal: t('browserBarExternal'), rtl: document.documentElement.dir === 'rtl' };
}

export interface Power { wifiOnly?: boolean; batteryGuard?: boolean; keepAwake?: boolean; whenDone?: 'nothing' | 'quit' | 'sleep' | 'shutdown';
  /** A computer: a notice when a download finishes, the tray icon with the speed, and the clipboard hotkeys by mode (Electron accelerators). */
  notifyDone?: boolean; tray?: boolean; hotkeys?: { video?: string; audio?: string; clip?: string; file?: string } }
export const powerOf = (): Power => getSettings().power ?? {};
/** The choices handed to the engine (at start and when they change). */
export async function applyPower(): Promise<void> {
  const p = powerOf();
  try {
    if (nativePlatform() === 'android') await (ktPlugin() as unknown as { configure(o: Record<string, unknown>): Promise<void> } | null)?.configure({ wifiOnly: !!p.wifiOnly, batteryGuard: !!p.batteryGuard, dedupe: !!getSettings().dedupe });
    else {
      const d = window.kurokawaTools as unknown as { desktopPrefs?(o: Record<string, unknown>): Promise<unknown> } | undefined;
      // (The Tauri shell also takes the interface's words for its tray menu and a Mac's menu bar, and says which hotkeys
      // the system refused — Electron ignores the one and never answers the other.)
      const r = await d?.desktopPrefs?.({ keepAwake: p.keepAwake !== false, whenDone: p.whenDone ?? 'nothing', notifyDone: p.notifyDone !== false, tray: !!p.tray, hotkeys: p.hotkeys ?? {}, labels: deskLabels() }) as { hotkeyErrors?: Record<string, string> } | undefined;
      const bad = r && r.hotkeyErrors && typeof r.hotkeyErrors === 'object' ? Object.entries(r.hotkeyErrors) : [];
      // (One toast for them all: a later toast takes an earlier one's place.)
      if (bad.length) { const { toast } = await import('../ui/dom'); toast(bad.map(([mode, why]) => t('hotkeyRefused', { keys: String((p.hotkeys as Record<string, string> | undefined)?.[mode] ?? mode), why: t(why === 'key' ? 'hotkeyWhyKey' : why === 'taken' ? 'hotkeyWhyTaken' : 'hotkeyWhyNone') })).join(' · '), 'error', 6000 + 2000 * (bad.length - 1)); }
    }
  } catch { /* an older native side */ }
}
export function setPower(o: Partial<Power>): void { updateSettings({ power: { ...powerOf(), ...o } }); void applyPower(); }
