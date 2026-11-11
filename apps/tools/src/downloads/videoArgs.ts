// What to get from a video page, as ONE pure function: the options the reader chose → yt-dlp's argument list (an
// array, never a shell string). Used by the page (the Add sheet and every other place a video link is added); the
// computer's main process and the phone's Java get the finished list and only vet it (see ALLOWED_FLAGS) and put the
// folder (-P), the ffmpeg location, the progress template and the sign-in beside it. No DOM and no i18n in here: the
// unit test (tests/videoargs.cjs) bundles this file alone.

export type VideoMode = 'video' | 'audio';
export type VideoContainer = 'mp4' | 'mkv' | 'webm';
export type AudioFormat = 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav';
export type NameStyle = 'title' | 'uploader' | 'playlist' | 'custom';
export interface VideoOptions {
  mode: VideoMode;
  /** Video: the tallest picture wanted (0: the best the page has). */
  height: number;
  container: VideoContainer;
  /** Prefer 60 fps when the page has it (off: 30 is enough, smaller files). */
  fps60: boolean;
  /** compat: H.264 + AAC (plays everywhere); small: AV1/VP9 + Opus (smaller files). */
  codec: 'compat' | 'small';
  /** Audio only. */
  audio: AudioFormat;
  mp3Rate: 'vbr' | '128' | '192' | '256' | '320';
  embedThumb: boolean; embedMeta: boolean; trackNo: boolean;
  subs: { on: boolean; langs: string[]; auto: boolean; how: 'embed' | 'file'; fmt: 'srt' | 'vtt' | 'ass' };
  thumbFile: boolean;
  chapters: 'off' | 'embed' | 'split';
  sponsor: 'off' | 'remove' | 'mark'; sponsorCats: string[];
  playlist: 'one' | 'all' | 'range'; range: string;
  name: NameStyle; custom: string;
  /** A playlist's videos numbered in their file names. */
  number: boolean;
}
export const HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144] as const;
export const SPONSOR_CATS = ['sponsor', 'intro', 'outro', 'selfpromo', 'interaction', 'preview', 'music_offtopic', 'filler'] as const;
export const DEFAULT_OPTIONS: VideoOptions = {
  mode: 'video', height: 0, container: 'mp4', fps60: true, codec: 'compat', audio: 'mp3', mp3Rate: '320', embedThumb: true, embedMeta: true, trackNo: false,
  subs: { on: false, langs: [], auto: false, how: 'embed', fmt: 'srt' }, thumbFile: false, chapters: 'embed', sponsor: 'off', sponsorCats: ['sponsor'],
  playlist: 'one', range: '', name: 'title', custom: '', number: true,
};

/* ---------- what the reader typed, made safe ---------- */
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const RANGE = /^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/;
const SECTION = /^[\d:.]+-[\d:.]+$/;
/** A file name pattern of the reader's own: yt-dlp's %(field)s tokens and plain text — no folders, no «..», no leading «-»,
 *  no «$» or «~» (yt-dlp expands them to paths), nothing but well-formed tokens after a «%». */
export function safeTemplate(s: unknown): string | null {
  if (typeof s !== 'string') return null; const v = s.trim();
  if (!v || v.length > 150 || v.startsWith('-') || v.startsWith('.') || /[\\/$~\x00-\x1f]|\.\./.test(v)) return null;
  const rest = v.replace(/%%/g, '').replace(/%\([A-Za-z_][\w.]*(?:[>|][^()]*)?\)[-#+ 0]*\d*(?:\.\d+)?[sdiBlqSUDhj]/g, '');
  return rest.includes('%') || /[:*?"<>|]/.test(rest) ? null : v;
}
/** Literal text put inside a template (a playlist's title): file-name safe, «%» doubled. */
const literal = (s: string): string => s.replace(/[\\/:*?"<>|$~\x00-\x1f]+/g, ' ').replace(/\.\.+/g, '.').replace(/\s+/g, ' ').replace(/^[\s.-]+/, '').replace(/%/g, '%%').trim().slice(0, 100);
export const safeLangs = (xs: unknown): string[] => (Array.isArray(xs) ? xs : []).map((x) => String(x).trim()).filter((x) => LANG.test(x)).slice(0, 12);
export const safeRange = (s: unknown): string | null => { const v = typeof s === 'string' ? s.replace(/\s+/g, '') : ''; return RANGE.test(v) && v.length <= 60 && !/(^|[,-])0+(?=[,-]|$)/.test(v) ? v : null; };
const oneOf = <T extends string | number>(v: unknown, xs: readonly T[], d: T): T => (xs as readonly unknown[]).includes(v) ? (v as T) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** Whatever was saved or passed in, made into options the builder can trust (unknown values fall back to the defaults). */
export function normaliseOptions(x: unknown, base: VideoOptions = DEFAULT_OPTIONS): VideoOptions {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>; const s = (o.subs && typeof o.subs === 'object' ? o.subs : {}) as Record<string, unknown>;
  const cats = (Array.isArray(o.sponsorCats) ? o.sponsorCats : base.sponsorCats).filter((c): c is typeof SPONSOR_CATS[number] => (SPONSOR_CATS as readonly unknown[]).includes(c));
  return {
    mode: oneOf(o.mode, ['video', 'audio'] as const, base.mode), height: oneOf(o.height, [0, ...HEIGHTS] as const, base.height), container: oneOf(o.container, ['mp4', 'mkv', 'webm'] as const, base.container),
    fps60: bool(o.fps60, base.fps60), codec: oneOf(o.codec, ['compat', 'small'] as const, base.codec), audio: oneOf(o.audio, ['mp3', 'm4a', 'opus', 'flac', 'wav'] as const, base.audio),
    mp3Rate: oneOf(o.mp3Rate, ['vbr', '128', '192', '256', '320'] as const, base.mp3Rate), embedThumb: bool(o.embedThumb, base.embedThumb), embedMeta: bool(o.embedMeta, base.embedMeta), trackNo: bool(o.trackNo, base.trackNo),
    subs: { on: bool(s.on, base.subs.on), langs: 'langs' in s ? safeLangs(s.langs) : base.subs.langs, auto: bool(s.auto, base.subs.auto), how: oneOf(s.how, ['embed', 'file'] as const, base.subs.how), fmt: oneOf(s.fmt, ['srt', 'vtt', 'ass'] as const, base.subs.fmt) },
    thumbFile: bool(o.thumbFile, base.thumbFile), chapters: oneOf(o.chapters, ['off', 'embed', 'split'] as const, base.chapters), sponsor: oneOf(o.sponsor, ['off', 'remove', 'mark'] as const, base.sponsor), sponsorCats: cats.length ? [...new Set(cats)] : base.sponsorCats,
    playlist: oneOf(o.playlist, ['one', 'all', 'range'] as const, base.playlist), range: typeof o.range === 'string' ? o.range.slice(0, 60) : base.range, name: oneOf(o.name, ['title', 'uploader', 'playlist', 'custom'] as const, base.name), custom: typeof o.custom === 'string' ? o.custom.slice(0, 150) : base.custom, number: bool(o.number, base.number),
  };
}

/* ---------- the arguments ---------- */
export interface ArgsContext {
  /** Pieces of a stream fetched at once (-N); 0 or none: yt-dlp's own (one). */
  fragments?: number;
  /** One video of a playlist, added by itself: its place in the list (named «NN - …», and the track number) and the list's title. */
  playlistIndex?: number; playlistTitle?: string;
  /** Sidecars and parts the settings or the sheet ask for. */
  extras?: { infoJson?: boolean; comments?: boolean; liveChat?: boolean; cover?: boolean; section?: string; chapterMatch?: string; headers?: Record<string, string>; bilingual?: boolean; outName?: string };
  /** Whether ffmpeg is here: without it, what only ffmpeg can do beside an «as is» audio file is left out (and said). */
  ffmpeg?: boolean;
}
export interface BuiltArgs {
  /** Everything but the folder (-P), the program's own location and progress options: the native side adds those. */
  args: string[];
  /** What this choice needs ffmpeg for (empty: it works without). */
  needs: string[];
  /** What was left out because ffmpeg is missing (only when `ffmpeg` is false), and what was refused as not valid. */
  dropped: string[]; rejected: string[];
}

export const TEMPLATES: Record<Exclude<NameStyle, 'custom'>, string> = { title: '%(title)s [%(id)s]', uploader: '%(uploader)s - %(title)s [%(id)s]', playlist: '%(playlist_title)s/%(playlist_index)02d - %(title)s' };
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Stream choice and sorting for the video: `-f` takes streams, `-S` ranks them (the tallest within the cap, 60 fps or not,
 *  the codecs the container plays), so nothing is converted afterwards that choosing right avoids. */
function videoFormat(o: VideoOptions): { f: string; S: string } {
  const sort: string[] = []; if (o.height) sort.push(`res:${o.height}`); sort.push(o.fps60 ? 'fps' : 'fps:30');
  if (o.container === 'webm') sort.push(o.codec === 'small' ? 'vcodec:av01' : 'vcodec:vp9', 'acodec:opus');
  else sort.push(o.codec === 'small' ? 'vcodec:av01' : 'vcodec:h264', o.codec === 'small' ? 'acodec:opus' : 'acodec:m4a');
  return { f: 'bv*+ba/b', S: sort.join(',') };
}

export function buildVideoArgs(opts: VideoOptions, ctx: ArgsContext = {}): BuiltArgs {
  const o = normaliseOptions(opts); const ex = ctx.extras ?? {}; const args: string[] = []; const needs = new Set<string>(); const dropped: string[] = []; const rejected: string[] = [];
  const ff = ctx.ffmpeg !== false; const audio = o.mode === 'audio';
  const need = (why: string) => needs.add(why);
  let mode = o.playlist; const range = mode === 'range' ? safeRange(o.range) : null;
  if (mode === 'range' && !range) { rejected.push('range'); mode = 'one'; }   // (a range that is not one: this video only, never the whole list)
  const native = mode !== 'one' && ctx.playlistIndex === undefined;   // (the whole list in one job: yt-dlp's own numbering) — else one video, numbered by the page)
  const inList = native || ctx.playlistIndex !== undefined;

  // The streams.
  let asIs = false;
  if (!audio) {
    const v = videoFormat(o); args.push('-f', v.f, '-S', v.S, '--merge-output-format', o.container); need('merge');
    if (o.container !== 'webm') { args.push('--remux-video', o.container); }
  } else if (o.audio === 'm4a' || o.audio === 'opus') {
    asIs = true; args.push('-f', o.audio === 'm4a' ? 'ba[ext=m4a]/ba' : 'ba[acodec=opus]/ba');
    // (With ffmpeg the file is pinned to the format — yt-dlp copies the stream when it already is that one; without, it stays as the page has it.)
    if (ff) args.push('-x', '--audio-format', o.audio);
  } else {
    args.push('-f', 'ba/b', '-x', '--audio-format', o.audio); need('convert');
    if (o.audio === 'mp3') args.push('--audio-quality', o.mp3Rate === 'vbr' ? '0' : `${o.mp3Rate}K`);
  }

  // Embedding: each only where the container can carry it, and only with ffmpeg (an «as is» file goes without it instead of failing).
  const embeds = (flag: string[], what: string, ok = true) => { if (!ok) { dropped.push(what); return; } if (!ff && asIs) { dropped.push(what); return; } args.push(...flag); need('embed'); };
  if (o.embedThumb) { const ok = audio ? o.audio !== 'wav' : o.container !== 'webm'; embeds(audio ? ['--embed-thumbnail', '--convert-thumbnails', 'jpg'] : ['--embed-thumbnail'], 'cover', ok); }
  if (o.embedMeta) embeds(['--embed-metadata'], 'metadata');
  if (audio && o.trackNo && o.embedMeta && inList && o.audio !== 'wav' && (ff || !asIs)) args.push('--parse-metadata', native ? 'playlist_index:%(track_number)s' : `${ctx.playlistIndex}:%(track_number)s`);
  if (o.chapters === 'embed') embeds(['--embed-chapters'], 'chapters');
  if (o.chapters === 'split') { args.push('--split-chapters'); need('split'); }

  // Subtitles: where they go with the picture, in the file or beside it (an audio file has no place for them).
  const langs = o.subs.on ? safeLangs(o.subs.langs) : []; const subLangs = [...langs, ...(ex.liveChat ? ['live_chat'] : [])];
  if (o.subs.on && !langs.length) rejected.push('subs');
  if (subLangs.length) {
    args.push('--write-subs'); if (langs.length && o.subs.auto) args.push('--write-auto-subs'); args.push('--sub-langs', subLangs.join(','));
    if (langs.length) { if (!audio && o.subs.how === 'embed') { args.push('--embed-subs'); need('embed'); if (ex.bilingual) args.push('--sub-format', 'srt/best', '--convert-subs', 'srt', '-k'); } else { args.push('--convert-subs', o.subs.fmt); need('convert-subs'); } }
  }
  if (o.thumbFile || ex.cover) { args.push('--write-thumbnail', '--convert-thumbnails', 'jpg'); need('convert-thumbnails'); }
  if (ex.infoJson) args.push('--write-info-json', '--no-clean-info-json');
  if (ex.comments) args.push('--write-comments');
  if (o.sponsor === 'remove') { args.push('--sponsorblock-remove', o.sponsorCats.join(',')); need('sponsorblock'); }
  else if (o.sponsor === 'mark') { args.push('--sponsorblock-mark', o.sponsorCats.join(',')); if (o.chapters !== 'embed') { args.push('--embed-chapters'); need('embed'); } }

  // Parts: time ranges and chapters by name (what the sheet's «only a part» gives).
  for (const sec of String(ex.section ?? '').split(/\s*[,;]\s*/)) if (SECTION.test(sec)) args.push('--download-sections', `*${sec}`);
  if (ex.chapterMatch) { if (/^[^-]/.test(ex.chapterMatch) && ex.chapterMatch.length <= 100 && !/[\x00-\x1f]/.test(ex.chapterMatch)) args.push('--download-sections', ex.chapterMatch); else rejected.push('chapterMatch'); }
  for (const [k, v] of Object.entries(ex.headers ?? {})) { if (/^[A-Za-z0-9-]{1,60}$/.test(k) && v && !/[\x00-\x1f]/.test(v) && v.length <= 2000) args.push('--add-header', `${k}:${v}`); else if (k) rejected.push('header'); }

  // Playlists: this video only, the whole list, or a range of it (the sheet adds a list's videos one by one — each its own task —
  // with `playlistIndex`; a whole list in one job is for a caller that wants it so).
  if (!native) args.push('--no-playlist');
  else if (mode === 'all') args.push('--yes-playlist');
  else args.push('--yes-playlist', '--playlist-items', range!);

  // The name: a preset or the reader's own pattern, in the download folder (the native side gives -P; no folder or path can come from here).
  let tpl: string;
  if (o.name === 'custom') { const c = safeTemplate(o.custom); if (c) tpl = c; else { if (o.custom.trim()) rejected.push('template'); tpl = TEMPLATES.title; } } else tpl = TEMPLATES[o.name];
  if (tpl === TEMPLATES.playlist || /%\(playlist_(index|title)\)/.test(tpl)) {
    // (Said by the page when one video of a list is added alone: its list's title and its place are literal then.)
    if (ctx.playlistIndex !== undefined) tpl = tpl.replace(/%\(playlist_title\)s/g, literal(ctx.playlistTitle ?? '') || 'playlist').replace(/%\(playlist_index\)0?2d/g, pad2(ctx.playlistIndex)).replace(/%\(playlist_index\)s/g, String(ctx.playlistIndex));
    else if (!native) tpl = tpl.replace(/%\(playlist_title\)s\/?/g, '').replace(/%\(playlist_index\)(0?2d|s)( - )?/g, '');
  } else if (o.number && inList) tpl = (ctx.playlistIndex !== undefined ? `${pad2(ctx.playlistIndex)} - ` : '%(playlist_index)02d - ') + tpl;
  const base = (ex.outName ? literal(ex.outName) : '') || tpl;   // (a name given by the caller wins; the folder of a playlist preset stays on the pieces)
  args.push('-o', `${base}.%(ext)s`);
  if (o.chapters === 'split') args.push('-o', `chapter:${base} - %(section_number)02d %(section_title)s.%(ext)s`);
  if (o.thumbFile || ex.cover) args.push('-o', `thumbnail:${base}.%(ext)s`);

  // Speed: pieces of a stream fetched at once, chunked requests (help against throttled hosts), patience on a flaky link, and a fresh start when the host slows the download to a crawl.
  const n = Math.max(0, Math.min(16, Math.floor(ctx.fragments ?? 0)));
  args.push(...(n > 1 ? ['-N', String(n)] : []), '--http-chunk-size', '10M', '--retries', '10', '--fragment-retries', '10', '--throttled-rate', '100K', '--buffer-size', '64K');
  return { args, needs: [...needs], dropped, rejected };
}

/** Pieces fetched at once from the setting (0: Auto) and the Downloads «connections» setting (0: the app decides). */
export const resolveFragments = (setting: number | undefined, connections: number | undefined): number => (setting && setting > 0 ? Math.min(16, setting) : connections && connections > 0 ? Math.min(16, connections) : 4);

/** Every flag the builder can write: the native sides refuse a list with any other (--exec, --config-location, --load-info-json, -P, --cookies… never pass). */
export const ALLOWED_FLAGS: readonly string[] = ['-f', '-S', '--merge-output-format', '--remux-video', '-x', '--audio-format', '--audio-quality', '--embed-thumbnail', '--convert-thumbnails', '--embed-metadata', '--parse-metadata', '--embed-chapters', '--split-chapters', '--write-subs', '--write-auto-subs', '--sub-langs', '--embed-subs', '--convert-subs', '--sub-format', '-k', '--write-thumbnail', '--write-info-json', '--no-clean-info-json', '--write-comments', '--sponsorblock-remove', '--sponsorblock-mark', '--download-sections', '--add-header', '--no-playlist', '--yes-playlist', '--playlist-items', '-o', '-N', '--http-chunk-size', '--retries', '--fragment-retries', '--throttled-rate', '--buffer-size'];
/** A list of arguments checked the way the native sides do: only known flags, values that are not flags, «-o» inside the download folder. Null when it fails. */
export function vetArgs(args: unknown): string[] | null {
  if (!Array.isArray(args) || args.length > 200 || !args.every((a) => typeof a === 'string' && a.length <= 4000 && !a.includes('\0'))) return null;
  const xs = args as string[]; const out: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i];
    if (!a.startsWith('-')) return null;                              // (a value is always taken with its flag below)
    if (!ALLOWED_FLAGS.includes(a)) return null; out.push(a);
    const alone = a === '-x' || a === '-k' || a === '--embed-thumbnail' || a === '--embed-metadata' || a === '--embed-chapters' || a === '--split-chapters' || a === '--write-subs' || a === '--write-auto-subs' || a === '--embed-subs' || a === '--write-thumbnail' || a === '--write-info-json' || a === '--no-clean-info-json' || a === '--write-comments' || a === '--no-playlist' || a === '--yes-playlist';
    if (alone) continue;
    const v = xs[++i]; if (v === undefined || v.startsWith('-')) return null;
    if (a === '-o') { const t = v.replace(/^(?:chapter|thumbnail|subtitle|infojson|description|pl_thumbnail|pl_infojson|pl_description|default):/, ''); if (/^[\\/~]|^[A-Za-z]:|\.\.|[$\x00]/.test(t) || t.split('/').some((p) => p === '..')) return null; }
    out.push(v);
  }
  return out;
}
