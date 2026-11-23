// The repository's catalogues (repo/tools/index.json, repo/themes/themes.json, repo/scenes/scenes.json): one way to
// read them. Each is fetched with the browser's own revalidation (`cache: 'no-cache'`: the stored ETag is sent back
// as If-None-Match where the host gave one, and a 304 costs nothing) and its bytes hashed — a change is known by
// the content's SHA-256, whatever the host's headers say. The last good copy is kept in IndexedDB; a failure backs
// off (1 min, doubling, at most 6 h) and the kept copy is answered instead; nothing here throws to the page.
import { addonUrl } from './repo';
import { db } from './db';

export interface Kept { text: string; hash: string; etag?: string; at: number }
export interface CatalogResult<T> {
  /** The catalogue (fresh or kept); null when it was never read and cannot be now. */
  data: T | null;
  /** Read from the repository just now (false: the kept copy). */
  fresh: boolean;
  /** The content differs from the copy kept before. */
  changed: boolean;
  /** When the copy answered was read. */
  at: number;
  /** Why the repository was not read (offline, HTTP 404, unreadable, backing off). */
  error?: string;
}
interface State { fails: number; next: number }

const KEY = (path: string) => `catalog:${path}`;
const back = new Map<string, State>();
const flights = new Map<string, Promise<CatalogResult<unknown>>>();
const MAX_BACKOFF = 6 * 3600_000;

export async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
/** Bytes from the repository (the page's fetch; a phone's request layer when the page's own is refused). */
export async function repoBytes(path: string, opts: { revalidate?: boolean } = {}): Promise<{ bytes: Uint8Array; etag?: string }> {
  const url = addonUrl(path);
  let r: Response;
  try { r = await fetch(url, { cache: opts.revalidate ? 'no-cache' : 'no-store' }); }
  catch (e) {
    const { request } = await import('./http');
    const x = await request(url, { binary: true }).catch(() => { throw e; });
    if (x.status !== 200) throw new Error(`HTTP ${x.status}`);
    const bin = atob(x.body); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { bytes: out };
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get('etag') ?? undefined };
}
async function kept(path: string): Promise<Kept | undefined> { try { return await db.getMeta<Kept>(KEY(path)); } catch { return undefined; } }

/** A catalogue read (or its kept copy). `check` validates the parsed JSON (throws on a shape it does not know);
 *  `auto`: the background checker's read, which keeps to the back-off (a reader's own action — «Check now», opening
 *  a list, «Try again» — always asks); `offlineOnly` answers the kept copy without asking. */
export async function readCatalog<T>(path: string, check: (x: unknown) => T, o: { auto?: boolean; offlineOnly?: boolean } = {}): Promise<CatalogResult<T>> {
  const had = await kept(path);
  const fromKept = (error?: string): CatalogResult<T> => {
    if (!had) return { data: null, fresh: false, changed: false, at: 0, error };
    try { return { data: check(JSON.parse(had.text)), fresh: false, changed: false, at: had.at, error }; } catch { return { data: null, fresh: false, changed: false, at: 0, error: error ?? 'kept copy unreadable' }; }
  };
  if (o.offlineOnly) return fromKept();
  const st = back.get(path);
  if (o.auto && st && Date.now() < st.next) return fromKept('backing off');
  const run = flights.get(path); if (run) return run as Promise<CatalogResult<T>>;
  const p = (async (): Promise<CatalogResult<T>> => {
    try {
      const { bytes, etag } = await repoBytes(path, { revalidate: true });
      const hash = await sha256Hex(bytes); const text = new TextDecoder().decode(bytes);
      let data: T; try { data = check(JSON.parse(text)); } catch (e) { throw new Error(`unreadable: ${String((e as Error)?.message ?? e)}`); }
      back.delete(path);
      const changed = !had || had.hash !== hash; const at = Date.now();
      await db.setMeta<Kept>(KEY(path), { text, hash, etag, at }).catch(() => undefined);
      return { data, fresh: true, changed, at };
    } catch (e) {
      const s = back.get(path) ?? { fails: 0, next: 0 }; s.fails++; s.next = Date.now() + Math.min(MAX_BACKOFF, 60_000 * 2 ** (s.fails - 1)); back.set(path, s);
      return fromKept(String((e as Error)?.message ?? e));
    } finally { flights.delete(path); }
  })();
  flights.set(path, p as Promise<CatalogResult<unknown>>);
  return p;
}
/** The back-off forgotten (a test, or the connection back). */
export const resetBackoff = (): void => { back.clear(); };
