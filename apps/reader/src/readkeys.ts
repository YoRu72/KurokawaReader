// The phone's keys and edges while a book is read (Android). The open reader says what it can do — whether sideways
// swipes turn its chapters, whether it is reading aloud, how it turns a page — and this asks the Android shell, only
// when it changes:
//  - setVolumeKeys({ on }): the volume keys turn pages (they then stop changing the volume) — the setting on, a book
//    open, nothing over it (a sheet, a panel, a full-screen view), nothing sounding (read aloud, a voice, a player),
//    the app on the screen. Each press comes back as the document event `kr:volume` ('up' | 'down').
//  - setEdgeGuard({ on }): a band in the middle of each side edge kept from the system's back gesture (the swipe
//    that turns a chapter starts there too) — the setting on, a book open in a mode where sideways swipes turn
//    chapters, nothing over it, the app on the screen.
// Everything is let go when the reader closes, something opens over it, or the app goes to the background
// (MainActivity also lets the keys go by itself when it is paused).
import { getSettings, onSettingsChange } from './settings';
import { nativePlatform, setVolumeKeys, setEdgeGuard } from './native';

export interface ReadingKeys {
  /** Whether a sideways swipe turns something in the book as it is shown now (chapter by chapter). */
  sideways(): boolean;
  /** Whether the reader is making sound (reading aloud, a voice playing): the keys then change the volume. */
  sounding(): boolean;
  /** The reader's own next / previous page or screen (onward in reading order when `forward`). */
  turn(forward: boolean): void;
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
  const edge = free && s.edgeGuard && !!reader?.sideways();
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
const onAppState = (e: Event): void => { active = (e as CustomEvent<boolean>).detail !== false; if (active) { sentVol = sentEdge = null; } refreshReadingKeys(); };
const onVisible = (): void => { if (document.visibilityState === 'visible') sentVol = sentEdge = null; refreshReadingKeys(); };

function wire(): void {
  if (wired) return; wired = true;
  document.addEventListener('kr:volume', onVolume);
  document.addEventListener('kr:appstate', onAppState);
  document.addEventListener('kr:panel', refreshReadingKeys);
  document.addEventListener('visibilitychange', onVisible);
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
  refreshReadingKeys();
  return () => {
    if (reader !== r) return;
    reader = null;
    offSettings?.(); offSettings = null;
    observer?.disconnect(); observer = null;
    evaluate();
  };
}
