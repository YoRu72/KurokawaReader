// A picture the web view cannot decode (a black screen with sound — H.264 in 10 bits, HEVC with no decoder here,
// XviD, MPEG-2, VC-1…), on the computer: the same <video> given the computer's ffmpeg turning it into H.264 as it
// plays (desktop/transcode.cjs). ffmpeg's stream starts at the time asked for, so the element is made to answer as
// the file would — its time and length the file's, a seek past what has come a new stream from there — and the
// events of each new start (a fresh «loadedmetadata», a «pause» while it loads) kept from the player, which sees one
// seek. Its sound comes with it, so nothing is played beside it.
import type { Probe } from './compat';

type Desk = { videoUrl?(): Promise<{ url: string }> };
const desk = (): Desk | null => { const d = window.kurokawaTools as unknown as Desk | undefined; return d?.videoUrl ? d : null; };
export const canConvert = (): boolean => !!desk();
export async function videoBase(): Promise<string | null> { try { return (await desk()?.videoUrl?.())?.url ?? null; } catch { return null; } }

const ms = (t: string) => { try { return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t); } catch { return false; } };
/** Why the web view will show no picture for this video, or null when it decodes it. */
export function pictureProblem(v: Probe['video']): string | null {
  if (!v?.codec) return null;
  const c = v.codec.toLowerCase(); const ten = /10|12/.test(v.pixFmt ?? '') || /10|4:2:2|4:4:4/.test(v.profile ?? '');
  const say = `${c.toUpperCase()}${ten ? ' 10-bit' : ''}`;
  switch (c) {
    case 'h264': return ten || !ms('video/mp4; codecs="avc1.640028"') ? say : null;
    case 'hevc': return ms(ten ? 'video/mp4; codecs="hvc1.2.4.L153.B0"' : 'video/mp4; codecs="hvc1.1.6.L153.B0"') ? null : say;
    case 'vp9': return ms(ten ? 'video/webm; codecs="vp09.02.10.10"' : 'video/webm; codecs="vp09.00.10.08"') ? null : say;
    case 'av1': return ms(ten ? 'video/mp4; codecs="av01.0.08M.10"' : 'video/mp4; codecs="av01.0.08M.08"') ? null : say;
    case 'vp8': case 'theora': return null;
    default: return say; // (mpeg4, msmpeg4v3, mpeg2video, mpeg1video, vc1, wmv3, rv40, flv1, h263…)
  }
}
/** The codec the page asks ffmpeg for: H.264 where this Chromium plays it (the app always), else VP9. */
const want = (): 'h264' | 'vp9' => (ms('video/mp4; codecs="avc1.640028"') ? 'h264' : 'vp9');

/** A <video> that has played a while and drawn no frame: its picture is not being decoded. */
export function noPicture(video: HTMLVideoElement): boolean {
  if (video.paused || video.currentTime < 2) return false;
  const q = (video as HTMLVideoElement & { getVideoPlaybackQuality?(): { totalVideoFrames: number } }).getVideoPlaybackQuality?.();
  return video.videoWidth === 0 || (!!q && q.totalVideoFrames === 0);
}

const N = HTMLMediaElement.prototype;
const d = (k: string) => Object.getOwnPropertyDescriptor(N, k)!;
const CT = d('currentTime'), DUR = d('duration'), BUF = d('buffered'), SRC = d('src'), CSRC = d('currentSrc');
const ranges = (rs: [number, number][]): TimeRanges => ({ length: rs.length, start: (i: number) => rs[i][0], end: (i: number) => rs[i][1] }) as TimeRanges;

export class Converted {
  private offset = 0; private restarting = false; private asSeek = false; private wasPlaying = false; private off: (() => void)[] = [];
  /** The file's length (ffprobe's); 0 until known, then the stream's own end. */
  duration = 0;
  constructor(private video: HTMLVideoElement, private base: string, private file: string, public track: number, duration: number) {
    this.duration = duration > 0 && isFinite(duration) ? duration : 0;
    const self = this; const v = video;
    Object.defineProperty(v, 'currentTime', { configurable: true, get() { return self.offset + (CT.get!.call(v) as number); }, set(t: number) { self.seek(Number(t)); } });
    Object.defineProperty(v, 'duration', { configurable: true, get() { const n = DUR.get!.call(v) as number; return self.duration || (isFinite(n) ? n + self.offset : NaN); } });
    Object.defineProperty(v, 'buffered', { configurable: true, get() { const b = BUF.get!.call(v) as TimeRanges; const r: [number, number][] = []; for (let i = 0; i < b.length; i++) r.push([b.start(i) + self.offset, b.end(i) + self.offset]); return ranges(r); } });
    Object.defineProperty(v, 'seekable', { configurable: true, get() { return ranges(self.duration ? [[0, self.duration]] : []); } });
    Object.defineProperty(v, 'currentSrc', { configurable: true, get() { return self.file; } });
    // (The events of each new stream are the stream's, not the player's: one «seeked» stands for them.)
    const hide = ['emptied', 'loadstart', 'abort', 'loadedmetadata', 'loadeddata', 'durationchange', 'pause', 'play', 'suspend', 'stalled'];
    const swallow = (e: Event) => { if (self.restarting) e.stopImmediatePropagation(); };
    for (const ev of hide) { v.addEventListener(ev, swallow, true); this.off.push(() => v.removeEventListener(ev, swallow, true)); }
    const ready = (e: Event) => { if (!self.restarting) return; e.stopImmediatePropagation(); self.restarting = false; if (self.asSeek) v.dispatchEvent(new Event('seeked')); v.dispatchEvent(new Event('durationchange')); v.dispatchEvent(new Event('timeupdate')); if (self.wasPlaying) void v.play().catch(() => undefined); };
    v.addEventListener('canplay', ready, true); this.off.push(() => v.removeEventListener('canplay', ready, true));
    const failed = (e: Event) => { if (!self.restarting) return; self.restarting = false; void e; };
    v.addEventListener('error', failed, true); this.off.push(() => v.removeEventListener('error', failed, true));
  }
  private url(at: number) { return `${this.base}?src=${encodeURIComponent(this.file)}&ss=${at.toFixed(3)}&a=${this.track}&c=${want()}`; }
  /** The stream from `at` seconds (the first start, a seek beyond what has come, another sound track). */
  start(at: number, play: boolean, asSeek = false) {
    this.restarting = true; this.asSeek = asSeek; this.wasPlaying = play; this.offset = Math.max(0, at);
    SRC.set!.call(this.video, this.url(this.offset)); this.video.load();
    if (play) void this.video.play().catch(() => undefined);
  }
  seek(t: number) {
    const to = Math.max(0, this.duration ? Math.min(t, this.duration - 0.5) : t); const local = to - this.offset;
    // (Within what has come already: a plain seek in it.)
    const b = BUF.get!.call(this.video) as TimeRanges;
    for (let i = 0; i < b.length; i++) if (local >= b.start(i) && local <= b.end(i) - 0.2) { CT.set!.call(this.video, local); return; }
    this.video.dispatchEvent(new Event('seeking'));
    this.start(to, !this.video.paused || (this.restarting && this.wasPlaying), true);
  }
  setTrack(i: number) { this.track = i; this.start(this.video.currentTime, !this.video.paused, true); }
  stop() { for (const f of this.off) f(); this.off = []; for (const k of ['currentTime', 'duration', 'buffered', 'seekable', 'currentSrc']) delete (this.video as unknown as Record<string, unknown>)[k]; void CSRC; }
}
