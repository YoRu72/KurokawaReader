// The app's settings: kept in localStorage under one key, applied to the document (theme, accent) on change.
import type { Limits } from './engine/types';
import { applyTheme, themeById, THEMES, readEnv, resolveBlur, migrateLook, upsertTheme, removeTheme, DEFAULT_THEME, type BlurPref, type Blur, type ThemeDef, type Mode } from './theme/themes';
import { migrateMain } from './theme/app';
import type { MyTheme } from './theme/custom';
import { myStore } from './myStore';
import { nativePlatform } from './native';

export type UiMode = 'system' | 'light' | 'dark';
export type DarkTone = 'default' | 'grey' | 'black';
export type Accent = 'theme' | 'graphite' | 'mono' | 'teal' | 'aqua' | 'mint' | 'olive' | 'gold' | 'sand' | 'coral' | 'rose' | 'violet' | 'custom';

export interface Settings {
  uiMode: UiMode;
  /** The interface's size, in percent (phones with big system fonts want less). */
  uiScale: number;
  darkTone: DarkTone;
  accent: Accent;
  accentCustom: string;
  /** The accent before a theme's own colours were taken (given back when a theme that follows the accent is chosen). */
  accentPrev?: Accent;
  /** The theme (theme/themes.ts): 'classic' = «Expressive 3», the main theme (the app's own look); the others glass. */
  theme?: string;
  /** The reader chose the theme (the gallery, the editor), so no move to a new default ever touches it (from 0.21). */
  themeChosen?: boolean;
  /** Set once by the move to themes for those who had chosen their own dark tone or accent: Frost keeps those colours. */
  themeKeepColours?: boolean;
  /** How much glass is blurred: chosen, or 'auto' (by the device, the system's wishes, the battery). */
  glassBlur?: BlurPref;
  /** A phone: lighter glass while the battery is low (default on). A computer: the sidebar in glass, or solid (default glass). */
  glassBattery?: boolean; glassRail?: boolean;
  /** A computer: the animated background (theme/animbg.ts) — off unless chosen —, how much it moves, and the seed its
   *  shapes and places come from (fixed: the same background each start). */
  animBg?: 'off' | 'match' | 'drift' | 'flow' | `scene:${string}`; animBgLevel?: 'full' | 'reduced' | 'still'; animBgSeed?: number;
  /** A computer's scenes: where they show (the whole window, the default, or the content area only), whether the app's
   *  accents follow the scene's own colours (off unless chosen), how much they answer the mouse (Subtle unless chosen). */
  animBgWhere?: 'whole' | 'content'; animBgTint?: boolean; animBgReact?: 'off' | 'subtle' | 'lively';
  /** A computer's own background mixes (theme/sceneMix.ts): stored as made, never trusted — cleaned (cleanMixes) on every
   *  read; chosen as animBg «scene:mix:<id>». They travel in the settings backup with the rest. */
  animBgMixes?: unknown[];
  /** A computer's own pictures and videos as the background (theme/bgLib.ts): the list, cleaned (cleanItems) on every
   *  read; chosen as animBg «scene:user:<id>». The files themselves are in the app's storage, not in the backup. */
  animBgLib?: unknown[];
  /** The download folder (a path, or a content: URI on Android); '' = the engine's default. */
  downloadDir: string;
  /** Folders chosen lately in the Add sheet, newest first. */
  recentDirs?: string[];
  maxActive: number;
  /** Video downloads at once (unset: 2 on a phone, 3 on a computer). */
  maxVideo?: number;
  /** The bottom bar's places in the reader's order, and those left off it (Settings always stays). */
  navOrder?: string[]; navHidden?: string[];
  /** A page swiped sideways goes to the bottom bar's next or previous place (on by default). */
  swipeTabs?: boolean;
  /** The + menu's entries in the reader's order, and those left off. */
  fabOrder?: string[]; fabHidden?: string[];
  /** Connections per file download (0: the app decides; fewer suit a weak phone link, more a fast one). */
  connections: number;
  /** Connections over every file download at once (the phone's engine). */
  connBudget?: number;
  /** The phone's file-download engine (stage M2): Java's (the default) or the Rust core's decisions. Phones only, and
   *  only offered when the app carries the core; read by the engine when a download starts. */
  dlEngine?: 'java' | 'rust';
  /** The phone's torrent engine for new torrents (stage M3): libtorrent4j as it is (Classic, the default), libtorrent4j
   *  steered by the Rust director (Director), or librqbit (Rust). Phones only, offered per library present. */
  torEngine?: 'classic' | 'director' | 'rust';
  /** Stage M4: the phone's screen translator engine (Settings → Advanced; the engine keeps its own copy). */
  screenEngine?: 'classic' | 'rust';
  /** (Stage M5: the Files jobs' engine on a phone with the Rust core — Settings → Advanced; default classic.) */
  fileEngine?: 'classic' | 'rust';
  /** Streams (HLS playlists) fetched by the app itself — pieces joined here — rather than by yt-dlp. Default on. */
  hlsNative?: boolean;
  /** A computer: a yt-dlp binary of the reader's own instead of the managed one (empty: managed). */
  videoBinaryPath?: string;
  /** The last quick preset (Fast / Quality / Compact / Music) applied first next time. Default on. */
  videoRememberPreset?: boolean;
  /** Courses: lectures numbered continuously across the course (default), or anew in each section. */
  coursesContinuous?: boolean;
  /** Convert on a computer: the hardware H.264 encoder (NVENC, VideoToolbox, QSV, AMF) when there is one. Default on. */
  convertHw?: boolean;
  /** A computer: the local API on 127.0.0.1 for a command line, scripts and a browser extension — on/off, its token and port. */
  localApi?: { on: boolean; token?: string; port?: number };
  /** Finished files hashed; identical ones become hard links (the room taken once). Android. */
  dedupe?: boolean;
  /** The rules: what a link gets by its host, its words or its kind (see downloads/rules.ts). */
  rules?: import('./downloads/rules').Rule[];
  limits: Limits;
  seedAfterDone: boolean;
  listenPort: number;
  /** Sequential download by default for video torrents. */
  sequentialVideo: boolean;
  /** A remote aria2 (JSON-RPC) used for every download. */
  aria2: { url: string; secret: string; use: boolean };
  autoUpdateCheck: boolean;
  /** How often updates are looked for, and (Android) whether a new version is fetched by itself, then offered. */
  updateEvery?: 'launch' | 'daily' | 'weekly'; updateAutoDownload?: boolean;
  /** Add-ons, themes and wallpapers brought up to date from the repository by themselves (liveUpdates.ts); unset: on. */
  liveUpdates?: boolean;
  /** Catalogue themes and scenes already shown to the reader (the rest carry «New»), by id. */
  seenThemes?: string[]; seenScenes?: string[];
  updateChannel: 'stable' | 'beta';
  notifyDone: boolean;
  notifyFailed: boolean;
  incognito: boolean;
  /** Installed add-ons by id. */
  addons: string[];
  /** Each add-on's own settings (keys, choices), by add-on id. */
  addonSettings: Record<string, Record<string, string | number | boolean>>;
  /** AniList: the OAuth client id the user made, changes queued while offline, progress marked as episodes are watched. */
  anilistClientId: string;
  /** «Watch now» plays the best release by itself (else the releases are shown to choose from, as in Hayase). */
  animeWatchAuto?: boolean;
  anilistPending: Record<string, unknown>;
  anilistAutoProgress: boolean;
  /** Anime: extension repositories (Hayase index.json or Seanime marketplace URLs), the preferred quality, adult shows. */
  animeRepos: string[];
  /** Auto-download rules (anime/auto.ts): a show's choices and the next episode to fetch. */
  animeAuto: unknown[];
  animeQuality: '' | '2160' | '1080' | '720' | '480';
  animeAdult: boolean;
  animeTitleLang: 'preferred' | 'romaji' | 'english' | 'native';
  /** Subtitles: the languages wanted, in order. */
  subLangs: string[];
  /** Settings shown as one list, or with a bar of tabs above: all, the app's own, each add-on's. */
  settingsLayout: 'tabs' | 'list';
  /** The Videos tab (the Player add-on's library: the phone's videos, the recent ones, media servers). */
  videosTab?: boolean;
  /** Media servers (Jellyfin, WebDAV) the library browses. */
  mediaServers?: { id: string; type: 'jellyfin' | 'webdav'; name: string; url: string; user: string; pass?: string; token?: string; userId?: string }[];
  /** Archives: unpack subtitle archives as they arrive; unpack every downloaded archive. */
  autoUnpackSubs: boolean;
  autoUnpackAll: boolean;
  /** Debrid: torrents go through the service by default; the transfers waiting on it. */
  debridDefault: boolean;
  debridTransfers: unknown[];
  /** Categories (Prism's): the user's own, folders per category, how the list is sorted. */
  categories: { id: string; name: string; icon: string; exts: string[]; dir?: string }[];
  useCategoryFolders: boolean;
  sort: 'queue' | 'added' | 'name' | 'size' | 'state' | 'progress' | 'speed' | 'eta';
  /** The Downloads page's options (filters, order, look): see views/downloadsOptions.ts. */
  dl?: import('./views/downloadsOptions').DlPrefs;
  /** The clipboard watched for links (asked before adding), and the schedule downloads run in. */
  clipboardWatch: boolean;
  /** A post's link (X, Instagram, Bluesky, Reddit, Telegram…) opens its photos and videos at once (off: «Show them» first). */
  socialAuto?: boolean;
  /** Torrent options (Senpwai's): peer discovery, encryption, when seeding stops (0 = never). */
  torrent: { dht: boolean; lsd: boolean; upnp: boolean; natpmp: boolean; enc: 'enabled' | 'forced' | 'disabled'; seedRatio: number; seedMinutes: number; addTrackers?: boolean; simpleDisk?: boolean; connsPerTorrent?: number; connsTotal?: number; torrentProxy?: boolean; bindIface?: string; anonymous?: boolean };
  /** Privacy (from the reader): DNS over HTTPS (off, a provider, or a resolver's address) and screenshots blocked. */
  doh: string; dohSplit?: 'auto' | 'always' | 'off'; /** (0.21 P9) the system's DNS when every DoH resolver failed — off by default. */ dohSystem?: boolean; secureScreen: boolean;
  /** How a video is watched: asked each time, the in-app player (the Player add-on), or another app. */
  playerWith: 'ask' | 'app' | 'external';
  /** Another app as the player (src/player/external): for each kind of source «ask», «app» or «out» (the outside way) —
   *  the phone's and the computer's apart (phone-only apps never offered on a computer, and the reverse). */
  extPlayers?: Partial<Record<'android' | 'desktop', Partial<Record<'torrent' | 'online' | 'http' | 'local', string>>>>;
  /** (Computer) which player the outside way uses: «auto» (the first known one found), a known player's id, or «chosen»
   *  (the program picked in the shell's own dialog — kept by the shell, never here). */ extPcPlayer?: string;
  /** «Mark as watched?» after an app that tells nothing: undefined — for a tracked episode; true — always; false — never. */ extAskWatched?: boolean;
  /** Sounds and the «Download complete» card (downloads/done.ts). */
  sounds?: import('./downloads/done').SoundPrefs;
  net?: Partial<import('./downloads/net').NetPrefs>;
  miniAuto?: boolean;
  /** A folder of fonts for styled subtitles (the Player add-on). */
  playerFontsDir?: string; /** A computer's installed fonts used for styled subtitles (on unless turned off). */ playerSystemFonts?: boolean; /** Slow mode on: the limits it replaced, put back when it is turned off. */ slowMode?: { prev?: { down: number; up: number } }; /** Finished entries cleared from the list after this many days (0: never; the files stay). */ dlAutoClean?: number; /** When downloads may run (Wi-Fi only, not on a low battery) and the computer's side (kept awake, when all are done). */ power?: import('./downloads/power').Power; /** The player's engine on Android: mpv (when its pack is here; the default) or the web view's own. */ playerEngine?: 'mpv' | 'web';
  /** More folders for the anime library. */
  animeLibraryDirs?: string[];
  /** Hayase's «hide spoilers»: episodes past the one you are on keep their titles and pictures hidden. */
  animeHideSpoilers?: boolean;
  /** Where an episode's note goes when Send is pressed on AniList: an activity, the list entry's notes, or nowhere. */
  animeNotesMode?: 'local' | 'activity' | 'notes';
  /** The user's own MyAnimeList API client ID (MyAnimeList gives apps none): for sending notes to its list comments. */
  malClientId?: string;
  /** After an episode counts as watched in the player: the progress on AniList (and MyAnimeList) moved to it (default on). */
  animeTrackAfterWatch?: boolean;
  /** After that: a small bar on the show's page offering to review the episode (default on). */
  animeAskReview?: boolean;
  /** Starting a download goes to the Downloads page (default off: a small floating progress bar instead). */
  openDownloadsOnStart?: boolean;
  /** What becomes of the data a streamed episode left on the device when the player is left: asked each time (default), kept, or deleted. */
  streamKeep?: 'ask' | 'keep' | 'delete';
  /** Halfway through an episode, the next one starts downloading. */
  animePreloadNext?: boolean;
  /** Episodes downloaded to be watched: kept, deleted once watched, or deleted some days after. */
  episodeCache?: { mode: 'keep' | 'watched' | 'days'; days: number };
  /** Senpwai's review of the picks before a range is added. */
  animeReview?: boolean;
  /** The TV & Movies add-on: Torrentio's options, and the series followed. */
  tv?: Partial<import('./tv/torrentio').TvPrefs>;
  tvFollows?: import('./tv/library').Follow[];
  /** Hayase's lookup preference: among equally good releases, the best quality, the smallest, or the most seeded. */
  animeLookup?: 'quality' | 'size' | 'seeders';
  /** The antivirus check after a download (the computer): which scanner, a command of one's own, which kinds of file. */
  /** Hugging Face: the server (or a mirror), the access token, the models folder. */
  hf?: import('./hf/hf').HfPrefs;
  av?: { on: boolean; kind: 'auto' | 'defender' | 'clamav' | 'custom'; command: string; args: string; extensions: string };
  /** Archives (HatchZip): space never used by an extraction in place (bytes), every checksum read before an archive is cut, the sheet closed when done. */
  archiveKeepFree: number; archiveVerifyFirst: boolean; archiveCloseWhenDone: boolean;
  /** The Video add-on: the quality taken when none is picked, the container, the cover and sponsor-skip. */
  videoQuality: 'best' | '2160' | '1440' | '1080' | '720' | '480' | 'audio'; videoContainer: 'mp4' | 'mkv' | 'webm'; videoEmbedThumb: boolean; videoSponsor: boolean;
  /** SponsorBlock: cut the segments out, or mark them as chapters; which categories (comma-separated yt-dlp names). */
  videoSponsorMode?: 'off' | 'remove' | 'mark'; videoSponsorCats?: string[];
  /** Sidecars beside finished videos for media servers: a Kodi/Jellyfin .nfo (and the info.json kept), the cover picture. */
  sidecarNfo?: boolean; sidecarKeepJson?: boolean; sidecarCover?: boolean;
  /** More beside a video: its comments and chapters as text, a live stream's chat; lyrics (.lrc from LRCLIB) beside music. */
  videoRyd?: boolean; sidecarComments?: boolean; sidecarChapters?: boolean; sidecarLiveChat?: boolean; sidecarLyrics?: boolean;
  /** What to get from a video page (src/downloads/videoArgs.ts): the last choice, kept as the default; the reader's named presets (just saved options); whether the sheet asks each time (default) or one tap uses the default; the pieces of a stream fetched at once (0: Auto). */
  videoOpts?: Partial<import('./downloads/videoArgs').VideoOptions>; videoPresets?: { name: string; opts: Partial<import('./downloads/videoArgs').VideoOptions> }[]; videoAsk?: boolean; videoFragments?: number;
  videoChapters?: boolean; videoTemplate?: string; videoNumber?: boolean; videoCookies?: string;
  schedule: { enabled: boolean; start: string; stop: string; days: number[] };
  /** A computer's window where the shell has the page draw its bar (the Tauri shell — src/ui/winbar.ts, the Reader's
   *  too): the app's own title bar in the theme's colours, or the system's frame. */
  titleBarKind: 'own' | 'system';
  /** The app's own bar without a surface: the window's buttons float over the top of the page. */
  titleBarClear: boolean;
  /** The app's icon and name at the start of its own (solid) bar; off, the sidebar keeps them. */
  titleBarName: boolean;
}

const KEY = 'kt.settings';
/** The snackbar owed after the main theme came back (0.21): what was in use before, for its «Use Frost». */
export const MAIN_NOTE_KEY = 'kt.mainThemeNote';
const DEFAULTS: Settings = {
  uiMode: 'system', uiScale: 100, darkTone: 'default', accent: 'graphite', accentCustom: '#7fb8ff', theme: DEFAULT_THEME, glassBlur: 'auto',
  downloadDir: '', maxActive: 3, connections: 0, limits: { down: 0, up: 0 }, seedAfterDone: false, listenPort: 0, sequentialVideo: false,
  aria2: { url: 'http://127.0.0.1:6800/jsonrpc', secret: '', use: false },
  autoUpdateCheck: true, updateChannel: 'stable', notifyDone: true, notifyFailed: true, incognito: false, addons: [], addonSettings: {},
  anilistClientId: '', anilistPending: {}, anilistAutoProgress: true, animeRepos: [], animeAuto: [], animeQuality: '1080', animeAdult: false, animeTitleLang: 'preferred',
  subLangs: [], settingsLayout: 'tabs', autoUnpackSubs: true, autoUnpackAll: false, debridDefault: false, debridTransfers: [],
  categories: [], useCategoryFolders: false, sort: 'added', clipboardWatch: false, torrent: { dht: true, lsd: true, upnp: true, natpmp: true, enc: 'enabled', seedRatio: 0, seedMinutes: 0 }, doh: 'off', secureScreen: false, playerWith: 'ask', archiveKeepFree: -1, archiveVerifyFirst: true, archiveCloseWhenDone: true, videoQuality: 'best', videoContainer: 'mp4', videoEmbedThumb: true, videoSponsor: false, schedule: { enabled: false, start: '01:00', stop: '07:00', days: [] },
  titleBarKind: 'own', titleBarClear: false, titleBarName: true,
};

/** Parts of the app once offered as add-ons and now always there: the player. */
export const BUILT_IN = ['player'];
const withBuiltIn = (s: Settings): Settings => (BUILT_IN.every((b) => s.addons.includes(b)) ? s : { ...s, addons: [...s.addons, ...BUILT_IN.filter((b) => !s.addons.includes(b))] });
let current: Settings = load();
// (The reader's own themes, among the others from the start. Their strict check — theme/custom.ts — is fetched only when
//  some are kept, so a start without any does not carry it: the page stays hidden that moment, as for the palettes.)
const raw0 = myStore.load(); const hasMine0 = Array.isArray(raw0) && raw0.length > 0;
migrateTheme(hasMine0);
// (The palette themes — theme/palettes.ts — are fetched with Appearance; at the start only when the theme in use, or the
//  base of one of the reader's, is not yet known: the page stays hidden that moment rather than flash another theme.)
const known = (id?: string) => THEMES.some((x) => x.id === id);
if (hasMine0 || !known(current.theme)) {
  const html = document.documentElement; html.dataset.themeWait = '';
  void (async () => {
    let mine0: MyTheme[] = []; let toDef: ((m: MyTheme) => ThemeDef) | null = null;
    if (hasMine0) { const c = await import('./theme/custom'); toDef = c.toDef; mine0 = c.loadMine(myStore); for (const m of mine0) upsertTheme(toDef(m)); }
    if (!known(current.theme) || mine0.some((m) => !known(m.base))) {
      const got = await import('./theme/palettes').then(() => true, () => false); if (!got) return;
      for (const m of mine0) upsertTheme(toDef!(m));
    }
    applyChrome();
  })().catch(() => undefined).finally(() => { delete html.dataset.themeWait; });
}
if (!current.subLangs.length) { const ui = (localStorage.getItem('kr.lang') || navigator.language || 'en').slice(0, 2); current.subLangs = [...new Set([ui, 'en'])]; }
const listeners = new Set<(s: Settings) => void>();
/** Once: the move to themes (kt.themeMigrated, 0.17). Then once (kt.mainTheme, 0.21): «Expressive 3» the main theme
 *  again — an install Frost was given without asking goes back to it (theme/app.ts migrateMain), a snackbar then
 *  says so and can undo it (kt.mainThemeNote, theme/mainNote.ts); a theme chosen is kept, and marked as chosen. */
function migrateTheme(hasMine: boolean): void {
  // (A theme that is no longer in the app — «ember» was taken out before release — falls back to the default.)
  if (current.theme === 'ember') { current = { ...current, theme: DEFAULT_THEME }; try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ } }
  try {
    const raw = localStorage.getItem(KEY);
    let stored: Partial<Settings> | null = null;
    try { const v: unknown = raw ? JSON.parse(raw) : null; stored = v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<Settings>) : null; } catch { stored = null; }
    let dirty = false;
    if (!localStorage.getItem('kt.themeMigrated')) {
      if (!stored?.theme) { const m = migrateLook(stored); current = { ...current, theme: m.theme, themeKeepColours: m.keepColours || undefined }; dirty = true; }
      localStorage.setItem('kt.themeMigrated', '1');
    }
    if (!localStorage.getItem('kt.mainTheme')) {
      const m = migrateMain(stored, hasMine);
      if (m.moved) { current = { ...current, theme: m.theme, themeKeepColours: undefined }; localStorage.setItem(MAIN_NOTE_KEY, JSON.stringify(m.prev)); dirty = true; }
      else if (m.chosen && !current.themeChosen) { current = { ...current, themeChosen: true }; dirty = true; }
      localStorage.setItem('kt.mainTheme', '1');
    }
    if (dirty && stored) localStorage.setItem(KEY, JSON.stringify(current));
  } catch { /* private mode: the defaults */ }
}
function load(): Settings {
  try { return withBuiltIn({ ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>), aria2: { ...DEFAULTS.aria2, ...((JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>).aria2 ?? {}) } }); } catch { return withBuiltIn({ ...DEFAULTS }); }
}
export const getSettings = (): Settings => current;
export function updateSettings(patch: Partial<Settings>): Settings {
  current = withBuiltIn({ ...current, ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
  applyChrome(current);
  listeners.forEach((fn) => fn(current));
  return current;
}
export function onSettingsChange(fn: (s: Settings) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/* ---------- the look ---------- */
const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
mql?.addEventListener?.('change', () => applyChrome());
/** What the blur came to here (shown beside the choice), and why. */
export let glassNow: ReturnType<typeof resolveBlur> = { blur: 'full', why: 'platform' };
let lowBattery = false;
let pictures: Record<string, string> = {}; let picturesFor = '';
/** The pictures of the theme in use, read from where its pack was kept (then the look applied again). */
export function reloadThemePictures(): void { picturesFor = ''; pictures = {}; applyChrome(); }
/** The theme being edited, shown live in place of the chosen one (null: the chosen one again). */
let previewing: { def: ThemeDef; useThemeColours: boolean; pictures: Record<string, string> } | null = null;
export function setThemePreview(p: typeof previewing): void { previewing = p; if (p) upsertTheme(p.def); else { removeTheme('my-preview'); picturesFor = ''; } applyChrome(); }
/** Pictures a theme draws: its pack's, and the reader's own for a theme of theirs. */
async function picturesOf(def: ThemeDef): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (def.pack?.id) Object.assign(out, await import('./themeIo').then((m) => m.themePictures(def.pack!.id)).catch(() => ({})));
  if (def.custom && def.id !== 'my-preview') { const { pictureKey, pictureAsset } = await import('./theme/custom'); for (const m of ['dark', 'light'] as Mode[]) { if ((m === 'dark' ? def.dark : def.light)?.picture !== pictureAsset(def.id, m)) continue; const b = await myStore.io.getFile(pictureKey(def.id, m)).catch(() => undefined); if (b) out[pictureAsset(def.id, m)] = URL.createObjectURL(b); } }
  return out;
}
const isPcNow = () => typeof document !== 'undefined' && document.documentElement.classList.contains('pc');
export function applyChrome(s: Settings = current): void {
  const wantLight = s.uiMode === 'light' ? true : s.uiMode === 'dark' ? false : !!mql?.matches;
  const html = document.documentElement;
  const def = previewing ? previewing.def : themeById(s.theme);
  const plat = nativePlatform(); const env = readEnv(plat === 'android' ? 'android' : plat === 'desktop' ? 'desktop' : 'web', lowBattery && s.glassBattery !== false && !isPcNow());
  glassNow = resolveBlur(s.glassBlur ?? 'auto', env);
  const useThemeColours = (previewing ? previewing.useThemeColours : s.accent === 'theme') && !def.classic && !!(def.dark?.roles || def.light?.roles);
  const packId = `${def.id}|${def.pack?.id ?? ''}`;
  if (packId !== picturesFor) { picturesFor = packId; pictures = {}; void picturesOf(def).then((p) => { if (picturesFor === packId && Object.keys(p).length) { pictures = p; applyChrome(); } }); }
  const got = applyTheme(html, { theme: def.id, mode: wantLight ? 'light' : 'dark', darkTone: s.darkTone, useThemeColours, keepColours: !!s.themeKeepColours, blur: glassNow.blur as Blur, pictures: previewing ? { ...pictures, ...previewing.pictures } : pictures });
  const light = got.mode === 'light';
  html.dataset.ui = light ? 'light' : 'dark';
  // (A theme's own size goes with the reader's: the two multiplied.)
  const zoom = ((s.uiScale || 100) / 100) * (def.scale ?? 1);
  (html.style as CSSStyleDeclaration & { zoom?: string }).zoom = Math.abs(zoom - 1) > 0.001 ? String(+zoom.toFixed(3)) : '';
  html.dataset.dark = s.darkTone;
  html.dataset.accent = s.accent === 'theme' ? (useThemeColours ? 'theme' : 'graphite') : s.accent;
  if (s.glassRail === false) html.dataset.railGlass = 'off'; else delete html.dataset.railGlass;
  const roles = ['--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container', '--md-secondary-container', '--md-on-secondary-container', '--md-tertiary-container', '--md-on-tertiary-container'];
  if (s.accent === 'custom') applyCustomAccent(html, s.accentCustom, light); else if (!useThemeColours) roles.forEach((k) => html.style.removeProperty(k));
  // (A theme's own colours while one background is shown — a computer's — over the accent.)
  const per = isPcNow() && s.animBg ? def.perBg?.[s.animBg]?.[got.mode] : undefined;
  if (per) for (const [k, v] of Object.entries(per)) html.style.setProperty(`--md-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v);
  const meta = document.querySelector('meta[name="theme-color"]');
  // (The theme's ground: glass themes their own, Expressive 3 the dark tone's or its soft light one.)
  if (meta) meta.setAttribute('content', got.ground);
}
// (The system's wishes and the battery change while the app is open: the blur follows.)
if (typeof matchMedia === 'function') for (const q of ['(prefers-reduced-transparency: reduce)', '(prefers-reduced-motion: reduce)']) matchMedia(q).addEventListener?.('change', () => applyChrome());
void (navigator as Navigator & { getBattery?(): Promise<{ level: number; charging: boolean; addEventListener(e: string, f: () => void): void }> }).getBattery?.().then((b) => {
  const read = () => { const low = !b.charging && b.level <= 0.2; if (low !== lowBattery) { lowBattery = low; applyChrome(); } };
  read(); b.addEventListener('levelchange', read); b.addEventListener('chargingchange', read);
}).catch(() => undefined);
function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); const n = m ? parseInt(m[1], 16) : 0x7fb8ff;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0; const l = (max + min) / 2; const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, sat * 100, l * 100];
}
/** The M3 colour roles derived from one accent hue (as the reader does). */
function applyCustomAccent(html: HTMLElement, hex: string, light: boolean): void {
  const [h, sRaw] = hexToHsl(hex); const s = Math.min(90, Math.max(25, sRaw));
  const set = (k: string, v: string) => html.style.setProperty(k, v);
  if (light) {
    set('--md-primary', `hsl(${h} ${s}% 34%)`); set('--md-on-primary', '#fff');
    set('--md-primary-container', `hsl(${h} ${s}% 88%)`); set('--md-on-primary-container', `hsl(${h} ${s}% 12%)`);
    set('--md-secondary-container', `hsl(${h} ${Math.round(s * .5)}% 90%)`); set('--md-on-secondary-container', `hsl(${h} ${Math.round(s * .5)}% 15%)`);
    set('--md-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .6)}% 86%)`); set('--md-on-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .6)}% 14%)`);
  } else {
    set('--md-primary', `hsl(${h} ${s}% 74%)`); set('--md-on-primary', `hsl(${h} ${s}% 14%)`);
    set('--md-primary-container', `hsl(${h} ${Math.round(s * .7)}% 28%)`); set('--md-on-primary-container', `hsl(${h} ${s}% 90%)`);
    set('--md-secondary-container', `hsl(${h} ${Math.round(s * .35)}% 24%)`); set('--md-on-secondary-container', `hsl(${h} ${Math.round(s * .4)}% 88%)`);
    set('--md-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .5)}% 26%)`); set('--md-on-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .5)}% 88%)`);
  }
}
