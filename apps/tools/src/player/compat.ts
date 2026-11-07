// Sound the player's decoder cannot play (AC-3, E-AC-3, DTS, TrueHD — most films and series' releases, and some
// anime): the video's audio track turned into AAC by ffmpeg as it plays (the app's own server, desktop/streamproxy.cjs
// and KtStream) and played by an <audio> beside the muted video, kept in step with it — its time, its pauses, its
// speed, its seeks. The track is found by ffprobe; when there is no ffprobe answer, a video that decodes no sound
// after a few seconds of playing is taken as such a video.
import { ktPlugin } from '../native';

export interface Probe { audio: { index: number; codec: string; lang?: string; title?: string; channels?: number; isDefault?: boolean }[]; video?: { codec: string; profile?: string; pixFmt?: string }; duration?: number }
type Raw = { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; profile?: string; pix_fmt?: string; channels?: number; tags?: { language?: string; title?: string }; disposition?: { default?: number } }[] };
type Desk = { ffprobe?(p: string): Promise<Raw>; audioUrl?(): Promise<{ url: string }> };
type Plug = { ffprobe?(o: { path: string }): Promise<{ json: string }>; audioUrl?(): Promise<{ url: string }> };
const desk = (): Desk | null => { const d = window.kurokawaTools as unknown as Desk | undefined; return d?.audioUrl ? d : null; };
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Plug | null; return p?.audioUrl ? p : null; };

/** What the web view's decoder plays (Chromium's own codecs). */
const PLAYABLE = new Set(['aac', 'mp3', 'mp2', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);
export const audioPlayable = (codec: string): boolean => PLAYABLE.has(codec.toLowerCase());
export const compatHere = (): boolean => !!(desk() || plug());

/** The video's tracks, by ffprobe (null: no ffprobe here, or it did not answer within 20 s). */
export async function probe(url: string): Promise<Probe | null> {
  const run = async (): Promise<Raw | null> => { const d = desk(); if (d?.ffprobe) return d.ffprobe(url); const p = plug(); if (p?.ffprobe) return JSON.parse((await p.ffprobe({ path: url })).json) as Raw; return null; };
  const raw = await Promise.race([run().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 20000))]);
  if (!raw?.streams) return null;
  const audio = raw.streams.filter((s) => s.codec_type === 'audio').map((s, index) => ({ index, codec: s.codec_name ?? '', lang: s.tags?.language, title: s.tags?.title, channels: s.channels, isDefault: !!s.disposition?.default }));
  const v = raw.streams.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png');
  return { audio, video: v ? { codec: v.codec_name ?? '', profile: v.profile, pixFmt: v.pix_fmt } : undefined, duration: Number(raw.format?.duration) || undefined };
}

/** The sound beside the video: started at the video's time, kept in step, restarted when it drifts or the video jumps. */
export class SoundBeside {
  readonly el = new Audio(); private base = 0; private timer = 0; private off: (() => void)[] = []; private restarting = false; private lastRestart = 0;
  constructor(private video: HTMLVideoElement, private src: string, public track: number, private audioBase: string) {
    this.el.preload = 'auto'; this.video.muted = true;
    const on = <K extends keyof HTMLMediaElementEventMap>(k: K, fn: () => void) => { this.video.addEventListener(k, fn); this.off.push(() => this.video.removeEventListener(k, fn)); };
    on('play', () => { void this.el.play().catch(() => undefined); });
    on('pause', () => this.el.pause());
    on('waiting', () => this.el.pause());
    on('playing', () => { this.restartIfOff(0.6); void this.el.play().catch(() => undefined); });
    on('seeked', () => this.restart());
    on('ratechange', () => { this.el.playbackRate = this.video.playbackRate; });
    on('volumechange', () => this.mirrorVolume());
    this.mirrorVolume(); this.restart();
    this.timer = window.setInterval(() => this.keepInStep(), 500);
  }
  /** Where the sound is now, in the video's time. */
  private at(): number { return this.base + this.el.currentTime; }
  private mirrorVolume() { this.el.volume = Math.min(1, this.video.volume); this.el.muted = false; if (!this.video.muted) this.video.muted = true; }
  restart(track = this.track) {
    this.track = track; const ss = Math.max(0, this.video.currentTime); this.base = ss; this.lastRestart = Date.now();
    this.el.src = `${this.audioBase}?src=${encodeURIComponent(this.src)}&ss=${ss.toFixed(2)}&a=${track}`;
    this.el.playbackRate = this.video.playbackRate;
    if (!this.video.paused) { this.restarting = true; void this.el.play().catch(() => undefined).finally(() => { this.restarting = false; }); }
  }
  private restartIfOff(limit: number) { if (Math.abs(this.at() - this.video.currentTime) > limit && Date.now() - this.lastRestart > 1500) this.restart(); }
  private keepInStep() {
    if (this.video.paused || this.restarting) return;
    const d = this.video.currentTime - this.at();
    // (Far apart — a jump, a stall —: started again there; a little: the sound's speed nudged until it catches up.)
    if (Math.abs(d) > 0.8) { this.restartIfOff(0.8); return; }
    this.el.playbackRate = this.video.playbackRate * (Math.abs(d) < 0.06 ? 1 : d > 0 ? 1.04 : 0.96);
  }
  stop() { window.clearInterval(this.timer); for (const f of this.off) f(); this.off = []; this.el.pause(); this.el.removeAttribute('src'); this.el.load(); this.video.muted = false; }
}
/** The address the sound comes from (null: no ffmpeg here — the pack not installed —, or no app server). */
export async function audioBase(): Promise<string | null> {
  try { const d = desk(); if (d?.audioUrl) return (await d.audioUrl()).url; const p = plug(); if (p?.audioUrl) return (await p.audioUrl()).url; } catch (e) { if (/pack:ffmpeg/.test(String((e as Error).message ?? e))) throw e; }
  return null;
}
