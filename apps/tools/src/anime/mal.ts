// MyAnimeList, for the notes only: its official API (v2) takes no reviews and nothing per episode — one «comments»
// text on a list entry (PATCH /anime/{id}/my_list_status). Signing in needs an API client ID of the user's own (MAL
// gives apps none; the type «other» has no secret, and none is ever asked for): OAuth 2 with PKCE, whose only
// method there is «plain»; the code taken from the address MAL sends the window to, then exchanged for the token.
// The token is kept on the device like AniList's.
import { request } from '../http';
import { getSettings } from '../settings';

const KEY = 'kt.mal.token';
/** The redirect address the user registers with the client (any address works: the app's window reads it before it loads). */
export const MAL_REDIRECT = 'http://localhost/kurokawa-mal';
const authBase = () => 'https://myanimelist.net/v1/oauth2';
const apiBase = () => 'https://api.myanimelist.net/v2';
interface Tok { access: string; refresh: string; exp: number; name: string }
const tok = (): Tok | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Tok | null; } catch { return null; } };
const keepTok = (t: Tok | null) => { try { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); } catch { /* private mode */ } };
export const malUser = (): string | null => tok()?.name ?? null;
export const malLinked = (): boolean => !!tok();
export const malUnlink = (): void => keepTok(null);
export const malClientId = (): string => (getSettings().malClientId ?? '').trim();

const VERIFIER = 'kt.mal.pkce';
const rand = (n: number) => { const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'; const b = crypto.getRandomValues(new Uint8Array(n)); return Array.from(b, (x) => abc[x % abc.length]).join(''); };
/** The sign-in page's address (a new verifier and state each time, kept for the code's exchange). */
export function malAuthUrl(): string {
  const v = rand(96), state = rand(24); try { sessionStorage.setItem(VERIFIER, JSON.stringify({ v, state })); } catch { /* none */ }
  const q = new URLSearchParams({ response_type: 'code', client_id: malClientId(), code_challenge: v, code_challenge_method: 'plain', state, redirect_uri: MAL_REDIRECT });
  return `${authBase()}/authorize?${q}`;
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function tokenCall(body: Record<string, string>): Promise<Tok> {
  const r = await request(`${authBase()}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form({ client_id: malClientId(), ...body }), timeoutMs: 30000 });
  let j: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; message?: string } = {}; try { j = JSON.parse(r.body); } catch { /* below */ }
  if (r.status !== 200 || !j.access_token) throw new Error(`MyAnimeList: ${j.message || j.error || `HTTP ${r.status}`}`);
  return { access: j.access_token, refresh: j.refresh_token ?? '', exp: Date.now() + (j.expires_in ?? 3600) * 1000, name: tok()?.name ?? '' };
}
/** The address the sign-in ended on (with ?code=…&state=…): the code exchanged, the account read and kept. */
export async function malFinish(address: string): Promise<string> {
  let u: URL; try { u = new URL(address.trim()); } catch { throw new Error('MyAnimeList: ?code'); }
  const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
  let saved: { v: string; state: string } | null = null; try { saved = JSON.parse(sessionStorage.getItem(VERIFIER) ?? 'null'); } catch { /* none */ }
  if (!code || !saved || state !== saved.state) throw new Error(`MyAnimeList: ${u.searchParams.get('error') ?? 'state'}`);
  const t = await tokenCall({ grant_type: 'authorization_code', code, code_verifier: saved.v, redirect_uri: MAL_REDIRECT });
  keepTok(t); try { sessionStorage.removeItem(VERIFIER); } catch { /* none */ }
  try { const me = await malFetch('/users/@me'); t.name = (JSON.parse(me.body) as { name?: string }).name ?? ''; keepTok(t); } catch (e) { keepTok(null); throw e; }
  return t.name;
}
// (A refresh token is good once: calls that find the token run out together share one renewal.)
let renewing: Promise<Tok> | null = null;
function renew(old: Tok): Promise<Tok> {
  renewing ??= tokenCall({ grant_type: 'refresh_token', refresh_token: old.refresh }).then((x) => { const n = { ...x, name: old.name }; keepTok(n); return n; }, (e) => { keepTok(null); throw e; }).finally(() => { setTimeout(() => { renewing = null; }, 0); });
  return renewing;
}
/** One call to the API, the token renewed once when MAL says it has run out. */
async function malFetch(path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  let t = tok(); if (!t) throw new Error('MyAnimeList: sign in');
  const go = (x: Tok) => request(`${apiBase()}${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${x.access}`, ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: init.body, timeoutMs: 30000 });
  let r = await go(t);
  if (r.status === 401 && t.refresh) { try { t = await renew(t); r = await go(t); } catch { throw new Error('MyAnimeList: sign in again'); } }
  if (r.status === 429) throw Object.assign(new Error('MyAnimeList: HTTP 429'), { later: true, retryAfter: Number(r.headers['retry-after']) || 60 });
  if (r.status >= 400) throw new Error(`MyAnimeList: HTTP ${r.status}`);
  return r;
}
/** The list entry's comments (null: the show is not on the user's list). */
export async function malComments(idMal: number): Promise<string | null> {
  const r = await malFetch(`/anime/${idMal}?fields=my_list_status%7Bcomments%7D`);
  const s = (JSON.parse(r.body) as { my_list_status?: { comments?: string } }).my_list_status; return s ? s.comments ?? '' : null;
}
/** The comments written (the show added as «Watching» when it was not on the list). */
export async function malSetComments(idMal: number, comments: string, add = false): Promise<void> {
  const body = form({ comments, ...(add ? { status: 'watching' } : {}) });
  // (The reference names PATCH and shows PUT in its example: PATCH, then PUT if the server refuses the method.)
  try { await malFetch(`/anime/${idMal}/my_list_status`, { method: 'PATCH', body }); }
  catch (e) { if (!/HTTP 405/.test(String((e as Error).message))) throw e; await malFetch(`/anime/${idMal}/my_list_status`, { method: 'PUT', body }); }
}

/* ---------- progress (after an episode is watched): never lowered, kept and sent again when MAL cannot be reached ---------- */
const PENDING = 'kt.tmp.malPending';
type Pend = Record<string, { ep: number; total?: number | null }>;
const pend = (): Pend => { try { return JSON.parse(localStorage.getItem(PENDING) ?? '{}') as Pend; } catch { return {}; } };
const keepPend = (p: Pend) => { try { localStorage.setItem(PENDING, JSON.stringify(p)); } catch { /* full */ } };
async function sendProgress(idMal: number, ep: number, total?: number | null): Promise<void> {
  const r = await malFetch(`/anime/${idMal}?fields=my_list_status%7Bnum_episodes_watched,status%7D`);
  const st = (JSON.parse(r.body) as { my_list_status?: { num_episodes_watched?: number; status?: string } }).my_list_status;
  if (st && (st.num_episodes_watched ?? 0) >= ep) return;
  const body = form({ num_watched_episodes: String(ep), ...(total && ep >= total ? { status: 'completed' } : !st || st.status === 'plan_to_watch' ? { status: 'watching' } : {}) });
  try { await malFetch(`/anime/${idMal}/my_list_status`, { method: 'PATCH', body }); }
  catch (e) { if (!/HTTP 405/.test(String((e as Error).message))) throw e; await malFetch(`/anime/${idMal}/my_list_status`, { method: 'PUT', body }); }
}
/** The list's progress moved to `ep` (when behind); unreachable: kept, and sent with the next one or when back online. */
export async function malProgress(idMal: number | undefined, ep: number, total?: number | null): Promise<void> {
  if (!idMal || !malLinked() || !(await autoOnNow())) return;
  await malFlush();
  try { await sendProgress(idMal, ep, total); }
  catch (e) { if (/sign in/.test(String((e as Error).message))) return; const p = pend(); if ((p[idMal]?.ep ?? 0) < ep) p[idMal] = { ep, total }; keepPend(p); }
}
let flushing = false;
const autoOnNow = () => import('./progress').then((m) => m.autoOn());
export async function malFlush(): Promise<void> {
  const p = pend(); if (flushing || !Object.keys(p).length || !malLinked() || !(await autoOnNow())) return; flushing = true;
  try { for (const [id, x] of Object.entries(p)) { try { await sendProgress(Number(id), x.ep, x.total); delete p[id]; } catch { /* next time */ } } keepPend(p); } finally { flushing = false; }
}
window.addEventListener('online', () => void malFlush());
