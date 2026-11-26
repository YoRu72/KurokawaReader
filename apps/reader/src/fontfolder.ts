// PDF → Word, «Fonts: in a folder»: the hand-over of «a document and its fonts» as one result (light: no font code here;
// the files themselves are made by fontstandalone.ts, loaded by the converter).

export type FolderFont = { family: string; style: string; ext: 'ttf' | 'otf'; data: Uint8Array };
/** What a converted file is, where it is more than one file: the document, and the fonts that go beside it. */
export type WithFonts = { fonts?: FolderFont[] };

/** A file name every system takes: no path or reserved characters, no device names, no trailing dot or space. */
export function safeFileName(s: string, max = 100): string {
  // eslint-disable-next-line no-control-regex
  let n = s.normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/\s+/g, ' ').trim();
  n = [...n].slice(0, max).join('').replace(/[. ]+$/g, '').replace(/^\.+/, '');
  if (!n) n = 'font';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = `_${n}`;
  return n;
}
/** The files of a folder: `<Family>-<Style>.ttf`, one per face, the same bytes under one name written once. */
export function folderFiles(fonts: FolderFont[]): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = []; const seen = new Map<string, Uint8Array>();
  for (const f of fonts) {
    const base = `${safeFileName(f.family, 80)}-${f.style.replace(/\s/g, '')}`; let name = `${base}.${f.ext}`; let n = 2;
    for (;;) {
      const o = seen.get(name.toLowerCase());
      if (!o) break;
      if (o.length === f.data.length && o.every((v, i) => v === f.data[i])) { name = ''; break; }
      name = `${base} ${n++}.${f.ext}`;
    }
    if (!name) continue;
    seen.set(name.toLowerCase(), f.data); out.push({ name, data: f.data });
  }
  return out;
}

/** «<document name> fonts» — the folder's name, from the document's file name. */
export const folderName = (docName: string): string => `${safeFileName(docName.replace(/\.docx$/i, ''), 100)} fonts`;

/** How many files a result's folder holds (0: a plain document). */
export const fontCount = (out: WithFonts): number => (out.fonts?.length ? folderFiles(out.fonts).length : 0);

/** The name of the ZIP a document with fonts is saved under (the document's name, .zip). */
export const zipName = (docName: string): string => `${safeFileName(docName.replace(/\.docx$/i, ''), 100)}.zip`;

/** What is saved or shared of a result: a plain document as it is; a document with fonts, one ZIP (stored) holding
 *  the document and its fonts folder, named after the document. */
export async function resultFile(out: { blob: Blob; name: string } & WithFonts): Promise<{ blob: Blob; name: string }> {
  const files = out.fonts?.length ? folderFiles(out.fonts) : [];
  if (!files.length) return { blob: out.blob, name: out.name };
  const { zipWrite } = await import('./zipstore');
  const base = safeFileName(out.name.replace(/\.docx$/i, ''), 100); const dir = folderName(out.name);
  const blob = await zipWrite([{ name: `${base}.docx`, blob: out.blob, store: true }, ...files.map((f) => ({ name: `${dir}/${f.name}`, blob: f.data, store: true }))], { type: 'application/zip' });
  return { blob, name: zipName(out.name) };
}
