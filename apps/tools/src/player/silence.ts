// A silence map of a local file (ffmpeg's silencedetect): the stretches with nothing to hear, so the player can
// jump over them (Smart Speed). Found once per file and kept.
import { ktPlugin } from '../native';
type Bridge = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffmpegAvailable?(): Promise<boolean> };
const desk = (): Bridge | null => { const d = window.kurokawaTools as unknown as Bridge | undefined; return d?.ffmpeg ? d : null; };
const plug = (): Bridge | null => { const p = ktPlugin() as unknown as Bridge | null; return p?.ffmpeg ? p : null; };
export const canMapSilence = (): boolean => !!(desk() || plug());
export interface Silence { start: number; end: number }
const key = (path: string) => `kt.silence.${path.length}.${hash(path)}`;
const hash = (s: string): string => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
/** The silences longer than `minS` seconds, quieter than `db` dB; from the cache when known. */
export async function silenceMap(path: string, minS = 1.2, db = -35): Promise<Silence[]> {
  try { const c = localStorage.getItem(key(path)); if (c) return JSON.parse(c) as Silence[]; } catch { /* none */ }
  const b = desk() ?? plug(); if (!b) return [];
  const id = `sil-${Date.now()}`;
  const r = await b.ffmpeg({ id, args: ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', `silencedetect=n=${db}dB:d=${minS}`, '-f', 'null', '-'] }).catch(() => null);
  if (!r) return [];
  const out: Silence[] = []; let start: number | null = null;
  for (const m of r.log.matchAll(/silence_(start|end): ([\d.]+)/g)) { const v = Number(m[2]); if (m[1] === 'start') start = v; else if (start !== null && v > start) { out.push({ start, end: v }); start = null; } }
  try { localStorage.setItem(key(path), JSON.stringify(out.slice(0, 2000))); } catch { /* none */ }
  return out;
}
