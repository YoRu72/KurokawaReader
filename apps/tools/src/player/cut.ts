// A/B → a clip: fast (stream copy from the keyframe before A) or exact (re-encoded), with the subtitles burnt
// in — the loaded track written out shifted to the clip's start, the video's own fonts dumped beside it, and
// ffmpeg's `subtitles=` filter (libass) drawing them; the result lands in Downloads/Kurokawa/Clips.
import { h, toast, openSheet, pickButton, icon } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { ktPlugin } from '../native';
import { getSettings } from '../settings';
import { shiftAss, cuesToSrt, type Cue } from './subs';
import type { PlayerSource } from './player';

export interface CutJob { src: PlayerSource; a: number; b: number; duration: number; subtitle?: { name: string; ass?: string; cues: Cue[]; delay: number }; video: HTMLVideoElement; fps?: number; setRange?(a: number, b: number): void }
type FfProgress = { id: string; time: number; size?: number; speed?: number; done?: boolean; error?: string };
type Bridge = { ffmpeg(o: { id: string; args: string[]; cwd?: string }): Promise<{ code: number; log: string }>; ffmpegCancel(id: string): Promise<void>; ffprobe(path: string): Promise<unknown>; writeTemp(name: string, text: string): Promise<string>; onFfmpegProgress(cb: (p: FfProgress) => void): () => void; ffmpegAvailable(): Promise<{ ok: boolean; path?: string; why?: string }> };
type Plugin = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffmpegCancel(o: { id: string }): Promise<void>; ffprobe(o: { path: string }): Promise<{ json: string }>; writeTemp(o: { name: string; text: string }): Promise<{ path: string }>; clipsDir(): Promise<{ dir: string }>; addListener(ev: 'ffmpegProgress', fn: (p: FfProgress) => void): Promise<{ remove(): void }> };
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
  let a = job.a, b = job.b; let mode: 'fast' | 'exact' = job.subtitle ? 'exact' : 'fast'; let burn = !!job.subtitle; let res: '' | '1080' | '720' | '480' = ''; let codec: 'h264' | 'hevc' = 'h264'; let quality = 23;
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
      h('button', { type: 'button', class: 'chip small', title: t('cutSetNow'), onclick: () => { const now = job.video.currentTime; if (which === 'a') a = now; else b = now; clamp(); paint(); } }, t('cutNow')),
      h('button', { type: 'button', class: 'chip small', title: t('cutShow'), onclick: () => show(which === 'a' ? a : b) }, '▶')));
  const preview = h('button', { type: 'button', class: 'btn tonal small', onclick: () => { job.setRange?.(a, b); show(a); void job.video.play().catch(() => undefined); sh.close(); toast(t('cutPreviewing')); } }, icon('play'), t('cutPreview'));
  sh.body.append(h('div', { class: 'cut-head' }, track, h('div', { class: 'row' }, h('span', null, t('cutLength')), badge)), endRow('a', aIn), endRow('b', bIn), h('div', { class: 'row-actions' }, preview));
  const modePick = pickButton(t('cutMode'), [['fast', t('cutFast')], ['exact', t('cutExact')]], mode, (v) => { mode = v; if (v === 'fast') { burn = false; burnBox.checked = false; } draw(); }, t('close'));
  const burnBox = h('input', { type: 'checkbox', checked: burn, disabled: !job.subtitle, onchange: () => { burn = burnBox.checked; if (burn) { mode = 'exact'; modePick.setValue('exact'); } draw(); } }) as HTMLInputElement;
  const opts = h('div', { class: 'cut-opts' });
  const draw = () => {
    opts.replaceChildren(
      h('div', { class: 'row' }, h('span', null, t('cutKind')), pickButton(t('cutKind'), [['video', t('cutKindVideo')], ['audio', t('cutKindAudio')], ['gif', 'GIF']], kind, (v) => { kind = v; draw(); }, t('close'))),
      ...(kind === 'video' ? [
        h('div', { class: 'row' }, h('span', null, t('cutMode'), h('small', { class: 'src' }, mode === 'fast' ? t('cutFastHint') : t('cutExactHint'))), modePick),
        h('label', { class: 'row switch-row' }, h('span', null, t('cutBurn'), h('small', { class: 'src' }, job.subtitle ? job.subtitle.name : t('cutNoSubtitle'))), burnBox),
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
      const outDir = d ? `${(getSettings().downloadDir || (await window.kurokawaTools!.defaultDir())).replace(/[\\/]$/, '')}/Clips` : (await p!.clipsDir()).dir;
      const base = job.src.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim(); const inExt = (/\.(\w+)$/.exec(job.src.name)?.[1] ?? 'mkv').toLowerCase();
      if (kind !== 'video') burn = false;
      const outExt = kind === 'audio' ? 'm4a' : kind === 'gif' ? 'gif' : mode === 'fast' ? (['mkv', 'mp4', 'webm', 'mov', 'ts'].includes(inExt) ? (inExt === 'mov' ? 'mp4' : inExt) : 'mkv') : 'mp4';
      const out = `${outDir}/${base} ${fmt(a).replace(/[:.]/g, '')}-${fmt(b).replace(/[:.]/g, '')}${burn ? ' sub' : ''}.${outExt}`;
      const args: string[] = ['-y', '-hide_banner', '-nostdin'];
      if (job.src.headers) for (const [k, v] of Object.entries(job.src.headers)) args.push('-headers', `${k}: ${v}\r\n`);
      args.push('-ss', fmt(a), '-to', fmt(b), '-i', input);
      if (kind === 'audio') args.push('-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
      else if (kind === 'gif') args.push('-an', '-vf', `fps=${gifFps},scale=${gifWidth}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0');
      else if (mode === 'fast') { args.push('-map', mute ? '0:v' : '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero'); if (mute) args.push('-an'); if (outExt === 'mp4') args.push('-map', '-0:t?', '-c:s', 'mov_text', '-movflags', '+faststart'); }
      else {
        const vf: string[] = []; if (res) vf.push(`scale=-2:${res}`);
        if (burn && job.subtitle) {
          const content = job.subtitle.ass ? shiftAss(job.subtitle.ass, -a + job.subtitle.delay) : cuesToSrt(job.subtitle.cues.map((c) => ({ ...c, start: c.start - a + job.subtitle!.delay, end: c.end - a + job.subtitle!.delay })).filter((c) => c.end > 0));
          const subName = job.subtitle.ass ? 'clip.ass' : 'clip.srt'; const subPath = d ? await d.writeTemp(subName, content) : (await p!.writeTemp({ name: subName, text: content })).path;
          const fontsDir = subPath.replace(/[\\/][^\\/]*$/, '/fonts');
          // The video's attached fonts, dumped beside the subtitle so libass finds them.
          if (isLocal) { const probe = d ? await d.ffprobe(input).catch(() => null) : await p!.ffprobe({ path: input }).then((r) => JSON.parse(r.json)).catch(() => null); const streams = ((probe as { streams?: { index: number; codec_type: string; tags?: { filename?: string } }[] } | null)?.streams ?? []).filter((s) => s.codec_type === 'attachment' && s.tags?.filename); if (streams.length) { const dumpArgs = ['-y', '-hide_banner', '-nostdin']; streams.forEach((s, i) => dumpArgs.push(`-dump_attachment:${s.index}`, `${fontsDir}/${s.tags!.filename!.replace(/[\\/]/g, '_') || `font${i}`}`)); dumpArgs.push('-i', input); line.textContent = t('cutDumpingFonts'); await (d ? d.ffmpeg({ id: `${id}-fonts`, args: dumpArgs }) : p!.ffmpeg({ id: `${id}-fonts`, args: dumpArgs })).catch(() => undefined); } }
          vf.push(`subtitles='${esc(subPath)}':fontsdir='${esc(fontsDir)}'`);
        }
        vf.push('format=yuv420p'); args.push('-vf', vf.join(','), '-map', '0:v:0'); if (!mute) args.push('-map', '0:a:0?'); else args.push('-an');
        if (android) args.push('-c:v', codec === 'hevc' ? 'hevc_mediacodec' : 'h264_mediacodec', '-bitrate_mode', 'vbr', '-b:v', `${Math.round(Math.max(1.5, 14 - quality * 0.4) * (res === '480' ? 0.35 : res === '720' ? 0.6 : 1))}M`, '-g', '60');
        else args.push('-c:v', codec === 'hevc' ? 'libx265' : 'libx264', '-preset', 'medium', '-crf', String(quality));
        if (!mute) args.push('-c:a', 'aac', '-b:a', '192k'); args.push('-movflags', '+faststart');
      }
      args.push('-progress', 'pipe:1', '-nostats', out);
      const total = b - a; let off: (() => void) | { remove(): void } | null = null;
      const onP = (pr: FfProgress) => { if (pr.id !== id) return; const f = Math.min(1, pr.time / total); (bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; line.textContent = `${localDigits(Math.round(f * 100))}%${pr.speed ? ` · ${localDigits(pr.speed.toFixed(1))}×` : ''}${pr.size ? ` · ${formatBytes(pr.size)}` : ''}`; };
      if (d) off = d.onFfmpegProgress(onP); else off = await p!.addListener('ffmpegProgress', onP);
      try { const r = d ? await d.ffmpeg({ id, args }) : await p!.ffmpeg({ id, args }); if (r.code !== 0) throw new Error(r.log.trim().split('\n').slice(-3).join(' ') || `ffmpeg ${r.code}`); }
      finally { if (off) { if (typeof off === 'function') off(); else off.remove(); } }
      // Done: the file opened or shared from here (Android's chooser), or its folder.
      sh.body.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('check')), h('p', null, t('cutDone', { name: out.split(/[\\/]/).pop()! })), h('p', { class: 'src', dir: 'ltr' }, out)));
      const mime = kind === 'audio' ? 'audio/*' : kind === 'gif' ? 'image/gif' : 'video/*';
      const kp = p as unknown as { openWith?(o: { path: string; mime: string; title: string }): Promise<void> } | null;
      sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('done')), h('button', { type: 'button', class: 'btn primary', onclick: () => { if (kp?.openWith) void kp.openWith({ path: out, mime, title: job.src.name }).catch((er) => toast(String((er as Error).message ?? er), 'error')); else void import('../native').then((n) => n.openFolder(out)); } }, icon('external'), t('cutOpen')));
    } catch (e) { const m = String((e as Error).message ?? e); sh.body.replaceChildren(h('p', { class: 'empty small' }, /cancel|stopped|255/i.test(m) ? t('cancelled') : m)); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); void cutClipSheet(job); } }, t('back'))); }
  }
}
