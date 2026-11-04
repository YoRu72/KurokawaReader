// The subtitles inside a video file — a Matroska's SRT and ASS tracks, an MP4's text — for the browser's player,
// which cannot read them by itself: ffmpeg (the add-on's, on a computer or from the pack on a phone) lists the
// file's streams and writes each text subtitle out, and the player takes them as tracks of its own. (mpv reads
// them by itself; this is for when the page plays the file.)
import { ktPlugin } from '../native';
import { readLocal } from './files';

export interface EmbeddedSub { index: number; name: string; lang?: string; codec: string; isDefault: boolean; forced: boolean; bytes: Uint8Array; ext: 'srt' | 'ass' }
type Stream = { index: number; codec_type: string; codec_name?: string; tags?: Record<string, string>; disposition?: Record<string, number> };
type Bridge = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffprobe(path: string): Promise<{ streams?: Stream[] } | null>; writeTemp(name: string, text: string): Promise<string> };
type Plugin = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffprobe(o: { path: string }): Promise<{ json: string }>; writeTemp(o: { name: string; text: string }): Promise<{ path: string }> };
const desk = (): Bridge | null => { const d = window.kurokawaTools as unknown as Partial<Bridge> | undefined; return d?.ffmpeg && d.ffprobe && d.writeTemp ? (d as Bridge) : null; };
const plug = (): Plugin | null => { const p = ktPlugin() as unknown as Partial<Plugin> | null; return p?.ffmpeg && p.ffprobe && p.writeTemp ? (p as Plugin) : null; };
export const canReadEmbedded = (): boolean => !!(desk() || plug());

const TEXT_CODECS: Record<string, 'srt' | 'ass'> = { subrip: 'srt', srt: 'srt', ass: 'ass', ssa: 'ass', webvtt: 'srt', mov_text: 'srt', text: 'srt', tx3g: 'srt' };

/** The text subtitles inside `path`, each written out and read back; none when there is no ffmpeg or no track. */
export async function embeddedSubs(path: string, onEach?: (s: EmbeddedSub) => void): Promise<EmbeddedSub[]> {
  const d = desk(); const p = plug(); if (!d && !p) return [];
  let streams: Stream[] = [];
  try { const probe = d ? await d.ffprobe(path) : JSON.parse((await p!.ffprobe({ path })).json) as { streams?: Stream[] }; streams = probe?.streams ?? []; } catch { return []; }
  const subs = streams.filter((s) => s.codec_type === 'subtitle' && TEXT_CODECS[s.codec_name ?? '']).slice(0, 12);
  const out: EmbeddedSub[] = [];
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i]; const ext = TEXT_CODECS[s.codec_name ?? '']; const tags = s.tags ?? {};
    const lang = tags.language ?? tags.LANGUAGE; const title = tags.title ?? tags.TITLE;
    const name = `${title ?? (lang ? lang.toUpperCase() : `#${i + 1}`)}.${ext}`;
    try {
      const tmp = d ? await d.writeTemp(`embedded-${i}-${Date.now()}.${ext}`, '') : (await p!.writeTemp({ name: `embedded-${i}-${Date.now()}.${ext}`, text: '' })).path;
      const args = ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-i', path, '-map', `0:${s.index}`, '-c:s', ext === 'ass' ? 'ass' : 'srt', '-f', ext === 'ass' ? 'ass' : 'srt', tmp];
      const r = d ? await d.ffmpeg({ id: `emb-${i}-${Date.now()}`, args }) : await p!.ffmpeg({ id: `emb-${i}-${Date.now()}`, args });
      if (r.code !== 0) continue;
      const bytes = await readLocal(tmp); if (!bytes || bytes.length < 8) continue;
      const one: EmbeddedSub = { index: s.index, name, lang, codec: s.codec_name ?? '', isDefault: !!s.disposition?.default, forced: !!s.disposition?.forced, bytes, ext };
      out.push(one); onEach?.(one);
    } catch { /* the next */ }
  }
  return out;
}
