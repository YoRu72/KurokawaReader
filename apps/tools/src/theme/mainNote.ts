// The snackbar owed once after «Expressive 3» came back as the main theme (0.21, settings.ts migrateTheme): it says so,
// «Use Frost» puts back what was in use (and records it as chosen), ✕ or its time dismisses it. Loaded only then.
import { h, icon } from '../ui/dom';
import { t } from '../i18n';
import { updateSettings, reloadThemePictures, MAIN_NOTE_KEY } from '../settings';

/** What the snackbar remembers: the theme in use before the move. */
interface Prev { theme?: string; themeKeepColours?: boolean }
export function readNote(): Prev | null {
  try { const raw = localStorage.getItem(MAIN_NOTE_KEY); if (!raw) return null; const v: unknown = JSON.parse(raw); return v && typeof v === 'object' ? (v as Prev) : { theme: 'frost' }; } catch { return null; }
}
/** Shown once: the note is forgotten as soon as it is on screen. */
export function showMainNote(ms = 12000): HTMLElement | null {
  const prev = readNote(); try { localStorage.removeItem(MAIN_NOTE_KEY); } catch { /* private mode */ }
  if (!prev) return null;
  let timer = 0;
  const close = () => { window.clearTimeout(timer); el.remove(); };
  const el = h('div', { class: 'toast undo-snack main-note', role: 'status' },
    h('span', { class: 'grow' }, t('mainThemeBack')),
    h('button', { type: 'button', class: 'toast-act', onclick: () => { close(); updateSettings({ theme: prev.theme || 'frost', themeKeepColours: prev.themeKeepColours || undefined, themeChosen: true }); reloadThemePictures(); } }, t('mainThemeUseFrost')),
    h('button', { type: 'button', class: 'toast-x', 'aria-label': t('close'), title: t('close'), onclick: close }, icon('close')));
  document.body.append(el);
  timer = window.setTimeout(close, ms);
  return el;
}
