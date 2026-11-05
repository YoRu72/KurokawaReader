// Videos (the Player add-on's library — REX Player's): the phone's videos by folder (Android's media index, with
// its thumbnails), each with how far it was watched; the ones played lately, to carry on; and media servers —
// Jellyfin (signed in, its libraries browsed, played straight from it) and WebDAV (a NAS, a cloud folder) — whose
// videos play in the app's player like any other. A video file can also be opened from anywhere.
import { h, icon, iconButton, toast, openSheet, pickButton, onLongPress } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { navigate } from '../router';
import { ktPlugin, nativePlatform } from '../native';
import { getSettings, updateSettings } from '../settings';
import { request } from '../http';
import type { Route } from '../router';

type Vid = { id: number; path: string; name: string; folder: string; duration: number; size: number; width: number; height: number; mtime: number };
type Plug = { mediaAccess?(o: { ask?: boolean }): Promise<{ granted: boolean; partial?: boolean }>; mediaVideos?(): Promise<{ videos: Vid[] }>; videoThumb?(o: { id: number }): Promise<{ url: string }>; localUrl?(o: { path: string }): Promise<{ url: string }>; proxyUrl?(o: { url: string; headers?: Record<string, string> }): Promise<{ url: string }> };
const plug = () => ktPlugin() as unknown as Plug | null;
type Server = NonNullable<ReturnType<typeof getSettings>['mediaServers']>[number];
type Mem = { pos: number; duration: number; watched?: boolean; at: number };
const memory = (): Record<string, Mem> => { try { return JSON.parse(localStorage.getItem('kt.player.memory') ?? '{}') as Record<string, Mem>; } catch { return {}; } };
const dur = (ms: number) => { const s = Math.round(ms / 1000); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return localDigits(hh ? `${hh}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`); };
const resName = (w: number, hgt: number) => { const p = Math.min(w, hgt); return p >= 2000 ? '4K' : p >= 1400 ? '1440p' : p >= 1000 ? '1080p' : p >= 700 ? '720p' : p >= 450 ? '480p' : p ? `${p}p` : ''; };
const VIDEO_RE = /\.(mp4|mkv|webm|avi|mov|m4v|ts|m2ts|wmv|flv|3gp|mpg|mpeg|ogv)$/i;

let cache: Vid[] | null = null;
const thumbs = new Map<number, string>();

export function videosView(route: Extract<Route, { name: 'videos' }>): HTMLElement & { dispose?: () => void } {
  const tab = route.tab ?? (localStorage.getItem('kt.videos.tab') || 'phone');
  const body = h('div', { class: 'body videos-body' });
  const fileIn = h('input', { type: 'file', accept: 'video/*,.mkv,.ts,.m2ts', hidden: true, onchange: () => { const f = fileIn.files?.[0]; if (f) void play(URL.createObjectURL(f), f.name); } }) as HTMLInputElement;
  const root = h('div', { class: 'view videos-view' }, h('header', { class: 'topbar' }, h('div', { class: 'title' }, h('span', null, t('navVideos'))), h('div', { class: 'topbar-actions' }, iconButton('upload', t('videosOpenFile'), () => fileIn.click()))), fileIn, body) as HTMLElement & { dispose?: () => void };
  const TABS: [string, string, string][] = [['phone', nativePlatform() === 'android' ? t('videosPhone') : t('videosFiles'), 'folder'], ['recent', t('videosRecent'), 'history'], ['servers', t('videosServers'), 'cloud'], ...(getSettings().addons.includes('video') ? [['followed', t('videosFollowed'), 'bell'] as [string, string, string]] : [])];
  const chips = h('div', { class: 'chips filter-chips' }, ...TABS.map(([k, label, ic]) => h('button', { type: 'button', class: 'chip' + (tab === k ? ' on' : ''), onclick: () => { try { localStorage.setItem('kt.videos.tab', k); } catch { /* */ } navigate(`/videos?tab=${k}`, true); } }, icon(ic), label)));
  body.append(chips);
  const content = h('div', { class: 'videos-content' }); body.append(content);
  if (tab === 'recent') recent(content); else if (tab === 'followed') void followed(content); else if (tab === 'servers') { if (route.srv) void browse(content, route.srv, route.p); else servers(content); } else void phone(content, route.folder);
  return root;
}

/* ---------- playing ---------- */
async function play(url: string, name: string, o: { localPath?: string; playlist?: { url: string; name: string; localPath?: string }[] } = {}): Promise<void> {
  const { openPlayer } = await import('./player'); await openPlayer(url, name, o);
}
async function urlOf(path: string): Promise<string | null> { const { localFileUrl } = await import('../player/files'); return localFileUrl(path); }
async function playLocal(list: Vid[], i: number): Promise<void> {
  const v = list[i]; const url = await urlOf(v.path); if (!url) { toast(t('playerCantPlay'), 'error'); return; }
  // (The folder as the playlist: the videos around this one, so next and previous go through it.)
  const near = list.slice(Math.max(0, i - 50), i + 50);
  const playlist = (await Promise.all(near.map(async (x) => ({ url: (await urlOf(x.path)) ?? '', name: x.name, localPath: x.path })))).filter((x) => x.url);
  await play(url, v.name, { localPath: v.path, playlist });
}

/* ---------- the phone's videos ---------- */
async function phone(out: HTMLElement, folder?: string): Promise<void> {
  const p = plug();
  if (!p?.mediaVideos) { out.append(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('playCircle')), h('p', null, t('videosNoIndex')), h('button', { type: 'button', class: 'btn primary', onclick: () => (document.querySelector('.videos-view input[type=file]') as HTMLInputElement)?.click() }, icon('upload'), t('videosOpenFile')))); return; }
  const acc: { granted: boolean; partial?: boolean } = await p.mediaAccess?.({}).catch(() => ({ granted: false })) ?? { granted: false };
  if (!acc.granted && !acc.partial) {
    const ask = h('button', { type: 'button', class: 'btn primary', onclick: async () => { await p.mediaAccess?.({ ask: true }); for (let k = 0; k < 60; k++) { await new Promise((r) => setTimeout(r, 1000)); const a = await p.mediaAccess?.({}).catch(() => null); if (a?.granted || a?.partial) { cache = null; out.replaceChildren(); void phone(out, folder); return; } } } }, icon('key'), t('videosAllow'));
    out.append(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('playCircle')), h('p', null, t('videosAllowWhy')), ask)); return;
  }
  out.append(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  try { cache ??= (await p.mediaVideos()).videos; } catch (e) { out.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); return; }
  const all = cache;
  const partialNote = acc.partial ? h('p', { class: 'hint' }, t('videosPartial'), ' ', h('button', { type: 'button', class: 'btn text small', onclick: () => void p.mediaAccess?.({ ask: true }) }, t('videosAllowMore'))) : null;
  const search = h('input', { type: 'search', class: 'settings-search', placeholder: t('videosSearch') }) as HTMLInputElement;
  const sortKey = (localStorage.getItem('kt.videos.sort') ?? 'date') as 'date' | 'name' | 'size' | 'length';
  let sort = sortKey;
  const sortBtn = pickButton(t('sortBy'), [['date', t('sortNewest')], ['name', t('sortName')], ['size', t('sortSize')], ['length', t('videosSortLength')]], sort, (v) => { sort = v; try { localStorage.setItem('kt.videos.sort', v); } catch { /* */ } draw(); }, t('close'));
  const list = h('div', { class: 'videos-list' });
  const sorted = (vs: Vid[]) => [...vs].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : sort === 'size' ? b.size - a.size : sort === 'length' ? b.duration - a.duration : b.mtime - a.mtime));
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    if (q) { const hits = sorted(all.filter((v) => v.name.toLowerCase().includes(q))); list.replaceChildren(...(hits.length ? hits.slice(0, 300).map((v) => videoRow(v, hits)) : [h('p', { class: 'empty small' }, t('noResults'))])); return; }
    if (folder !== undefined) { const vs = sorted(all.filter((v) => v.folder === folder)); list.replaceChildren(...vs.map((v) => videoRow(v, vs))); return; }
    // Folders, the newest first; each with its count, its size, and its newest video's picture.
    const by = new Map<string, Vid[]>(); for (const v of all) { const k = v.folder || '—'; (by.get(k) ?? by.set(k, []).get(k)!).push(v); }
    const folders = [...by.entries()].sort((a, b) => (sort === 'name' ? a[0].localeCompare(b[0]) : sort === 'size' ? b[1].reduce((s, v) => s + v.size, 0) - a[1].reduce((s, v) => s + v.size, 0) : Math.max(...b[1].map((v) => v.mtime)) - Math.max(...a[1].map((v) => v.mtime))));
    list.replaceChildren(...(folders.length ? folders.map(([name, vs]) => h('button', { type: 'button', class: 'video-folder', onclick: () => navigate(`/videos?tab=phone&folder=${encodeURIComponent(name)}`) }, thumb(vs[0]), h('span', { class: 'grow' }, h('b', { dir: 'auto' }, name), h('small', { class: 'src' }, `${t('videosCount', { n: localDigits(vs.length) })} · ${formatBytes(vs.reduce((s, v) => s + v.size, 0))}`)), icon('chevronRight'))) : [h('p', { class: 'empty small' }, t('videosNone'))]));
  };
  search.addEventListener('input', draw);
  out.replaceChildren(...(partialNote ? [partialNote] : []),
    ...(folder !== undefined ? [h('div', { class: 'row videos-crumb' }, iconButton('back', t('back'), () => navigate('/videos?tab=phone', true)), h('b', { class: 'grow', dir: 'auto' }, folder))] : []),
    h('div', { class: 'videos-tools' }, search, sortBtn), list);
  draw();
}
function thumb(v: Vid): HTMLElement {
  const box = h('span', { class: 'video-thumb' }, icon('film'));
  const set = (u: string) => { box.replaceChildren(h('img', { src: u, alt: '', loading: 'lazy' })); };
  const have = thumbs.get(v.id); if (have) set(have);
  else { const io = new IntersectionObserver((es) => { if (!es.some((e) => e.isIntersecting)) return; io.disconnect(); void plug()?.videoThumb?.({ id: v.id }).then((r) => { thumbs.set(v.id, r.url); set(r.url); }).catch(() => undefined); }); requestAnimationFrame(() => io.observe(box)); }
  return box;
}
function videoRow(v: Vid, list: Vid[]): HTMLElement {
  const m = memory()[v.path]; const f = m?.watched ? 1 : m && m.duration ? Math.min(1, m.pos / m.duration) : 0;
  const tb = thumb(v); tb.append(h('i', { class: 'video-dur' }, dur(v.duration)), ...(f > 0 ? [h('i', { class: 'video-prog', style: { width: `${f * 100}%` } })] : []));
  const row = h('button', { type: 'button', class: 'video-row' + (m?.watched ? ' seen' : ''), onclick: () => void playLocal(list, list.indexOf(v)) }, tb,
    h('span', { class: 'grow' }, h('b', { dir: 'auto' }, v.name), h('small', { class: 'src' }, [resName(v.width, v.height), formatBytes(v.size), m?.watched ? t('videosWatched') : f > 0 ? t('videosLeftAt', { t: dur(m!.pos * 1000) }) : ''].filter(Boolean).join(' · '))));
  onLongPress(row, () => videoMenu(v, list));
  return row;
}
function videoMenu(v: Vid, list: Vid[]): void {
  const sh = openSheet(v.name, t('close'));
  const row = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label));
  const mem = memory(); const watched = !!mem[v.path]?.watched;
  const setMem = (o: Partial<Mem> | null) => { const all = memory(); if (o === null) delete all[v.path]; else all[v.path] = { ...(all[v.path] ?? { pos: 0, duration: v.duration / 1000 }), ...o, at: Date.now() }; try { localStorage.setItem('kt.player.memory', JSON.stringify(all)); } catch { /* */ } };
  sh.body.append(h('div', { class: 'dest-list' },
    row('play', t('play'), () => void playLocal(list, list.indexOf(v))),
    ...(mem[v.path]?.pos ? [row('refresh', t('videosFromStart'), () => { setMem({ pos: 0 }); void playLocal(list, list.indexOf(v)); })] : []),
    row(watched ? 'circle' : 'check', watched ? t('videosMarkUnwatched') : t('videosMarkWatched'), () => { setMem(watched ? { watched: false, pos: 0 } : { watched: true }); navigate(location.hash.slice(1), true); }),
    ...(ktPlugin() ? [row('external', t('openWithPlayer'), () => void (ktPlugin() as unknown as { openWith?(o: { path: string; mime: string; title: string }): Promise<void> }).openWith?.({ path: v.path, mime: 'video/*', title: v.name }))] : []),
    row('info', t('details'), () => { const s2 = openSheet(v.name, t('close')); s2.body.append(h('dl', { class: 'kv' }, ...([[t('duration'), dur(v.duration)], [t('resolution'), v.width ? `${localDigits(v.width)}×${localDigits(v.height)}` : '—'], [t('size'), formatBytes(v.size)], [t('videosFolder'), v.folder], [t('videosPath'), v.path]] as [string, string][]).flatMap(([k, x]) => [h('dt', null, k), h('dd', { dir: 'auto' }, x)]))); })));
}

/* ---------- played lately ---------- */
function recent(out: HTMLElement): void {
  const all = Object.entries(memory()).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
  const list = h('div', { class: 'videos-list' });
  const name = (k: string) => decodeURIComponent(k.split(/[\\/]/).pop()?.split('?')[0] ?? k);
  const draw = () => list.replaceChildren(...(all.length ? all.map(([k, m]) => {
    const f = m.watched ? 1 : m.duration ? Math.min(1, m.pos / m.duration) : 0; const local = k.startsWith('/') || /^[A-Za-z]:[\\/]/.test(k); const playable = local || /^https?:/.test(k);
    return h('div', { class: 'video-row' + (m.watched ? ' seen' : '') }, h('span', { class: 'video-thumb' }, icon(local ? 'film' : 'cloud'), f > 0 ? h('i', { class: 'video-prog', style: { width: `${f * 100}%` } }) : null),
      h('button', { type: 'button', class: 'grow plain', disabled: !playable, onclick: async () => { const u = local ? await urlOf(k) : k; if (u) void play(u, name(k), local ? { localPath: k } : {}); } }, h('b', { dir: 'auto' }, name(k)), h('small', { class: 'src' }, [m.watched ? t('videosWatched') : m.pos ? t('videosLeftAt', { t: dur(m.pos * 1000) }) : '', new Date(m.at).toLocaleDateString()].filter(Boolean).join(' · '))),
      iconButton('close', t('videosForget'), () => { const mem = memory(); delete mem[k]; try { localStorage.setItem('kt.player.memory', JSON.stringify(mem)); } catch { /* */ } all.splice(all.findIndex((x) => x[0] === k), 1); draw(); }));
  }) : [h('p', { class: 'empty small' }, t('videosNoRecent'))]));
  draw();
  out.append(list, ...(all.length ? [h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small danger', onclick: () => { if (!confirm(t('videosClearAsk'))) return; localStorage.removeItem('kt.player.memory'); all.length = 0; draw(); } }, icon('trash'), t('videosClear')))] : []));
}

/* ---------- media servers: Jellyfin, WebDAV ---------- */
const servers_ = (): Server[] => getSettings().mediaServers ?? [];
const saveServers = (l: Server[]) => updateSettings({ mediaServers: l });
const DEVICE = (() => { try { let d = localStorage.getItem('kt.deviceId'); if (!d) { d = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('kt.deviceId', d); } return d; } catch { return 'kt'; } })();
const jfAuth = (token?: string) => `MediaBrowser Client="Kurokawa Tools", Device="${nativePlatform()}", DeviceId="${DEVICE}", Version="1"${token ? `, Token="${token}"` : ''}`;
const basic = (s: Server) => `Basic ${btoa(unescape(encodeURIComponent(`${s.user}:${s.pass ?? ''}`)))}`;
const base = (u: string) => u.trim().replace(/\/+$/, '');

function servers(out: HTMLElement): void {
  const list = servers_();
  out.append(h('p', { class: 'hint' }, t('serversHint')),
    h('div', { class: 'videos-list' }, ...(list.length ? list.map((s) => h('div', { class: 'video-folder' }, h('span', { class: 'video-thumb' }, icon(s.type === 'jellyfin' ? 'tv' : 'cloud')),
      h('button', { type: 'button', class: 'grow plain', onclick: () => navigate(`/videos?tab=servers&srv=${s.id}`) }, h('b', { dir: 'auto' }, s.name), h('small', { class: 'src', dir: 'ltr' }, `${s.type === 'jellyfin' ? 'Jellyfin' : 'WebDAV'} · ${s.url}`)),
      iconButton('trash', t('delete'), () => { if (!confirm(t('serversRemoveAsk', { name: s.name }))) return; saveServers(servers_().filter((x) => x.id !== s.id)); navigate('/videos?tab=servers', true); }))) : [h('p', { class: 'empty small' }, t('serversNone'))])),
    h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => addServer() }, icon('plus'), t('serversAdd'))));
}
function addServer(): void {
  const sh = openSheet(t('serversAdd'), t('close')); let type: Server['type'] = 'jellyfin';
  const url = h('input', { type: 'url', dir: 'ltr', placeholder: 'http://192.168.1.10:8096' }) as HTMLInputElement;
  const user = h('input', { type: 'text', dir: 'ltr', autocomplete: 'username', placeholder: t('serversUser') }) as HTMLInputElement;
  const pass = h('input', { type: 'password', dir: 'ltr', autocomplete: 'current-password', placeholder: t('password') }) as HTMLInputElement;
  const name = h('input', { type: 'text', dir: 'auto', placeholder: t('serversName') }) as HTMLInputElement;
  const note = h('p', { class: 'hint' });
  const kind = pickButton(t('serversType'), [['jellyfin', 'Jellyfin'], ['webdav', 'WebDAV']], type, (v) => { type = v; url.placeholder = v === 'jellyfin' ? 'http://192.168.1.10:8096' : 'https://nas.local/dav/Videos'; note.textContent = v === 'webdav' ? t('serversWebdavNote') : ''; }, t('close'));
  const status = h('p', { class: 'src' });
  sh.body.append(h('div', { class: 'row' }, h('span', null, t('serversType')), kind), url, user, pass, name, note, status);
  const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const u = base(url.value); if (!/^https?:\/\//.test(u)) { status.textContent = t('serversBadUrl'); return; }
    go.disabled = true; status.textContent = t('checking');
    try {
      const s: Server = { id: Date.now().toString(36), type, name: name.value.trim() || u.replace(/^https?:\/\//, ''), url: u, user: user.value.trim() };
      if (type === 'jellyfin') {
        const r = await request(`${u}/Users/AuthenticateByName`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-emby-authorization': jfAuth(), authorization: jfAuth() }, body: JSON.stringify({ Username: s.user, Pw: pass.value }) });
        if (r.status !== 200) throw new Error(r.status === 401 ? t('serversWrongLogin') : `HTTP ${r.status}`);
        const j = JSON.parse(r.body) as { AccessToken: string; User: { Id: string } }; s.token = j.AccessToken; s.userId = j.User.Id;
      } else {
        s.pass = pass.value;
        const r = await request(u + '/', { method: 'PROPFIND', headers: { depth: '0', authorization: basic(s) } });
        if (r.status !== 207 && r.status !== 200) throw new Error(r.status === 401 ? t('serversWrongLogin') : `HTTP ${r.status}`);
      }
      saveServers([...servers_(), s]); sh.close(); toast(t('serversAdded', { name: s.name })); navigate(`/videos?tab=servers&srv=${s.id}`, true);
    } catch (e) { status.textContent = String((e as Error).message ?? e); go.disabled = false; }
  } }, icon('check'), t('serversConnect')) as HTMLButtonElement;
  sh.actions.append(go);
}
type Entry = { id: string; name: string; folder: boolean; video: boolean; size?: number; image?: string; url?: string; headers?: Record<string, string>; sub?: string; seen?: boolean; progress?: number };
async function browse(out: HTMLElement, srvId: string, at?: string): Promise<void> {
  const s = servers_().find((x) => x.id === srvId); if (!s) { navigate('/videos?tab=servers', true); return; }
  const crumb = h('div', { class: 'row videos-crumb' }, iconButton('back', t('back'), () => history.back()), h('b', { class: 'grow', dir: 'auto' }, s.name), h('small', { class: 'src', dir: 'auto' }, at && s.type === 'webdav' ? decodeURIComponent(at) : ''));
  const list = h('div', { class: 'videos-list' }, h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  out.append(crumb, list);
  try {
    const items = s.type === 'jellyfin' ? await jellyfin(s, at) : await webdav(s, at);
    const vids = items.filter((x) => x.video);
    list.replaceChildren(...(items.length ? items.map((x) => h('button', { type: 'button', class: x.folder ? 'video-folder' : 'video-row' + (x.seen ? ' seen' : ''), onclick: () => { if (x.folder) navigate(`/videos?tab=servers&srv=${s.id}&p=${encodeURIComponent(x.id)}`); else if (x.video) void playRemote(s, vids, vids.indexOf(x)); } },
      h('span', { class: 'video-thumb' }, x.image ? h('img', { src: x.image, alt: '', loading: 'lazy' }) : icon(x.folder ? 'folder' : x.video ? 'film' : 'file'), x.progress ? h('i', { class: 'video-prog', style: { width: `${x.progress * 100}%` } }) : null),
      h('span', { class: 'grow' }, h('b', { dir: 'auto' }, x.name), x.sub || x.size ? h('small', { class: 'src' }, [x.sub ?? '', x.size ? formatBytes(x.size) : ''].filter(Boolean).join(' · ')) : null), x.folder ? icon('chevronRight') : null)) : [h('p', { class: 'empty small' }, t('videosNone'))]));
  } catch (e) { list.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
}
/** A server's video: Jellyfin's straight stream (its key in the address); WebDAV's through the app's own local
 *  relay where it can sign the request, else as it is. */
async function playRemote(s: Server, vids: Entry[], i: number): Promise<void> {
  const resolve = async (x: Entry) => { if (!x.url) return ''; if (x.headers && plug()?.proxyUrl) return (await plug()!.proxyUrl!({ url: x.url, headers: x.headers })).url; return x.url; };
  const near = vids.slice(Math.max(0, i - 30), i + 30);
  const playlist = (await Promise.all(near.map(async (x) => ({ url: await resolve(x).catch(() => ''), name: x.name })))).filter((x) => x.url);
  const url = await resolve(vids[i]); if (!url) { toast(t('playerCantPlay'), 'error'); return; }
  if (s.type === 'webdav' && !plug()?.proxyUrl && vids[i].headers) toast(t('serversNoRelay'));
  await play(url, vids[i].name, { playlist });
}
async function jellyfin(s: Server, parent?: string): Promise<Entry[]> {
  const H = { 'x-emby-authorization': jfAuth(s.token), authorization: jfAuth(s.token), accept: 'application/json' };
  const path = parent ? `/Users/${s.userId}/Items?ParentId=${encodeURIComponent(parent)}&SortBy=SortName&SortOrder=Ascending&Fields=MediaSources,UserData&EnableImageTypes=Primary,Thumb&Limit=500` : `/Users/${s.userId}/Views`;
  const r = await request(`${s.url}${path}`, { headers: H }); if (r.status === 401) throw new Error(t('serversSignInAgain')); if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(r.body) as { Items: { Id: string; Name: string; Type: string; IsFolder: boolean; ProductionYear?: number; IndexNumber?: number; ParentIndexNumber?: number; RunTimeTicks?: number; UserData?: { Played?: boolean; PlayedPercentage?: number } }[] };
  return j.Items.map((x) => {
    const video = ['Movie', 'Episode', 'Video', 'MusicVideo'].includes(x.Type);
    const sub = [x.Type === 'Episode' && x.IndexNumber ? `${x.ParentIndexNumber ? `S${x.ParentIndexNumber}` : ''}E${x.IndexNumber}` : '', x.ProductionYear ? String(x.ProductionYear) : '', x.RunTimeTicks ? dur(x.RunTimeTicks / 10000) : ''].filter(Boolean).join(' · ');
    return { id: x.Id, name: x.Name, folder: x.IsFolder, video, sub, seen: !!x.UserData?.Played, progress: x.UserData?.PlayedPercentage ? x.UserData.PlayedPercentage / 100 : undefined, image: `${s.url}/Items/${x.Id}/Images/Primary?maxHeight=180&quality=80&api_key=${s.token}`, url: video ? `${s.url}/Videos/${x.Id}/stream?static=true&api_key=${s.token}` : undefined };
  });
}
async function webdav(s: Server, at?: string): Promise<Entry[]> {
  const dir = at ? `${new URL(s.url).origin}${at}` : `${s.url}/`;
  const r = await request(dir, { method: 'PROPFIND', headers: { depth: '1', authorization: basic(s), 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getcontenttype/></d:prop></d:propfind>' });
  if (r.status === 401) throw new Error(t('serversWrongLogin')); if (r.status !== 207 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const doc = new DOMParser().parseFromString(r.body, 'application/xml'); const here = new URL(dir).pathname.replace(/\/?$/, '/');
  const out: Entry[] = [];
  for (const resp of Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))) {
    const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? ''; const p = (() => { try { return new URL(href, dir).pathname; } catch { return href; } })();
    if (p.replace(/\/?$/, '/') === here) continue;
    const folder = resp.getElementsByTagNameNS('DAV:', 'collection').length > 0;
    const nm = resp.getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent || decodeURIComponent(p.replace(/\/$/, '').split('/').pop() ?? p);
    const size = Number(resp.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? 0) || undefined;
    const video = !folder && VIDEO_RE.test(nm);
    out.push({ id: p, name: nm, folder, video, size, url: video ? `${new URL(s.url).origin}${p}` : undefined, headers: video ? { Authorization: basic(s) } : undefined });
  }
  return out.filter((x) => x.folder || x.video || /\.(srt|ass|vtt)$/i.test(x.name)).sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/* ---------- followed channels and playlists: looked at now and then; new videos added on their own or counted ---------- */
async function followed(content: HTMLElement): Promise<void> {
  const m = await import('../video/follow'); const { videoEnabled } = await import('../video/ytdlp');
  const fmtAgo = (ms?: number) => { if (!ms) return t('followNever'); const mins = Math.round((Date.now() - ms) / 60000); return mins < 60 ? t('followMinutesAgo', { n: localDigits(mins) }) : mins < 1440 ? t('followHoursAgo', { n: localDigits(Math.round(mins / 60)) }) : t('followDaysAgo', { n: localDigits(Math.round(mins / 1440)) }); };
  const list = h('div', { class: 'dest-list' });
  const draw = () => {
    const fs = m.follows();
    list.replaceChildren(...(fs.length ? fs.map((f) => h('div', { class: 'dest-row' + (f.error ? ' off' : '') },
      icon(f.checking ? 'refresh' : f.auto ? 'download' : 'bell'),
      h('button', { type: 'button', class: 'grow plain files-main', onclick: () => editSheet(f) }, h('span', { class: 'name', dir: 'auto' }, f.title), h('small', { class: 'src', dir: 'auto' }, [f.auto ? t('followAuto') : t('followNotify'), t('followEvery', { h: localDigits(f.every) }), fmtAgo(f.lastAt), f.newCount ? t('followNewN', { n: localDigits(f.newCount) }) : '', f.error ? f.error : ''].filter(Boolean).join(' · '))),
      iconButton('refresh', t('followCheckNow'), () => { void m.check(f, true).then((n) => { toast(n ? t(f.auto ? 'followAdded' : 'followNew', { n: String(n) }) : t('followNothingNew')); draw(); }); draw(); }),
      iconButton('trash', t('delete'), () => { m.unfollow(f.id); draw(); }))) : [h('p', { class: 'empty small' }, t('followEmpty'))]));
  };
  const editSheet = (f: import('../video/follow').Follow | null) => {
    const sh = openSheet(f ? f.title : t('followAdd'), t('cancel'));
    const url = h('input', { type: 'url', dir: 'ltr', value: f?.url ?? '', placeholder: 'https://www.youtube.com/@channel/videos', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
    const title = h('input', { type: 'text', dir: 'auto', value: f?.title && f.title !== f.url ? f.title : '', placeholder: t('followTitleHint') }) as HTMLInputElement;
    let every = f?.every ?? 6; const everyBtn = pickButton(t('followEveryLabel'), [['1', t('followEvery', { h: localDigits(1) })], ['3', t('followEvery', { h: localDigits(3) })], ['6', t('followEvery', { h: localDigits(6) })], ['12', t('followEvery', { h: localDigits(12) })], ['24', t('followEvery', { h: localDigits(24) })]], String(every), (v) => { every = Number(v); }, t('close'));
    const auto = h('input', { type: 'checkbox', checked: !!f?.auto }) as HTMLInputElement; const max = h('input', { type: 'number', value: String(f?.max ?? 5), min: '1', max: '50' }) as HTMLInputElement; const dir = h('input', { type: 'text', dir: 'ltr', value: f?.dir ?? '', placeholder: t('ruleDirHint') }) as HTMLInputElement;
    sh.body.append(h('p', { class: 'hint' }, t('followHint')), h('label', { class: 'field' }, h('span', null, t('followUrl')), url), h('label', { class: 'field' }, h('span', null, t('ruleName')), title), h('div', { class: 'row' }, h('span', null, t('followEveryLabel')), everyBtn),
      h('label', { class: 'check-row' }, auto, h('span', null, t('followAutoLabel'), h('small', { class: 'src' }, t('followAutoHint')))), h('label', { class: 'field row' }, h('span', { class: 'label' }, t('followMax')), max), h('label', { class: 'field' }, h('span', null, t('ruleDir')), dir));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { const u = url.value.trim(); if (!/^https?:\/\//i.test(u)) { toast(t('invalidLink'), 'error'); return; } const all = m.follows(); const nf = f ? all.find((x) => x.id === f.id)! : m.newFollow(u); Object.assign(nf, { url: u, title: title.value.trim() || (f?.title ?? u), every, auto: auto.checked, max: Math.max(1, Number(max.value) || 5), dir: dir.value.trim() || undefined }); if (!f) all.push(nf); m.saveFollows(all); sh.close(); draw(); if (!f) void m.check(nf).then(draw); } }, icon('check'), t('save')));
  };
  content.replaceChildren(h('p', { class: 'hint' }, videoEnabled() ? t('followedHint') : t('videoYtdlpMissingLong')), list, h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal', onclick: () => void m.tick(true).then(draw) }, icon('refresh'), t('followCheckAll')), h('button', { type: 'button', class: 'btn primary', onclick: () => editSheet(null) }, icon('plus'), t('followAdd'))));
  draw(); const off = m.onFollowsChange(draw); const mo = new MutationObserver(() => { if (!content.isConnected) { off(); mo.disconnect(); } }); mo.observe(document.body, { childList: true, subtree: true });
}
