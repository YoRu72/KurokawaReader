// The dispatcher of Back (ui/backstack.ts holds the stack): one step back, whoever asked — Android's back key or
// gesture, an arrow in the page, a mouse's back button, Alt+←, the desktop shell's back, Esc on a computer.
import { layers, tabTrail, tabPath, type Layer, type LayerKind } from './backstack';
import { navigate, parseRoute, sectionOfRoute } from '../router';

const MODAL: LayerKind[] = ['sheet', 'menu', 'dialog', 'overlay', 'player', 'fullscreen', 'editor'];
const live = (l: Layer) => { try { return l.on ? l.on() : true; } catch { return false; } };
const tryLayers = (pick: (l: Layer) => boolean): boolean => {
  for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; if (!l || !pick(l) || !live(l)) continue; if (l.back()) return true; }
  return false;
};
const visible = (d: Element) => d.getClientRects().length > 0 && getComputedStyle(d).visibility !== 'hidden';
/** What is open on top without a layer of its own (an older overlay): its close pressed. */
function domFallback(): boolean {
  const sheets = document.querySelectorAll('.sheet'); const top = sheets[sheets.length - 1] as (HTMLElement & { __close?: () => void }) | undefined;
  if (top) { const b = top.querySelector<HTMLButtonElement>(':scope > .sheet-head > button[data-icon="close"]'); if (b) b.click(); else top.__close?.(); return true; }
  const panelClose = document.querySelector<HTMLButtonElement>('.panel.open .panel-head button'); if (panelClose) { panelClose.click(); return true; }
  const overlays = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => !d.classList.contains('panel') && !d.classList.contains('sheet') && visible(d));
  const btn = overlays.length ? overlays[overlays.length - 1].querySelector<HTMLButtonElement>('.lb-close, .topbar button, button[aria-label]') : null;
  if (btn) { btn.click(); return true; }
  return false;
}
const ROOT: Record<string, string> = { downloads: '/', search: '/search', anime: '/anime', tv: '/tv', videos: '/videos', files: '/files', subs: '/subs', settings: '/settings' };
/** At a tab's top: to the tab the reader came from (as it was left), else the downloads; false at the downloads' top. */
export function leaveTab(): boolean {
  const here = sectionOfRoute(parseRoute());
  if (here === 'downloads') { const hs = location.hash; if (hs && hs !== '#/' && hs !== '#') { navigate('/'); return true; } return false; }
  const i = tabTrail.lastIndexOf(here); if (i >= 0) tabTrail.splice(i, 1);
  const to = tabTrail[tabTrail.length - 1] ?? 'downloads';
  navigate(tabPath.get(to) ?? ROOT[to] ?? '/');
  return true;
}
/** One step back. `esc`: a computer's Esc — what is open and a selection or a search only; never a page or a tab. */
export function goBack(mode: 'back' | 'esc' = 'back'): boolean {
  if (tryLayers((l) => l.kind === 'sheet' || l.kind === 'menu')) return true;
  if (document.querySelector('.sheet') && domFallback()) return true;
  if (tryLayers((l) => MODAL.includes(l.kind))) return true;
  if (domFallback()) return true;
  if (tryLayers((l) => !MODAL.includes(l.kind) && (mode === 'back' || l.kind === 'selection' || l.kind === 'search'))) return true;
  if (mode === 'esc') return false;
  const viewBack = Array.from(document.querySelectorAll<HTMLButtonElement>('.view .topbar button[data-icon="back"]')).find(visible);
  if (viewBack) { viewBack.click(); return true; }
  return leaveTab();
}

let wired = false;
/** A computer's ways back: the mouse's back button, Alt+← (not while typing), Esc for what is open. */
export function wirePcBack(): void {
  if (wired) return; wired = true;
  // (The mouse's back button: its press kept from the page, so no text is selected and the browser does not go
  // back a page on its own. Its forward button, and Alt+→: forward again to where back came from.)
  window.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);
  window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } else if (e.button === 4) { e.preventDefault(); history.forward(); } }, true);
  const typing = (e: Event) => !!(e.target as HTMLElement).matches?.('input, textarea, select, [contenteditable], [contenteditable] *');
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey && !typing(e) && goBack('esc')) e.preventDefault(); return; }
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey || e.shiftKey || typing(e)) return;
    e.preventDefault(); if (e.key === 'ArrowLeft') goBack(); else history.forward();
  });
  // (For the tests and the audit: the stack as it stands.)
  (window as unknown as { __ktBack?: unknown }).__ktBack = { layers, tabTrail, goBack };
}
