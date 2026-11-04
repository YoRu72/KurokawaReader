// Subtitle translations kept on the device (IndexedDB): a track translated once is there the next time the same
// subtitle is opened — with no connection, as the Reader keeps its book translations — and a translation stopped
// midway is taken up where it stopped. Keyed by the subtitle's own text, so the same file under another name finds it.
import { db } from '../db';
import type { Cue } from './subs';

type Saved = { at: number; texts: string[] };
const INDEX = 'subtr:index';
const hash = (s: string): string => { let a = 0x811c9dc5; for (let i = 0; i < s.length; i++) { a ^= s.charCodeAt(i); a = Math.imul(a, 0x01000193) >>> 0; } return a.toString(36); };
/** A subtitle's identity: its line count and a hash of its text. */
export const keyOf = (tr: { cues: Cue[] }): string => `${tr.cues.length}:${hash(tr.cues.map((c) => c.text).join('\n'))}`;

/** The saved translation of `tr` into `target` (texts by cue index), or null. */
export async function loadSaved(tr: { cues: Cue[] }, target: string): Promise<string[] | null> {
  try { const s = await db.getMeta<Saved>(`subtr:${keyOf(tr)}:${target}`); return s && s.texts.length === tr.cues.length ? s.texts : null; } catch { return null; }
}
/** The languages `tr` was translated into before. */
export async function savedTargets(tr: { cues: Cue[] }): Promise<string[]> {
  try { const idx = (await db.getMeta<Record<string, string[]>>(INDEX)) ?? {}; return idx[keyOf(tr)] ?? []; } catch { return []; }
}
let saveTimer = 0; let pending: { key: string; target: string; texts: string[] } | null = null;
/** The translation so far kept (soon; writes are gathered), and the index of what exists trimmed to 200 subtitles. */
export function saveTranslation(tr: { cues: Cue[] }, target: string, texts: string[]): Promise<void> {
  pending = { key: keyOf(tr), target, texts: texts.slice() };
  return new Promise((res) => { clearTimeout(saveTimer); saveTimer = window.setTimeout(async () => {
    const p = pending; pending = null; if (!p) { res(); return; }
    try {
      await db.setMeta(`subtr:${p.key}:${p.target}`, { at: Date.now(), texts: p.texts } as Saved);
      const idx = (await db.getMeta<Record<string, string[]>>(INDEX)) ?? {}; const mine = new Set(idx[p.key] ?? []); mine.add(p.target); idx[p.key] = [...mine];
      const keys = Object.keys(idx); if (keys.length > 200) { for (const k of keys.slice(0, keys.length - 200)) { for (const tg of idx[k]) void db.deleteMeta(`subtr:${k}:${tg}`); delete idx[k]; } }
      await db.setMeta(INDEX, idx);
    } catch { /* not kept */ }
    res();
  }, 800); });
}
/** Every saved translation dropped (Settings). */
export async function clearSaved(): Promise<number> {
  const idx = (await db.getMeta<Record<string, string[]>>(INDEX).catch(() => undefined)) ?? {}; let n = 0;
  for (const [k, tgs] of Object.entries(idx)) for (const tg of tgs) { await db.deleteMeta(`subtr:${k}:${tg}`).catch(() => undefined); n++; }
  await db.deleteMeta(INDEX).catch(() => undefined); return n;
}
