// The Video add-on: yt-dlp behind the one Add bar. A link is looked at once; if it is a page a video site serves
// (or any page yt-dlp knows), what it offers comes back here — title, picture, the qualities — and the download
// runs as an ordinary task. On the desktop yt-dlp is the official binary from its GitHub releases (checked against
// their SHA2-256SUMS); on Android it runs inside the app. Both are brought up to date on their own.
import { nativePlatform as getPlatform, ktPlugin } from '../native';
import { getSettings } from '../settings';

export const VIDEO_ADDON = 'video';
export interface VideoChoice { id: string; kind: 'video' | 'audio'; label: string; ext?: string; height?: number; fps?: number; size?: number; vcodec?: string; acodec?: string; note?: string }
export interface VideoInfo { kind: 'video'; id: string; title: string; thumbnail?: string; duration?: number; site?: string; url: string; uploader?: string; choices: VideoChoice[]; audio: VideoChoice[]; subtitles: string[]; /** Languages with automatic captions only. */ autoSubs?: string[]; live: boolean; chapters: number }
export interface PlaylistInfo { kind: 'playlist'; title: string; url: string; count: number; entries: { url: string; title?: string; duration?: number; id?: string; /** A course's section (chapter) and its number, when the site tells. */ chapter?: string; chapterNo?: number }[] }
export type PageInfo = VideoInfo | PlaylistInfo;

/** Sites yt-dlp is always asked about (others are, too, when the link is a web page rather than a file). */
export const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|reddit\.com|bilibili\.com|bilibili\.tv|nicovideo\.jp|soundcloud\.com|bandcamp\.com|ok\.ru|vk\.com|vkvideo\.ru|rumble\.com|odysee\.com|streamable\.com|imgur\.com|pinterest\.com|threads\.net|9gag\.com|crunchyroll\.com|iwara\.tv|nhk\.or\.jp|abema\.tv|tver\.jp|kick\.com|archive\.org|ted\.com|bitchute\.com|mixcloud\.com|vlive\.tv|weibo\.com|douyin\.com|ixigua\.com|youku\.com|zhihu\.com|naver\.com|kakao\.com|aparat\.com|shahid\.mbc\.net)$/i;
export const isVideoHost = (url: string): boolean => { try { return VIDEO_HOSTS.test(new URL(url).hostname); } catch { return false; } };
/** A link whose path names a file (an extension that is not a page): a plain download, not a page for yt-dlp. */
export const looksLikeFile = (url: string): boolean => { try { const p = new URL(url).pathname; return /\.[a-z0-9]{1,5}$/i.test(p) && !/\.(html?|php|aspx?|jsp|cgi)$/i.test(p); } catch { return false; } };

export const videoSupported = (): boolean => { const p = getPlatform(); return (p === 'desktop' && !!window.kurokawaTools?.videoInfo) || (p === 'android' && !!ktPlugin()); };
export const videoEnabled = (): boolean => videoSupported() && getSettings().addons.includes(VIDEO_ADDON);

interface Bridge { videoJsRuntime?(): Promise<{ missing: boolean; seen?: boolean; installed: string | null } | null>; videoInfo?(o: { url: string; playlist?: boolean }): Promise<unknown>; videoReady?(): Promise<unknown>; videoVersion?(): Promise<{ version: string | null; ready: boolean }>; videoUpdate?(): Promise<{ version: string | null; updated?: boolean; latest?: string }> }
const desk = (): Bridge | null => (window.kurokawaTools as unknown as Bridge | undefined) ?? null;
/** The Tauri shell's own codes for a new yt-dlp / gallery-dl that did not start (stage P5: the one before put back, or
 *  none and it was removed) in the page's language; any other error as it came. */
export async function toolError<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    const m = /^kt-video:(rolledback|broken):([\w-]+)(?::(.+))?$/.exec(String((e as Error)?.message ?? e));
    if (!m) throw e;
    const { t } = await import('../i18n');
    throw new Error(m[1] === 'rolledback' ? t('videoNewFailedBack', { tool: m[2], v: m[3] ?? '' }) : t('videoNewFailed', { tool: m[2] }));
  }
}
const plug = () => ktPlugin() as unknown as { videoInfo(o: { url: string; playlist?: boolean; cookieJar?: string }): Promise<{ json: string }>; videoVersion(): Promise<{ version: string | null; ready: boolean }>; videoUpdate(): Promise<{ version: string | null }> } | null;

// (Kept ten minutes: the sheet, the add that follows and a second look at the same link cost one yt-dlp run, not three.)
const INFO_TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; p: Promise<PageInfo> }>();
/** What a page offers (asked once per link per session). Throws yt-dlp's own last error line. */
export function pageInfo(url: string, playlist = false, opts: { cookieJar?: string } = {}): Promise<PageInfo> {
  const key = `${playlist ? 'p' : 'v'}|${opts.cookieJar ?? ''}|${url}`; const hit = cache.get(key); if (hit && Date.now() - hit.at < INFO_TTL) return hit.p;
  const p = (async () => {
    const { withPacks } = await import('../packs'); const { t } = await import('../i18n');
    // (yt-dlp needs Python and ffmpeg on a phone. On a computer reading a page needs neither: ffmpeg is asked for when a choice that needs it is added — an audio file taken as it is never does.)
    const d = desk(); if (d?.videoInfo) {
      await d.videoReady?.();
      // (The Tauri shell: yt-dlp with no JavaScript runtime here — said in the answer, or a look that failed — → the
      // «deno» pack offered, once; ui/jsruntime.ts. Electron gives yt-dlp its own Node: never there.)
      let r: unknown;
      try { r = await toolError(d.videoInfo({ url, playlist })); } catch (e) { if (d.videoJsRuntime) void d.videoJsRuntime().then((s) => { if (s && (s.seen || (s.missing && isVideoHost(url)))) void import('../ui/jsruntime').then((m) => m.offerDeno()); }).catch(() => undefined); throw e; }
      if ((r as { jsRuntime?: string } | null)?.jsRuntime === 'missing') void import('../ui/jsruntime').then((m) => m.offerDeno());
      return normalise(r);
    }
    const k = plug(); if (k) return normalise(JSON.parse((await withPacks(['python', 'ffmpeg'], t('packWhyVideo'), () => k.videoInfo({ url, playlist, cookieJar: opts.cookieJar }))).json));
    throw new Error('yt-dlp');
  })();
  cache.set(key, { at: Date.now(), p }); p.catch(() => cache.delete(key));
  if (cache.size > 40) for (const [k, v] of cache) if (Date.now() - v.at > INFO_TTL) cache.delete(k);
  return p;
}
/** The looks kept are forgotten (a component arrived that changes what yt-dlp sees). */
export function forgetPageInfo(): void { cache.clear(); }
export async function videoVersion(): Promise<string | null> { try { const d = desk(); if (d?.videoVersion) return (await d.videoVersion()).version; const k = plug(); return k ? (await k.videoVersion()).version : null; } catch { return null; } }
export async function updateVideo(): Promise<string | null> { const d = desk(); if (d?.videoUpdate) return (await toolError(d.videoUpdate())).version; const k = plug(); return k ? (await k.videoUpdate()).version : null; }
/** Once a day, quietly: yt-dlp follows the sites as they change, so it is kept current. */
export function autoUpdateVideo(): void {
  if (!videoEnabled()) return;
  let last = 0; try { last = Number(localStorage.getItem('kt.video.checked') || 0); } catch { /* none */ }
  if (Date.now() - last < 86400000) return;
  setTimeout(() => { void updateVideo().then(() => { try { localStorage.setItem('kt.video.checked', String(Date.now())); } catch { /* full */ } }).catch(() => undefined); }, 20000);
}

type Fmt = { format_id: string; url?: string; manifest_url?: string; vcodec?: string; acodec?: string; height?: number; fps?: number; tbr?: number; abr?: number; ext?: string; filesize?: number; filesize_approx?: number; dynamic_range?: string; format_note?: string };
type Raw = { _type?: string; id?: string; title?: string; thumbnail?: string; duration?: number; extractor_key?: string; webpage_url?: string; original_url?: string; uploader?: string; channel?: string; formats?: Fmt[]; subtitles?: Record<string, unknown>; is_live?: boolean; chapters?: unknown[]; entries?: (Raw & { url?: string })[]; kind?: string; choices?: unknown };
/** yt-dlp's `-J` shaped for the sheet: one choice per height (the best stream of it, with the best audio when the
 *  stream has none), the four best audio streams, the subtitle languages. Already-shaped info passes through. */
export function normalise(input: unknown): PageInfo {
  const j = input as Raw;
  if (j.kind === 'video' && Array.isArray(j.choices)) return j as unknown as VideoInfo;
  if (j.kind === 'playlist' && Array.isArray(j.entries) && !j._type) return j as unknown as PlaylistInfo;
  if (j._type === 'playlist') return { kind: 'playlist', title: j.title ?? '', url: j.webpage_url ?? j.original_url ?? '', count: (j.entries ?? []).length, entries: (j.entries ?? []).filter(Boolean).map((e) => ({ url: e.url ?? e.webpage_url ?? e.original_url ?? '', title: e.title, duration: e.duration, id: e.id, chapter: (e as { chapter?: string }).chapter, chapterNo: (e as { chapter_number?: number }).chapter_number })) };
  const fmts = (j.formats ?? []).filter((f) => f.url || f.manifest_url);
  const has = (c?: string) => !!c && c !== 'none';
  const video = fmts.filter((f) => has(f.vcodec)); const audioOnly = fmts.filter((f) => !has(f.vcodec) && has(f.acodec));
  const hdr = (f: Fmt) => !!f.dynamic_range && /HDR|HLG/i.test(f.dynamic_range);
  const byHeight = new Map<string, { f: Fmt; score: number }>();
  for (const f of video) { const key = `${f.height ?? 0}${hdr(f) ? ' HDR' : ''}`; const score = (f.fps ?? 0) * 1000 + (f.tbr ?? 0) + (has(f.acodec) ? 1 : 0); const prev = byHeight.get(key); if (!prev || score > prev.score) byHeight.set(key, { f, score }); }
  const abr = (f: Fmt) => f.abr ?? f.tbr ?? 0; const size = (f?: Fmt) => (f ? f.filesize ?? f.filesize_approx ?? 0 : 0);
  const audios = [...audioOnly].sort((a, b) => abr(b) - abr(a)); const best = audios[0];
  const choices: VideoChoice[] = [...byHeight.values()].map((v) => v.f).sort((a, b) => (b.height ?? 0) - (a.height ?? 0)).map((f) => {
    const muxed = has(f.acodec); const sz = size(f) + (muxed ? 0 : size(best));
    return { id: muxed ? f.format_id : `${f.format_id}+${best ? best.format_id : 'bestaudio'}`, kind: 'video', label: `${f.height ? `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ''}` : f.format_note ?? f.format_id}${hdr(f) ? ' HDR' : ''}`, ext: f.ext, height: f.height, fps: f.fps, size: sz || undefined, vcodec: f.vcodec, acodec: muxed ? f.acodec : best?.acodec, note: f.format_note };
  });
  const audio: VideoChoice[] = audios.slice(0, 4).map((f) => ({ id: f.format_id, kind: 'audio', label: `${Math.round(abr(f))} kbps ${f.acodec && f.acodec !== 'none' ? f.acodec.split('.')[0] : ''}`.trim(), ext: f.ext, size: size(f) || undefined, acodec: f.acodec }));
  return { kind: 'video', id: j.id ?? '', title: j.title ?? '', thumbnail: j.thumbnail, duration: j.duration, site: j.extractor_key, url: j.webpage_url ?? j.original_url ?? '', uploader: j.uploader ?? j.channel, choices, audio, subtitles: Object.keys(j.subtitles ?? {}), autoSubs: Object.keys((j as { automatic_captions?: Record<string, unknown> }).automatic_captions ?? {}).filter((k) => !(k in (j.subtitles ?? {}))), live: !!j.is_live, chapters: (j.chapters ?? []).length };
}
