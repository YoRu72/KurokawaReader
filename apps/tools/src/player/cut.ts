// A/B → a clip: fast (stream copy from the keyframe before A) or exact (re-encoded), with the subtitles burnt
// in — the loaded track written out shifted to the clip's start, the video's own fonts dumped beside it, and
// ffmpeg's `subtitles=` filter (libass) drawing them; the result lands in Downloads/Kurokawa/Clips.
import { h, toast, openSheet, pickButton, icon } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { ktPlugin } from '../native';
import { getSettings } from '../settings';
import { shiftAss, cuesToSrt, type Cue } from './subs';
import type { PlayerSource } from './player';

export interface CutJob { src: PlayerSource; a: number; b: number; duration: number; subtitle?: { name: string; ass?: string; cues: Cue[]; delay: number }; video: HTMLVideoElement }
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
  const timeIn = (v: number, set: (x: number) => void) => h('input', { type: 'text', value: fmt(v), dir: 'ltr', style: { width: '8em' }, onchange: (e: Event) => { const s = (e.target as HTMLInputElement).value.split(':').map(Number); set(s.length === 3 ? s[0] * 3600 + s[1] * 60 + s[2] : s.length === 2 ? s[0] * 60 + s[1] : Number(s[0]) || 0); } });
  const modePick = pickButton(t('cutMode'), [['fast', t('cutFast')], ['exact', t('cutExact')]], mode, (v) => { mode = v; if (v === 'fast') { burn = false; burnBox.checked = false; } draw(); }, t('close'));
  const burnBox = h('input', { type: 'checkbox', checked: burn, disabled: !job.subtitle, onchange: () => { burn = burnBox.checked; if (burn) { mode = 'exact'; modePick.setValue('exact'); } draw(); } }) as HTMLInputElement;
  const opts = h('div', { class: 'cut-opts' });
  const draw = () => {
    opts.replaceChildren(
      h('div', { class: 'row' }, h('span', null, 'A'), timeIn(a, (x) => { a = x; })), h('div', { class: 'row' }, h('span', null, 'B'), timeIn(b, (x) => { b = x; })),
      h('div', { class: 'row' }, h('span', null, t('cutMode'), h('small', { class: 'src' }, mode === 'fast' ? t('cutFastHint') : t('cutExactHint'))), modePick),
      h('label', { class: 'row switch-row' }, h('span', null, t('cutBurn'), h('small', { class: 'src' }, job.subtitle ? job.subtitle.name : t('cutNoSubtitle'))), burnBox),
      ...(mode === 'exact' ? [h('div', { class: 'row' }, h('span', null, t('resolution')), pickButton(t('resolution'), [['', t('cutSourceRes')], ['1080', '1080p'], ['720', '720p'], ['480', '480p']], res, (v) => { res = v; }, t('close'))), h('div', { class: 'row' }, h('span', null, t('codec')), pickButton(t('codec'), [['h264', 'H.264'], ['hevc', 'HEVC']], codec, (v) => { codec = v; }, t('close'))), h('div', { class: 'row' }, h('span', null, t('quality'), h('small', { class: 'src' }, t('qualityHint'))), h('input', { type: 'range', min: '16', max: '32', step: '1', value: String(quality), oninput: (e: Event) => { quality = Number((e.target as HTMLInputElement).value); } }))] : []));
  };
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
      const outExt = mode === 'fast' ? (['mkv', 'mp4', 'webm', 'mov', 'ts'].includes(inExt) ? (inExt === 'mov' ? 'mp4' : inExt) : 'mkv') : 'mp4';
      const out = `${outDir}/${base} ${fmt(a).replace(/[:.]/g, '')}-${fmt(b).replace(/[:.]/g, '')}${burn ? ' sub' : ''}.${outExt}`;
      const args: string[] = ['-y', '-hide_banner', '-nostdin'];
      if (job.src.headers) for (const [k, v] of Object.entries(job.src.headers)) args.push('-headers', `${k}: ${v}\r\n`);
      args.push('-ss', fmt(a), '-to', fmt(b), '-i', input);
      if (mode === 'fast') { args.push('-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero'); if (outExt === 'mp4') args.push('-map', '-0:t?', '-c:s', 'mov_text', '-movflags', '+faststart'); }
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
        vf.push('format=yuv420p'); args.push('-vf', vf.join(','), '-map', '0:v:0', '-map', '0:a:0?');
        if (android) args.push('-c:v', codec === 'hevc' ? 'hevc_mediacodec' : 'h264_mediacodec', '-bitrate_mode', 'vbr', '-b:v', `${Math.round(Math.max(1.5, 14 - quality * 0.4) * (res === '480' ? 0.35 : res === '720' ? 0.6 : 1))}M`, '-g', '60');
        else args.push('-c:v', codec === 'hevc' ? 'libx265' : 'libx264', '-preset', 'medium', '-crf', String(quality));
        args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
      }
      args.push('-progress', 'pipe:1', '-nostats', out);
      const total = b - a; let off: (() => void) | { remove(): void } | null = null;
      const onP = (pr: FfProgress) => { if (pr.id !== id) return; const f = Math.min(1, pr.time / total); (bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; line.textContent = `${localDigits(Math.round(f * 100))}%${pr.speed ? ` · ${localDigits(pr.speed.toFixed(1))}×` : ''}${pr.size ? ` · ${formatBytes(pr.size)}` : ''}`; };
      if (d) off = d.onFfmpegProgress(onP); else off = await p!.addListener('ffmpegProgress', onP);
      try { const r = d ? await d.ffmpeg({ id, args }) : await p!.ffmpeg({ id, args }); if (r.code !== 0) throw new Error(r.log.trim().split('\n').slice(-3).join(' ') || `ffmpeg ${r.code}`); }
      finally { if (off) { if (typeof off === 'function') off(); else off.remove(); } }
      toast(t('cutDone', { name: out.split(/[\\/]/).pop()! }), 'info', 5000); sh.close();
    } catch (e) { const m = String((e as Error).message ?? e); sh.body.replaceChildren(h('p', { class: 'empty small' }, /cancel|stopped|255/i.test(m) ? t('cancelled') : m)); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); void cutClipSheet(job); } }, t('back'))); }
  }
}
