// Debrid services (the Debrid add-on): a magnet, a .torrent or a hoster link handed to the service, which
// fetches it in the cloud and gives back direct links the app downloads at full speed — Real-Debrid,
// AllDebrid, Premiumize and TorBox behind one interface (Seanime's). Keys live in the add-on's settings.
import { request } from '../http';
import { addonSettings, loadIndex } from '../addons';
import { getSettings } from '../settings';

export type DebridId = 'realdebrid' | 'alldebrid' | 'premiumize' | 'torbox';
export interface DebridFile { id: string; name: string; size: number; link?: string }
export interface DebridTorrent { id: string; name: string; hash?: string; size: number; progress: number; status: 'queued' | 'downloading' | 'ready' | 'error' | 'other'; speed?: number; seeders?: number; files: DebridFile[]; error?: string }
export interface DebridLink { url: string; name: string; size?: number }
export interface Debrid {
  id: DebridId; name: string;
  account(): Promise<{ user: string; premium: boolean; expires?: string }>;
  addMagnet(magnet: string): Promise<string>;
  addTorrent?(base64: string): Promise<string>;
  torrent(id: string): Promise<DebridTorrent>;
  torrents(): Promise<DebridTorrent[]>;
  remove(id: string): Promise<void>;
  /** A direct download link for a file (or a hoster link unrestricted). */
  unrestrict(link: string): Promise<DebridLink>;
  /** Hashes the service already holds, when it can say (several services closed this door). */
  cached?(hashes: string[]): Promise<Set<string>>;
  /** Does a plain hoster link belong to a site this service can unrestrict? */
  hosts?(): Promise<string[]>;
}
const j = async <T>(r: Awaited<ReturnType<typeof request>>, what: string): Promise<T> => { let o: unknown; try { o = JSON.parse(r.body); } catch { throw new Error(`${what}: HTTP ${r.status}`); } if (r.status >= 400) throw new Error(`${what}: ${(o as { error?: string; detail?: string; message?: string }).error ?? (o as { detail?: string }).detail ?? (o as { message?: string }).message ?? `HTTP ${r.status}`}`); return o as T; };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/* ---------- Real-Debrid ---------- */
function realDebrid(key: string): Debrid {
  const B = 'https://api.real-debrid.com/rest/1.0'; const H = { Authorization: `Bearer ${key}` }; const HF = { ...H, 'Content-Type': 'application/x-www-form-urlencoded' };
  const map = (t: { id: string; filename: string; hash: string; bytes: number; progress: number; status: string; speed?: number; seeders?: number; files?: { id: number; path: string; bytes: number; selected: number }[]; links?: string[] }): DebridTorrent => {
    const st = t.status; const status: DebridTorrent['status'] = st === 'downloaded' ? 'ready' : st === 'downloading' || st === 'queued' || st === 'magnet_conversion' || st === 'waiting_files_selection' || st === 'compressing' || st === 'uploading' ? (st === 'waiting_files_selection' ? 'queued' : 'downloading') : st === 'error' || st === 'virus' || st === 'dead' || st === 'magnet_error' ? 'error' : 'other';
    const sel = (t.files ?? []).filter((f) => f.selected); const files: DebridFile[] = sel.map((f, i) => ({ id: String(f.id), name: f.path.replace(/^\//, ''), size: f.bytes, link: t.links?.[i] }));
    return { id: t.id, name: t.filename, hash: t.hash, size: t.bytes, progress: t.progress, status, speed: t.speed, seeders: t.seeders, files, error: status === 'error' ? st : undefined };
  };
  return {
    id: 'realdebrid', name: 'Real-Debrid',
    async account() { const u = await j<{ username: string; type: string; expiration: string }>(await request(`${B}/user`, { headers: H }), 'Real-Debrid'); return { user: u.username, premium: u.type === 'premium', expires: u.expiration }; },
    async addMagnet(magnet) { const r = await j<{ id: string }>(await request(`${B}/torrents/addMagnet`, { method: 'POST', headers: HF, body: form({ magnet }) }), 'Real-Debrid'); await request(`${B}/torrents/selectFiles/${r.id}`, { method: 'POST', headers: HF, body: form({ files: 'all' }) }); return r.id; },
    async addTorrent(b64) { const r = await j<{ id: string }>(await request(`${B}/torrents/addTorrent`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/x-bittorrent' }, body: b64, bodyBase64: true }), 'Real-Debrid'); await request(`${B}/torrents/selectFiles/${r.id}`, { method: 'POST', headers: HF, body: form({ files: 'all' }) }); return r.id; },
    async torrent(id) { return map(await j(await request(`${B}/torrents/info/${id}`, { headers: H }), 'Real-Debrid')); },
    async torrents() { return (await j<Parameters<typeof map>[0][]>(await request(`${B}/torrents?limit=100`, { headers: H }), 'Real-Debrid')).map(map); },
    async remove(id) { await request(`${B}/torrents/delete/${id}`, { method: 'DELETE', headers: H }); },
    async unrestrict(link) { const u = await j<{ download: string; filename: string; filesize: number }>(await request(`${B}/unrestrict/link`, { method: 'POST', headers: HF, body: form({ link }) }), 'Real-Debrid'); return { url: u.download, name: u.filename, size: u.filesize }; },
    async hosts() { return Object.keys(await j<Record<string, unknown>>(await request(`${B}/hosts`, { headers: H }), 'Real-Debrid')); },
  };
}
/* ---------- AllDebrid ---------- */
function allDebrid(key: string): Debrid {
  const B = 'https://api.alldebrid.com/v4'; const Q = `agent=KurokawaTools&apikey=${encodeURIComponent(key)}`;
  const ok = async <T>(r: Awaited<ReturnType<typeof request>>): Promise<T> => { const o = await j<{ status: string; data?: T; error?: { message: string } }>(r, 'AllDebrid'); if (o.status !== 'success') throw new Error(`AllDebrid: ${o.error?.message ?? 'error'}`); return o.data as T; };
  const map = (m: { id: number; filename: string; hash: string; size: number; status: string; statusCode: number; downloaded?: number; downloadSpeed?: number; seeders?: number; links?: { link: string; filename: string; size: number }[] }): DebridTorrent => ({ id: String(m.id), name: m.filename, hash: m.hash, size: m.size, progress: m.statusCode === 4 ? 100 : m.size ? Math.round(((m.downloaded ?? 0) / m.size) * 100) : 0, status: m.statusCode === 4 ? 'ready' : m.statusCode < 4 ? 'downloading' : 'error', speed: m.downloadSpeed, seeders: m.seeders, files: (m.links ?? []).map((l, i) => ({ id: String(i), name: l.filename, size: l.size, link: l.link })), error: m.statusCode > 4 ? m.status : undefined });
  return {
    id: 'alldebrid', name: 'AllDebrid',
    async account() { const u = await ok<{ user: { username: string; isPremium: boolean; premiumUntil: number } }>(await request(`${B}/user?${Q}`)); return { user: u.user.username, premium: u.user.isPremium, expires: u.user.premiumUntil ? new Date(u.user.premiumUntil * 1000).toISOString() : undefined }; },
    async addMagnet(magnet) { const d = await ok<{ magnets: { id: number; error?: { message: string } }[] }>(await request(`${B}/magnet/upload?${Q}&${new URLSearchParams({ 'magnets[]': magnet })}`)); const m = d.magnets[0]; if (m.error) throw new Error(`AllDebrid: ${m.error.message}`); return String(m.id); },
    async torrent(id) { const d = await ok<{ magnets: Parameters<typeof map>[0] | Parameters<typeof map>[0][] }>(await request(`${B}/magnet/status?${Q}&id=${id}`)); return map(Array.isArray(d.magnets) ? d.magnets[0] : d.magnets); },
    async torrents() { const d = await ok<{ magnets: Parameters<typeof map>[0][] }>(await request(`${B}/magnet/status?${Q}`)); return d.magnets.map(map); },
    async remove(id) { await request(`${B}/magnet/delete?${Q}&id=${id}`); },
    async unrestrict(link) { const d = await ok<{ link: string; filename: string; filesize: number }>(await request(`${B}/link/unlock?${Q}&link=${encodeURIComponent(link)}`)); return { url: d.link, name: d.filename, size: d.filesize }; },
    async hosts() { const d = await ok<{ hosts: Record<string, { domains: string[] }> }>(await request(`${B}/hosts?${Q}`)); return Object.values(d.hosts).flatMap((h) => h.domains); },
  };
}
/* ---------- Premiumize ---------- */
function premiumize(key: string): Debrid {
  const B = 'https://www.premiumize.me/api'; const Q = `apikey=${encodeURIComponent(key)}`;
  const ok = async <T>(r: Awaited<ReturnType<typeof request>>): Promise<T> => { const o = await j<T & { status: string; message?: string }>(r, 'Premiumize'); if (o.status !== 'success') throw new Error(`Premiumize: ${o.message ?? 'error'}`); return o; };
  const files = async (folderId?: string, fileId?: string): Promise<DebridFile[]> => { if (fileId) { const f = await ok<{ content: { id: string; name: string; size: number; link: string } }>(await request(`${B}/item/details?${Q}&id=${fileId}`)); return [{ id: f.content.id, name: f.content.name, size: f.content.size, link: f.content.link }]; } if (!folderId) return []; const d = await ok<{ content: { id: string; name: string; type: string; size?: number; link?: string }[] }>(await request(`${B}/folder/list?${Q}&id=${folderId}`)); const out: DebridFile[] = []; for (const c of d.content) { if (c.type === 'folder') out.push(...(await files(c.id)).map((f) => ({ ...f, name: `${c.name}/${f.name}` }))); else out.push({ id: c.id, name: c.name, size: c.size ?? 0, link: c.link }); } return out; };
  const map = async (t: { id: string; name: string; status: string; progress: number; message?: string; folder_id?: string; file_id?: string; src?: string }, deep: boolean): Promise<DebridTorrent> => ({ id: t.id, name: t.name, hash: /btih:([a-f0-9]{40})/i.exec(t.src ?? '')?.[1]?.toLowerCase(), size: 0, progress: t.status === 'finished' ? 100 : Math.round((t.progress ?? 0) * 100), status: t.status === 'finished' ? 'ready' : t.status === 'error' || t.status === 'banned' || t.status === 'timeout' ? 'error' : t.status === 'waiting' || t.status === 'queued' ? 'queued' : 'downloading', files: deep && t.status === 'finished' ? await files(t.folder_id, t.file_id) : [], error: t.status === 'error' ? t.message : undefined });
  return {
    id: 'premiumize', name: 'Premiumize',
    async account() { const u = await ok<{ customer_id: string; premium_until: number }>(await request(`${B}/account/info?${Q}`)); return { user: u.customer_id, premium: u.premium_until * 1000 > Date.now(), expires: new Date(u.premium_until * 1000).toISOString() }; },
    async addMagnet(magnet) { const d = await ok<{ id: string }>(await request(`${B}/transfer/create?${Q}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ src: magnet }) })); return d.id; },
    async torrent(id) { const d = await ok<{ transfers: Parameters<typeof map>[0][] }>(await request(`${B}/transfer/list?${Q}`)); const t = d.transfers.find((x) => x.id === id); if (!t) throw new Error('Premiumize: transfer gone'); return map(t, true); },
    async torrents() { const d = await ok<{ transfers: Parameters<typeof map>[0][] }>(await request(`${B}/transfer/list?${Q}`)); return Promise.all(d.transfers.map((t) => map(t, false))); },
    async remove(id) { await request(`${B}/transfer/delete?${Q}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ id }) }); },
    async unrestrict(link) { if (/^https?:\/\/[^/]*premiumize/.test(link)) return { url: link, name: decodeURIComponent(link.split('/').pop() ?? 'file') }; const d = await ok<{ content: { path: string; link: string; size: number }[] }>(await request(`${B}/transfer/directdl?${Q}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ src: link }) })); const c = d.content[0]; if (!c) throw new Error('Premiumize: nothing'); return { url: c.link, name: c.path.split('/').pop() ?? 'file', size: c.size }; },
    async cached(hashes) { const d = await ok<{ response: boolean[] }>(await request(`${B}/cache/check?${Q}&${hashes.map((h) => `items[]=${h}`).join('&')}`)); return new Set(hashes.filter((_, i) => d.response[i])); },
  };
}
/* ---------- TorBox ---------- */
function torbox(key: string): Debrid {
  const B = 'https://api.torbox.app/v1/api'; const H = { Authorization: `Bearer ${key}` };
  const ok = async <T>(r: Awaited<ReturnType<typeof request>>): Promise<T> => { const o = await j<{ success: boolean; detail?: string; data: T }>(r, 'TorBox'); if (!o.success) throw new Error(`TorBox: ${o.detail ?? 'error'}`); return o.data; };
  const map = (t: { id: number; name: string; hash: string; size: number; progress: number; download_state: string; download_speed?: number; seeds?: number; download_finished?: boolean; files?: { id: number; name: string; size: number; short_name?: string }[] }): DebridTorrent => ({ id: String(t.id), name: t.name, hash: t.hash, size: t.size, progress: t.download_finished ? 100 : Math.round((t.progress ?? 0) * 100), status: t.download_finished || t.download_state === 'completed' || t.download_state === 'cached' || t.download_state === 'uploading' ? 'ready' : /error|fail|stalled/i.test(t.download_state) ? 'error' : t.download_state === 'metaDL' || t.download_state === 'checking' ? 'queued' : 'downloading', speed: t.download_speed, seeders: t.seeds, files: (t.files ?? []).map((f) => ({ id: String(f.id), name: f.name, size: f.size, link: `torbox://${t.id}/${f.id}` })), error: /error|fail/i.test(t.download_state) ? t.download_state : undefined });
  return {
    id: 'torbox', name: 'TorBox',
    async account() { const u = await ok<{ email: string; plan: number; premium_expires_at?: string }>(await request(`${B}/user/me?settings=false`, { headers: H })); return { user: u.email, premium: u.plan > 0, expires: u.premium_expires_at }; },
    async addMagnet(magnet) { const d = await ok<{ torrent_id: number }>(await request(`${B}/torrents/createtorrent`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ magnet, seed: '1', allow_zip: 'false' }) })); return String(d.torrent_id); },
    async torrent(id) { const d = await ok<Parameters<typeof map>[0]>(await request(`${B}/torrents/mylist?id=${id}&bypass_cache=true`, { headers: H })); return map(d); },
    async torrents() { const d = await ok<Parameters<typeof map>[0][]>(await request(`${B}/torrents/mylist?bypass_cache=true`, { headers: H })); return d.map(map); },
    async remove(id) { await request(`${B}/torrents/controltorrent`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ torrent_id: Number(id), operation: 'delete' }) }); },
    async unrestrict(link) { const m = /^torbox:\/\/(\d+)\/(\d+)$/.exec(link); if (!m) { const d = await ok<string>(await request(`${B}/webdl/requestdl?token=${encodeURIComponent(key)}&web_id=${encodeURIComponent(link)}`, { headers: H })); return { url: d, name: 'file' }; } const d = await ok<string>(await request(`${B}/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${m[1]}&file_id=${m[2]}`, { headers: H })); return { url: d, name: decodeURIComponent(d.split('/').pop()?.split('?')[0] ?? 'file') }; },
    async cached(hashes) { const d = await ok<Record<string, unknown>>(await request(`${B}/torrents/checkcached?hash=${hashes.join(',')}&format=object&list_files=false`, { headers: H })); return new Set(Object.keys(d ?? {}).map((h) => h.toLowerCase())); },
  };
}

const MAKERS: Record<DebridId, (key: string) => Debrid> = { realdebrid: realDebrid, alldebrid: allDebrid, premiumize, torbox };
export const DEBRID_NAMES: Record<DebridId, string> = { realdebrid: 'Real-Debrid', alldebrid: 'AllDebrid', premiumize: 'Premiumize', torbox: 'TorBox' };

/** The services with a key, the preferred one first. */
export async function debridServices(): Promise<Debrid[]> {
  const ix = await loadIndex().catch(() => null); const e = ix?.addons.find((a) => a.id === 'debrid'); if (!e || !getSettings().addons.includes('debrid')) return [];
  const s = addonSettings(e); const out: Debrid[] = [];
  const order = ([String(s.preferred ?? ''), 'realdebrid', 'alldebrid', 'premiumize', 'torbox'] as string[]).filter((x, i, a) => x && a.indexOf(x) === i) as DebridId[];
  for (const id of order) { const key = String(s[`${id}Key`] ?? '').trim(); if (key && MAKERS[id]) out.push(MAKERS[id](key)); }
  return out;
}
export const debridOn = (): boolean => getSettings().addons.includes('debrid');
export async function preferredDebrid(): Promise<Debrid | null> { return (await debridServices())[0] ?? null; }
