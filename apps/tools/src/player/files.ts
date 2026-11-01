// Local files for the player: a URL the <video> can read (the desktop's file://, the phone's stream server),
// and the files beside a video (subtitles of the same name).
import { ktPlugin } from '../native';
type Desk = { fileUrl?(p: string): Promise<string>; siblings?(p: string): Promise<string[]> };
type Plug = { localUrl?(o: { path: string }): Promise<{ url: string }>; siblings?(o: { path: string }): Promise<{ paths: string[] }> };
export async function localFileUrl(path: string): Promise<string | null> {
  const d = window.kurokawaTools as unknown as Desk | undefined; if (d?.fileUrl) return d.fileUrl(path);
  const p = ktPlugin() as unknown as Plug | null; if (p?.localUrl) return (await p.localUrl({ path })).url;
  return null;
}
export async function siblingFiles(path: string): Promise<string[]> {
  const d = window.kurokawaTools as unknown as Desk | undefined; if (d?.siblings) return (await d.siblings(path).catch(() => [])) ?? [];
  const p = ktPlugin() as unknown as Plug | null; if (p?.siblings) return (await p.siblings({ path }).catch(() => ({ paths: [] }))).paths ?? [];
  return [];
}
/** A local file's bytes: through the desktop bridge, or fetched from the phone's stream server. */
export async function readLocal(path: string): Promise<Uint8Array | null> {
  const d = window.kurokawaTools as (typeof window.kurokawaTools & { readFile?(p: string): Promise<ArrayBuffer> }) | undefined;
  if (d?.readFile) { try { return new Uint8Array(await d.readFile(path)); } catch { return null; } }
  const u = await localFileUrl(path); if (!u) return null; try { const r = await fetch(u); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; }
}
