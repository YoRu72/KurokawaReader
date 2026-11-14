// Picture sites: the boorus with open JSON APIs (Danbooru, Safebooru, Gelbooru, Konachan, yande.re — a tag search or
// a post) read by the app itself on every platform; on a computer, every other site gallery-dl knows (DeviantArt,
// Pixiv, ArtStation, Flickr, Tumblr, Imgur, Kemono…) through its listing, the pictures then downloaded by the app's
// engine with their names. Signed-in sites take a cookies.txt the reader points at.
import { request } from '../http';
import type { SocialItem } from './social';
export interface Gallery { title: string; items: SocialItem[] }
type Desk = { galleryList?(o: { url: string; range?: string; cookies?: string }): Promise<{ title: string; items: { url: string; name: string; headers?: Record<string, string> }[] }>; galleryReady?(): Promise<{ ready: boolean; version: string | null }> };
const desk = (): Desk | null => { const d = window.kurokawaTools as unknown as Desk | undefined; return d?.galleryList ? d : null; };

const BOORUS: { host: RegExp; kind: 'danbooru' | 'gelbooru' | 'moebooru'; api: string }[] = [
  { host: /(^|\.)danbooru\.donmai\.us$/, kind: 'danbooru', api: 'https://danbooru.donmai.us' },
  { host: /(^|\.)safebooru\.donmai\.us$/, kind: 'danbooru', api: 'https://safebooru.donmai.us' },
  { host: /(^|\.)gelbooru\.com$/, kind: 'gelbooru', api: 'https://gelbooru.com' },
  { host: /(^|\.)safebooru\.org$/, kind: 'gelbooru', api: 'https://safebooru.org' },
  { host: /(^|\.)konachan\.(com|net)$/, kind: 'moebooru', api: 'https://konachan.net' },
  { host: /(^|\.)yande\.re$/, kind: 'moebooru', api: 'https://yande.re' },
];
/** Is this a gallery link the app can read: a booru (anywhere) or, on a computer, anything gallery-dl knows. */
export function galleryOf(u: string): { kind: 'booru' | 'gallery-dl'; name: string } | null {
  let url: URL; try { url = new URL(u.trim()); } catch { return null; } const host = url.hostname.replace(/^www\./, '');
  const b = BOORUS.find((x) => x.host.test(host)); if (b) return { kind: 'booru', name: host };
  if (desk() && /(^|\.)(deviantart\.com|pixiv\.net|artstation\.com|flickr\.com|tumblr\.com|imgur\.com|kemono\.(su|party|cr)|coomer\.(su|party)|e-hentai\.org|exhentai\.org|nhentai\.net|fanbox\.cc|fantia\.jp|newgrounds\.com|furaffinity\.net|inkbunny\.net|rule34\.xxx|realbooru\.com|hitomi\.la|mangadex\.org|twitter\.com|x\.com|instagram\.com|threads\.net|weibo\.com|bilibili\.com|unsplash\.com|wallhaven\.cc|4chan\.org|4channel\.org|8kun\.top|catbox\.moe|bunkr\.[a-z]+|cyberdrop\.[a-z]+|gofile\.io|pinterest\.com|vk\.com|patreon\.com|redgifs\.com)$/i.test(host)) return { kind: 'gallery-dl', name: host };
  return null;
}
const json = async <T>(u: string): Promise<T> => { const r = await request(u, { headers: { Accept: 'application/json', 'User-Agent': 'KurokawaTools/1.0' } }); if (r.status !== 200) throw new Error(`HTTP ${r.status}`); return JSON.parse(r.body) as T; };
const nameOf = (id: unknown, url: string, tags?: string) => { const ext = (/\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url) ?? [])[1] ?? 'jpg'; const tg = (tags ?? '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ').slice(0, 60); return `${id}${tg ? ` ${tg}` : ''}.${ext}`.replace(/[\\/:*?"<>|]+/g, ' '); };
/** A booru page: a post's picture, or a tag search's pages of posts (up to `max`). */
async function booru(u: string, max: number): Promise<Gallery> {
  const url = new URL(u); const host = url.hostname.replace(/^www\./, ''); const b = BOORUS.find((x) => x.host.test(host))!; const items: SocialItem[] = [];
  const postId = /\/posts?\/(\d+)/.exec(url.pathname)?.[1] ?? (b.kind === 'gelbooru' ? (url.searchParams.get('s') === 'view' ? url.searchParams.get('id') : null) : null) ?? (b.kind === 'moebooru' ? /\/post\/show\/(\d+)/.exec(url.pathname)?.[1] : null);
  const tags = url.searchParams.get('tags') ?? '';
  if (b.kind === 'danbooru') {
    type P = { id: number; file_url?: string; large_file_url?: string; tag_string?: string; file_ext?: string; preview_file_url?: string };
    const posts = postId ? [await json<P>(`${b.api}/posts/${postId}.json`)] : (await Promise.all(Array.from({ length: Math.ceil(max / 200) }, (_, i) => json<P[]>(`${b.api}/posts.json?tags=${encodeURIComponent(tags)}&limit=200&page=${i + 1}`)))).flat();
    for (const p of posts) { const f = p.file_url ?? p.large_file_url; if (f) items.push({ href: f, kind: /\.(mp4|webm|zip)$/i.test(f) ? 'video' : 'image', text: p.tag_string?.slice(0, 80) ?? String(p.id), name: nameOf(p.id, f, p.tag_string), thumb: p.preview_file_url }); }
    return { title: postId ? `${host} #${postId}` : `${host}: ${tags}`, items: items.slice(0, max) };
  }
  if (b.kind === 'gelbooru') {
    type R = { post?: { id: number; file_url: string; tags?: string; preview_url?: string }[] } | { id: number; file_url: string; tags?: string; preview_url?: string }[];
    const pages = postId ? 1 : Math.ceil(max / 100);
    for (let i = 0; i < pages; i++) { const r = await json<R>(`${b.api}/index.php?page=dapi&s=post&q=index&json=1&limit=100&pid=${i}${postId ? `&id=${postId}` : `&tags=${encodeURIComponent(tags)}`}`); const posts = Array.isArray(r) ? r : (r.post ?? []); if (!posts.length) break; for (const p of posts) items.push({ href: p.file_url, kind: /\.(mp4|webm)$/i.test(p.file_url) ? 'video' : 'image', text: p.tags?.slice(0, 80) ?? String(p.id), name: nameOf(p.id, p.file_url, p.tags), thumb: p.preview_url }); }
    return { title: postId ? `${host} #${postId}` : `${host}: ${tags}`, items: items.slice(0, max) };
  }
  type M = { id: number; file_url: string; tags?: string; preview_url?: string };
  const pages = postId ? 1 : Math.ceil(max / 100);
  for (let i = 0; i < pages; i++) { const posts = await json<M[]>(`${b.api}/post.json?limit=100&page=${i + 1}${postId ? `&tags=id:${postId}` : `&tags=${encodeURIComponent(tags)}`}`); if (!posts.length) break; for (const p of posts) items.push({ href: p.file_url.startsWith('//') ? `https:${p.file_url}` : p.file_url, kind: 'image', text: p.tags?.slice(0, 80) ?? String(p.id), name: nameOf(p.id, p.file_url, p.tags), thumb: p.preview_url }); }
  return { title: postId ? `${host} #${postId}` : `${host}: ${tags}`, items: items.slice(0, max) };
}
/** What the gallery holds, by the booru APIs or gallery-dl; `cookies` a cookies.txt path for signed-in sites. */
export async function gallery(u: string, opts: { max?: number; cookies?: string; range?: string } = {}): Promise<Gallery> {
  const g = galleryOf(u); if (!g) return { title: '', items: [] };
  if (g.kind === 'booru') return booru(u, opts.max ?? 400);
  const { toolError } = await import('../video/ytdlp');
  const r = await toolError(desk()!.galleryList!({ url: u, range: opts.range, cookies: opts.cookies }));
  return { title: r.title || g.name, items: r.items.map((x) => ({ href: x.url, kind: /\.(mp4|webm|mkv|mov|gif)$/i.test(x.name) ? 'video' : 'image', text: x.name, name: x.name })) };
}
