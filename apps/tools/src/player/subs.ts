// Subtitles for the player: SRT, WebVTT and plain ASS/SSA parsed into cues the player draws itself (so size,
// colour, position, delay and speed are the app's to set); full ASS rendered by JASSUB (libass in WASM) when
// its files were bundled, with the video's fonts. A file's encoding is sniffed (UTF-8, UTF-16, else Windows-1256
// for Arabic-looking bytes, Windows-1252 otherwise) unless the user picks one.
export interface Cue { start: number; end: number; text: string; top?: boolean }
export type SubFormat = 'srt' | 'vtt' | 'ass' | 'unknown';

export function sniffFormat(name: string, text: string): SubFormat {
  if (/^﻿?WEBVTT/.test(text)) return 'vtt';
  if (/\[Script Info\]|\[V4\+? Styles\]|^Dialogue:/m.test(text)) return 'ass';
  if (/^\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(text)) return 'srt';
  const ext = name.toLowerCase().split('.').pop(); return ext === 'ass' || ext === 'ssa' ? 'ass' : ext === 'vtt' ? 'vtt' : ext === 'srt' ? 'srt' : 'unknown';
}
export function decodeSubtitle(bytes: Uint8Array, codepage?: string): string {
  if (codepage) { try { return new TextDecoder(codepage).decode(bytes); } catch { /* unknown label */ } }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  // High bytes in the Arabic letter range of cp1256 are 0xC1–0xDA, 0xDD–0xDF; cp1252 text rarely clusters there.
  let hi = 0, arab = 0; for (let i = 0; i < Math.min(bytes.length, 20000); i++) { const b = bytes[i]; if (b >= 0x80) { hi++; if ((b >= 0xc1 && b <= 0xda) || (b >= 0xdd && b <= 0xdf) || b === 0xe1 || (b >= 0xe3 && b <= 0xe6) || b === 0xec || b === 0xed || (b >= 0xf0 && b <= 0xf3) || b === 0xf5 || b === 0xf6 || b === 0xf9 || b === 0xfa || b === 0xfc || b === 0xfd) arab++; } }
  return new TextDecoder(hi && arab / hi > 0.6 ? 'windows-1256' : 'windows-1252').decode(bytes);
}
const ts = (s: string): number => { const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s) ?? /(\d{1,2}):(\d{2})[,.](\d{1,3})/.exec(s); if (!m) return NaN; return m.length === 5 ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000 : Number(m[1]) * 60 + Number(m[2]) + Number(m[3].padEnd(3, '0')) / 1000; };
const clean = (s: string) => s.replace(/<\/?(?:b|i|u|font|c|v|ruby|rt|lang)[^>]*>/gi, (m) => (/^<\/?(b|i|u)>$/i.test(m) ? m.toLowerCase() : '')).replace(/\{\\[^}]*\}/g, '').replace(/\\N|\\n/g, '\n').replace(/\\h/g, ' ').trim();

export function parseCues(text: string, fmt: SubFormat): Cue[] {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (fmt === 'ass') {
    const cues: Cue[] = []; let fmtCols: string[] | null = null;
    for (const line of text.split('\n')) {
      if (/^Format:/i.test(line) && /Start/i.test(line)) { fmtCols = line.slice(7).split(',').map((x) => x.trim().toLowerCase()); continue; }
      if (!/^Dialogue:/i.test(line)) continue;
      const cols = fmtCols ?? ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = line.slice(9).split(','); if (parts.length < cols.length) continue;
      const rec: Record<string, string> = {}; cols.forEach((c, i) => { rec[c] = i === cols.length - 1 ? parts.slice(i).join(',') : parts[i].trim(); });
      const start = ts(rec.start), end = ts(rec.end); if (!(end > start)) continue;
      const raw = rec.text ?? ''; const top = /\{[^}]*\\an[789][^}]*\}/.test(raw) || /\{[^}]*\\a[5-7][^}]*\}/.test(raw);
      const t = clean(raw); if (t) cues.push({ start, end, text: t, top });
    }
    return cues.sort((a, b) => a.start - b.start);
  }
  const blocks = text.split(/\n{2,}/); const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n'); const ti = lines.findIndex((l) => l.includes('-->')); if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->'); const start = ts(a), end = ts(z); if (!(end > start)) continue;
    const top = /line:\s*(?:[0-4]\d?%|[0-4])(?!\d)/.test(z); const t = clean(lines.slice(ti + 1).join('\n')); if (t) cues.push({ start, end, text: t, top });
  }
  return cues.sort((a, b) => a.start - b.start);
}
/** The cues on screen at `time` (binary search to the first that could be, then a short scan). */
export function cuesAt(cues: Cue[], time: number): Cue[] {
  let lo = 0, hi = cues.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= time) lo = mid + 1; else hi = mid; }
  const out: Cue[] = []; for (let i = Math.max(0, lo - 40); i < lo; i++) if (cues[i].end > time && cues[i].start <= time) out.push(cues[i]);
  return out;
}
/** ASS text with the header's styles kept and the events shifted by `delay` seconds and stretched by `speed` (for export). */
export function shiftAss(text: string, delay: number, speed = 1): string {
  const f = (s: number) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`; };
  return text.replace(/^(Dialogue:\s*[^,]*,)([^,]*),([^,]*),/gm, (_m, a: string, s: string, e: string) => `${a}${f(ts(s) * speed + delay)},${f(ts(e) * speed + delay)},`);
}
export function cuesToSrt(cues: Cue[]): string {
  const f = (s: number) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`; };
  return cues.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(c.end)}\n${c.text}\n`).join('\n');
}

/* ---------- JASSUB (libass) when bundled ---------- */
export interface AssRenderer { setTrack(content: string): void; free(): void; setOffset(seconds: number): void; resize(): void }
type JassubCtor = new (o: Record<string, unknown>) => { setTrack(c: string): void; freeTrack(): void; destroy(): void; timeOffset: number; resize(): void };
let jassub: Promise<JassubCtor | null> | null = null;
export function assAvailable(): Promise<boolean> { return loadJassub().then((c) => !!c); }
function loadJassub(): Promise<JassubCtor | null> {
  jassub ??= (async () => { try { const r = await fetch('assets/jassub/jassub.es.js', { method: 'HEAD' }); if (!r.ok) return null; const m = (await import(/* @vite-ignore */ new URL('assets/jassub/jassub.es.js', document.baseURI).href)) as { default: JassubCtor }; return m.default; } catch { return null; } })();
  return jassub;
}
export async function createAssRenderer(video: HTMLVideoElement, canvas: HTMLCanvasElement, content: string, fonts: string[], extra: Record<string, string> = {}): Promise<AssRenderer | null> {
  const J = await loadJassub(); if (!J) return null;
  const base = new URL('assets/jassub/', document.baseURI).href;
  const r = new J({ video, canvas, subContent: content, workerUrl: `${base}jassub-worker.js`, wasmUrl: `${base}jassub-worker.wasm`, fonts, fallbackFont: 'liberation sans', availableFonts: { 'liberation sans': `${base}default.woff2`, ...extra }, prescaleFactor: 0.8, dropAllAnimations: false });
  return { setTrack: (c) => r.setTrack(c), free: () => r.destroy(), setOffset: (s) => { r.timeOffset = s; }, resize: () => r.resize() };
}
