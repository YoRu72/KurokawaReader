// Prism's connection settings, for every file download: the name the app gives servers (its own, a browser's, or
// one of the user's), how many times a chunk is tried again, how long to wait for a server, a proxy, and what to do
// when a file of that name is there already. Kept in Settings; the engine (the phone's, or aria2 on a computer)
// is told at start and on each change.
import { getSettings } from '../settings';
import { ktPlugin } from '../native';

export type Conflict = 'rename' | 'overwrite' | 'skip';
export interface NetPrefs { uaMode: 'app' | 'browser' | 'custom'; ua: string; retries: number; timeout: number; proxy: string; conflict: Conflict }
export const NET_DEFAULT: NetPrefs = { uaMode: 'app', ua: '', retries: 5, timeout: 60, proxy: '', conflict: 'rename' };
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const netPrefs = (): NetPrefs => ({ ...NET_DEFAULT, ...(getSettings().net ?? {}) });

/** What the engine is told: the name resolved, the numbers kept in range. */
export function engineNet(p = netPrefs()): { ua: string; retries: number; timeout: number; proxy: string; conflict: Conflict } {
  const ua = p.uaMode === 'browser' ? BROWSER_UA : p.uaMode === 'custom' ? p.ua.trim() : '';
  return { ua, retries: Math.max(0, Math.min(30, Math.round(p.retries))), timeout: Math.max(5, Math.min(600, Math.round(p.timeout))), proxy: validProxy(p.proxy) ? p.proxy.trim() : '', conflict: p.conflict };
}
/** «http://host:port», «socks5://host:port», «host:port» — or empty. */
export const validProxy = (s: string): boolean => !s.trim() || /^((https?|socks[45]h?):\/\/)?(\[[0-9a-f:]+\]|[\w.-]+):\d{1,5}\/?$/i.test(s.trim());

export async function applyNet(p = netPrefs()): Promise<void> {
  const net = engineNet(p);
  try { const d = window.kurokawaTools as unknown as { configure?(o: Record<string, unknown>): Promise<void> } | undefined; if (d?.configure) await d.configure({ net }); else { const { getSettings } = await import('../settings'); await ktPlugin()?.configure({ net, connBudget: getSettings().connBudget ?? 24 } as never); } } catch { /* the engine is not up yet */ }
}
/** Whether files are there (the computer or the phone); undefined where it cannot be asked. */
export async function existing(paths: string[]): Promise<boolean[] | undefined> {
  const d = window.kurokawaTools as unknown as { exists?(p: string[]): Promise<boolean[]> } | undefined; if (d?.exists) return d.exists(paths);
  const p = ktPlugin() as unknown as { exists?(o: { paths: string[] }): Promise<{ exists: boolean[] }> } | null; if (p?.exists) return (await p.exists({ paths })).exists;
  return undefined;
}
