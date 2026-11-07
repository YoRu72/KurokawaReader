// A/B → a clip: fast (stream copy from the keyframe before A) or exact (re-encoded), with the subtitles burnt
// in — the loaded track written out shifted to the clip's start, the video's own fonts dumped beside it, and
// ffmpeg's `subtitles=` filter (libass) drawing them; the result lands in Movies/KUROKAWACLIPS on a phone, the download folder on a computer.
import { h, toast, openSheet, pickButton, icon } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { ktPlugin } from '../native';
import { getSettings } from '../settings';
import { shiftAss, cuesToSrt, type Cue } from './subs';
import type { PlayerSource } from './player';

export interface CutJob { src: PlayerSource; a: number; b: number; duration: number; subtitle?: { name: string; ass?: string; cues: Cue[]; delay: number; /** How the player draws it (SRT/VTT): font family, size (% of the player's), colours, outline, bold, position. */ style?: { font: string; size: number; color: string; outline: string; outlineWidth: number; bold: boolean; italic: boolean; pos: number; background: string } }; video: HTMLVideoElement; fps?: number; setRange?(a: number, b: number): void }
type FfProgress = { id: string; time: number; size?: number; speed?: number; done?: boolean; error?: string };
type Bridge = { ffmpeg(o: { id: string; args: string[]; cwd?: string }): Promise<{ code: number; log: string }>; ffmpegCancel(id: string): Promise<void>; ffprobe(path: string): Promise<unknown>; writeTemp(name: string, text: string): Promise<string>; writeTempBytes?(o: { name: string; b64: string; sub?: string }): Promise<string>; onFfmpegProgress(cb: (p: FfProgress) => void): () => void; ffmpegAvailable(): Promise<{ ok: boolean; path?: string; why?: string }> };
type Plugin = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffmpegCancel(o: { id: string }): Promise<void>; ffprobe(o: { path: string }): Promise<{ json: string }>; writeTemp(o: { name: string; text: string }): Promise<{ path: string }>; writeTempBytes?(o: { name: string; b64: string; sub?: string }): Promise<{ path: string }>; clipsDir(): Promise<{ dir: string }>; addListener(ev: 'ffmpegProgress', fn: (p: FfProgress) => void): Promise<{ remove(): void }> };
const desk = (): Bridge | null => { const d = window.kurokawaTools as unknown as Bridge | undefined; return d?.ffmpeg ? d : null; };
const plug = (): Plugin | null => { const p = ktPlugin() as unknown as Plugin | null; return p?.ffmpeg ? p : null; };
export const canCut = (): boolean => !!(desk() || plug());
const fmt = (s: number) => { const h0 = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${String(h0).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`; };
const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/,/g, '\\,').replace(/;/g, '\\;');

export async function cutClipSheet(job: CutJob): Promise<void> {
  const sh = openSheet(t('cutClip'), t('close'));
  if (!canCut()) { sh.body.append(h('p', { class: 'hint' }, t('cutUnavailable'))); return; }
  const input = job.src.localPath ?? job.src.url; const isLocal = !!job.src.localPath || /^https?:\/\/127\.0\.0\.1/.test(job.src.url);
  if (!isLocal) sh.body.append(h('p', { class: 'hint' }, t('cutRemoteNote')));
  let a = job.a, b = job.b; let mode: 'fast' | 'exact' = 'fast'; let burn = false; /* (Asked for, not assumed: off until ticked.) */ let res: '' | '1080' | '720' | '480' = ''; let codec: 'h264' | 'hevc' = 'h264'; let quality = 23;
  // REX Player's clip sheet: what comes out (a video, its sound, a GIF), the sound kept or not.
  let kind: 'video' | 'audio' | 'gif' = 'video'; let mute = false; let gifWidth = 480; let gifFps = 12;
  const D = job.duration || job.video.duration || Math.max(b, 1); const frame = 1 / (job.fps || 30);
  const clamp = () => { a = Math.max(0, Math.min(a, D)); b = Math.max(0, Math.min(b, D)); if (b - a < 0.1) b = Math.min(D, a + 0.1); job.setRange?.(a, b); };
  const parse = (v: string) => { const s2 = v.trim().split(':').map(Number); return s2.length === 3 ? s2[0] * 3600 + s2[1] * 60 + s2[2] : s2.length === 2 ? s2[0] * 60 + s2[1] : Number(s2[0]) || 0; };
  // The range on a strip of its own: A and B dragged, the stretch between them coloured, its length in a badge.
  const track = h('div', { class: 'cut-track', dir: 'ltr' }, h('i', { class: 'cut-range' }), h('b', { class: 'cut-h a', tabindex: '0', 'aria-label': 'A' }, 'A'), h('b', { class: 'cut-h b', tabindex: '0', 'aria-label': 'B' }, 'B'));
  const badge = h('span', { class: 'cut-badge', dir: 'ltr' });
  const aIn = h('input', { type: 'text', dir: 'ltr', class: 'cut-time', onchange: () => { a = parse(aIn.value); clamp(); paint(); show(a); } }) as HTMLInputElement;
  const bIn = h('input', { type: 'text', dir: 'ltr', class: 'cut-time', onchange: () => { b = parse(bIn.value); clamp(); paint(); show(b); } }) as HTMLInputElement;
  const paint = () => { const pa = (a / D) * 100, pb = (b / D) * 100; (track.querySelector('.cut-range') as HTMLElement).style.cssText = `left:${pa}%;width:${Math.max(0, pb - pa)}%`; (track.querySelector('.cut-h.a') as HTMLElement).style.left = `${pa}%`; (track.querySelector('.cut-h.b') as HTMLElement).style.left = `${pb}%`; aIn.value = fmt(a); bIn.value = fmt(b); badge.textContent = `${fmt(b - a).replace(/^00:/, '')}`; };
  /** The player behind the sheet shows the frame at a time (paused there). */
  const show = (tm: number) => { try { job.video.pause(); job.video.currentTime = tm; } catch { /* not seekable */ } };
  for (const which of ['a', 'b'] as const) {
    const el = track.querySelector(`.cut-h.${which}`) as HTMLElement;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); const r = track.getBoundingClientRect();
      const mv = (ev: PointerEvent) => { const v = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * D; if (which === 'a') a = Math.min(v, b - 0.1); else b = Math.max(v, a + 0.1); clamp(); paint(); show(which === 'a' ? a : b); };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); });
    el.addEventListener('keydown', (e) => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return; e.preventDefault(); nudge(which, d * (e.shiftKey ? 1 : frame)); });
  }
  const nudge = (which: 'a' | 'b', d: number) => { if (which === 'a') a += d; else b += d; clamp(); paint(); show(which === 'a' ? a : b); };
  const endRow = (which: 'a' | 'b', input: HTMLInputElement) => h('div', { class: 'cut-end' }, h('b', { class: `cut-tag ${which}` }, which.toUpperCase()), input,
    h('div', { class: 'cut-nudges', dir: 'ltr' }, ...([[-1, '−1s'], [-frame, '−1f'], [frame, '+1f'], [1, '+1s']] as [number, string][]).map(([d, l]) => h('button', { type: 'button', class: 'chip small', onclick: () => nudge(which, d) }, l)),
      h('button', { type: 'button', class: 'chip small', title: t('cutSetNow'), onclick: () => { const now = job.video.currentTime; if (which === 'a') a = now; else b = now; clamp(); paint(); } }, which === 'a' ? t('framePointA') : t('framePointB')),
      h('button', { type: 'button', class: 'chip small', title: t('cutShow'), onclick: () => show(which === 'a' ? a : b) }, '▶')));
  const preview = h('button', { type: 'button', class: 'btn tonal small', onclick: () => { job.setRange?.(a, b); show(a); void job.video.play().catch(() => undefined); sh.close(); toast(t('cutPreviewing')); } }, icon('play'), t('cutPreview'));
  sh.body.append(h('div', { class: 'cut-head' }, track, h('div', { class: 'row' }, h('span', null, t('cutLength')), badge)), endRow('a', aIn), endRow('b', bIn), h('div', { class: 'row-actions' }, preview));
  const modePick = pickButton(t('cutMode'), [['fast', t('cutFast')], ['exact', t('cutExact')]], mode, (v) => { mode = v; if (v === 'fast') { burn = false; burnBox.checked = false; } draw(); }, t('close'));
  const burnBox = h('input', { type: 'checkbox', checked: burn, disabled: !job.subtitle, onchange: () => { burn = burnBox.checked; if (burn) { mode = 'exact'; modePick.setValue('exact'); } draw(); } }) as HTMLInputElement;
  // (The player's own look — its font, size, colours and outline — kept on the burnt subtitle, with that font's file carried along for libass.)
  let styled = true; const styledBox = h('input', { type: 'checkbox', checked: true, disabled: !job.subtitle, onchange: () => { styled = styledBox.checked; } }) as HTMLInputElement;
  const opts = h('div', { class: 'cut-opts' });
  const draw = () => {
    opts.replaceChildren(
      h('div', { class: 'row' }, h('span', null, t('cutKind')), pickButton(t('cutKind'), [['video', t('cutKindVideo')], ['audio', t('cutKindAudio')], ['gif', 'GIF']], kind, (v) => { kind = v; draw(); }, t('close'))),
      ...(kind === 'video' ? [
        h('div', { class: 'row' }, h('span', null, t('cutMode'), h('small', { class: 'src' }, mode === 'fast' ? t('cutFastHint') : t('cutExactHint'))), modePick),
        h('label', { class: 'row switch-row' }, h('span', null, t('cutBurn'), h('small', { class: 'src' }, job.subtitle ? job.subtitle.name : t('cutNoSubtitle'))), burnBox),
        h('label', { class: 'row switch-row' }, h('span', null, t('cutBurnStyled'), h('small', { class: 'src' }, t('cutBurnStyledHint'))), styledBox),
        h('label', { class: 'row switch-row' }, h('span', null, t('cutMute')), h('input', { type: 'checkbox', checked: mute, onchange: (e: Event) => { mute = (e.target as HTMLInputElement).checked; } })),
        ...(mode === 'exact' ? [h('div', { class: 'row' }, h('span', null, t('resolution')), pickButton(t('resolution'), [['', t('cutSourceRes')], ['1080', '1080p'], ['720', '720p'], ['480', '480p']], res, (v) => { res = v; }, t('close'))), h('div', { class: 'row' }, h('span', null, t('codec')), pickButton(t('codec'), [['h264', 'H.264'], ['hevc', 'HEVC']], codec, (v) => { codec = v; }, t('close'))), h('div', { class: 'row' }, h('span', null, t('quality'), h('small', { class: 'src' }, t('qualityHint'))), h('input', { type: 'range', min: '16', max: '32', step: '1', value: String(quality), oninput: (e: Event) => { quality = Number((e.target as HTMLInputElement).value); } }))] : [])] : []),
      ...(kind === 'audio' ? [h('p', { class: 'hint' }, t('cutAudioHint'))] : []),
      ...(kind === 'gif' ? [h('div', { class: 'row' }, h('span', null, t('cutGifWidth')), pickButton(t('cutGifWidth'), [['320', '320'], ['480', '480'], ['640', '640'], ['800', '800']], String(gifWidth), (v) => { gifWidth = Number(v); }, t('close'))), h('div', { class: 'row' }, h('span', null, t('cutGifFps')), pickButton(t('cutGifFps'), [['8', '8'], ['12', '12'], ['15', '15'], ['24', '24']], String(gifFps), (v) => { gifFps = Number(v); }, t('close'))), h('p', { class: 'hint' }, t('cutGifHint'))] : []));
  };
  paint();
  draw(); sh.body.append(opts);
  const go = h('button', { type: 'button', class: 'btn primary', onclick: () => void run() }, icon('scroll'), t('cutExport')); sh.actions.append(go);
  async function run() {
    if (!(b > a)) { toast(t('cutBadRange'), 'error'); return; }
    if (!(await (await import('../packs')).ensurePacks(['ffmpeg'], t('packWhyClip')))) return;
    go.disabled = true; const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src', dir: 'ltr' }, t('cutPreparing'));
    sh.body.replaceChildren(h('div', { class: 'extract-progress' }, h('span', null, t('cutExporting')), bar, line));
    const id = `cut-${Date.now()}`; sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void (desk() ? desk()!.ffmpegCancel(id) : plug()!.ffmpegCancel({ id })) }, t('cancel')));
    try {
      const d = desk(); const p = plug(); const android = !d;
      const outDir = d ? `${(getSettings().downloadDir || (await window.kurokawaTools!.defaultDir())).replace(/[\\/]$/, '')}` : (await p!.clipsDir()).dir;
      const base = job.src.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim(); const inExt = (/\.(\w+)$/.exec(job.src.name)?.[1] ?? 'mkv').toLowerCase();
      if (kind !== 'video') burn = false;
      const outExt = kind === 'audio' ? 'm4a' : kind === 'gif' ? 'gif' : mode === 'fast' ? (['mkv', 'mp4', 'webm', 'mov', 'ts'].includes(inExt) ? (inExt === 'mov' ? 'mp4' : inExt) : 'mkv') : 'mp4';
      const out = `${outDir}/${base} ${fmt(a).replace(/[:.]/g, '')}-${fmt(b).replace(/[:.]/g, '')}${burn ? ' sub' : ''}.${outExt}`;
      const args: string[] = ['-y', '-hide_banner', '-nostdin']; let encoders: string[][] = [[]];
      if (job.src.headers) for (const [k, v] of Object.entries(job.src.headers)) args.push('-headers', `${k}: ${v}\r\n`);
      // (A fast cut copies the picture as it is, so it can only begin on a keyframe: begun at A itself, players show
      // nothing until the next one — seconds late. It begins on the keyframe at or before A instead, said so.)
      let from = a;
      if (kind === 'video' && mode === 'fast') { const kf = await keyframeBefore(input, a, job.src.headers).catch(() => null); if (kf !== null && kf <= a + 0.05) from = kf; }
      // (Asked a hair after the keyframe: at its very time, a container's coarse index lands on the keyframe before it.)
      args.push('-ss', fmt(from < a ? from + 0.05 : from), '-to', fmt(b), '-i', input);
      if (kind === 'audio') args.push('-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
      else if (kind === 'gif') args.push('-an', '-vf', `fps=${gifFps},scale=${gifWidth}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0');
      else if (mode === 'fast') { args.push('-map', mute ? '0:v' : '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero'); if (mute) args.push('-an'); if (outExt === 'mp4') args.push('-map', '-0:t?', '-c:s', 'mov_text', '-movflags', '+faststart'); }
      else {
        const vf: string[] = []; if (res) vf.push(`scale=-2:${res}`);
        if (burn && job.subtitle) {
          const content = job.subtitle.ass ? shiftAss(job.subtitle.ass, -from + job.subtitle.delay) : cuesToSrt(job.subtitle.cues.map((c) => ({ ...c, start: c.start - from + job.subtitle!.delay, end: c.end - from + job.subtitle!.delay })).filter((c) => c.end > 0));
          const subName = job.subtitle.ass ? 'clip.ass' : 'clip.srt'; const subPath = d ? await d.writeTemp(subName, content) : (await p!.writeTemp({ name: subName, text: content })).path;
          const fontsDir = subPath.replace(/[\\/][^\\/]*$/, '/fonts');
          // The video's attached fonts, dumped beside the subtitle so libass finds them.
          if (isLocal) { const probe = d ? await d.ffprobe(input).catch(() => null) : await p!.ffprobe({ path: input }).then((r) => JSON.parse(r.json)).catch(() => null); const streams = ((probe as { streams?: { index: number; codec_type: string; tags?: { filename?: string } }[] } | null)?.streams ?? []).filter((s) => s.codec_type === 'attachment' && s.tags?.filename); if (streams.length) { const dumpArgs = ['-y', '-hide_banner', '-nostdin']; streams.forEach((s, i) => dumpArgs.push(`-dump_attachment:${s.index}`, `${fontsDir}/${s.tags!.filename!.replace(/[\\/]/g, '_') || `font${i}`}`)); dumpArgs.push('-i', input); line.textContent = t('cutDumpingFonts'); await (d ? d.ffmpeg({ id: `${id}-fonts`, args: dumpArgs }) : p!.ffmpeg({ id: `${id}-fonts`, args: dumpArgs })).catch(() => undefined); } }
          // The fonts the subtitle names (an ASS's styles), and the player's own font for a plain SRT/VTT, written beside it;
          // the player's style handed to libass as force_style so the clip looks as the screen did.
          let force = '';
          try {
            const F = await import('./fonts'); const want = job.subtitle.ass ? F.fontsUsed(job.subtitle.ass) : (styled && job.subtitle.style?.font ? [job.subtitle.style.font] : []);
            if (want.length) { const files = await F.fontFiles(want); for (const [fam, bytes] of Object.entries(files)) { let b64 = ''; for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); b64 = btoa(b64); const name = `${fam.replace(/[^\w.-]+/g, '_')}.ttf`; if (d?.writeTempBytes) await d.writeTempBytes({ name, b64, sub: 'fonts' }); else if (p?.writeTempBytes) await p.writeTempBytes({ name, b64, sub: 'fonts' }); } }
            if (styled && !job.subtitle.ass && job.subtitle.style) {
              const st = job.subtitle.style; const bgr = (hex: string) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex); return m ? `&H00${m[3]}${m[2]}${m[1]}&`.toUpperCase() : '&H00FFFFFF&'; };
              const h0 = job.video.videoHeight || 720; const size = Math.round((h0 / 18) * (st.size / 100));
              force = [st.font ? `FontName=${st.font.replace(/[,:']/g, '')}` : '', `FontSize=${size}`, `PrimaryColour=${bgr(st.color)}`, `OutlineColour=${bgr(st.outline)}`, `Outline=${Math.max(0, Math.round(st.outlineWidth * (h0 / 720) * 10) / 10)}`, `Bold=${st.bold ? -1 : 0}`, `Italic=${st.italic ? -1 : 0}`, `Alignment=2`, `MarginV=${Math.round(h0 * 0.04 + (h0 * 0.9 * (100 - st.pos)) / 100)}`, st.background === 'box' ? 'BorderStyle=4,BackColour=&H80000000&' : ''].filter(Boolean).join(',');
            }
          } catch { /* the default look then */ }
          vf.push(`subtitles='${esc(subPath)}':fontsdir='${esc(fontsDir)}'${force ? `:force_style='${esc(force)}'` : ''}`);
        }
        const mbps = Math.round(Math.max(1.5, 14 - quality * 0.4) * (res === '480' ? 0.35 : res === '720' ? 0.6 : 1));
        // (The encoders to try in turn: on a phone its own (MediaCodec, which most phones take only in NV12), then x264,
        // then ffmpeg's built-in MPEG-4 — one of them is always there.)
        encoders = android
          ? [['-vf', [...vf, 'format=nv12'].join(','), '-c:v', codec === 'hevc' ? 'hevc_mediacodec' : 'h264_mediacodec', '-bitrate_mode', 'vbr', '-b:v', `${mbps}M`, '-g', '60'],
            ['-vf', [...vf, 'format=yuv420p'].join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality)],
            ['-vf', [...vf, 'format=yuv420p'].join(','), '-c:v', 'mpeg4', '-q:v', '3']]
          : [['-vf', [...vf, 'format=yuv420p'].join(','), '-c:v', codec === 'hevc' ? 'libx265' : 'libx264', '-preset', 'medium', '-crf', String(quality)]];
        args.push('-map', '0:v:0'); if (!mute) args.push('-map', '0:a:0?'); else args.push('-an');
        if (!mute) args.push('-c:a', 'aac', '-b:a', '192k'); args.push('-movflags', '+faststart');
      }
      args.push('-progress', 'pipe:1', '-nostats', out);
      // (From here the clip is cut in the background: the sheet closes, the progress is in a card and the
      // notifications, and it goes on wherever you go; a pop-up says when it is done.)
      const mime = kind === 'audio' ? 'audio/*' : kind === 'gif' ? 'image/gif' : 'video/*';
      const { runClip } = await import('./clipJob');
      sh.close();
      void runClip({ id, title: out.split(/[\\/]/).pop()!, out, mime, total: b - from, attempts: encoders.map((enc) => { const i = args.lastIndexOf('-progress'); return [...args.slice(0, i), ...enc, ...args.slice(i)]; }), from: from < a - 0.05 ? from : undefined, srcName: job.src.name });
      return;
    } catch (e) { const m = String((e as Error).message ?? e); sh.body.replaceChildren(h('p', { class: 'empty small' }, /cancel|stopped|255/i.test(m) ? t('cancelled') : m)); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); void cutClipSheet(job); } }, t('back'))); }
  }
}

/** The last keyframe at or before `t` seconds (where a fast cut can begin), by ffmpeg copying the twelve seconds
 *  before it and listing its packets (framecrc: a packet with no «F=» flags is a keyframe). Null when unknown. */
async function keyframeBefore(input: string, t: number, headers?: Record<string, string>): Promise<number | null> {
  const d = desk(); const p = plug(); if (!d && !p) return null;
  const t0 = Math.max(0, t - 12); const name = `kf-${Date.now()}.txt`;
  const tmp = d ? await d.writeTemp(name, '') : (await p!.writeTemp({ name, text: '' })).path;
  const args = ['-y', '-hide_banner', '-nostdin', '-v', 'error'];
  if (headers) for (const [k, v] of Object.entries(headers)) args.push('-headers', `${k}: ${v}\r\n`);
  args.push('-ss', String(t0), '-copyts', '-i', input, '-to', String(t + 0.6), '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', tmp); // (-copyts: the file's own times, so the end is given as a time too)
  const r = d ? await d.ffmpeg({ id: `kf-${Date.now()}`, args }) : await p!.ffmpeg({ id: `kf-${Date.now()}`, args });
  if (r.code !== 0) return null;
  const { readLocal } = await import('./files'); const b = await readLocal(tmp); if (!b) return null;
  return keyframeFromCrc(new TextDecoder().decode(b), t);
}
/** From framecrc's text: the latest keyframe time at or before `t` (exported for the tests). */
export function keyframeFromCrc(text: string, t: number): number | null {
  const tb = /#tb 0:\s*(\d+)\/(\d+)/.exec(text); if (!tb) return null; const unit = Number(tb[1]) / Number(tb[2]);
  let best: number | null = null;
  for (const line of text.split('\n')) {
    if (!/^0,/.test(line) || /F=0x/i.test(line) && !/F=0x0*1\b/i.test(line)) continue;
    const f = line.split(',').map((x) => x.trim()); const pts = Number(f[2]); if (!Number.isFinite(pts)) continue;
    const s = pts * unit; if (s <= t + 0.05 && (best === null || s > best)) best = s;
  }
  return best;
}
