// A subtitle that came packed — a .zip from a subtitle site (one file, or a season's worth), or a .gz — opened in
// the page itself: its subtitle files, the one for this episode first. Anything else is given back as it came.
import { zipEntries, zipRead } from '../ipa/zip';

export interface SubFile { name: string; bytes: Uint8Array }
const SUB = /\.(srt|ass|ssa|vtt|sub)$/i;

export const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The subtitle files in what was fetched or picked; `episode` puts that episode's first. Empty for a pack with
 *  none in it; the same bytes back for a plain subtitle. */
export async function unpackSubtitle(name: string, bytes: Uint8Array, episode?: number): Promise<SubFile[]> {
  if (isGzip(bytes)) return unpackSubtitle(name.replace(/\.gz$/i, ''), await gunzip(bytes), episode);
  if (!isZip(bytes)) return [{ name, bytes }];
  const blob = new Blob([bytes as BlobPart]);
  const subs = (await zipEntries(blob)).filter((e) => SUB.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name) && e.usize < 20e6);
  const { parseFilename } = await import('../anime/anitomy');
  const base = (n: string) => n.split('/').pop() ?? n;
  const rank = (n: string) => { const ep = parseFilename(base(n)).episode; return (episode !== undefined && ep === episode ? 10 : 0) + (/\.ass$/i.test(n) ? 1 : 0); };
  subs.sort((a, b) => rank(b.name) - rank(a.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out: SubFile[] = [];
  for (const e of subs.slice(0, 40)) { try { out.push({ name: base(e.name), bytes: await zipRead(blob, e) }); } catch { /* one unreadable */ } }
  return out;
}
