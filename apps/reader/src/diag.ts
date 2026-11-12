// The app's own small record of how it runs on this device — for the Performance page (Settings → About), where it
// can be copied or saved and sent by the reader himself. Nothing here is ever sent anywhere by the app.
// Kept: times, counts, kinds and rounded sizes only — never a book's title, a file's name, a word of text, a search,
// an address, a key or an account. Always on, so it costs almost nothing: observers the browser feeds (no polling),
// numbers kept in memory, written to localStorage (`kr.diag`, capped in bytes) in idle moments, when the app is hidden
// or left, and every half minute while it is in use — never on the way of a touch or a scroll. Its own cost is
// measured and shown. Not in backups or sync (backup.ts and sync.ts carry only the keys they name).

const KEY = 'kr.diag';
/** The ring: the last sessions, the last events, and the whole record under this many bytes. */
export const DIAG_CAP = { sessions: 20, events: 200, bytes: 48 * 1024 };

export type EndHow = 'left' | 'bg' | 'unexpected';
export interface DiagEnv { v: string; plat: string; wv: string; scr: string; lang: string; mode: string; rm: boolean; dm?: number; sto?: string }
export interface DiagSession {
  /** Started (epoch ms). */ at: number;
  env: DiagEnv;
  /** Start-up marks, ms from the navigation's start: the script running, the library first shown, usable. */
  st: { js?: number; shown?: number; usable?: number; dcl?: number };
  /** How it ended (decided at the next start, or as the page was unloaded); none while it runs. */
  end?: EndHow;
  /** The screen at its last record, ms run, hidden then, a book open then. */
  scr: string; ran: number; hid: boolean; book: boolean;
  /** Long tasks and slow frames: counts over 50 ms, 100 ms, 250 ms, 1 s; long tasks while reading. */
  lt: number[]; laf: number[]; ltRead: number;
  /** The worst few: [ms, screen, 'task' | 'frame']. */
  worst: [number, string, string][];
  /** Taps and touches the browser timed as slow (over 100 ms from the touch to the next picture), the worst input delay. */
  ev: { slow: number; maxDelay: number; maxDur: number };
  /** The JS heap's peak (MB), where the platform says. */
  mem?: number;
  /** Books opened; times the reader was left; ms spent recording all this. */
  opens: number; leaves: number; oh: number;
}
export interface DiagEvent { t: number; k: string; [f: string]: string | number | boolean | undefined }
interface Store { s: DiagSession[]; e: DiagEvent[] }

const T0 = performance.now();
let overhead = 0;
/** Runs `fn`, its time counted as the recorder's own. */
function cost<T>(fn: () => T): T { const a = performance.now(); try { return fn(); } finally { overhead += performance.now() - a; } }

const load = (): Store => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Store | null; if (v && Array.isArray(v.s) && Array.isArray(v.e)) return v; } catch { /* none, or unreadable */ } return { s: [], e: [] }; };
let store: Store = { s: [], e: [] };
let cur: DiagSession;
let dirty = false; let pending = 0;

/** The version of Chrome the WebView (or the browser) is, from the user agent: a number, nothing else of it. */
const webview = (): string => { const m = /Chrome\/(\d+)/.exec(navigator.userAgent); if (m) return `Chrome ${m[1]}${/; wv\)/.test(navigator.userAgent) ? ' WebView' : ''}`; const f = /Firefox\/(\d+)/.exec(navigator.userAgent); if (f) return `Firefox ${f[1]}`; const s = /Version\/(\d+).*Safari/.exec(navigator.userAgent); return s ? `Safari ${s[1]}` : 'other'; };
const platform = (): string => { const w = window as unknown as { kurokawaDesktop?: unknown; Capacitor?: { isNativePlatform?(): boolean; getPlatform?(): string } }; if (w.kurokawaDesktop) return 'desktop'; if (w.Capacitor?.isNativePlatform?.()) return w.Capacitor.getPlatform?.() ?? 'native'; return 'web'; };
const readingMode = (): string => { try { const s = JSON.parse(localStorage.getItem('kr.visual') ?? 'null') as { readingMode?: string } | null; return s?.readingMode ?? 'chapters'; } catch { return '?'; } };
function env(): DiagEnv {
  return { v: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0', plat: platform(), wv: webview(), scr: `${screen.width}x${screen.height}@${Math.round(devicePixelRatio * 100) / 100}`, lang: (() => { try { return localStorage.getItem('kr.lang') || navigator.language.slice(0, 2); } catch { return '?'; } })(), mode: readingMode(), rm: matchMedia('(prefers-reduced-motion: reduce)').matches, dm: (navigator as Navigator & { deviceMemory?: number }).deviceMemory };
}

/** The record written now (and capped): the last sessions and events, then the oldest let go until it fits. */
export function diagFlush(): void {
  cost(() => {
    window.clearTimeout(pending); pending = 0;
    cur.ran = Math.round(Date.now() - cur.at); cur.oh = Math.round(overhead * 10) / 10;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) cur.mem = Math.max(cur.mem ?? 0, Math.round(mem.usedJSHeapSize / 1048576));
    if (store.s.length > DIAG_CAP.sessions) store.s.splice(0, store.s.length - DIAG_CAP.sessions);
    if (store.e.length > DIAG_CAP.events) store.e.splice(0, store.e.length - DIAG_CAP.events);
    let text = JSON.stringify(store);
    while (text.length > DIAG_CAP.bytes && (store.e.length > 20 || store.s.length > 1)) {
      if (store.e.length > 20) store.e.splice(0, Math.max(1, store.e.length >> 3)); else store.s.shift();
      text = JSON.stringify(store);
    }
    try { localStorage.setItem(KEY, text); dirty = false; } catch { /* full, or private mode: kept in memory */ }
  });
}
/** A write asked for, done when the app is idle (never on the way of a touch or a scroll). */
function later(): void {
  dirty = true; if (pending) return;
  const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
  pending = window.setTimeout(() => { pending = 0; if (w.requestIdleCallback) w.requestIdleCallback(() => { if (dirty) diagFlush(); }, { timeout: 5000 }); else diagFlush(); }, 1500);
}

/** One thing that happened (kinds and numbers only). */
export function diagEvent(k: string, f: Record<string, string | number | boolean | undefined> = {}): void {
  cost(() => { store.e.push({ t: Date.now(), k, ...f }); if (store.e.length > DIAG_CAP.events + 20) store.e.splice(0, 20); });
  later();
}

/** A start-up mark (the first time only). */
export function diagMark(m: 'shown' | 'usable'): void {
  if (cur.st[m] !== undefined) return;
  // (The picture after this frame: what the reader sees, not when it was asked for.)
  requestAnimationFrame(() => setTimeout(() => { cost(() => { if (cur.st[m] === undefined) cur.st[m] = Math.round(performance.now()); }); later(); }, 0));
}

let screenNow = 'start';
/** The screen on show (the route's name). */
export function diagScreen(name: string): void { screenNow = name; cur.scr = name; later(); }

/* ---- leaving the reader, and why ---- */
let lastEdge = -1e9; let edgeSide = ''; let touching = false;
let intent: { why: string; at: number; f?: Record<string, string | number | boolean | undefined> } | null = null;
/** Whether a touch began at a screen edge (within 32 px) in the 600 ms before now — the system's back gesture
 *  starts there; a swipe across the page may too. */
function edge(): Record<string, string | number | boolean> {
  const ago = Math.round(performance.now() - lastEdge);
  return ago <= 600 ? { edge: edgeSide, edgeAgo: ago, touching } : { edge: 'none', touching };
}
/** What is about to leave the view on show — the back button or gesture, the top bar's back, a link, a book missing,
 *  an error. `weak`: kept only when nothing else said so a moment ago (the back button presses the top bar's back). */
export function diagLeaveIntent(why: string, weak = false, f?: Record<string, string | number | boolean | undefined>): void {
  const now = performance.now();
  if (weak && intent && now - intent.at < 400) return;
  intent = { why, at: now, f };
}
/** A press of back (Android's button or gesture, a computer's): kept with where the last touch began. */
export function diagBack(src: string): void {
  const e = cost(edge);
  diagLeaveIntent(src, false, e);
  diagEvent('back', { src, scr: screenNow, ...e });
}
/** The reader left, for the screen `to`: the reason said just before (within 2 s), else how the address changed. */
export function diagReaderLeft(to: string, move: string): void {
  const now = performance.now();
  const said = intent && now - intent.at < 2000 ? intent : null; intent = null;
  const why = said?.why ?? (move === 'pop' ? 'history' : 'code');
  cur.leaves++;
  diagEvent('leave', { why, to, ...(said?.f ?? {}), ...(openedAt ? { inBook: Math.round((now - openedAt) / 1000) } : {}) });
}

/* ---- opening a book ---- */
let openedAt = 0;
/** The opening not yet written (its place not yet put back): written as it is, if the book is left first. */
let unfinished: (() => void) | null = null;
const KINDS: Record<string, string> = { pdf: 'pdf', epub: 'epub', txt: 'text', md: 'text', html: 'text', fb2: 'text', docx: 'text', odt: 'text', webnovel: 'web novel', shamela: 'shamela' };
/** A size as a class, rounded: "100-500", "1k-5k"… (never the number itself). */
export function sizeClass(n: number): string {
  const steps = [10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1e6, 5e6, 1e7, 5e7];
  const f = (x: number) => (x >= 1e6 ? `${x / 1e6}M` : x >= 1000 ? `${x / 1000}k` : String(x));
  let lo = 0; for (const s of steps) { if (n < s) return `${f(lo)}-${f(s)}`; lo = s; }
  return `${f(lo)}+`;
}
/** A book being opened: the marks to call as its size is known, its first content shows, its place is put back. */
export function diagOpen(format: string, count = 1): { size(what: 'pages' | 'paras' | 'bytes', n: number): void; shown(): void; placed(): void; failed(what: string): void } {
  unfinished?.();
  const t0 = performance.now(); openedAt = t0; cur.book = true; cur.opens++;
  const rec: Record<string, string | number | boolean | undefined> = { kind: KINDS[format] ?? 'other', ...(count > 1 ? { books: count } : {}), mode: format === 'pdf' ? 'pdf' : readingMode() };
  let done = false;
  const ms = () => Math.round(performance.now() - t0);
  const finish = () => { if (done) return; done = true; if (unfinished === finish) unfinished = null; diagEvent('open', rec); };
  unfinished = () => { rec.left = 'before place'; finish(); };
  return {
    size: (what, n) => { rec[what] = sizeClass(n); },
    shown: () => { if (rec.first === undefined) rec.first = ms(); },
    placed: () => { if (rec.first === undefined) rec.first = ms(); if (rec.placed === undefined) rec.placed = ms(); finish(); },
    failed: (what) => { rec.failed = what; },
  };
}
/** No book open now (the reader left). */
export function diagBookClosed(): void { unfinished?.(); cur.book = false; openedAt = 0; later(); }

/* ---- slow moments ---- */
const bucket = (arr: number[], ms: number) => { if (ms > 50) arr[0]++; if (ms > 100) arr[1]++; if (ms > 250) arr[2]++; if (ms > 1000) arr[3]++; };
function worst(ms: number, kind: string): void {
  const w = cur.worst; if (w.length >= 5 && ms <= w[w.length - 1][0]) return;
  w.push([Math.round(ms), screenNow, kind]); w.sort((a, b) => b[0] - a[0]); w.length = Math.min(w.length, 5);
}
function observe(type: string, fn: (e: PerformanceEntry) => void, extra: Record<string, unknown> = {}): void {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    new PerformanceObserver((list) => { cost(() => { for (const e of list.getEntries()) fn(e); }); later(); }).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
  } catch { /* not here */ }
}

/** The record as it is now (the page reads it; the current session last). */
export function diagData(): { sessions: DiagSession[]; events: DiagEvent[]; overhead: number; since: number } {
  cur.ran = Math.round(Date.now() - cur.at); cur.oh = Math.round(overhead * 10) / 10;
  return { sessions: store.s.map((s) => ({ ...s })), events: store.e.slice(), overhead: cur.oh, since: cur.at };
}
/** Everything let go but the session running (its counts start over). */
export function diagClear(): void { store = { s: [], e: [] }; cur = fresh(); store.s.push(cur); diagFlush(); }

function fresh(): DiagSession {
  return { at: Date.now(), env: env(), st: {}, scr: screenNow, ran: 0, hid: document.visibilityState === 'hidden', book: false, lt: [0, 0, 0, 0], laf: [0, 0, 0, 0], ltRead: 0, worst: [], ev: { slow: 0, maxDelay: 0, maxDur: 0 }, opens: 0, leaves: 0, oh: 0 };
}

/* ---- the start ---- */
cost(() => {
  store = load();
  // How the last session ended, now that it has: left (unloaded in the ordinary way — marked as it went), else with a
  // book open (the reader's own mark, src/resume.ts, still there: an end it did not ask for) or on show — unexpected —,
  // else in the background and not seen again (the system ended it there).
  let readingMark = false; try { readingMark = !!localStorage.getItem('kr.reading'); } catch { /* none */ }
  const prev = store.s[store.s.length - 1];
  if (prev && !prev.end) {
    prev.end = prev.book || readingMark ? 'unexpected' : prev.hid ? 'bg' : 'unexpected';
    store.e.push({ t: Date.now(), k: 'ended', how: prev.end, scr: prev.scr, bg: prev.hid, book: prev.book || readingMark, ran: Math.round(prev.ran / 1000) });
  }
  cur = fresh();
  cur.st.js = Math.round(T0);
  store.s.push(cur);
  const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav) { const dcl = () => { cur.st.dcl = Math.round(nav.domContentLoadedEventEnd) || undefined; }; if (nav.domContentLoadedEventEnd) dcl(); else document.addEventListener('DOMContentLoaded', () => setTimeout(dcl, 0), { once: true }); }
});
observe('longtask', (e) => { bucket(cur.lt, e.duration); if (screenNow === 'read') cur.ltRead += e.duration > 50 ? 1 : 0; if (e.duration > 100) worst(e.duration, 'task'); });
observe('long-animation-frame', (e) => { bucket(cur.laf, e.duration); if (e.duration > 100) worst(e.duration, 'frame'); });
observe('event', (e) => {
  const ev = e as PerformanceEventTiming; if (!/^(pointer|touch|click|key|mouse)/.test(ev.name)) return;
  cur.ev.slow++; cur.ev.maxDur = Math.max(cur.ev.maxDur, Math.round(ev.duration)); cur.ev.maxDelay = Math.max(cur.ev.maxDelay, Math.round(ev.processingStart - ev.startTime));
}, { durationThreshold: 104 });
observe('first-input', (e) => { const ev = e as PerformanceEventTiming; cur.ev.maxDelay = Math.max(cur.ev.maxDelay, Math.round(ev.processingStart - ev.startTime)); });
// Where a touch begins (only numbers kept; nothing else done on the way of the touch).
addEventListener('touchstart', (e) => {
  const a = performance.now(); touching = true;
  const p = (e as TouchEvent).touches[0]; if (p) { const x = p.clientX, y = p.clientY, w = innerWidth, hh = innerHeight; const side = x < 32 ? 'left' : x > w - 32 ? 'right' : y > hh - 32 ? 'bottom' : y < 32 ? 'top' : ''; if (side) { lastEdge = a; edgeSide = side; } }
  overhead += performance.now() - a;
}, { capture: true, passive: true });
const untouch = () => { touching = false; };
addEventListener('touchend', untouch, { capture: true, passive: true }); addEventListener('touchcancel', untouch, { capture: true, passive: true });
// Hidden (the moment the system may end the app) and left: written at once.
const hidden = (h: boolean) => { cur.hid = h; if (h) diagFlush(); else later(); };
document.addEventListener('visibilitychange', () => hidden(document.visibilityState === 'hidden'));
addEventListener('pagehide', (e) => { if (!(e as PageTransitionEvent).persisted) cur.end = 'left'; diagFlush(); });
/** The native app's own word that it went to the background or came back (Capacitor's appStateChange). */
export function diagAppState(active: boolean): void { diagEvent(active ? 'fg' : 'bg', { scr: screenNow }); hidden(!active); }
// While in use, every half minute: how long it has run (the last record before an end no one saw).
setInterval(() => { if (document.visibilityState === 'visible') later(); }, 30000);
// The storage's size, once, well after the start.
setTimeout(() => void navigator.storage?.estimate?.().then((s) => { cur.env.sto = `${Math.round((s.usage ?? 0) / 1048576)}/${Math.round((s.quota ?? 0) / 1048576)} MB`; later(); }).catch(() => undefined), 8000);
diagFlush();
// (For tests and for a look from the WebView's inspector.)
(window as unknown as { __krDiag?: unknown }).__krDiag = { data: diagData, flush: diagFlush, event: diagEvent, clear: () => diagClear(), cap: DIAG_CAP };
