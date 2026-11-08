// Subtitles made from the voice, for a video with none: its sound taken out with ffmpeg (mono, 16 kHz, AAC, in
// ten-minute parts — a few megabytes each, well under the services' 25 MB), each part sent to a speech-to-text
// model (Whisper, through an OpenAI-style /audio/transcriptions: Groq's — fast, a free tier — or OpenAI's, or any
// address of the same kind), the lines it hears put back on the video's clock. The player then shows them as a
// track, and its translator turns them into the reader's language like any other subtitle. Saved as ASS or SRT.
import { request } from '../http';
import { ktPlugin } from '../native';
import type { Cue } from './subs';

export type VoiceProvider = 'groq' | 'openai' | 'custom';
export interface VoiceConfig { provider: VoiceProvider; key: string; base: string; model: string; lang: string }
export const VOICE_PRESETS: Record<VoiceProvider, { label: string; base: string; model: string; keyUrl: string }> = {
  groq: { label: 'Groq (Whisper)', base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyUrl: 'https://console.groq.com/keys' },
  openai: { label: 'OpenAI (Whisper)', base: 'https://api.openai.com/v1', model: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys' },
  custom: { label: 'Custom API', base: '', model: 'whisper-1', keyUrl: '' },
};
const PART = 600;

type Run = (o: { id: string; args: string[] }) => Promise<{ code: number; log: string }>;
function ffmpeg(): { run: Run; temp: (name: string) => Promise<string> } | null {
  const d = window.kurokawaTools as unknown as { ffmpeg?: Run; writeTemp?(name: string, text: string): Promise<string> } | undefined;
  if (d?.ffmpeg && d.writeTemp) return { run: (o) => d.ffmpeg!(o), temp: (n) => d.writeTemp!(n, '') };
  const p = ktPlugin() as unknown as { ffmpeg?: Run; writeTemp?(o: { name: string; text: string }): Promise<{ path: string }> } | null;
  if (p?.ffmpeg && p.writeTemp) return { run: (o) => p.ffmpeg!(o), temp: async (n) => (await p.writeTemp!({ name: n, text: '' })).path };
  return null;
}

/** A multipart/form-data body (as base64, the way the app's requests carry bytes) with the audio part and fields. */
export function multipart(fields: Record<string, string>, file: { name: string; type: string; bytes: Uint8Array }, boundary: string): string {
  const enc = new TextEncoder(); const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.bytes, enc.encode(`\r\n--${boundary}--\r\n`));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  let s = ''; for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode(...all.subarray(i, i + 0x8000)); return btoa(s);
}

/** The lines a transcription heard, on the video's clock (`offset`: where the part starts), empty ones left out. */
export function cuesOf(json: { segments?: { start: number; end: number; text: string; no_speech_prob?: number }[]; text?: string }, offset: number, partLen: number): Cue[] {
  const segs = json.segments ?? (json.text ? [{ start: 0, end: partLen, text: json.text }] : []);
  return segs.filter((s) => s.text.trim() && (s.no_speech_prob ?? 0) < 0.8).map((s) => ({ start: offset + s.start, end: offset + Math.max(s.end, s.start + 0.6), text: s.text.trim() }));
}

/** The video's voice as subtitles. `source`: its path or address; `duration` in seconds. */
export async function transcribe(source: string, duration: number, cfg: VoiceConfig, progress: (done: number, total: number, phase: 'audio' | 'voice') => void, stopped: () => boolean): Promise<Cue[]> {
  const ff = ffmpeg(); if (!ff) throw new Error('ffmpeg-missing');
  const preset = VOICE_PRESETS[cfg.provider]; const base = (cfg.base.trim() || preset.base).replace(/\/+$/, ''); const model = cfg.model.trim() || preset.model;
  if (!base) throw new Error('voice-base'); if (!cfg.key.trim()) throw new Error('voice-key');
  const parts = Math.max(1, Math.ceil(duration / PART)); const out: Cue[] = [];
  const { readLocal } = await import('./files');
  for (let i = 0; i < parts && !stopped(); i++) {
    progress(i, parts, 'audio');
    const path = await ff.temp(`voice-${Date.now()}-${i}.m4a`);
    const r = await ff.run({ id: `voice-${i}-${Date.now()}`, args: ['-y', '-ss', String(i * PART), '-t', String(PART), '-i', source, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', path] });
    if (r.code !== 0) throw new Error(`ffmpeg: ${r.log.split(/\r?\n/).filter((l) => /error|invalid|no such/i.test(l)).slice(-1)[0] ?? r.code}`);
    const bytes = await readLocal(path); if (!bytes || bytes.length < 200) continue;
    if (stopped()) break; progress(i, parts, 'voice');
    const boundary = `----kt${Math.random().toString(36).slice(2)}`;
    const fields: Record<string, string> = { model, response_format: 'verbose_json', 'timestamp_granularities[]': 'segment' }; if (cfg.lang && cfg.lang !== 'auto') fields.language = cfg.lang.split('-')[0];
    const res = await request(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.key.trim()}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: multipart(fields, { name: 'audio.m4a', type: 'audio/mp4', bytes }, boundary), bodyBase64: true });
    if (res.status === 401 || res.status === 403) throw new Error('voice-key');
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    out.push(...cuesOf(JSON.parse(res.body), i * PART, Math.min(PART, duration - i * PART)));
  }
  progress(parts, parts, 'voice');
  return out;
}

const assTime = (s: number) => { const cs = Math.round(s * 100); const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, x = Math.floor(cs / 100) % 60, c = cs % 100; return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(c).padStart(2, '0')}`; };
/** The lines as an ASS file (one plain style; Arabic in Uthman Taha Naskh), ready for a typesetter's hands. */
export function toAss(cues: Cue[], title: string, rtl: boolean): string {
  const font = rtl ? 'Uthman Taha Naskh' : 'Arial';
  return ['[Script Info]', `Title: ${title}`, 'ScriptType: v4.00+', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${rtl ? 64 : 60},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,90,90,60,${rtl ? 178 : 1}`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text.replace(/\r?\n/g, '\\N')}`)].join('\n') + '\n';
}
const srtTime = (s: number) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
export const toSrt = (cues: Cue[]): string => cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
