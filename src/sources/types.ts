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
}

/** A filter as a Mihon filter sheet shows it: a choice, a set of choices, a sort order, or text. */
export type SourceFilter =
  | { id: string; label: string; kind: 'select'; options: { value: string; label: string }[]; value: string }
  | { id: string; label: string; kind: 'multi'; options: { value: string; label: string }[]; value: string[] }
  | { id: string; label: string; kind: 'sort'; options: { value: string; label: string }[]; value: string }
  | { id: string; label: string; kind: 'text'; value: string; placeholder?: string }
  | { id: string; label: string; kind: 'toggle'; value: boolean };

export type FilterValues = Record<string, string | string[] | boolean>;

export interface SourceTag { id: string; label: string; count?: number }

export interface SourceFile { id: string; label: string; ext: string; size?: number; url: string; mime?: string }

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
}

export class SourceError extends Error {
  constructor(msg: string, readonly kind: 'offline' | 'cloudflare' | 'rate' | 'http' | 'parse' | 'auth' | 'cors' = 'http', readonly status?: number) { super(msg); }
}
