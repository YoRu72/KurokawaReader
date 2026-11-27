// The player's first moment for a stream that is not ready yet (a release still being found, its details still coming,
// an online address still being asked for): the player's own black screen opens at once, from wherever the user is,
// with a back button, a spinner and a line that says what is happening. Back (the button, the system's back, the
// Escape key) stops the start cleanly and leaves the page exactly as it was. When the stream is ready the real player
// takes the screen (`handover`); its own guard (streamGuard.ts) goes on from there. A start that cannot be made shows
// the same sheet the guard shows — Try again, Back and, when there is another stream to choose, «Another stream».
import { h, icon, iconButton, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { pushLayer } from '../ui/backstack';
import { notePlayerOpen, playerClosed } from './returnTo';

export interface Start {
  /** Back was pressed (or the start was closed): nothing more should be asked for. */
  readonly cancelled: boolean;
  /** What is happening now, and how far (0–100) when it is known. */
  status(text: string, pct?: number): void;
  /** The start could not be made: the sheet with Try again / Back (/ Another stream). */
  fail(why: string, o: { retry?: () => void; another?: () => void }): void;
  /** The real player took over: this screen goes without a trace (no «back to the page»). */
  handover(): void;
  /** Closed from outside (nothing to tell the opener). */
  close(): void;
}
export function openStart(o: { title: string; meta?: { anilistId?: number; episode?: number }; onCancel: () => void; /** The page's sheet put back when the start is left (the chooser the stream was picked in). */ after?: () => void }): Start {
  notePlayerOpen(o.meta);
  let gone = false; let handed = false; let cancelled = false; let failed = false; let sheetClose: (() => void) | null = null;
  const line = h('div', { class: 'kt-wait kt-start-line', role: 'status', 'aria-live': 'polite' }, t('streamStarting'));
  const bar = h('div', { class: 'kt-start-bar', hidden: true }, h('i'));
  const root = h('div', { class: 'player-view kt-player kt-start', role: 'dialog', 'aria-label': o.title },
    h('div', { class: 'kt-top' }, iconButton('back', t('back'), () => cancel()), h('span', { class: 'kt-title grow', dir: 'auto' }, o.title)),
    h('div', { class: 'kt-centre busy' }, line, bar),
    h('div', { class: 'kt-start-actions' }, h('button', { type: 'button', class: 'btn tonal', onclick: () => cancel() }, t('cancel'))));
  const unBack = pushLayer({ kind: 'player', name: 'player start', on: () => root.isConnected, back: () => { cancel(); return true; } });
  document.body.append(root);
  function end() { if (gone) return; gone = true; sheetClose?.(); sheetClose = null; unBack(); root.remove(); }
  function cancel() { if (gone) return; cancelled = true; end(); o.onCancel(); playerClosed({ watched: false, meta: o.meta, at: location.hash }); o.after?.(); }
  return {
    get cancelled() { return cancelled || (gone && !handed); },
    status(text, pct) { if (gone) return; line.textContent = text; if (pct !== undefined && isFinite(pct)) { bar.hidden = false; (bar.firstChild as HTMLElement).style.width = `${Math.max(3, Math.min(100, Math.round(pct)))}%`; } },
    fail(why, a) {
      if (gone || sheetClose) return; failed = true; root.querySelector('.kt-centre')?.classList.remove('busy');
      const sh = openSheet(t('streamDeadTitle'), t('close'), { stack: true, onClose: () => { sheetClose = null; } }); sheetClose = sh.close; sh.body.classList.add('kt-problem');
      const act = (label: string, ic: string, cls: string, fn: () => void) => h('button', { type: 'button', class: `btn ${cls}`, onclick: () => { sh.close(); fn(); } }, icon(ic), label);
      sh.body.append(h('p', { class: 'kt-problem-msg', dir: 'auto' }, why), h('div', { class: 'ext-error-actions' },
        ...(a.retry ? [act(t('streamRetry'), 'refresh', 'primary', () => { failed = false; root.querySelector('.kt-centre')?.classList.add('busy'); line.textContent = t('streamStarting'); a.retry!(); })] : []),
        act(t('streamBack'), 'back', 'tonal', () => cancel()),
        ...(a.another ? [act(t('streamAnother'), 'list', 'tonal', () => { cancelled = true; end(); o.onCancel(); playerClosed({ watched: false, meta: o.meta, at: location.hash }); a.another!(); })] : [])));
    },
    handover() { if (!failed) { handed = true; end(); } },
    close() { end(); },
  };
}
