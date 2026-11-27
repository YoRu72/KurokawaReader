// What the Anime screens show while the catalogue is slow, busy or away. One rule for every list: the request has a
// time budget (anilist.ts), a wait the catalogue asked for is shown — counted down, and can be cancelled —, the last good
// answer of that list is shown at once when there is one (marked as being refreshed; anime/listCache.ts) and replaced
// when the new one comes, and a failure says why in plain words with a «Try again» button. A spinner alone never stays
// for good: the request ends in an answer or in an error the user can see.
import { h, icon } from '../ui/dom';
import { t } from '../i18n';
import * as al from '../anilist';
import { cached, keep } from '../anime/listCache';

/** Why a request failed, in plain words (the catalogue's own message when it is none of the usual faults). */
export function reasonOf(e: unknown): string {
  switch (al.faultKind(e)) {
    case 'offline': return t('animeNetOffline');
    case 'timeout': return t('animeNetTimeout');
    case 'cut': return t('animeNetCut');
    case 'busy': return t('animeNetBusy');
    case 'server': return t('animeNetServer');
    case 'bad': return t('animeNetBad');
    case 'cancelled': return t('animeNetCancelled');
    default: { const m = String((e as Error)?.message ?? e ?? '').trim(); return m && m !== 'cancelled' ? m : t('animeNetBad'); }
  }
}

/** Waits that can all be stopped at once (leaving the tab): `next()` stops the previous request of the screen and gives
 *  the signal of the new one. */
export function scope(): { next: () => AbortSignal; stop: () => void } {
  let c = new AbortController();
  return { next: () => { c.abort(); c = new AbortController(); return c.signal; }, stop: () => { c.abort(); c = new AbortController(); } };
}

/** The failure of a list that has nothing else to show: why, and a «Try again» button. */
export function failBlock(e: unknown, retry: () => void): HTMLElement {
  return h('div', { class: 'empty net-fail' }, icon(al.faultKind(e) === 'offline' ? 'wifi' : 'alert'), h('p', { dir: 'auto' }, reasonOf(e)), h('button', { type: 'button', class: 'btn tonal net-btn', onclick: retry }, icon('refresh'), t('animeNetRetry')));
}
const spinner = (): HTMLElement => h('div', { class: 'center' }, h('div', { class: 'spinner' }));

/** The strip above a list: «refreshing», the wait the catalogue asked for (with Cancel), or the failure kept beside what
 *  is shown (with Try again). Hidden when there is nothing to say. */
export interface Notice { el: HTMLElement; refreshing(): void; slow(): void; wait(n: number, cancel: () => void): void; failed(e: unknown, partial: boolean, retry: () => void): void; plain(e: unknown, retry: () => void): void; clear(): void }
export function notice(): Notice {
  const el = h('div', { class: 'net-note', role: 'status', hidden: true });
  const set = (cls: string, text: string, ...acts: HTMLElement[]) => { el.hidden = false; el.className = `net-note ${cls}`; el.replaceChildren(cls.startsWith('busy') ? h('span', { class: 'mini-spinner' }) : icon(cls === 'bad' ? 'alert' : 'refresh'), h('span', { class: 'net-text', dir: 'auto' }, text), ...acts); };
  const btn = (label: string, on: () => void, ic: string) => h('button', { type: 'button', class: 'btn tonal net-btn', onclick: on }, icon(ic), label);
  return {
    el,
    refreshing: () => set('busy', t('animeNetRefreshing')),
    slow: () => { if (el.className.includes('wait') || el.className.includes('bad')) return; set('busy', t('animeNetSlow')); },
    wait: (n, cancel) => { if (n <= 0) { el.hidden = true; return; } set('busy wait', t('animeNetWait', { n }), btn(t('cancel'), cancel, 'close')); },
    failed: (e, partial, retry) => set('bad', `${partial ? t('animeNetPartial') : t('animeNetKept')} ${reasonOf(e)}`, btn(t('animeNetRetry'), retry, 'refresh')),
    plain: (e, retry) => set('bad', reasonOf(e), btn(t('animeNetRetry'), retry, 'refresh')),
    clear: () => { el.hidden = true; el.replaceChildren(); },
  };
}

export interface LoadOpts<T> {
  /** The list's place: filled with the strip and the content. */
  host: HTMLElement;
  /** Stops the request and every wait of it when aborted (see scope()). */
  signal: AbortSignal;
  /** Still the list wanted (the tab's and the reload's own tokens). */
  live?: () => boolean;
  /** The name the last good answer is kept under; none: nothing is kept. */
  key?: string;
  /** The request. `part` paints what is already there (a first page) while the rest is asked for. */
  ask: (net: al.Net, part: (v: T) => void) => Promise<T>;
  /** Draws the answer into the box (it may throw: the list is then taken as failed, not blank). */
  show: (v: T, box: HTMLElement) => void;
  /** An answer with nothing in it is not kept. */
  empty?: (v: T) => boolean;
}
/** Runs the request into the host. Returns nothing: the caller's signal is the way to stop it. */
export function netLoad<T>(o: LoadOpts<T>): void {
  const note = notice(); const box = h('div', { class: 'net-box' });
  o.host.replaceChildren(note.el, box);
  const live = (): boolean => !o.signal.aborted && (o.live?.() ?? true);
  const ctl = new AbortController(); let done = false; let painted = false; let userCancel = false; let kept = false; let slowTm = 0;
  const onAbort = () => ctl.abort(); o.signal.addEventListener('abort', onAbort);
  const stop = () => { done = true; window.clearTimeout(slowTm); o.signal.removeEventListener('abort', onAbort); window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline); };
  const again = () => { stop(); ctl.abort(); netLoad(o); };
  const draw = (v: T): boolean => { try { o.show(v, box); painted = true; return true; } catch { return false; } };
  const fail = (e: unknown) => {
    if (done) return; stop(); if (!live()) return;
    if (al.faultKind(e) === 'cancelled' && !userCancel) return;
    if (painted) { note.failed(userCancel ? new Error(t('animeNetCancelled')) : e, !kept, again); return; }
    box.replaceChildren(failBlock(userCancel ? new Error(t('animeNetCancelled')) : e, again));
    // (Offline: the list is asked for again by itself once the phone is back online.)
    if (al.faultKind(e) === 'offline') { window.addEventListener('online', onOnline); o.signal.addEventListener('abort', () => window.removeEventListener('online', onOnline), { once: true }); }
  };
  function onOnline() { if (live()) again(); }
  function onOffline() { if (done || !live()) return; fail(Object.assign(new Error('offline'), { kind: 'offline' as al.FaultKind })); ctl.abort(); }
  window.addEventListener('offline', onOffline);

  const had = o.key ? cached<T>(o.key) : null;
  if (had && draw(had.v)) { kept = true; note.refreshing(); } else { box.replaceChildren(spinner()); slowTm = window.setTimeout(() => { if (!done && live()) note.slow(); }, 6000); }
  const net: al.Net = { signal: ctl.signal, onWait: (n) => { if (!done && live()) { if (n <= 0) { if (painted) note.refreshing(); else note.clear(); return; } note.wait(n, () => { userCancel = true; ctl.abort(); }); } } };
  let first = true;
  o.ask(net, (v) => { if (done || !live()) return; if (draw(v) && first) { first = false; window.clearTimeout(slowTm); if (!kept) note.clear(); } }).then((v) => {
    if (done) return; if (!live()) { stop(); return; }
    if (!draw(v)) { fail(new Error('bad')); return; }
    stop(); note.clear(); if (o.key && !o.empty?.(v)) keep(o.key, v);
  }, fail);
}
