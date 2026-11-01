// Prism's drop zone and keyboard, for the whole app: links, magnets or a .torrent dragged onto the window go to the
// Add sheet (an outline says where to drop); and on a keyboard — Ctrl/⌘ N adds, Ctrl/⌘ V outside a field adds what
// was copied, Ctrl/⌘ , opens Settings, Ctrl/⌘ L turns the speed limiter on or off (the Downloads page adds its own:
// F for search, A to select all, Delete, Space, Escape).
import { h, icon, toast } from './dom';
import { t, formatBytes } from '../i18n';
import { navigate } from '../router';
import { getEngine, parseSources } from '../engine';
import { getSettings, updateSettings } from '../settings';

const typing = (e: Event) => { const el = e.target as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
const sheetOpen = () => !!document.querySelector('.sheet, .kt-player, .player-view');

export function startDropAndKeys(): void {
  let depth = 0; let veil: HTMLElement | null = null;
  const show = () => { if (veil) return; veil = h('div', { class: 'drop-veil' }, h('div', { class: 'drop-box' }, icon('download'), h('b', null, t('dropHere')), h('small', null, t('dropHint')))); document.body.append(veil); };
  const hide = () => { veil?.remove(); veil = null; depth = 0; };
  const carries = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).some((x) => x === 'Files' || x === 'text/uri-list' || x === 'text/plain');
  window.addEventListener('dragenter', (e) => { if (!carries(e) || sheetOpen()) return; depth++; show(); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) hide(); });
  window.addEventListener('dragover', (e) => { if (veil) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!veil) return; e.preventDefault(); hide();
    const dt = e.dataTransfer; if (!dt) return;
    const file = Array.from(dt.files).find((f) => /\.torrent$/i.test(f.name));
    if (file) { void import('../views/add').then((m) => m.addSheet('', { torrent: file })); return; }
    const text = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (text && parseSources(text).length) { void import('../views/add').then((m) => m.addSheet(text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).join('\n'))); return; }
    toast(t('dropNothing'), 'error');
  });
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey; if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n' && !e.shiftKey) { e.preventDefault(); void import('../views/add').then((m) => m.addSheet()); }
    else if (k === ',') { e.preventDefault(); navigate('/settings'); }
    else if (k === 'l' && !typing(e)) { e.preventDefault(); toggleLimiter(); }
    else if (k === 'v' && !typing(e) && !sheetOpen()) {
      void (async () => { let text = ''; try { const d = window.kurokawaTools as unknown as { clipboardText?(): Promise<string> } | undefined; text = d?.clipboardText ? await d.clipboardText() : await navigator.clipboard.readText(); } catch { /* not allowed */ } if (text && parseSources(text).length) void import('../views/add').then((m) => m.addSheet(text)); })();
    }
  });
}
/** The speed limiter on or off (the last limit kept, 2 MB/s the first time). */
export function toggleLimiter(): void {
  const s = getSettings(); const eng = getEngine(); const KEY = 'kt.lastLimit';
  if (!eng.can.limits) return;
  let l: typeof s.limits;
  if (s.limits.down) { try { localStorage.setItem(KEY, String(s.limits.down)); } catch { /* none */ } l = { ...s.limits, down: 0 }; }
  else { let v = 2 * 1048576; try { v = Number(localStorage.getItem(KEY)) || v; } catch { /* none */ } l = { ...s.limits, down: v }; }
  updateSettings({ limits: l }); void eng.setLimits?.(l);
  toast(l.down ? t('sbLimit', { v: t('perSecond', { n: formatBytes(l.down) }) }) : t('sbLimitOff'));
  window.dispatchEvent(new CustomEvent('kt:limits'));
}
