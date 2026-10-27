// The Internet Archive (archive.org) as a source: its search API for the shelves and queries, its metadata
// API for a book's page and files. Free to read, no key; the files come straight from the archive.
import { fetchJson, fetchBytes } from './http';
import { SourceError, type Source, type SourceFilter, type FilterValues, type SourcePage, type SourceBook, type SourceDetails, type SourceTag, type SourceFile } from './types';

const API = (typeof localStorage !== 'undefined' && localStorage.getItem('kr.archive.base')) || 'https://archive.org';
const FIELDS = ['identifier', 'title', 'creator', 'year', 'language', 'subject', 'downloads', 'mediatype', 'collection', 'description', 'publicdate'];

const LANGUAGES: [string, string][] = [
  ['', 'Any'], ['Arabic', 'العربية'], ['English', 'English'], ['French', 'Français'], ['Spanish', 'Español'], ['German', 'Deutsch'], ['Italian', 'Italiano'],
  ['Portuguese', 'Português'], ['Russian', 'Русский'], ['Turkish', 'Türkçe'], ['Persian', 'فارسی'], ['Urdu', 'اردو'], ['Indonesian', 'Bahasa Indonesia'], ['Malay', 'Bahasa Melayu'],
  ['Hindi', 'हिन्दी'], ['Bengali', 'বাংলা'], ['Chinese', '中文'], ['Japanese', '日本語'], ['Korean', '한국어'], ['Latin', 'Latina'], ['Greek', 'Ελληνικά'], ['Hebrew', 'עברית'], ['Dutch', 'Nederlands'], ['Swedish', 'Svenska'], ['Polish', 'Polski'],
];
/** Collections anyone may fetch from (the lending library's books cannot be downloaded). */
const SHELVES: SourceTag[] = [
  { id: 'texts', label: 'All texts' },
  { id: 'opensource', label: 'Community texts' },
  { id: 'gutenberg', label: 'Project Gutenberg' },
  { id: 'americana', label: 'American libraries' },
  { id: 'europeanlibraries', label: 'European libraries' },
  { id: 'universallibrary', label: 'Universal Library (Million Books)' },
  { id: 'cdl', label: 'California Digital Library' },
  { id: 'toronto', label: 'Canadian libraries' },
  { id: 'biodiversity', label: 'Biodiversity Heritage Library' },
  { id: 'comics', label: 'Comics' },
  { id: 'audio_bookspoetry', label: 'Audiobooks & poetry (audio)' },
  { id: 'librivoxaudio', label: 'LibriVox (audio)' },
];
// Formats as archive.org names them, with what they are to the reader.
const FORMATS: [RegExp, string, string, string][] = [
  [/^Text PDF$/, 'PDF', 'pdf', 'application/pdf'], [/^EPUB$/, 'EPUB', 'epub', 'application/epub+zip'], [/^DjVu$/, 'DjVu', 'djvu', 'image/vnd.djvu'],
  [/^Kindle$/, 'Kindle (MOBI)', 'mobi', 'application/x-mobipocket-ebook'], [/^DjVuTXT$/, 'Text', 'txt', 'text/plain'], [/^Comic Book ZIP$/, 'CBZ', 'cbz', 'application/vnd.comicbook+zip'],
  [/^Comic Book RAR$/, 'CBR', 'cbr', 'application/vnd.comicbook-rar'], [/^(Additional Text )?PDF$/, 'PDF', 'pdf', 'application/pdf'], [/^Word Document$/, 'Word', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  [/^Rich Text Format$/, 'RTF', 'rtf', 'application/rtf'], [/^HTML$/, 'HTML', 'html', 'text/html'], [/^FictionBook$/, 'FB2', 'fb2', 'application/x-fictionbook+xml'],
  [/^VBR MP3$/, 'MP3 (audio)', 'mp3', 'audio/mpeg'], [/^64Kbps MP3$/, 'MP3 64k (audio)', 'mp3', 'audio/mpeg'], [/^Ogg Vorbis$/, 'OGG (audio)', 'ogg', 'audio/ogg'], [/^M4B$/, 'M4B (audiobook)', 'm4b', 'audio/mp4'],
];
const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : String(v).split(';').map((s) => s.trim()).filter(Boolean));
const plain = (html: string): string => { const d = new DOMParser().parseFromString(html, 'text/html'); return (d.body.textContent ?? '').replace(/\s+/g, ' ').trim(); };

interface SearchDoc { identifier: string; title?: unknown; creator?: unknown; year?: unknown; language?: unknown; subject?: unknown; downloads?: number; mediatype?: string; collection?: unknown; description?: unknown; publicdate?: string }
interface SearchResponse { response?: { numFound: number; start: number; docs: SearchDoc[] } }
interface MetaResponse { metadata?: Record<string, unknown>; files?: { name: string; format?: string; size?: string; source?: string }[]; server?: string; dir?: string }

const quote = (s: string) => `"${s.replace(/["\\]/g, ' ').trim()}"`;

export const archiveSource: Source = {
  id: 'archive',
  name: 'Internet Archive',
  lang: 'en',
  site: 'https://archive.org',
  description: 'Millions of free books, texts and audiobooks: public domain works, community uploads and library scans. Fetch a book as PDF, EPUB, DjVu, Kindle or text.',
  filters: (): SourceFilter[] => [
    { id: 'sort', label: 'Sort', kind: 'sort', value: 'downloads desc', options: [['downloads desc', 'Most downloaded'], ['', 'Relevance'], ['publicdate desc', 'Newest added'], ['year desc', 'Newest'], ['year asc', 'Oldest'], ['titleSorter asc', 'Title A–Z'], ['week desc', 'Popular this week']].map(([value, label]) => ({ value, label })) },
    { id: 'media', label: 'Kind', kind: 'select', value: 'texts', options: [['texts', 'Books & texts'], ['audio', 'Audiobooks & audio'], ['', 'Anything']].map(([value, label]) => ({ value, label })) },
    { id: 'language', label: 'Language', kind: 'select', value: '', options: LANGUAGES.map(([value, label]) => ({ value, label })) },
    { id: 'in', label: 'Search in', kind: 'select', value: 'any', options: [['any', 'Anywhere'], ['title', 'Title'], ['creator', 'Author'], ['subject', 'Subject'], ['text', 'Full text']].map(([value, label]) => ({ value, label })) },
    { id: 'from', label: 'Year from', kind: 'text', value: '', placeholder: '1800' },
    { id: 'to', label: 'Year to', kind: 'text', value: '', placeholder: '1950' },
    { id: 'free', label: 'Downloadable only (no lending-library books)', kind: 'toggle', value: true },
  ],
  shelves: async () => SHELVES,
  async browse(q, f, page, shelf): Promise<SourcePage> {
    const parts: string[] = [];
    const text = q.trim();
    if (text) {
      const field = String(f.in ?? 'any');
      if (field === 'any') parts.push(`(${text.split(/\s+/).map((w) => `(title:(${w}) OR creator:(${w}) OR subject:(${w}) OR description:(${w}))`).join(' AND ')})`);
      else if (field === 'text') parts.push(`(${text})`);
      else parts.push(`${field}:(${text})`);
    }
    const media = String(f.media ?? 'texts');
    if (shelf && shelf !== 'texts') parts.push(`collection:(${shelf})`);
    if (media) parts.push(`mediatype:(${media})`);
    if (f.language) parts.push(`language:(${quote(String(f.language))})`);
    const from = String(f.from ?? '').trim(), to = String(f.to ?? '').trim();
    if (/^\d{3,4}$/.test(from) || /^\d{3,4}$/.test(to)) parts.push(`year:[${from || '*'} TO ${to || '*'}]`);
    if (f.free !== false) parts.push('NOT collection:(inlibrary) AND NOT access-restricted-item:(true)');
    for (const tag of Array.isArray(f.tags) ? f.tags : []) parts.push(`subject:(${quote(tag)})`);
    if (!parts.length) parts.push('mediatype:(texts)');
    const sort = String(f.sort ?? 'downloads desc');
    const url = `${API}/advancedsearch.php?q=${encodeURIComponent(parts.join(' AND '))}${FIELDS.map((x) => `&fl[]=${x}`).join('')}${sort ? `&sort[]=${encodeURIComponent(sort)}` : ''}&rows=40&page=${page}&output=json`;
    const j = await fetchJson<SearchResponse>(url);
    const docs = j.response?.docs ?? [];
    const items: SourceBook[] = docs.map((d) => ({
      id: d.identifier, title: first(d.title) || d.identifier, author: list(d.creator).slice(0, 2).join(', ') || undefined,
      cover: `${API}/services/img/${encodeURIComponent(d.identifier)}`, lang: first(d.language) || undefined, year: first(d.year) || undefined,
      badge: d.downloads ? shortCount(d.downloads) : undefined, description: typeof d.description === 'string' ? plain(d.description).slice(0, 300) : undefined,
    }));
    // The subjects the page's books share, as tags to narrow by.
    const counts = new Map<string, number>();
    for (const d of docs) for (const s of list(d.subject)) { const k = s.trim(); if (k && k.length < 40) counts.set(k, (counts.get(k) ?? 0) + 1); }
    const tags = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([label, count]) => ({ id: label, label, count }));
    const total = j.response?.numFound ?? 0;
    return { items, hasMore: page * 40 < total, tags, title: shelf ? SHELVES.find((s) => s.id === shelf)?.label : undefined };
  },
  async details(id): Promise<SourceDetails> {
    const j = await fetchJson<MetaResponse>(`${API}/metadata/${encodeURIComponent(id)}`);
    const m = j.metadata ?? {};
    if (!j.files) throw new SourceError('parse', 'parse');
    const files: SourceFile[] = [];
    for (const f of j.files) {
      const fmt = FORMATS.find(([re]) => re.test(f.format ?? ''));
      if (!fmt || /_text\.pdf$|_bw\.pdf$/i.test(f.name) && files.some((x) => x.ext === 'pdf')) continue;
      files.push({ id: f.name, label: fmt[1], ext: fmt[2], mime: fmt[3], size: f.size ? Number(f.size) : undefined, url: `${API}/download/${encodeURIComponent(id)}/${encodeURIComponent(f.name).replace(/%2F/g, '/')}` });
    }
    const order = ['epub', 'pdf', 'djvu', 'mobi', 'cbz', 'cbr', 'fb2', 'docx', 'rtf', 'txt', 'html', 'm4b', 'mp3', 'ogg'];
    files.sort((a, b) => order.indexOf(a.ext) - order.indexOf(b.ext) || (a.size ?? 0) - (b.size ?? 0));
    // (One of each kind: the first PDF, not every derivative.)
    const seen = new Set<string>(); const kept = files.filter((f) => { if (f.ext === 'mp3' || f.ext === 'ogg') return true; if (seen.has(f.ext)) return false; seen.add(f.ext); return true; });
    const subjects = list(m.subject).map((s) => s.trim()).filter(Boolean);
    const meta: { label: string; value: string }[] = [];
    for (const [k, label] of [['publisher', 'Publisher'], ['date', 'Date'], ['language', 'Language'], ['contributor', 'Contributor'], ['isbn', 'ISBN'], ['source', 'Source'], ['collection', 'Collections']] as const) { const v = list(m[k]).join(', '); if (v) meta.push({ label, value: v }); }
    const restricted = String(first(m['access-restricted-item'])) === 'true' || list(m.collection).includes('inlibrary');
    return {
      id, title: first(m.title) || id, author: list(m.creator).join(', ') || undefined, cover: `${API}/services/img/${encodeURIComponent(id)}`,
      lang: first(m.language) || undefined, year: first(m.year) || first(m.date)?.slice(0, 4) || undefined,
      description: typeof m.description === 'string' ? plain(m.description) : list(m.description).map(plain).join('\n'),
      tags: subjects.map((s) => ({ id: s, label: s })), files: restricted ? [] : kept, meta, url: `${API}/details/${encodeURIComponent(id)}`,
      badge: restricted ? 'borrow only' : undefined,
    };
  },
  async fetchFile(book, file, onProgress): Promise<File> {
    const bytes = await fetchBytes(file.url, onProgress);
    const name = `${book.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || book.id}.${file.ext}`;
    return new File([bytes.buffer as ArrayBuffer], name, { type: file.mime ?? '' });
  },
};

function shortCount(n: number): string { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n); }
