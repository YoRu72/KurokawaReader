// The Player add-on's engine on Android — mpv (libmpv, as mpv-android, mpvEx and REX Player use it), from the mpv
// pack — made to look to the player like the <video> it was written for: an element with currentTime, duration,
// paused, play(), pause(), playbackRate, volume, muted, buffered, the media events and the audio tracks, each
// one turned into mpv's properties and commands (KtMpv on the native side). So every control, gesture, subtitle
// drawn by the page and the rest of the player work on it unchanged, while mpv plays what the web view cannot:
// AC-3, E-AC-3, DTS, TrueHD, HEVC, 10-bit, the file's own subtitles (ASS by libass), every Matroska feature.
import { ktPlugin } from '../native';

export interface MpvTrack { id: number; type: 'video' | 'audio' | 'sub'; title?: string; lang?: string; codec?: string; selected: boolean; external?: boolean; default?: boolean; channels?: number }
type Ev = { prop?: string; value?: unknown; event?: string; error?: string; log?: string };
type Plug = {
  mpvAvailable?(): Promise<{ available: boolean }>;
  mpvOpen(o: { url: string; options: Record<string, string | boolean> }): Promise<void>;
  mpvCommand(o: { args: string[] }): Promise<void>;
  mpvSet(o: { name: string; value: string }): Promise<void>;
  mpvGet(o: { name: string }): Promise<{ value: string | null }>;
  mpvClose(): Promise<void>;
  addListener(ev: 'mpv', fn: (e: Ev) => void): Promise<{ remove(): void }>;
};
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Plug | null; return p?.mpvAvailable ? p : null; };

/** Whether mpv is here (Android, with the mpv pack installed). */
export async function mpvAvailable(): Promise<boolean> { const p = plug(); if (!p) return false; try { return (await p.mpvAvailable!()).available; } catch { return false; } }

export interface MpvControl {
  tracks(): MpvTrack[];
  setTrack(type: 'audio' | 'sub', id: number | 'no'): void;
  addSub(urlOrData: string, title?: string, isData?: boolean): void;
  set(name: string, value: string | number | boolean): void;
  command(...args: string[]): void;
  /** A frame saved, with the subtitles on it or not. */
  screenshot(subs?: boolean): void;
  onTracks(fn: () => void): void;
  close(): void;
}

/** An element that plays `url` through mpv, behaving as a <video> for the player. */
export function mpvVideo(url: string, opts: { start?: number; alang?: string; slang?: string; speed?: number; headers?: Record<string, string>; extra?: Record<string, string> } = {}): HTMLVideoElement & { _mpv: MpvControl } {
  const p = plug()!; const el = document.createElement('div'); el.className = 'kt-video kt-mpv-video';
  let time = 0, duration = NaN, paused = true, speed = opts.speed ?? 1, volume = 1, muted = false, ended = false, cache = 0, w = 0, h = 0, ready = 0, waiting = false, seeking = false;
  let error: { code: number; message: string } | null = null; let tracks: MpvTrack[] = []; let lastTime = 0; let loaded = false; const trackFns: (() => void)[] = [];
  const fire = (type: string) => el.dispatchEvent(new Event(type));
  const set = (name: string, value: string | number | boolean) => { void p.mpvSet({ name, value: typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value) }).catch(() => undefined); };
  const command = (...args: string[]) => { void p.mpvCommand({ args }).catch(() => undefined); };
  const playingNow = () => { if (!paused && !waiting && !seeking) fire('playing'); };
  let sub: { remove(): void } | null = null;
  void Promise.resolve(p.addListener('mpv', (e) => {
    if (e.error) { error = { code: 4, message: e.error }; fire('error'); return; }
    if (e.event === 'loaded') { loaded = true; ready = 4; if (isFinite(duration)) fire('loadedmetadata'); fire('loadeddata'); fire('canplay'); return; }
    if (e.event === 'restart') { if (seeking) { seeking = false; fire('seeked'); } playingNow(); return; }
    if (e.event === 'end' && loaded && !ended) { /* (keep-open: eof-reached says it) */ return; }
    const v = e.value;
    switch (e.prop) {
      case 'time-pos': if (typeof v === 'number') { time = v; const now = performance.now(); if (now - lastTime > 200) { lastTime = now; fire('timeupdate'); } } break;
      case 'duration': if (typeof v === 'number' && v > 0) { const first = !isFinite(duration); duration = v; fire('durationchange'); if (first && loaded) fire('loadedmetadata'); } break;
      case 'pause': if (typeof v === 'boolean' && v !== paused) { paused = v; fire(v ? 'pause' : 'play'); if (!v) playingNow(); } break;
      case 'paused-for-cache': case 'seeking': { const b = !!v; if (e.prop === 'seeking') { if (b && !seeking) { seeking = true; fire('seeking'); } } else waiting = b; if (b) fire('waiting'); else playingNow(); break; }
      case 'speed': if (typeof v === 'number') { speed = v; fire('ratechange'); } break;
      case 'volume': if (typeof v === 'number') { volume = Math.max(0, v / 100); fire('volumechange'); } break;
      case 'mute': if (typeof v === 'boolean') { muted = v; fire('volumechange'); } break;
      case 'eof-reached': if (v === true && !ended) { ended = true; paused = true; fire('ended'); } else if (v === false) ended = false; break;
      case 'demuxer-cache-time': if (typeof v === 'number') { cache = v; fire('progress'); } break;
      case 'video-params/w': if (typeof v === 'number') { w = v; fire('resize'); } break;
      case 'video-params/h': if (typeof v === 'number') { h = v; fire('resize'); } break;
      case 'track-list': if (typeof v === 'string') { try { tracks = (JSON.parse(v) as { id: number; type: string; title?: string; lang?: string; codec?: string; selected?: boolean; external?: boolean; default?: boolean; 'demux-channel-count'?: number }[]).filter((t) => t.type === 'video' || t.type === 'audio' || t.type === 'sub').map((t) => ({ id: t.id, type: t.type as MpvTrack['type'], title: t.title, lang: t.lang, codec: t.codec, selected: !!t.selected, external: t.external, default: t.default, channels: t['demux-channel-count'] })); } catch { /* left */ } for (const f of trackFns) f(); fire('tracks'); } break;
    }
  })).then((s) => { sub = s; });
  // (Audio tracks as a <video> lists them: the player's sound menu and its «b» key work on them as they are.)
  const audioTracks = new Proxy({} as Record<string | number, unknown>, {
    get(_t, k) {
      const a = tracks.filter((x) => x.type === 'audio');
      if (k === 'length') return a.length;
      const i = typeof k === 'string' && /^\d+$/.test(k) ? Number(k) : -1; if (i < 0 || i >= a.length) return undefined;
      const tr = a[i];
      return { get enabled() { return tr.selected; }, set enabled(b: boolean) { if (b) set('aid', tr.id); }, label: tr.title ?? '', language: tr.lang ?? '', id: String(tr.id), kind: 'main' };
    },
  });
  const control: MpvControl = {
    tracks: () => tracks,
    setTrack: (type, id) => set(type === 'audio' ? 'aid' : 'sid', id),
    addSub: (u, title, isData) => command('sub-add', isData ? `memory://${u}` : u, 'select', title ?? ''),
    set, command: (...a) => command(...a),
    screenshot: (subs?: boolean) => command('screenshot', subs ? 'subtitles' : 'video'),
    onTracks: (fn) => { trackFns.push(fn); },
    close: () => { sub?.remove(); void p.mpvClose().catch(() => undefined); },
  };
  Object.defineProperties(el, {
    currentTime: { get: () => time, set: (v: number) => { if (!isFinite(v)) return; time = Math.max(0, v); ended = false; seeking = true; fire('seeking'); command('seek', time.toFixed(3), 'absolute'); fire('timeupdate'); } },
    duration: { get: () => duration }, paused: { get: () => paused }, ended: { get: () => ended }, seeking: { get: () => seeking },
    playbackRate: { get: () => speed, set: (v: number) => { speed = v; set('speed', v); fire('ratechange'); } },
    defaultPlaybackRate: { get: () => 1, set: () => undefined },
    volume: { get: () => volume, set: (v: number) => { volume = Math.max(0, v); set('volume', Math.round(volume * 100)); fire('volumechange'); } },
    muted: { get: () => muted, set: (v: boolean) => { muted = !!v; set('mute', muted); fire('volumechange'); } },
    preservesPitch: { get: () => true, set: (v: boolean) => set('audio-pitch-correction', !!v) },
    videoWidth: { get: () => w }, videoHeight: { get: () => h }, readyState: { get: () => ready }, error: { get: () => error },
    buffered: { get: () => ({ length: cache > 0 ? 1 : 0, start: () => 0, end: () => Math.max(time, cache) }) },
    currentSrc: { get: () => url }, src: { get: () => url, set: () => undefined },
    audioTracks: { get: () => audioTracks },
    disableRemotePlayback: { get: () => true, set: () => undefined },
    play: { value: () => { ended = false; set('pause', false); return Promise.resolve(); } },
    pause: { value: () => { set('pause', true); } },
    load: { value: () => undefined },
    requestPictureInPicture: { value: () => Promise.reject(new Error('mpv')) },
    _mpv: { value: control },
  });
  const removeAttr = el.removeAttribute.bind(el);
  el.removeAttribute = (n: string) => { if (n === 'src') control.close(); else removeAttr(n); };
  const o: Record<string, string | boolean> = { paused: false };
  if (opts.start && opts.start > 1) o.start = String(opts.start);
  if (opts.alang) o.alang = opts.alang; if (opts.slang) o.slang = opts.slang; if (opts.speed && opts.speed !== 1) o.speed = String(opts.speed);
  if (opts.headers && Object.keys(opts.headers).length) o['http-header-fields'] = Object.entries(opts.headers).map(([k, v]) => `${k}: ${v.replace(/,/g, '\\,')}`).join(',');
  Object.assign(o, opts.extra ?? {});
  document.documentElement.classList.add('kt-mpv-on');
  void p.mpvOpen({ url, options: o }).catch((e) => { error = { code: 4, message: String((e as Error).message ?? e) }; fire('error'); });
  return el as unknown as HTMLVideoElement & { _mpv: MpvControl };
}
/** The page made opaque again once mpv is let go. */
export function mpvDone(): void { document.documentElement.classList.remove('kt-mpv-on'); }
