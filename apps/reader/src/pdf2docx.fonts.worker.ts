// The PDF → Word converter's font rebuilding (fontfix.ts buildFont), off the app's thread: a long Arabic book's
// fonts took seconds there, a second at a time with the screen frozen. The page (src/pdf2docx.ts buildDocFonts)
// sends each font's sources — the PDF's own font files, read again here exactly as there — and the lines its text
// sets, packed into flat arrays (a book's hundred thousand glyph uses cost nothing to send that way), and gets the
// font back. buildFont is a pure function of these: the font is the one the page would have built.
import { buildFont } from './fontfix';
import { unpackLines, type FontJob, type FontDone } from './fontpack';
import { readSfnt, glyphReader, verticalMetrics } from './fontbuild';

self.onmessage = (e: MessageEvent<FontJob>) => {
  const j = e.data; let built: Uint8Array | null = null; let error: string | undefined;
  try {
    const sources = j.datas.map((d) => { const sf = readSfnt(d)!; const r = glyphReader(sf); const vm = verticalMetrics(sf); return { outline: r.outline, upem: r.upem, asc: vm?.asc, desc: vm?.desc }; });
    built = buildFont(sources, unpackLines(j), j.meta, j.spaceGid);
  } catch (err) { error = String((err as Error)?.stack ?? err); }
  (self as unknown as Worker).postMessage({ id: j.id, built, error } satisfies FontDone, built && built.byteOffset === 0 && built.byteLength === built.buffer.byteLength ? [built.buffer as ArrayBuffer] : []);
};
