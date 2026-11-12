// A book open when the app was ended under it — the phone's system ended the app in the background for its memory,
// or the page that draws it (the WebView's renderer) was ended and the app started again — is open again when the
// app comes back, at its saved place: such a start used to land in the library, the book closed "by itself". A book
// left by the reader (back, the library, another book) is not: leaving it clears the mark; nor one whose page was
// closed in the ordinary way (a window or tab closed, the page loaded again: it is unloaded — an app ended by the
// system is not). Only soon after (the app gone a short while), and only once: a book that ends the app each time it
// opens is not opened again and again.
const KEY = 'kr.reading';
/** How long the app may have been away for the book to be opened again at its start. */
const SOON_MS = 30 * 60000;

interface Mark { ids: string[]; at: number; again?: number }
const read = (): Mark | null => { try { const m = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Mark | null; return m && Array.isArray(m.ids) && m.ids.length && typeof m.at === 'number' ? m : null; } catch { return null; } };
const write = (m: Mark | null) => { try { if (m) localStorage.setItem(KEY, JSON.stringify(m)); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

/** The reader opened these books: marked open, and kept marked (its time renewed) when the app is hidden — the
 *  moment the system may end it. Returns the clean-up for the reader's leaving: the mark cleared. */
export function markReading(ids: string[]): () => void {
  const had = read();
  // (Opened again by the start below: counted, so that a second end in a row does not open it a third time.)
  const again = had && had.ids.join() === ids.join() && had.again ? had.again : 0;
  write({ ids, at: Date.now(), ...(again ? { again } : {}) });
  const mine = () => { const m = read(); return m && m.ids.join() === ids.join() ? m : null; };
  const renew = () => { const m = mine(); if (m) write({ ...m, at: Date.now() }); };
  const onVis = () => { if (document.visibilityState === 'hidden') renew(); };
  // (Unloaded — closed, or loaded again — by the reader or the app: not an end it did not ask for.)
  const unloaded = (e: PageTransitionEvent) => { if (!e.persisted && mine()) write(null); };
  document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', unloaded);
  // (Read for a while after being opened again: it did not end the app — the count starts over.)
  const settled = again ? window.setTimeout(() => { if (mine()) write({ ids, at: Date.now() }); }, 20000) : 0;
  return () => {
    document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', unloaded); window.clearTimeout(settled);
    if (mine()) write(null);
  };
}

/** At the app's start, on the library: the books to open again (and the mark counted as used), or null. */
export function takeResume(now = Date.now()): string[] | null {
  const m = read(); if (!m) return null;
  if (now - m.at > SOON_MS || (m.again ?? 0) >= 1) { write(null); return null; }
  write({ ...m, again: (m.again ?? 0) + 1 });
  return m.ids;
}
