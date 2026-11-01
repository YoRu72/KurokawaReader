// A post's media from its link, at full quality, without opening the site: X (Twitter) through FxTwitter's open
// API (VxTwitter's when it fails) — any of x.com, twitter.com, fxtwitter, fixupx, vxtwitter, nitter links —, Bluesky
// through its public API, Reddit through the post's JSON. Photos come in their original size, videos as the
// best MP4 there is. (A Bluesky video is a stream: it goes to the Video add-on, which can join it.)
import { request } from '../http';

export interface SocialItem { href: string; text: string; name?: string; thumb?: string; kind: 'image' | 'video' | 'gif'; viaVideo?: boolean }
export interface SocialPost { site: 'x' | 'bluesky' | 'reddit'; title: string; author?: string; items: SocialItem[] }

const X_HOSTS = /(^|\.)(x|twitter|fxtwitter|fixupx|vxtwitter|fixvx|twittpr|nitter\.[a-z.]+|xcancel|d\.fxtwitter)\.com$|^nitter\.[a-z.]+$|^(mobile\.)?twitter\.com$/i;
/** Which site a link is a post of (null: none of these). */
export function socialOf(u: string): { site: SocialPost['site']; id: string; user?: string } | null {
  let url: URL; try { url = new URL(u.trim()); } catch { return null; }
  const host = url.hostname.replace(/^www\./, '');
  const x = /\/status(?:es)?\/(\d{5,25})/.exec(url.pathname);
  if (x && (X_HOSTS.test(host) || /nitter/.test(host))) return { site: 'x', id: x[1], user: url.pathname.split('/')[1] };
  const b = /^\/profile\/([^/]+)\/post\/([a-z0-9]+)/i.exec(url.pathname);
  if (b && /(^|\.)bsky\.app$/.test(host)) return { site: 'bluesky', id: b[2], user: b[1] };
  const r = /\/comments\/([a-z0-9]+)/i.exec(url.pathname);
  if (/(^|\.)reddit\.com$/.test(host) && r) return { site: 'reddit', id: r[1] };
  if (host === 'redd.it' && /^\/[a-z0-9]+$/i.test(url.pathname)) return { site: 'reddit', id: url.pathname.slice(1) };
  return null;
}

const json = async <T>(u: string): Promise<T> => { const r = await request(u, { headers: { Accept: 'application/json' } }); if (r.status !== 200) throw new Error(`HTTP ${r.status}`); return JSON.parse(r.body) as T; };
const extOf = (u: string, d: string) => { const x = new URL(u); return (x.searchParams.get('format') ?? /\.([a-z0-9]{2,4})$/i.exec(x.pathname)?.[1] ?? d).toLowerCase(); };
const clip = (s: string, n = 80) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/* ---------- X ---------- */
type FxMedia = { type: 'photo' | 'video' | 'gif'; url: string; thumbnail_url?: string; width?: number; height?: number; formats?: { url: string; container?: string; bitrate?: number }[]; variants?: { url: string; content_type?: string; bitrate?: number }[] };
type FxTweet = { id: string; text: string; author: { screen_name: string; name?: string }; media?: { all?: FxMedia[] }; quote?: FxTweet };
const bestMp4 = (m: FxMedia): string => {
  const mp4s = [...(m.formats ?? []).filter((f) => f.container === 'mp4' || /\.mp4(\?|$)/.test(f.url)), ...(m.variants ?? []).filter((v) => v.content_type === 'video/mp4')] as { url: string; bitrate?: number }[];
  return mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url ?? m.url;
};
/** A photo at its original size: «…/media/ID.jpg?name=orig» (or ?format=jpg&name=orig). */
export const origPhoto = (u: string): string => { try { const x = new URL(u); if (x.hostname !== 'pbs.twimg.com') return u; const f = x.searchParams.get('format'); x.search = ''; return f ? `${x.href}?format=${f}&name=orig` : `${x.href}?name=orig`; } catch { return u; } };
function xItems(tw: FxTweet, out: SocialItem[], depth = 0): void {
  const who = tw.author?.screen_name ?? 'x';
  (tw.media?.all ?? []).forEach((m, i) => {
    const n = i + 1;
    if (m.type === 'photo') { const href = origPhoto(m.url); out.push({ href, kind: 'image', thumb: m.url, text: `${clip(tw.text, 60) || who} · ${n}`, name: `${who}-${tw.id}-${n}.${extOf(m.url, 'jpg')}` }); }
    else { const href = bestMp4(m); out.push({ href, kind: m.type === 'gif' ? 'gif' : 'video', thumb: m.thumbnail_url, text: `${clip(tw.text, 60) || who} · ${n}${m.height ? ` · ${m.height}p` : ''}`, name: `${who}-${tw.id}-${n}.mp4` }); }
  });
  if (tw.quote && depth < 1) xItems(tw.quote, out, depth + 1);
}
async function fromX(id: string): Promise<SocialPost> {
  try {
    const d = await json<{ code: number; message?: string; tweet?: FxTweet }>(`https://api.fxtwitter.com/status/${id}`);
    if (!d.tweet) throw new Error(d.message ?? 'not found');
    const items: SocialItem[] = []; xItems(d.tweet, items);
    return { site: 'x', title: clip(d.tweet.text, 140), author: `@${d.tweet.author.screen_name}`, items };
  } catch (e) {
    // (VxTwitter's API, the same post another way, when FxTwitter's is down or refuses.)
    try {
      const v = await json<{ text: string; user_screen_name: string; tweetID: string; media_extended?: { type: 'image' | 'video' | 'gif'; url: string; thumbnail_url?: string }[] }>(`https://api.vxtwitter.com/i/status/${id}`);
      const who = v.user_screen_name;
      return { site: 'x', title: clip(v.text, 140), author: `@${who}`, items: (v.media_extended ?? []).map((m, i) => ({ href: m.type === 'image' ? origPhoto(m.url) : m.url, kind: m.type, thumb: m.thumbnail_url ?? m.url, text: `${clip(v.text, 60) || who} · ${i + 1}`, name: `${who}-${id}-${i + 1}.${m.type === 'image' ? extOf(m.url, 'jpg') : 'mp4'}` })) };
    } catch { throw e; }
  }
}

/* ---------- Bluesky ---------- */
type BskyEmbed = { $type: string; images?: { fullsize: string; thumb: string; alt?: string }[]; playlist?: string; thumbnail?: string; media?: BskyEmbed };
async function fromBluesky(user: string, id: string, link: string): Promise<SocialPost> {
  const d = await json<{ thread?: { post?: { author: { handle: string }; record?: { text?: string }; embed?: BskyEmbed } } }>(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${user}/app.bsky.feed.post/${id}`)}&depth=0&parentHeight=0`);
  const p = d.thread?.post; if (!p) throw new Error('not found');
  const text = p.record?.text ?? ''; const who = p.author.handle; const items: SocialItem[] = [];
  const add = (e?: BskyEmbed) => {
    if (!e) return;
    if (e.images) e.images.forEach((im, i) => items.push({ href: im.fullsize, kind: 'image', thumb: im.thumb, text: clip(im.alt || text, 60) || `${who} · ${i + 1}`, name: `${who}-${id}-${i + 1}.${/@(\w+)$/.exec(im.fullsize)?.[1] ?? 'jpg'}` }));
    if (e.playlist) items.push({ href: link, kind: 'video', thumb: e.thumbnail, text: clip(text, 60) || who, name: `${who}-${id}.mp4`, viaVideo: true });
    if (e.media) add(e.media);
  };
  add(p.embed);
  return { site: 'bluesky', title: clip(text, 140), author: `@${who}`, items };
}

/* ---------- Reddit ---------- */
type RedditPost = { title: string; author: string; url_overridden_by_dest?: string; post_hint?: string; is_video?: boolean; media?: { reddit_video?: { fallback_url: string; hls_url?: string } }; gallery_data?: { items: { media_id: string }[] }; media_metadata?: Record<string, { m?: string; s?: { u?: string; gif?: string; mp4?: string } }>; preview?: { images?: { source: { url: string } }[] }; crosspost_parent_list?: RedditPost[]; permalink: string };
const unesc = (s: string) => s.replace(/&amp;/g, '&');
async function fromReddit(id: string): Promise<SocialPost> {
  const d = await json<{ data: { children: { data: RedditPost }[] } }[]>(`https://www.reddit.com/comments/${id}.json?raw_json=1&limit=1`);
  let p = d[0]?.data.children[0]?.data; if (!p) throw new Error('not found');
  if (p.crosspost_parent_list?.length) p = { ...p, ...p.crosspost_parent_list[0], title: p.title };
  const items: SocialItem[] = []; const t = clip(p.title, 60);
  if (p.gallery_data && p.media_metadata) p.gallery_data.items.forEach((g, i) => { const m = p!.media_metadata![g.media_id]; const u = m?.s?.mp4 ?? m?.s?.gif ?? m?.s?.u; if (u) items.push({ href: unesc(u), kind: m?.s?.mp4 || m?.s?.gif ? 'gif' : 'image', text: `${t} · ${i + 1}`, name: `${id}-${i + 1}.${extOf(unesc(u), 'jpg')}` }); });
  else if (p.is_video && p.media?.reddit_video) items.push({ href: `https://www.reddit.com${p.permalink}`, kind: 'video', text: t, name: `${id}.mp4`, viaVideo: true });
  else if (p.url_overridden_by_dest && /\.(jpe?g|png|gif|webp|mp4)(\?|$)/i.test(p.url_overridden_by_dest)) items.push({ href: p.url_overridden_by_dest, kind: /\.(gif|mp4)/i.test(p.url_overridden_by_dest) ? 'gif' : 'image', text: t });
  else if (p.preview?.images?.[0]) items.push({ href: unesc(p.preview.images[0].source.url), kind: 'image', text: t, name: `${id}.jpg` });
  return { site: 'reddit', title: clip(p.title, 140), author: `u/${p.author}`, items };
}

/** A post's media (throws with the site's answer when it cannot be read). */
export async function socialPost(link: string): Promise<SocialPost | null> {
  const s = socialOf(link); if (!s) return null;
  if (s.site === 'x') return fromX(s.id);
  if (s.site === 'bluesky') return fromBluesky(s.user!, s.id, link);
  return fromReddit(s.id);
}
