// Sources: places books are browsed and fetched from, each an "extension" with the same shape — a search (or
// a shelf to browse when there is no query), filters the way Mihon shows them, tags, a book's page with its
// details and the ways to get it. The views draw every source the same way; each source speaks its site's API.

export interface SourceBook {
  id: string;                 // the source's own id for the book
  title: string;
  author?: string;
  cover?: string;             // a picture's URL
  lang?: string;              // a language code or name, for the badge
  year?: string;
  badge?: string;             // a short mark on the cover (downloads, pages…)
  description?: string;
  /** The formats the book can be fetched in (EPUB, PDF…), when the source tells at a glance: an empty list
   *  is a book that cannot be fetched (the archive's lending-only ones); left out, the source does not say. */
  formats?: string[];
  /** A card that opens a shelf of the source (a folder) instead of a book's page. */
  openShelf?: string;
  /** How the item is drawn: a folder's card (its first volume's cover on it), a series' card at the head of
   *  its volumes (with a button to fetch them all), a volume as a row with its cover, contents and button. */
  look?: 'folder' | 'series' | 'volume';
  /** The file a volume row fetches. */
  file?: SourceFile;
  /** The other editions of the same volume (a store's EPUB, a premium one, a scan…), the row's own first. */
  alts?: { label: string; id: string; file: SourceFile }[];
  /** The files a series' card fetches. */
  files?: SourceFile[];
  /** How many of the series' volumes, of how many, are in the library (a folder's card). */
  have?: number;
  /** New volumes of a series the reader follows, since the series' page was last opened. */
  fresh?: number;
  /** The series a fetched volume belongs to (remembered on the book). */
  group?: string;
  /** Its number in the series, when the name says. */
  volume?: number;
  /** The source's shelf (a folder) the series lives on, so the library can open the series' page there. */
  shelf?: string;
  /** For a series' card: the ids of every edition of each of its volumes (one in the library is enough). */
  volumeIds?: string[][];
  /** The file whose cover a volume's row or a series' card shows: an EPUB edition when there is one (its own
   *  cover picture, where a PDF's is its first page drawn). */
  coverFile?: SourceFile;
  /** A series' genres and tags (from AniList, for a folder that has none), shown on its page. */
  genres?: string[];
  tagList?: { name: string; rank: number; category?: string; spoiler?: boolean }[];
}

/** What a file holds, looked into from afar: its cover (a small picture's address), title, contents. */
export interface SourcePeek { title?: string; author?: string; cover?: string; toc?: { label: string; depth: number }[]; count?: number; description?: string; publisher?: string }

/** A filter as a Mihon filter sheet shows it: a choice, a set of choices, a sort order, or text. */
export type SourceFilter =
  | { id: string; label: string; kind: 'select'; options: { value: string; label: string }[]; value: string }
  /** `tri`: each option asked for or (its value marked "!") left out; `alpha`: many options, in sections by their
   *  first letter. */
  | { id: string; label: string; kind: 'multi'; options: { value: string; label: string }[]; value: string[]; tri?: boolean; alpha?: boolean }
  /** `reversible`: the chosen order can be turned round (its value then ends in ":rev"). */
  | { id: string; label: string; kind: 'sort'; options: { value: string; label: string }[]; value: string; reversible?: boolean }
  | { id: string; label: string; kind: 'text'; value: string; placeholder?: string }
  | { id: string; label: string; kind: 'toggle'; value: boolean };

export type FilterValues = Record<string, string | string[] | boolean>;

export interface SourceTag { id: string; label: string; count?: number }

export interface SourceFile {
  id: string; label: string; ext: string; size?: number; url: string; mime?: string;
  /** The file's own name, kept when it is fetched (else the book's title names it). */
  name?: string;
  /** A set of files that make one work in parts (volumes, sides): fetched merged (PDF, text) or as separate books. */
  parts?: SourceFile[];
}

export interface SourceChapter { id: string; title: string; level: number; page?: number }

export interface SourceDetails extends SourceBook {
  tags: SourceTag[];
  files: SourceFile[];                  // what can be fetched into the library
  chapters?: SourceChapter[];           // for a book read online, its contents
  pages?: number;
  volumes?: { name: string; from: number; to: number }[];
  meta?: { label: string; value: string }[];
  url?: string;                         // the book's page on the site
  raw?: unknown;                        // the source's own record of the book, for what adds it to the library
  toc?: { label: string; depth: number }[];   // a file's own contents, read from it
}

export interface SourcePage { items: SourceBook[]; hasMore: boolean; tags?: SourceTag[]; title?: string; /** What an empty page says instead of "No results", and the page on the site to open instead. */ empty?: { text: string; url?: string } }

export interface Source {
  id: string;
  name: string;
  lang: string;                         // the catalogue's main language
  description: string;
  site: string;
  /** The filters offered (with their defaults). */
  filters(): SourceFilter[];
  /** Shelves to browse before searching: a few entry points (collections, categories, authors). `current`
   *  is the shelf on screen (a source of folders offers its shelves only at its top). */
  shelves?(current?: string): Promise<SourceTag[]>;
  /** A line about the source's own state shown above its shelf (an index of its files, and how to renew it). */
  status?(): Promise<{ text: string; auto?: boolean; action?: { label: string; run: (progress: (text: string) => void, live: () => boolean, auto?: boolean) => Promise<boolean | void> } } | null>;
  /** A page of books: a search, or a shelf when `shelf` is given, with the filters applied. */
  browse(q: string, filters: FilterValues, page: number, shelf?: string): Promise<SourcePage>;
  details(id: string): Promise<SourceDetails>;
  /** Fetch a file into a File (the library imports it). */
  fetchFile?(book: SourceDetails, file: SourceFile, onProgress: (p: { pct: number; got: number; total: number }) => void): Promise<File>;
  /** A file that can be fetched by the platform's downloader (a plain address): its address and headers. */
  downloadInfo?(file: SourceFile): { url: string; headers?: Record<string, string> } | null;
  /** True when the source cannot be reached from a plain web page (no CORS): the apps can. */
  needsApp?: boolean;
  /** A volume's cover, title and contents, read from the file without fetching it whole. */
  peek?(b: SourceBook): Promise<SourcePeek | null>;
  /** A folder's cover (its own picture, or its first volume's) and how many volumes it holds. */
  folderCover?(shelf: string): Promise<SourcePeek | null>;
  /** The same two when already known in this session, at once. */
  peekNow?(b: SourceBook): SourcePeek | undefined;
  folderCoverNow?(shelf: string): SourcePeek | undefined;
  /** A series' genres and tags when its page does not have them yet (asked of AniList first in line). */
  tagsFor?(b: SourceBook): Promise<Pick<SourceBook, 'genres' | 'tagList'> | null>;
  /** How many series are still waiting for their tags (a shelf filtered by tag may still grow). */
  tagsWaiting?(): number;
  /** A series' synopsis from elsewhere (AniList, for a web folder of light novels), when its site gives none. */
  synopsisFor?(b: SourceBook): Promise<string | null>;
  /** How many new volumes a series has now (a page come back to shows what was seen meanwhile). */
  freshNow?(shelf: string): number | undefined;
}

/** What went wrong reaching a source: 'cloudflare' a check the reader can pass, 'blocked' a site that refuses
 *  even a browser — `detail` the title of the page the site answered with, when known. */
export class SourceError extends Error {
  constructor(msg: string, readonly kind: 'offline' | 'cloudflare' | 'blocked' | 'rate' | 'http' | 'parse' | 'auth' | 'cors' = 'http', readonly status?: number, /** what the site's page said (its title) */ readonly detail?: string) { super(msg); }
}
