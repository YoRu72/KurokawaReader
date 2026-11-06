// How much waits at the sources — new chapters, new volumes in a web folder — as last counted: kept so the library's
// Browse button can show its mark at once, without loading the sources (sources/updates.ts counts and writes it).
export interface Pending { chapters: number; series: number }
const KEY = 'kr.updates.pending'; const EVENT = 'kr-pending';
export function readPending(): Pending { try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Pending | null; return v && typeof v.chapters === 'number' ? v : { chapters: 0, series: 0 }; } catch { return { chapters: 0, series: 0 }; } }
export function writePending(p: Pending): void {
  const was = readPending(); if (was.chapters === p.chapters && was.series === p.series) return;
  try { localStorage.setItem(KEY, JSON.stringify({ chapters: p.chapters, series: p.series })); } catch { /* full */ }
  window.dispatchEvent(new Event(EVENT));
}
export function onPendingChanged(fn: () => void): () => void { window.addEventListener(EVENT, fn); return () => window.removeEventListener(EVENT, fn); }
