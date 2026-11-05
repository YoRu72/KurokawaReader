// Ranobe (ranobe.app — "every officially translated light novel, free to read"): a site, not a folder, with an
// account. Added by a word in the + sheet like OTL (its manifest {"kurokawa": "site", "site": "ranobe", url}),
// shown nowhere else. The reader signs in once (the site's own sign-in: better-auth's email form; the session
// cookie lives in the app's own jar from then on); then the site's search (its public endpoint), its browse page
// and a novel's page are read the way its own pages read them — a Next.js app, whose pages carry their data
// as "flight" JSON inside the HTML — and a volume is fetched as the EPUB the page links, or opened on the site.
// Nothing of the account is kept beyond the cookie the site set; the email is remembered to prefill the form.
import { request } from './http';
import { t, localDigits } from '../i18n';
import { SourceError, type Source, type SourceBook, type SourceDetails, type SourceFile, type SourcePage, type FilterValues, type SourceFilter, type SourceTag } from './types';
import type { Repo } from './repos';
import { h, icon, openSheet, toast } from '../ui/dom';

type Novel = { id: string | number; ranobedbId?: string | number; title: string; author?: string; cover?: string; image?: string; description?: string; synopsis?: string; volumes?: unknown; [k: string]: unknown };

const base = (repo: Repo): string => (repo.folder ?? repo.url).replace(/\/+$/, '');
const key = (repo: Repo, k: string) => `kr.ranobe.${repo.key}.${k}`;
export const signedIn = (repo: Repo): boolean => localStorage.getItem(key(repo, 'in')) === '1';
const emailOf = (repo: Repo) => localStorage.getItem(key(repo, 'email')) ?? '';
let cookie = '';   // (the session token, when the answer let us see it: sent along in case the jar did not keep it)

async function api<T>(repo: Repo, path: string, init: { method?: string; body?: unknown; quiet?: boolean } = {}): Promise<{ status: number; data: T | null; text: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { accept: 'application/json, text/html;q=0.8', referer: `${base(repo)}/` }; if (cookie) headers.cookie = cookie;
  const r = await request(`${base(repo)}${path}`, { method: init.method ?? 'GET', headers: init.body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, quiet: init.quiet ?? true, retries: 1 });
  const sc = r.headers['set-cookie']; if (sc) { const m = /(better-auth\.session_token=[^;]+)/.exec(sc) ?? /(__Secure-better-auth\.session_token=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
  let data: T | null = null; try { data = JSON.parse(r.body) as T; } catch { /* a page */ }
  return { status: r.status, data, text: r.body, headers: r.headers };
}

/* ---------- the account ---------- */
export async function signIn(repo: Repo, email: string, password: string): Promise<void> {
  const r = await api<{ user?: { email?: string }; token?: string; message?: string }>(repo, '/api/auth/sign-in/email', { method: 'POST', body: { email, password, rememberMe: true } });
  if (r.status >= 400 || !r.data?.user) throw new SourceError(r.data?.message || (r.status === 401 || r.status === 403 ? t('ranobeBadLogin') : `HTTP ${r.status}`), 'parse');
  try { localStorage.setItem(key(repo, 'in'), '1'); localStorage.setItem(key(repo, 'email'), email); } catch { /* none */ }
}
export async function signOut(repo: Repo): Promise<void> { try { await api(repo, '/api/auth/sign-out', { method: 'POST', body: {} }); } catch { /* gone anyway */ } cookie = ''; try { localStorage.removeItem(key(repo, 'in')); } catch { /* none */ } }
/** Whether the site still knows us (its session endpoint). */
export async function sessionAlive(repo: Repo): Promise<boolean> { try { const r = await api<{ user?: unknown } | null>(repo, '/api/auth/get-session'); return r.status < 400 && !!r.data && typeof r.data === 'object' && !!(r.data as { user?: unknown }).user; } catch { return false; } }
/** The sign-in sheet: the site's own form, in the app. Resolves true when signed in. */
export function signInSheet(repo: Repo): Promise<boolean> {
  return new Promise((res) => {
    let done = false; const sh = openSheet(t('ranobeSignIn'), t('cancel'), { onClose: () => { if (!done) res(false); } } as never);
    const email = h('input', { type: 'email', value: emailOf(repo), dir: 'ltr', autocapitalize: 'off', autocomplete: 'username', inputmode: 'email' }) as HTMLInputElement;
    const pass = h('input', { type: 'password', dir: 'ltr', autocomplete: 'current-password' }) as HTMLInputElement; const status = h('p', { class: 'hint' }, t('ranobeSignInHint'));
    sh.body.append(h('label', { class: 'field' }, h('span', null, t('ranobeEmail')), email), h('label', { class: 'field' }, h('span', null, t('ranobePassword')), pass), status);
    const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => { if (!email.value.trim() || !pass.value) return; go.disabled = true; status.textContent = t('ranobeSigningIn'); try { await signIn(repo, email.value.trim(), pass.value); done = true; sh.close(); toast(t('ranobeSignedIn')); res(true); } catch (e) { status.textContent = String((e as Error).message ?? e); go.disabled = false; } } }, icon('key'), t('ranobeSignIn'));
    sh.actions.append(go); setTimeout(() => (email.value ? pass : email).focus(), 60);
  });
}
async function ensureSignedIn(repo: Repo): Promise<void> {
  if (signedIn(repo)) return;
  const ok = await signInSheet(repo); if (!ok) throw new SourceError(t('ranobeNeedsAccount'), 'parse');
}

/* ---------- the site's pages: their flight data (Next.js) read for the records they carry ---------- */
/** Every JSON value a Next page pushes to its client, decoded; the objects among them flattened out. */
function flight(html: string): unknown[] {
  const out: unknown[] = []; const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g; let m: RegExpExecArray | null; let text = '';
  while ((m = re.exec(html))) { try { text += JSON.parse(`"${m[1]}"`); } catch { /* skip */ } }
  for (const line of text.split('\n')) { const i = line.indexOf(':'); if (i < 0) continue; const payload = line.slice(i + 1); if (!/^[[{]/.test(payload)) continue; try { out.push(JSON.parse(payload)); } catch { /* a reference line */ } }
  return out;
}
function* walk(v: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 12 || !v || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) yield* walk(x, depth + 1); return; }
  yield v as Record<string, unknown>; for (const x of Object.values(v as Record<string, unknown>)) yield* walk(x, depth + 1);
}
const isNovel = (o: Record<string, unknown>): o is Novel => typeof o.title === 'string' && (('ranobedbId' in o) || ('volumes' in o) || ('author' in o && 'id' in o));
/** The novels a page carries (its own props), in the order found, each once. */
function novelsIn(html: string): Novel[] { const seen = new Set<string>(); const out: Novel[] = []; for (const v of flight(html)) for (const o of walk(v)) if (isNovel(o)) { const id = String(o.ranobedbId ?? o.id); if (!seen.has(id)) { seen.add(id); out.push(o); } } return out; }

const imageUrl = (repo: Repo, u: unknown): string | undefined => { if (typeof u !== 'string' || !u) return undefined; if (/^https?:\/\//.test(u)) return u; if (u.startsWith('/api/images/') || u.startsWith('/')) return `${base(repo)}${u}`; return `${base(repo)}/api/images/${u}`; };
const card = (repo: Repo, n: Novel): SourceBook => ({ id: String(n.ranobedbId ?? n.id), title: n.title, author: typeof n.author === 'string' ? n.author : Array.isArray(n.author) ? (n.author as string[]).join(', ') : undefined, cover: imageUrl(repo, n.cover ?? n.image ?? n.coverUrl ?? n.imageUrl), badge: Array.isArray(n.volumes) ? t('volumesN', { n: localDigits(String(n.volumes.length)) }) : typeof n.volumes === 'number' ? t('volumesN', { n: localDigits(String(n.volumes)) }) : undefined, description: typeof n.description === 'string' ? n.description : typeof n.synopsis === 'string' ? n.synopsis : undefined, lang: 'en' });

/* ---------- the source ---------- */
export function ranobeSource(repo: Repo): Source {
  const srcId = `dir:${repo.key}`;
  const pageHtml = async (path: string): Promise<string> => {
    const r = await api<unknown>(repo, path);
    if (r.status === 401 || r.status === 403 || /\/auth\?/.test(r.headers.location ?? '') || /name="email"[\s\S]*name="password"/.test(r.text.slice(0, 60000)) && !/novel|volume/i.test(r.text.slice(0, 2000))) { try { localStorage.removeItem(key(repo, 'in')); } catch { /* none */ } await ensureSignedIn(repo); return (await api<unknown>(repo, path)).text; }
    if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, 'network');
    return r.text;
  };
  return {
    id: srcId, name: repo.name, lang: 'en', site: base(repo), needsApp: true,
    description: t('ranobeDesc'),
    filters: (): SourceFilter[] => [{ id: 'sort', label: t('sortBy'), kind: 'sort', value: 'title', options: [{ value: 'title', label: t('sortByTitle') }, { value: 'recent', label: t('sortByRecent') }] }],
    shelves: async (): Promise<SourceTag[]> => [{ id: 'browse', label: t('ranobeBrowse') }, { id: 'account', label: t('ranobeAccount') }],
    async status() {
      const on = signedIn(repo);
      return { text: on ? t('ranobeStatusIn', { email: emailOf(repo) }) : t('ranobeStatusOut'), action: { label: on ? t('ranobeSignOut') : t('ranobeSignIn'), run: async () => { if (on) { await signOut(repo); toast(t('ranobeSignedOut')); } else await signInSheet(repo); return true; } } };
    },
    async browse(q, _f: FilterValues, page, shelf): Promise<SourcePage> {
      const text = q.trim();
      if (text) {
        // (The site's own search endpoint — public — for the dropdown; its browse page takes the same query for a full list.)
        const r = await api<Novel[]>(repo, `/api/v1/novels/search?q=${encodeURIComponent(text)}&limit=50`);
        if (Array.isArray(r.data)) return { items: r.data.map((n) => card(repo, n)), hasMore: false, title: text };
        await ensureSignedIn(repo); const html = await pageHtml(`/browse?search=${encodeURIComponent(text)}&page=${page}`); const ns = novelsIn(html);
        return { items: ns.map((n) => card(repo, n)), hasMore: ns.length >= 20 };
      }
      await ensureSignedIn(repo);
      if (shelf === 'account') { const html = await pageHtml('/account'); const ns = novelsIn(html); return { items: ns.map((n) => card(repo, n)), hasMore: false, title: t('ranobeAccount'), empty: { text: t('ranobeAccountEmpty'), url: `${base(repo)}/account` } }; }
      const html = await pageHtml(`/browse?page=${page}`); const ns = novelsIn(html);
      return { items: ns.map((n) => card(repo, n)), hasMore: ns.length >= 20, title: t('ranobeBrowse'), empty: ns.length ? undefined : { text: t('ranobeNothingRead'), url: `${base(repo)}/browse` } };
    },
    async details(id): Promise<SourceDetails> {
      await ensureSignedIn(repo);
      const html = await pageHtml(`/novel/${encodeURIComponent(id)}`); const ns = novelsIn(html); const n = ns.find((x) => String(x.ranobedbId ?? x.id) === id) ?? ns[0];
      if (!n) throw new SourceError(t('ranobeNoNovel'), 'parse');
      const files: SourceFile[] = []; const meta: { label: string; value: string }[] = [];
      // (The volumes the page lists: each with the file it links — an EPUB when the site gives one — else its page on the site.)
      const vols = Array.isArray(n.volumes) ? (n.volumes as Record<string, unknown>[]) : [];
      vols.forEach((v, i) => {
        const vt = typeof v.title === 'string' ? v.title : t('volumeN', { n: localDigits(String(i + 1), 'prose') });
        const link = [v.epubUrl, v.epub, v.fileUrl, v.downloadUrl, v.file, v.url].find((x) => typeof x === 'string' && /\.epub(\?|$)/i.test(x as string)) as string | undefined;
        if (link) files.push({ id: String(v.id ?? i), label: vt, ext: 'epub', url: /^https?:\/\//.test(link) ? link : `${base(repo)}${link.startsWith('/') ? '' : '/'}${link}`, mime: 'application/epub+zip', name: `${n.title} - ${vt}.epub` });
        else meta.push({ label: vt, value: typeof v.releaseDate === 'string' ? v.releaseDate : typeof v.publisher === 'string' ? v.publisher : '' });
      });
      for (const k of ['publisher', 'status', 'originalTitle', 'illustrator', 'translator']) if (typeof n[k] === 'string' && n[k]) meta.push({ label: k, value: n[k] as string });
      return { ...card(repo, n), tags: [], files, meta, url: `${base(repo)}/novel/${encodeURIComponent(id)}`, raw: n };
    },
    downloadInfo: (file) => ({ url: file.url, headers: cookie ? { cookie } : undefined }),
  };
}
