// The phone's keys and edges while a book is read (Android). The open reader says what it can do — whether sideways
// swipes turn its chapters, whether it is reading aloud, how it turns a page — and this asks the Android shell, only
// when it changes:
//  - setVolumeKeys({ on }): the volume keys turn pages (they then stop changing the volume) — the setting on, a book
//    open, nothing over it (a sheet, a panel, a full-screen view), nothing sounding (read aloud, a voice, a player),
//    the app on the screen. Each press comes back as the document event `kr:volume` ('up' | 'down').
//  - setEdgeGuard({ on }): a band in the middle of each side edge kept from the system's back gesture (the swipe
//    that turns a chapter starts there too) — the setting on (off by default), a book open in a mode where sideways
//    swipes turn chapters, its bars hidden (the reader reading, not finding his way: with the bars shown Back always
//    works), nothing over it, the app on the screen.
// And Back in the middle of a page-turn swipe (Android's back gesture fired by a swipe that began near an edge): taken
// as part of the swipe — ignored once — when the reader turned a chapter with that very swipe 350 ms or less before,
// or when it comes while the finger is still down and that touch then turns a chapter; a Back with no turn (a fresh
// gesture, the system's own swipe the page saw cancelled, the button) leaves as ever. See swipeBack below.
// And the phone's own Back zone (Android 10+ with gesture navigation: a strip at each side edge, as wide as "Back
// sensitivity" makes it — told by the shell, src/native.ts getGestureInsets): a touch that begins in it is the
// phone's — the reader starts no swipe from it (src/views/reader.ts), a Back during it goes on at once —, except in the
// band the edge guard keeps, when the guard is on. Two or three buttons: no zone, the whole width is the reader's.
// Everything is let go when the reader closes, something opens over it, or the app goes to the background
// (MainActivity also lets the keys go by itself when it is paused).
import { getSettings, onSettingsChange } from './settings';
import { nativePlatform, setVolumeKeys, setEdgeGuard, setBackGate, getGestureInsets, onGestureInsets, type GestureInsets } from './native';
import { diagBackHeld, diagEvent } from './diag';

export interface ReadingKeys {
  /** Whether a sideways swipe turns something in the book as it is shown now (chapter by chapter). */
  sideways(): boolean;
  /** Whether the reader is making sound (reading aloud, a voice playing): the keys then change the volume. */
  sounding(): boolean;
  /** The reader's own next / previous page or screen (onward in reading order when `forward`). */
  turn(forward: boolean): void;
  /** Whether the reader's bars (top bar, toolbar) are shown: the reader is finding his way, the edges are left to Back. */
  barsShown?(): boolean;
  /** The reader's own element, watched for its bars shown or hidden (a class). */
  root?: HTMLElement;
}

let reader: ReadingKeys | null = null;
let sentVol: boolean | null = null;
let sentEdge: boolean | null = null;
let queued = false;
let wired = false;
let offSettings: (() => void) | null = null;
let observer: MutationObserver | null = null;
let active = true;

/** Something over the book: a sheet or menu, a side panel that floats over the text, a full-screen view, the
 *  camera, the app's lock. (Existence, not layout: the check runs often and must not force a layout.) */
export function overBook(): boolean {
  if (document.querySelector('.sheet, .cam-view, .app-lock, .panel.open:not(.docked)')) return true;
  for (const d of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))) if (!d.classList.contains('panel') && !d.hidden) return true;
  return false;
}
const soundingAnywhere = (): boolean => {
  if (reader?.sounding()) return true;
  try { if ('speechSynthesis' in window && speechSynthesis.speaking && !speechSynthesis.paused) return true; } catch { /* none */ }
  return Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video')).some((m) => !m.paused && !m.muted);
};

function evaluate(): void {
  queued = false;
  if (nativePlatform() !== 'android') return;
  const s = getSettings();
  const shown = active && document.visibilityState !== 'hidden';
  const free = !!reader && shown && !overBook();
  const vol = free && s.volumeKeys && !soundingAnywhere();
  const edge = free && s.edgeGuard && !!reader?.sideways() && !reader?.barsShown?.();
  if (vol !== sentVol) { sentVol = vol; void setVolumeKeys(vol); }
  if (edge !== sentEdge) { sentEdge = edge; void setEdgeGuard(edge); }
}
/** Ask again (soon, once however many times it is called) what the shell should do: the reader calls it when it
 *  starts or stops sounding; settings, sheets and the app's state call it by themselves. */
export function refreshReadingKeys(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(evaluate);
}

const onVolume = (e: Event): void => {
  if (!reader || !sentVol) return;   // (a press already on its way when the keys were let go)
  const down = (e as CustomEvent<string>).detail !== 'up';
  reader.turn(getSettings().volumeSwap ? !down : down);
};
const onAppState = (e: Event): void => { active = (e as CustomEvent<boolean>).detail !== false; if (active) { sentVol = sentEdge = null; askZone(); } else noteSystemTouches(); refreshReadingKeys(); };
const onVisible = (): void => { if (document.visibilityState === 'visible') sentVol = sentEdge = null; refreshReadingKeys(); };

function wire(): void {
  if (wired) return; wired = true;
  document.addEventListener('kr:volume', onVolume);
  document.addEventListener('kr:appstate', onAppState);
  document.addEventListener('kr:panel', refreshReadingKeys);
  document.addEventListener('visibilitychange', onVisible);
  // (The touches, for Back in the middle of a swipe: where each began, whether it is still down. Passive, nothing
  // done on the way of the touch but two numbers kept; the end heard after the reader's own handlers.)
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchCancel, { passive: true });
  setBackGate(swipeBack);
  onGestureInsets((g) => { sys = g; });
}

/* ---------- The phone's own Back zone ---------- */
let sys: GestureInsets = { left: 0, right: 0, nav: 'none' };
/** Touches begun in the phone's zone while a book was open, not yet in the record. */
let leftToSystem = 0;
/** The edge guard's band (KurokawaPlugin.java layEdgeGuard: 40 % of the height, 200 dp at most, centred). */
const guardBand = (y: number): boolean => { const h = innerHeight; const band = Math.min(Math.floor(h * 0.4), 200); const top = (h - band) / 2; return y >= top && y < top + band; };
/** The zone as last told: its widths at the left and right edges (CSS px) and the navigation. */
export function systemZone(): GestureInsets { return sys; }
/** Whether a touch that begins at (x, y) is the phone's (its Back zone, outside the guarded band when the guard is on). */
export function inSystemZone(x: number, y: number): boolean {
  if (!(sys.left > 0 && x < sys.left) && !(sys.right > 0 && x >= innerWidth - sys.right)) return false;
  return !(sentEdge && guardBand(y));
}
function askZone(open = false): void {
  void getGestureInsets().then((g) => {
    if (g) sys = g;
    // (For the Performance page: the zone and the navigation as the book opened.)
    if (open) diagEvent('syszone', { l: Math.round(sys.left), r: Math.round(sys.right), nav: g ? sys.nav : 'unknown', guard: getSettings().edgeGuard });
  });
}
function noteSystemTouches(): void { if (leftToSystem) { diagEvent('systouch', { n: leftToSystem }); leftToSystem = 0; } }

/* ---------- Back in the middle of a page-turn swipe ---------- */
/** How long after a chapter turned by a swipe a Back is still taken as that swipe's (ms); also how long a Back that
 *  comes with a finger still down waits for that touch to end. */
export const SWIPE_BACK_MS = 350;
/** A touch that began within this many px of a side edge (where Android's back gesture starts). */
export const EDGE_PX = 32;
let touchDown = false;
let touchAt = -1e9;
let touchEdge = '';
/** The touch under way began in the phone's Back zone. */
let touchSys = false;
/** When the reader last turned a chapter by a swipe (of the touch that began at `touchAt`); -1e9 when none since. */
let turnAt = -1e9;
let waiting: { go: () => void; timer: number } | null = null;

function onTouchStart(e: TouchEvent): void {
  if (e.touches.length > 1) return;
  const p = e.touches[0]; touchDown = true; touchAt = performance.now(); turnAt = -1e9;
  touchEdge = p && p.clientX <= EDGE_PX ? 'left' : p && p.clientX >= innerWidth - EDGE_PX ? 'right' : '';
  touchSys = !!p && !!reader && inSystemZone(p.clientX, p.clientY);
  if (touchSys) leftToSystem++;
}
function onTouchEnd(e: TouchEvent): void {
  if (e.touches.length) return;
  touchDown = false;
  // (Heard after the reader's own touchend: a chapter turned by this touch is known by now.)
  if (waiting) settle(turnAt >= touchAt ? 'hold' : 'go', 'down');
}
function onTouchCancel(e: TouchEvent): void {
  if (e.touches.length) return;
  touchDown = false;
  // (Cancelled: the system took the touch — its back gesture. The Back that waited for it goes on.)
  if (waiting) settle('go', 'cancel');
}
function settle(how: 'hold' | 'go', why: string): void {
  const w = waiting; if (!w) return;
  waiting = null; window.clearTimeout(w.timer);
  if (how === 'hold') { turnAt = -1e9; diagBackHeld('swipe', { how: why, edge0: touchEdge || 'none' }); return; }
  w.go();
}

/** The reader turned a chapter (or a page) by a sideways swipe just now: a Back that comes right after it, from the
 *  same swipe, is the swipe's, not the reader's. Called by the reader from its touchend. */
export function swipeTurned(): void { turnAt = performance.now(); }

/** Back, offered to the open reader before anything else (src/native.ts): true when it is taken — ignored once as part
 *  of a page-turn swipe, or kept until the touch under way ends (`go` then called unless that touch turned a chapter;
 *  `SWIPE_BACK_MS` at most). False: Back goes on as ever. */
function swipeBack(go: () => void): boolean {
  if (!reader) return false;
  // (A second press while the first waits: the first goes on, and this one after it.)
  if (waiting) { settle('go', 'again'); return false; }
  const ago = performance.now() - turnAt;
  if (ago <= SWIPE_BACK_MS) { turnAt = -1e9; diagBackHeld('swipe', { how: 'after-turn', ms: Math.round(ago), edge0: touchEdge || 'none' }); return true; }
  // (A touch begun in the phone's own zone turns nothing: its Back goes on at once.)
  if (touchDown && !touchSys) { waiting = { go, timer: window.setTimeout(() => { touchDown = false; settle('go', 'timeout'); }, SWIPE_BACK_MS) }; return true; }
  return false;
}

/** The reader on the screen, while it is there: the returned function is called when it goes. */
export function readingKeys(r: ReadingKeys): () => void {
  if (nativePlatform() !== 'android') return () => undefined;
  wire();
  reader = r;
  offSettings?.(); offSettings = onSettingsChange(() => refreshReadingKeys());
  // (Sheets, menus and full-screen views come and go as elements: watched while a book is open, and only then.)
  observer?.disconnect();
  observer = new MutationObserver(() => refreshReadingKeys());
  observer.observe(document.body, { childList: true, subtree: true });
  // (…and the reader's bars, shown or hidden by a class on its own element.)
  if (r.root) observer.observe(r.root, { attributes: true, attributeFilter: ['class'] });
  turnAt = -1e9;
  // (For the Performance page: whether the edges were to be kept in this book — the setting, as the book opened.)
  diagEvent('edgeguard', { on: getSettings().edgeGuard, sideways: r.sideways() });
  askZone(true);
  refreshReadingKeys();
  return () => {
    if (reader !== r) return;
    reader = null;
    offSettings?.(); offSettings = null;
    observer?.disconnect(); observer = null;
    // (A Back still waiting for its touch when the book is left some other way: not done on the next screen.)
    if (waiting) { window.clearTimeout(waiting.timer); waiting = null; }
    turnAt = -1e9;
    noteSystemTouches();
    evaluate();
  };
}
