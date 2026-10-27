// وصلة الشاملة (shamela.link): an independent service that puts the Shamela library behind an MCP server —
// full-text search (phrase, boolean, wildcards, root forms) over some 8,600 books with facets by category,
// century, book and author, the catalogue by name, and pages. It wants an account (free) and a sign-in: the
// standard OAuth flow the service publishes (PKCE, a client registered on the fly), the tokens kept on this
// device alone. The calls are plain JSON-RPC over HTTPS, the reply JSON or a short event stream.
import { http } from '../net';
import { nativePlatform } from '../native';
import { SourceError } from './types';

const ORIGIN = 'https://shamela.link';
const MCP = `${ORIGIN}/mcp`;
const META_URL = `${ORIGIN}/.well-known/oauth-authorization-server/api/auth`;
const FALLBACK = { authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`, token_endpoint: `${ORIGIN}/api/auth/oauth2/token`, registration_endpoint: `${ORIGIN}/api/auth/oauth2/register` };
const K_CLIENT = 'kr.shamelalink.client', K_TOKENS = 'kr.shamelalink.tokens', K_FLOW = 'kr.shamelalink.flow';

interface Tokens { access: string; refresh?: string; exp: number }
interface Meta { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string }

export function redirectUri(): string { return nativePlatform() === 'web' ? `${location.origin}${location.pathname}` : 'kurokawareader://oauth'; }
export function isConnected(): boolean { return !!tokens(); }
function tokens(): Tokens | null { try { return JSON.parse(localStorage.getItem(K_TOKENS) ?? 'null') as Tokens | null; } catch { return null; } }
export function disconnect(): void { localStorage.removeItem(K_TOKENS); session = null; }

async function metadata(): Promise<Meta> {
  try { const r = await http(META_URL, { headers: { accept: 'application/json' } }); if (r.status < 400) { const j = JSON.parse(r.body) as Partial<Meta>; if (j.authorization_endpoint && j.token_endpoint) return { ...FALLBACK, ...j } as Meta; } } catch { /* the published endpoints */ }
  return FALLBACK;
}
async function clientId(meta: Meta): Promise<string> {
  const uri = redirectUri();
  try { const c = JSON.parse(localStorage.getItem(K_CLIENT) ?? 'null') as { id: string; uri: string } | null; if (c?.id && c.uri === uri) return c.id; } catch { /* register */ }
  if (!meta.registration_endpoint) throw new SourceError('no registration', 'auth');
  const r = await http(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: 'KurokawaReader', redirect_uris: [uri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'openid offline_access' }) });
  if (r.status >= 400) throw new SourceError(`register ${r.status}`, 'auth', r.status);
  const j = JSON.parse(r.body) as { client_id?: string };
  if (!j.client_id) throw new SourceError('register', 'auth');
  localStorage.setItem(K_CLIENT, JSON.stringify({ id: j.client_id, uri }));
  return j.client_id;
}
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256(s: string): Promise<string> { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }

/** Begin the sign-in: the browser opens the service's page; the redirect comes back to `finishSignIn`. */
export async function connect(): Promise<void> {
  const meta = await metadata();
  const id = await clientId(meta);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = `shamela:${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  localStorage.setItem(K_FLOW, JSON.stringify({ verifier, state, token: meta.token_endpoint, id }));
  const url = `${meta.authorization_endpoint}?response_type=code&client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(redirectUri())}&scope=${encodeURIComponent('openid offline_access')}&state=${encodeURIComponent(state)}&code_challenge=${await sha256(verifier)}&code_challenge_method=S256&resource=${encodeURIComponent(MCP)}`;
  window.open(url, '_blank', 'noopener');
}
/** Is this redirect ours? */
export function isOurRedirect(url: string): boolean { try { return (new URL(url.replace(/^kurokawareader:\/\//, 'https://x/')).searchParams.get('state') ?? '').startsWith('shamela:'); } catch { return false; } }
/** The redirect back from the sign-in: the code becomes the tokens. */
export async function finishSignIn(url: string): Promise<boolean> {
  const u = new URL(url.replace(/^kurokawareader:\/\//, 'https://x/'));
  const code = u.searchParams.get('code'), state = u.searchParams.get('state');
  const flow = JSON.parse(localStorage.getItem(K_FLOW) ?? 'null') as { verifier: string; state: string; token: string; id: string } | null;
  if (!code || !flow || state !== flow.state) return false;
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: flow.id, code_verifier: flow.verifier, resource: MCP }).toString();
  const r = await http(flow.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (r.status >= 400) throw new SourceError(`token ${r.status}`, 'auth', r.status);
  const j = JSON.parse(r.body) as { access_token: string; refresh_token?: string; expires_in?: number };
  localStorage.setItem(K_TOKENS, JSON.stringify({ access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 } satisfies Tokens));
  localStorage.removeItem(K_FLOW);
  return true;
}
async function accessToken(): Promise<string> {
  const t = tokens(); if (!t) throw new SourceError('auth', 'auth');
  if (Date.now() < t.exp - 30000) return t.access;
  if (!t.refresh) { disconnect(); throw new SourceError('auth', 'auth'); }
  const meta = await metadata(); const id = await clientId(meta);
  const r = await http(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: id, resource: MCP }).toString() });
  if (r.status >= 400) { disconnect(); throw new SourceError('auth', 'auth', r.status); }
  const j = JSON.parse(r.body) as { access_token: string; refresh_token?: string; expires_in?: number };
  const next: Tokens = { access: j.access_token, refresh: j.refresh_token ?? t.refresh, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  localStorage.setItem(K_TOKENS, JSON.stringify(next));
  return next.access;
}

/* ---------- the MCP session ---------- */
let session: { id?: string; ready: Promise<void> } | null = null;
let seq = 1;
interface RpcResult { result?: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }; error?: { code: number; message: string } }

async function rpc(method: string, params: unknown, token: string, sid?: string): Promise<{ json: RpcResult | null; sid?: string; status: number }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
  if (sid) headers['mcp-session-id'] = sid;
  const id = method.startsWith('notifications/') ? undefined : seq++;
  const r = await http(MCP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
  const newSid = r.headers['mcp-session-id'];
  if (r.status === 401) { disconnect(); throw new SourceError('auth', 'auth', 401); }
  if (r.status === 429) throw new SourceError('rate', 'rate', 429);
  if (r.status >= 400) throw new SourceError(`MCP ${r.status}`, 'http', r.status);
  if (!id) return { json: null, sid: newSid, status: r.status };
  const body = r.body.trim();
  // A reply as JSON, or as an event stream whose data lines hold the JSON.
  if (body.startsWith('{')) return { json: JSON.parse(body) as RpcResult, sid: newSid, status: r.status };
  for (const line of body.split('\n')) if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5).trim()) as RpcResult & { id?: number }; if (j.id === id || j.result || j.error) return { json: j, sid: newSid, status: r.status }; } catch { /* next */ } }
  throw new SourceError('parse', 'parse');
}
async function ensureSession(token: string): Promise<string | undefined> {
  if (!session) {
    const s: { id?: string; ready: Promise<void> } = { ready: Promise.resolve() };
    s.ready = (async () => {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'KurokawaReader', version: '1' } }, token);
      s.id = init.sid;
      await rpc('notifications/initialized', {}, token, s.id).catch(() => undefined);
    })();
    session = s;
  }
  await session.ready;
  return session.id;
}
/** Call a tool; the structured result when the server gives one, else the text. */
export async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const token = await accessToken();
  let sid = await ensureSession(token);
  let r = await rpc('tools/call', { name, arguments: { response_format: 'json', ...args } }, token, sid);
  // (A session the server forgot: begin another.)
  if (r.json?.error && /session/i.test(r.json.error.message)) { session = null; sid = await ensureSession(token); r = await rpc('tools/call', { name, arguments: { response_format: 'json', ...args } }, token, sid); }
  if (r.json?.error) throw new SourceError(r.json.error.message, 'http');
  const res = r.json?.result;
  if (!res) throw new SourceError('parse', 'parse');
  if (res.structuredContent !== undefined) return res.structuredContent as T;
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  if (res.isError) throw new SourceError(text || 'error', 'http');
  const m = /```json\s*([\s\S]*?)```/.exec(text);
  try { return JSON.parse(m ? m[1] : text) as T; } catch { return text as unknown as T; }
}

/* ---------- what the sources ask for ---------- */
export interface Hit { book_id: number; book_name: string; author_name?: string; category?: string; page_id: number; printed_page?: string; snippet_body?: string; snippet_foot?: string }
export interface SearchResult { total_hits: number; has_more: boolean; next_offset?: number; results: Hit[]; coverage?: { by_category?: Record<string, number>; by_century?: Record<string, number>; by_book?: Record<string, number>; by_author?: Record<string, number> } }
export type Scope = { book_ids?: number[]; author_ids?: number[]; category_ids?: number[]; period_from?: number; period_to?: number };
export function searchPages(query: string, o: { scope?: Scope; offset?: number; limit?: number; morphology?: boolean; wildcards?: boolean; titles?: boolean; phrase?: boolean } = {}): Promise<SearchResult> {
  const tool = o.titles ? 'shamela_search_titles' : o.phrase ? 'shamela_search_phrase' : 'shamela_search_pages';
  const args: Record<string, unknown> = { query, limit: o.limit ?? 20, offset: o.offset ?? 0 };
  if (o.scope && Object.keys(o.scope).length) args.scope = o.scope;
  if (o.morphology || o.wildcards) args.options = { morphology: !!o.morphology, wildcards: !!o.wildcards && !o.morphology };
  return callTool<SearchResult>(tool, args);
}
export interface BookHit { book_id: number; book_name: string; author_name?: string; category?: string; book_date?: number; snippet?: string }
export function searchBooks(query: string, o: { scope?: Scope; offset?: number; limit?: number } = {}): Promise<{ results: BookHit[]; has_more: boolean; total_hits?: number }> {
  const args: Record<string, unknown> = { query, limit: o.limit ?? 30, offset: o.offset ?? 0 };
  if (o.scope && Object.keys(o.scope).length) args.scope = o.scope;
  return callTool('shamela_search_books', args);
}
export function listCategories(): Promise<{ categories?: { id: number; name: string; book_count?: number }[] } | { id: number; name: string }[]> { return callTool('shamela_list_categories', {}); }
