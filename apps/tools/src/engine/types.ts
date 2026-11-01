// What a download is, wherever its bytes come from — a plain file over HTTP, a torrent (a magnet or a .torrent
// file), a debrid service's link — and however the platform fetches it: the app's own engine on Android
// (libtorrent, the multi-connection downloader), aria2c beside the desktop app, a remote aria2 the user
// points the app at, or the browser's own download on the web. The views speak this and nothing else.

export type TaskState = 'queued' | 'metadata' | 'downloading' | 'seeding' | 'paused' | 'done' | 'failed' | 'checking';
export type TaskKind = 'http' | 'torrent' | 'debrid' | 'video';

/** Where the bytes come from. Exactly one of the three is set. */
export interface TaskSource {
  /** A direct link (http/https/ftp). */
  url?: string;
  /** A magnet link. */
  magnet?: string;
  /** A .torrent file's bytes, base64. */
  torrent?: string;
  /** Headers the link needs (a referer, a cookie, a debrid token). */
  headers?: Record<string, string>;
}

export interface TaskFile {
  index: number;
  /** Path inside the download (relative; a single-file torrent's name). */
  path: string;
  size: number;
  done: number;
  /** 0 = skipped, 1 = normal, 2 = high (the file being streamed). */
  priority: 0 | 1 | 2;
}

export interface Task {
  id: string;
  kind: TaskKind;
  /** The name shown: the torrent's, the file's, the link's last part until the server says. */
  name: string;
  source: TaskSource;
  /** The folder the download lands in (a path, or a content: URI on Android). */
  dir: string;
  state: TaskState;
  done: number;
  total: number;
  downSpeed: number;
  upSpeed: number;
  /** Seconds left, when known. */
  eta?: number;
  peers?: number;
  seeds?: number;
  connections?: number;
  infoHash?: string;
  files: TaskFile[];
  /** Sequential piece order (so the file plays while it comes). */
  sequential?: boolean;
  error?: string;
  addedAt: number;
  doneAt?: number;
  /** What added it: a search add-on, a page, the user — for the list's groups and the anime add-on's tracking. */
  /** The ranges the connections are fetching (plain files): what the details page draws. */
  segments?: { start: number; pos: number; end: number; speed?: number; active: boolean; worker: number }[];
  /** A torrent's pieces in a hundred stretches (a digit 0–9 each: how much of it is here), and the pieces here of all. */
  pieceMap?: string; numPieces?: number; havePieces?: number;
  meta?: { kind?: 'subtitle' | 'apk' | 'video'; lang?: string; archive?: string; debrid?: string; addon?: string; title?: string; episode?: number; batch?: boolean; anilistId?: number; imdbId?: string; cover?: string; season?: number; quality?: string; provider?: string; hash?: string; fileIdx?: number;
    /** A Hugging Face file: its repository, and the SHA-256 it is checked against when done. */
    hf?: string; sha256?: string };
  /** Which engine holds it (the platform's, 'aria2' for a remote aria2, 'browser'). */
  engine: EngineId;
}

export type EngineId = 'native' | 'aria2' | 'browser';

export interface AddOptions {
  source: TaskSource;
  dir?: string;
  name?: string;
  sequential?: boolean;
  /** Files to take (indexes); the rest skipped. Undefined: all. */
  files?: number[];
  /** Connections for an HTTP download (the engine's default otherwise). */
  connections?: number;
  meta?: Task['meta'];
  /** Start paused (to pick files once the metadata is here). */
  paused?: boolean;
  /** A page for yt-dlp (the Video add-on): the format chosen and what the list shows. */
  video?: { format?: string; title?: string; site?: string; label?: string; audioOnly?: boolean; container?: string; subs?: string; thumbnail?: string; playlistIndex?: number; embedThumb?: boolean; sponsorblock?: boolean; headers?: Record<string, string>; outName?: string;
    /** Chapters kept in the file; the file name's pattern (yt-dlp's); only a part («1:00-2:30»); a browser's cookies (desktop). */
    chapters?: boolean; template?: string; section?: string; cookies?: string };
}

export interface Limits { down: number; up: number; /** bytes/s; 0 = unlimited */ }

export interface TorrentDetail { peers?: { ip: string; client: string; down: number; up: number; progress: number; total: number; utp: boolean }[]; trackers?: { url: string; tier: number; state: 'working' | 'updating' | 'failing' | 'waiting'; message: string; fails: number }[]; seeds?: number; peersConnected?: number; seedsInSwarm?: number; peersInSwarm?: number; ratio?: number; limitDown?: number; limitUp?: number }
/** One torrent's metadata, fetched before the download is added (to pick files, to see the size). */
export interface TorrentInfo { name: string; infoHash: string; total: number; files: { index: number; path: string; size: number }[] }

/** The engine of one platform. Every method may throw a plain Error with a message for the user. */
export interface Engine {
  readonly id: EngineId;
  /** What this engine can do here. */
  readonly can: { torrents: boolean; http: boolean; stream: boolean; limits: boolean; pickFiles: boolean; pause: boolean; seeding: boolean };
  list(): Promise<Task[]>;
  add(o: AddOptions): Promise<Task>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  /** The task gone; `deleteFiles` takes its files off the disk too. */
  remove(id: string, deleteFiles: boolean): Promise<void>;
  setFiles?(id: string, priorities: (0 | 1 | 2)[]): Promise<void>;
  setSequential?(id: string, on: boolean): Promise<void>;
  /** A torrent up close: its peers, trackers, swarm counts and own limits. */
  torrentDetail?(id: string): Promise<TorrentDetail>;
  /** Its files checked again against their hashes. */
  recheck?(id: string): Promise<void>;
  /** Every tracker and the DHT asked for peers now. */
  reannounce?(id: string): Promise<void>;
  /** This download's own speed limits (bytes/s; 0 = none). */
  setTaskLimits?(id: string, down: number, up: number): Promise<void>;
  setLimits?(l: Limits): Promise<void>;
  /** A new address for a file download whose link ran out: the same file, gone on from where it stopped. */
  setUrl?(id: string, url: string): Promise<void>;
  /** Moved in the queue: -1 up, +1 down, -2 to the top, +2 to the bottom. */
  move?(id: string, how: -2 | -1 | 1 | 2): Promise<void>;
  /** The metadata of a magnet or .torrent, without adding it. */
  torrentInfo?(source: TaskSource): Promise<TorrentInfo>;
  /** A local address the file can be played from while it comes (range requests served from the pieces). */
  streamUrl?(id: string, fileIndex: number): Promise<string>;
  /** Told of every change (progress, state); returns the way to stop listening. */
  onChange(fn: (tasks: Task[]) => void): () => void;
  /** Opens the finished file (or its folder) with the system. */
  open?(id: string, fileIndex?: number): Promise<void>;
}
