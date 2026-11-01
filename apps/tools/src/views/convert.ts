// Prism's two media tools for a finished download, with the ffmpeg the app carries: Convert (a video to MP4, MKV
// or WebM, its sound to MP3 / M4A / FLAC / Opus, a short clip to GIF; music between formats; pictures to JPG,
// PNG or WebP) and Make smaller (a video or a song squeezed to fit a size — Discord's 10 MB, e-mail's 25 MB, and
// so on — its bitrate worked out from its length). The new file goes beside the original, which stays as it is.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { ktPlugin } from '../native';

type Prog = { id: string; time: number; size?: number; speed?: number };
type Bridge = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffmpegCancel(id: string): Promise<void>; ffprobe(path: string): Promise<{ format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] } | null>; onFfmpegProgress(cb: (p: Prog) => void): () => void };
type Plugin = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffmpegCancel(o: { id: string }): Promise<void>; ffprobe(o: { path: string }): Promise<{ json: string }>; clipsDir(): Promise<{ dir: string }>; addListener(ev: 'ffmpegProgress', fn: (p: Prog) => void): Promise<{ remove(): void }> };
const desk = (): Bridge | null => { const d = window.kurokawaTools as unknown as Bridge | undefined; return d?.ffmpeg ? d : null; };
const plug = (): Plugin | null => { const p = ktPlugin() as unknown as Plugin | null; return p?.ffmpeg ? p : null; };
export const canConvert = (): boolean => !!(desk() || plug());
export const kindOf = (name: string): 'video' | 'audio' | 'image' | null => (/\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts|wmv|flv|3gp|mpg|mpeg)$/i.test(name) ? 'video' : /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|alac|aiff?)$/i.test(name) ? 'audio' : /\.(jpe?g|png|webp|avif|heic|heif|bmp|tiff?|gif)$/i.test(name) ? 'image' : null);

async function probe(path: string): Promise<{ duration: number; video: boolean }> {
  const d = desk(); const p = plug();
  const j = d ? await d.ffprobe(path).catch(() => null) : p ? await p.ffprobe({ path }).then((r) => JSON.parse(r.json) as Awaited<ReturnType<Bridge['ffprobe']>>).catch(() => null) : null;
  return { duration: Number(j?.format?.duration) || 0, video: !!j?.streams?.some((s) => s.codec_type === 'video' && (s.width ?? 0) > 0) };
}
async function run(args: string[], total: number, onP: (f: number, line: string) => void, idOut: (id: string) => void): Promise<void> {
  const d = desk(); const p = plug(); const id = `conv-${Date.now()}`; idOut(id);
  const cb = (pr: Prog) => { if (pr.id !== id) return; const f = total ? Math.min(1, pr.time / total) : 0; onP(f, `${localDigits(Math.round(f * 100))}%${pr.speed ? ` · ${localDigits(pr.speed.toFixed(1))}×` : ''}${pr.size ? ` · ${formatBytes(pr.size)}` : ''}`); };
  const off: (() => void) | { remove(): void } = d ? d.onFfmpegProgress(cb) : await p!.addListener('ffmpegProgress', cb);
  try { const r = d ? await d.ffmpeg({ id, args: [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args[args.length - 1]] }) : await p!.ffmpeg({ id, args: [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args[args.length - 1]] }); if (r.code !== 0) throw new Error(r.log.trim().split('\n').slice(-3).join(' ') || `ffmpeg ${r.code}`); }
  finally { if (typeof off === 'function') off(); else off.remove(); }
}
const cancel = (id: string) => { const d = desk(); if (d) void d.ffmpegCancel(id); else void plug()?.ffmpegCancel({ id }); };

/** The sheet: Convert or Make smaller, for the file at `path`. */
export async function convertSheet(path: string, mode: 'convert' | 'shrink' = 'convert'): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path; const kind = kindOf(name);
  const sh = openSheet(mode === 'convert' ? t('convertTitle') : t('shrinkTitle'), t('close'));
  if (!canConvert() || !kind) { sh.body.append(h('p', { class: 'hint' }, t('convertUnavailable'))); return; }
  const android = !desk(); const base = name.replace(/\.[^.]+$/, '');
  const outDir = android ? (await plug()!.clipsDir()).dir : path.replace(/[\\/][^\\/]*$/, '');
  const info = await probe(path);
  const choose = h('div', { class: 'chip-row wrap' }); let pick = '';
  const formats: [string, string][] = kind === 'video' ? [['mp4', 'MP4 (H.264)'], ['mkv', 'MKV'], ['webm', 'WebM'], ['mp3', 'MP3'], ['m4a', 'M4A'], ['gif', 'GIF']] : kind === 'audio' ? [['mp3', 'MP3'], ['m4a', 'M4A (AAC)'], ['flac', 'FLAC'], ['opus', 'Opus'], ['wav', 'WAV']] : [['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']];
  const targets: [string, string][] = [['8', '8 MB'], ['10', '10 MB · Discord'], ['16', '16 MB · WhatsApp'], ['25', '25 MB · Email'], ['50', '50 MB'], ['100', '100 MB']];
  const list = mode === 'convert' ? formats : kind === 'image' ? [['75', t('shrinkQuality', { n: 75 })], ['50', t('shrinkQuality', { n: 50 })], ['1920', t('shrinkWidth', { n: 1920 })], ['1280', t('shrinkWidth', { n: 1280 })]] as [string, string][] : targets;
  const draw = () => choose.replaceChildren(...list.map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (pick === k ? ' on' : ''), onclick: () => { pick = k; draw(); go.disabled = false; } }, l)));
  const go = h('button', { type: 'button', class: 'btn primary', disabled: true }, icon(mode === 'convert' ? 'convert' : 'archive'), mode === 'convert' ? t('convertGo') : t('shrinkGo')) as HTMLButtonElement;
  sh.body.append(h('p', { class: 'src', dir: 'ltr' }, name), h('span', { class: 'label' }, mode === 'convert' ? t('convertTo') : t('shrinkTo')), choose, h('p', { class: 'hint' }, t('convertBeside')));
  draw(); sh.actions.append(go);
  go.addEventListener('click', async () => {
    if (!(await (await import('../packs')).ensurePacks(['ffmpeg'], t('packWhyConvert')))) return;
    const args: string[] = ['-y', '-hide_banner', '-nostdin', '-i', path]; let ext = pick; let tag = mode === 'convert' ? '' : ' (small)';
    if (mode === 'convert') {
      if (pick === 'mp4') args.push(...(android ? ['-c:v', 'h264_mediacodec', '-b:v', '6M'] : ['-c:v', 'libx264', '-crf', '21', '-preset', 'medium']), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
      else if (pick === 'mkv') args.push('-map', '0', '-c', 'copy');
      else if (pick === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k');
      else if (pick === 'gif') args.push('-t', '15', '-vf', 'fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse');
      else if (pick === 'mp3') args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '2');
      else if (pick === 'm4a') args.push('-vn', '-c:a', 'aac', '-b:a', '256k');
      else if (pick === 'flac') args.push('-vn', '-c:a', 'flac');
      else if (pick === 'opus') args.push('-vn', '-c:a', 'libopus', '-b:a', '160k');
      else if (pick === 'wav') args.push('-vn', '-c:a', 'pcm_s16le');
      else if (pick === 'jpg') args.push('-q:v', '2'); else if (pick === 'webp') args.push('-quality', '88');
    } else if (kind === 'image') {
      ext = /\.(png)$/i.test(name) ? 'jpg' : (/\.(\w+)$/.exec(name)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg').replace(/heic|heif|bmp|tiff?|avif/, 'jpg');
      if (Number(pick) > 100) args.push('-vf', `scale='min(${pick},iw)':-2`, ...(ext === 'jpg' ? ['-q:v', '4'] : [])); else args.push(...(ext === 'jpg' ? ['-q:v', String(Math.round(2 + (100 - Number(pick)) / 8))] : ext === 'webp' ? ['-quality', pick] : []));
    } else {
      // Make smaller: the bitrate that lands just under the size, from the length (the sound kept modest).
      if (!info.duration) { toast(t('shrinkNoLength'), 'error'); return; }
      const bits = Number(pick) * 8 * 1024 * 1024 * 0.95; const aud = kind === 'audio' ? 0 : Math.min(128000, Math.max(48000, bits / info.duration * 0.12));
      if (kind === 'audio') { ext = 'm4a'; const ab = Math.max(32000, Math.floor(bits / info.duration)); args.push('-vn', '-c:a', 'aac', '-b:a', String(ab)); }
      else { ext = 'mp4'; const vb = Math.max(100000, Math.floor(bits / info.duration - aud)); const scale = vb < 700000 ? ['-vf', "scale='min(854,iw)':-2"] : vb < 1500000 ? ['-vf', "scale='min(1280,iw)':-2"] : [];
        args.push(...scale, ...(android ? ['-c:v', 'h264_mediacodec', '-b:v', String(vb)] : ['-c:v', 'libx264', '-preset', 'medium', '-b:v', String(vb), '-maxrate', String(Math.floor(vb * 1.1)), '-bufsize', String(vb * 2)]), '-c:a', 'aac', '-b:a', String(Math.floor(aud)), '-movflags', '+faststart'); }
    }
    const out = `${outDir.replace(/[\\/]$/, '')}/${base}${tag || (ext === (/\.(\w+)$/.exec(name)?.[1] ?? '').toLowerCase() ? ' (converted)' : '')}.${ext}`;
    args.push(out); tag = '';
    const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src' }, '');
    sh.body.replaceChildren(h('div', { class: 'extract-progress' }, h('span', null, t('converting')), bar, line)); let jobId = '';
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => cancel(jobId) }, t('cancel')));
    try { await run(args, kind === 'image' ? 0 : pick === 'gif' ? Math.min(15, info.duration) : info.duration, (f, l) => { (bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; line.textContent = l; }, (id) => { jobId = id; }); toast(t('convertDone', { name: out.split(/[\\/]/).pop()! }), 'info', 5000); sh.close(); }
    catch (e) { const m = String((e as Error).message ?? e); sh.body.replaceChildren(h('p', { class: 'empty small' }, /cancel|255/i.test(m) ? t('cancelled') : m)); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); void convertSheet(path, mode); } }, t('back'))); }
  });
}
