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
  /** The files a series' card fetches. */
  files?: SourceFile[];
}

/** What a file holds, looked into from afar: its cover (a small picture's address), title, contents. */
export interface SourcePeek { title?: string; author?: string; cover?: string; toc?: { label: string; depth: number }[]; count?: number }

/** A filter as a Mihon filter sheet shows it: a choice, a set of choices, a sort order, or text. */
export type SourceFilter =
  | { id: string; label: string; kind: 'select'; options: { value: string; label: string }[]; value: string }
  | { id: string; label: string; kind: 'multi'; options: { value: string; label: string }[]; value: string[] }
  | { id: string; label: string; kind: 'sort'; options: { value: string; label: string }[]; value: string }
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

export interface SourcePage { items: SourceBook[]; hasMore: boolean; tags?: SourceTag[]; title?: string }

export interface Source {
  id: string;
  name: string;
  lang: string;                         // the catalogue's main language
  description: string;
  site: string;
  /** The filters offered (with their defaults). */
  filters(): SourceFilter[];
  /** Shelves to browse before searching: a few entry points (collections, categories, authors). */
  shelves?(): Promise<SourceTag[]>;
  /** A page of books: a search, or a shelf when `shelf` is given, with the filters applied. */
  browse(q: string, filters: FilterValues, page: number, shelf?: string): Promise<SourcePage>;
  details(id: string): Promise<SourceDetails>;
  /** Fetch a file into a File (the library imports it). */
  fetchFile?(book: SourceDetails, file: SourceFile, onProgress: (p: { pct: number; got: number; total: number }) => void): Promise<File>;
  /** True when the source cannot be reached from a plain web page (no CORS): the apps can. */
  needsApp?: boolean;
  /** A volume's cover, title and contents, read from the file without fetching it whole. */
  peek?(b: SourceBook): Promise<SourcePeek | null>;
  /** A folder's cover (its own picture, or its first volume's) and how many volumes it holds. */
  folderCover?(shelf: string): Promise<SourcePeek | null>;
  /** The same two when already known in this session, at once. */
  peekNow?(b: SourceBook): SourcePeek | undefined;
  folderCoverNow?(shelf: string): SourcePeek | undefined;
}

export class SourceError extends Error {
  constructor(msg: string, readonly kind: 'offline' | 'cloudflare' | 'rate' | 'http' | 'parse' | 'auth' | 'cors' = 'http', readonly status?: number) { super(msg); }
}
