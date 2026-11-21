// The ffmpeg arguments of a clip (cut.ts's sheet): pure — no page, no ffmpeg — so the tests check the lists for each
// choice (subtitles none, burnt, kept as a track in MP4 or MKV) without running anything.
import type { Cue } from './subs';

const fmt = (s: number) => { const h0 = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${String(h0).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`; };
/* ---------- the ffmpeg arguments of a clip (pure: the tests check the lists for each subtitle choice) ---------- */
/** None, burnt into the picture (exact mode), or kept as a track (MKV, fonts attached; fast mode too). */
export type ClipSubs = 'none' | 'burn' | 'soft';
export interface ClipPlan {
  input: string; a: number; b: number; /** Where the cut really begins (a keyframe at or before A in fast mode). */ from: number; out: string;
  kind: 'video' | 'audio' | 'gif'; mode: 'fast' | 'exact'; subs: ClipSubs; mute: boolean;
  res: '' | '1080' | '720' | '480'; codec: 'h264' | 'hevc'; quality: number; gifWidth: number; gifFps: number;
  android: boolean; headers?: Record<string, string>;
  /** burn: the `subtitles=` filter, escaped. */ burnFilter?: string;
  /** soft: a subtitle file written for the clip (already shifted to its start), or the file's own track (its number among the subtitle streams). */
  softFile?: string; softTrack?: number; softTitle?: string; softLang?: string;
  /** soft: the container — MP4 (a mov_text track: the words and times, no styling or fonts) or MKV (the track as it is, fonts attached). */
  softBox?: 'mp4' | 'mkv';
  /** soft: font files to carry, and how many the video holds itself (copied first; unknown → every attachment tagged). */
  attach?: { path: string; mime: string }[]; videoAttachments?: number;
}
/** The container: a kept track goes in the one chosen for it (MP4 unless MKV was asked), whatever the source was. */
export function clipOutExt(kind: ClipPlan['kind'], mode: ClipPlan['mode'], subs: ClipSubs, inExt: string, softBox: 'mp4' | 'mkv' = 'mp4'): string {
  if (kind === 'audio') return 'm4a'; if (kind === 'gif') return 'gif'; if (subs === 'soft') return softBox;
  return mode === 'fast' ? (['mkv', 'mp4', 'webm', 'mov', 'ts'].includes(inExt) ? (inExt === 'mov' ? 'mp4' : inExt) : 'mkv') : 'mp4';
}
/** A subtitle made of pictures (Blu-ray PGS, DVD VobSub, DVB): MP4 cannot carry it, so it is kept only in MKV. */
export const pictureSub = (codec?: string): boolean => !!codec && /pgs|dvd_sub|dvb_sub|vobsub|xsub/i.test(codec);
/** Every attempt's full argument list (one per encoder tried in turn; one for a copy). */
export function clipArgs(o: ClipPlan): string[][] {
  const args: string[] = ['-y', '-hide_banner', '-nostdin']; let encoders: string[][] = [[]];
  if (o.headers) for (const [k, v] of Object.entries(o.headers)) args.push('-headers', `${k}: ${v}\r\n`);
  // (Asked a hair after the keyframe: at its very time, a container's coarse index lands on the keyframe before it.)
  args.push('-ss', fmt(o.from < o.a ? o.from + 0.05 : o.from), '-to', fmt(o.b), '-i', o.input);
  const soft = o.kind === 'video' && o.subs === 'soft' && (!!o.softFile || o.softTrack !== undefined);
  const burn = o.kind === 'video' && o.subs === 'burn' && !!o.burnFilter && o.mode === 'exact';
  if (soft && o.softFile) args.push('-i', o.softFile);
  const box = o.softBox === 'mkv' ? 'mkv' : 'mp4'; const mp4Track = soft && box === 'mp4';
  const outExt = clipOutExt(o.kind, o.mode, soft ? 'soft' : 'none', (/\.(\w+)$/.exec(o.input)?.[1] ?? 'mkv').toLowerCase(), box);
  // (MKV: the track as it is and the video's fonts with it; MP4: a mov_text track — ffmpeg turns ASS into its plain text —, no attachments.)
  const softMaps = () => ['-map', o.softFile ? '1:0' : `0:s:${o.softTrack}`, ...(mp4Track ? [] : ['-map', '0:t?'])];
  const softCodec = () => (mp4Track ? ['-c:s', 'mov_text'] : ['-c:s', 'copy', '-c:t', 'copy']);
  if (o.kind === 'audio') args.push('-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  else if (o.kind === 'gif') args.push('-an', '-vf', `fps=${o.gifFps},scale=${o.gifWidth}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0');
  else if (o.mode === 'fast' && soft) { args.push('-map', '0:v'); if (!o.mute) args.push('-map', '0:a?'); args.push(...softMaps(), '-c', 'copy', ...(mp4Track ? ['-c:s', 'mov_text', '-movflags', '+faststart'] : []), '-avoid_negative_ts', 'make_zero'); if (o.mute) args.push('-an'); }
  else if (o.mode === 'fast') { args.push('-map', o.mute ? '0:v' : '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero'); if (o.mute) args.push('-an'); if (outExt === 'mp4') args.push('-map', '-0:t?', '-c:s', 'mov_text', '-movflags', '+faststart'); }
  else {
    const vf: string[] = []; if (o.res) vf.push(`scale=-2:${o.res}`); if (burn) vf.push(o.burnFilter!);
    const mbps = Math.round(Math.max(1.5, 14 - o.quality * 0.4) * (o.res === '480' ? 0.35 : o.res === '720' ? 0.6 : 1));
    // (The encoders to try in turn: on a phone its own (MediaCodec, which most phones take only in NV12), then x264,
    // then ffmpeg's built-in MPEG-4 — one of them is always there.)
    encoders = o.android
      ? [['-vf', [...vf, 'format=nv12'].join(','), '-c:v', o.codec === 'hevc' ? 'hevc_mediacodec' : 'h264_mediacodec', '-bitrate_mode', 'vbr', '-b:v', `${mbps}M`, '-g', '60'],
        ['-vf', [...vf, 'format=yuv420p'].join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.quality)],
        ['-vf', [...vf, 'format=yuv420p'].join(','), '-c:v', 'mpeg4', '-q:v', '3']]
      : [['-vf', [...vf, 'format=yuv420p'].join(','), '-c:v', o.codec === 'hevc' ? 'libx265' : 'libx264', '-preset', 'medium', '-crf', String(o.quality)]];
    args.push('-map', '0:v:0'); if (!o.mute) args.push('-map', '0:a:0?'); else args.push('-an');
    if (soft) args.push(...softMaps(), ...softCodec());
    if (!o.mute) args.push('-c:a', 'aac', '-b:a', '192k'); if (!soft || mp4Track) args.push('-movflags', '+faststart');
  }
  if (soft) {
    const n0 = o.videoAttachments;
    if (!mp4Track) (o.attach ?? []).forEach((f, i) => { args.push('-attach', f.path); if (n0 !== undefined) args.push(`-metadata:s:t:${n0 + i}`, `mimetype=${f.mime}`); });
    if (!mp4Track && n0 === undefined && o.attach?.length) args.push('-metadata:s:t', `mimetype=${o.attach[0].mime}`);
    if (o.softTitle) args.push('-metadata:s:s:0', `title=${o.softTitle}`); if (o.softLang) args.push('-metadata:s:s:0', `language=${o.softLang}`);
    args.push('-disposition:s:0', 'default');
    // (The written track holds the whole film's lines shifted: the clip's length keeps it from running on.)
    if (o.softFile) args.push('-t', (o.b - o.from).toFixed(3));
  }
  const tail = ['-progress', 'pipe:1', '-nostats', o.out];
  return encoders.map((enc) => [...args, ...enc, ...tail]);
}
/** Cues moved by `by` seconds, those that end before the clip left out. */
export const shiftCues = (cues: Cue[], by: number): Cue[] => cues.map((c) => ({ ...c, start: c.start + by, end: c.end + by })).filter((c) => c.end > 0);
/** How the player draws a plain subtitle (cut.ts's CutJob style). */
export interface SubStyle { font: string; size: number; color: string; outline: string; outlineWidth: number; bold: boolean; italic: boolean; pos: number; background: string }
const bgr = (hex: string, alpha = '00') => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex); return m ? `&H${alpha}${m[3]}${m[2]}${m[1]}&`.toUpperCase() : `&H${alpha}FFFFFF&`; };
const marginV = (st: SubStyle, h0: number) => Math.round(h0 * 0.04 + (h0 * 0.9 * (100 - st.pos)) / 100);
/** The player's look as libass's force_style (a burnt SRT/VTT). */
export function forceStyle(st: SubStyle, h0: number): string {
  const size = Math.round((h0 / 18) * (st.size / 100));
  return [st.font ? `FontName=${st.font.replace(/[,:']/g, '')}` : '', `FontSize=${size}`, `PrimaryColour=${bgr(st.color)}`, `OutlineColour=${bgr(st.outline)}`, `Outline=${Math.max(0, Math.round(st.outlineWidth * (h0 / 720) * 10) / 10)}`, `Bold=${st.bold ? -1 : 0}`, `Italic=${st.italic ? -1 : 0}`, `Alignment=2`, `MarginV=${marginV(st, h0)}`, st.background === 'box' ? 'BorderStyle=4,BackColour=&H80000000&' : ''].filter(Boolean).join(',');
}
/** A plain subtitle as ASS in the player's look (its font, size, colours, outline, place), for a track kept in the clip. */
export function cuesToStyledAss(cues: Cue[], st: SubStyle, h0: number): string {
  const f = (s: number) => { s = Math.max(0, s); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${hh}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`; };
  const size = Math.round((h0 / 18) * (st.size / 100)); const font = (st.font || 'sans-serif').replace(/,/g, ' ');
  const style = `Style: Default,${font},${size},${bgr(st.color)},&H000000FF&,${bgr(st.outline)},&H80000000&,${st.bold ? -1 : 0},${st.italic ? -1 : 0},0,0,100,100,0,0,${st.background === 'box' ? 3 : 1},${Math.max(0, Math.round(st.outlineWidth * (h0 / 720) * 10) / 10)},0,2,20,20,${marginV(st, h0)},1`;
  const text = (s: string) => s.replace(/\r/g, '').replace(/<\/?(b|i|u)>/gi, (m0) => ({ '<b>': '{\\b1}', '</b>': '{\\b0}', '<i>': '{\\i1}', '</i>': '{\\i0}', '<u>': '{\\u1}', '</u>': '{\\u0}' } as Record<string, string>)[m0.toLowerCase()] ?? '').replace(/<[^>]+>/g, '').replace(/\n/g, '\\N');
  return ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${Math.round((h0 * 16) / 9)}`, `PlayResY: ${h0}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding', style, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${f(c.start)},${f(c.end)},Default,,0,0,0,,${c.top ? '{\\an8}' : ''}${text(c.text)}`), ''].join('\n');
}
