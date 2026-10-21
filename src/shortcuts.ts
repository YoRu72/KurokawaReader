// Keyboard shortcuts (desktop & web): a default map the user can rebind in Settings.
import { getSettings, updateSettings } from './settings';

export interface ShortcutDef { id: string; label: string; def: string; scope: 'global' | 'reader' }
export const SHORTCUTS: ShortcutDef[] = [
  { id: 'import', label: 'importBooks', def: 'Ctrl+O', scope: 'global' },
  { id: 'scan', label: 'scanDevice', def: 'Ctrl+Shift+O', scope: 'global' },
  { id: 'library', label: 'library', def: 'Ctrl+L', scope: 'global' },
  { id: 'settings', label: 'settings', def: 'Ctrl+,', scope: 'global' },
  { id: 'notes', label: 'allNotes', def: 'Ctrl+Shift+N', scope: 'global' },
  { id: 'search', label: 'searchInBook', def: 'Ctrl+F', scope: 'reader' },
  { id: 'options', label: 'visualOptions', def: 'Ctrl+Shift+V', scope: 'reader' },
  { id: 'toc', label: 'contents', def: 'Ctrl+Shift+C', scope: 'reader' },
  { id: 'bookmark', label: 'addBookmark', def: 'Ctrl+D', scope: 'reader' },
  { id: 'translate', label: 'aiTranslate', def: 'Ctrl+Shift+T', scope: 'reader' },
  { id: 'speak', label: 'readAloud', def: 'Ctrl+Shift+S', scope: 'reader' },
  { id: 'fullscreen', label: 'fullscreen', def: 'F11', scope: 'reader' },
  { id: 'nextChapter', label: 'nextChapter', def: 'Ctrl+ArrowRight', scope: 'reader' },
  { id: 'prevChapter', label: 'prevChapter', def: 'Ctrl+ArrowLeft', scope: 'reader' },
  { id: 'fontUp', label: 'fontSize', def: 'Ctrl+=', scope: 'reader' },
  { id: 'fontDown', label: 'fontSize', def: 'Ctrl+-', scope: 'reader' },
];

export function bindingFor(id: string): string { return getSettings().shortcuts[id] ?? SHORTCUTS.find((s) => s.id === id)?.def ?? ''; }
export function setBinding(id: string, combo: string): void { updateSettings({ shortcuts: { ...getSettings().shortcuts, [id]: combo } }); }
export function resetBindings(): void { updateSettings({ shortcuts: {} }); }

/** Canonical "Ctrl+Shift+K" form of a key event (Cmd counts as Ctrl). */
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return '';
  // keep "=" even when Shift turns it into "+"
  if (k === '+') k = '=';
  parts.push(k);
  return parts.join('+');
}

/** Which action (if any) this key event triggers. */
export function actionFor(e: KeyboardEvent): string | null {
  const combo = comboOf(e);
  if (!combo) return null;
  for (const s of SHORTCUTS) if (bindingFor(s.id).toLowerCase() === combo.toLowerCase()) return s.id;
  return null;
}
