// PDF → Word, «Fonts: in a folder»: the PDF's own fonts as files that install on their own (they were only ever read
// by Word from inside the .docx), and the names they go by. Loaded by the converter only when a folder is asked for.
import { readSfnt, cmapGlyphs, writeSfnt, unitsPerEm, type Sfnt } from './fontbuild';
import type { FolderFont } from './fontfolder';

const CLASSIC = ['Regular', 'Bold', 'Italic', 'Bold Italic'];
const dv = (a: Uint8Array) => new DataView(a.buffer, a.byteOffset, a.byteLength);

/** Fonts a computer has already (or Word's own stand-ins for): a font written for a folder never goes by one of these
 *  names, or installing it would cover the system's own. */
const SYSTEM_FONT = /^(Arial|Arial Black|Arial Narrow|Arial Unicode MS|Times New Roman|Times|Courier New|Courier|Helvetica( Neue)?|Calibri|Cambria|Cambria Math|Candara|Consolas|Constantia|Corbel|Georgia|Verdana|Tahoma|Trebuchet MS|Segoe UI|Garamond|Book Antiqua|Palatino( Linotype)?|Century( Gothic| Schoolbook)?|Gill Sans( MT)?|Lucida .*|Symbol|Wingdings.*|Webdings|Impact|Comic Sans MS|Monaco|Menlo|Geneva|Optima|Futura|Baskerville|Didot|Avenir|San Francisco|SF Pro.*|Traditional Arabic|Simplified Arabic|Arabic Typesetting|Sakkal Majalla|Andalus|Microsoft Sans Serif|Microsoft Uighur|Aldhabi|Urdu Typesetting|MS Mincho|MS Gothic|MS PGothic|MS PMincho|SimSun|SimHei|NSimSun|Microsoft YaHei|Malgun Gothic|Batang|Gulim|Meiryo|Yu Gothic|Yu Mincho|Liberation (Serif|Sans|Mono)|DejaVu (Serif|Sans|Sans Mono)|Noto .*|Roboto|Open Sans|Droid .*|Amiri|Cairo|Tajawal|Scheherazade.*|Lateef|Naskh.*)$/i;
/** The name a font goes by in the document and the folder: its own, unless a computer already has a font of that name
 *  (then «Times New Roman (PDF)»). `taken`: the names the document already uses. */
export function folderFamily(family: string, taken: Set<string>): string {
  if (!SYSTEM_FONT.test(family.trim())) return family;
  let name = `${family} (PDF)`; let n = 2;
  while (taken.has(name)) name = `${family} (PDF ${n++})`;
  return name;
}

const hash8 = (s: string): string => { let h = 0x811c9dc5; for (const ch of s) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };

/** The PostScript name: ASCII letters, digits and hyphens, 63 at most, and each its own (a font name in Arabic would
 *  otherwise have none). `taken`: the ones given already. */
export function postScriptName(family: string, style: string, taken: Set<string>): string {
  const stem = family.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || `KR${hash8(family)}`;
  const st = style.replace(/\s/g, '');
  let ps = `${stem}-${st}`; let n = 2;
  while (taken.has(ps)) ps = `${stem.slice(0, 30)}${hash8(family)}${n++}-${st}`.slice(0, 63);
  taken.add(ps); return ps;
}

const u16s = (s: string): number[] => { const a: number[] = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a.push(c >> 8, c & 255); } return a; };

/** A name table that stands alone: the family (1), its style (2), the unique name (3), the full name (4), the version
 *  (5) and the PostScript name (6), in the Windows records and — where the name is plain ASCII — the Mac's; the
 *  maker's notes the font came with (copyright, licence: 0 and 7–15) kept. */
function standaloneNames(old: Uint8Array | undefined, family: string, style: string, ps: string): Uint8Array {
  type Rec = { pid: number; eid: number; lang: number; id: number; b: number[] };
  const recs: Rec[] = [];
  const win = (id: number, s: string) => recs.push({ pid: 3, eid: 1, lang: 0x409, id, b: u16s(s) });
  const mac = (id: number, s: string) => { if (/^[\x20-\x7e]+$/.test(s)) recs.push({ pid: 1, eid: 0, lang: 0, id, b: [...s].map((c) => c.charCodeAt(0)) }); };
  const full = style === 'Regular' ? family : `${family} ${style}`;
  const set: [number, string][] = [[1, family], [2, style], [3, `${ps};Kurokawa`], [4, full], [5, 'Version 1.000'], [6, ps]];
  const kept: Rec[] = [];
  if (old && old.length >= 6) {
    try {
      const d = dv(old); const n = d.getUint16(2), so = d.getUint16(4);
      for (let i = 0; i < n; i++) {
        const r = 6 + i * 12; const pid = d.getUint16(r), id = d.getUint16(r + 6), len = d.getUint16(r + 8), off = d.getUint16(r + 10);
        if (pid !== 3 || !(id === 0 || (id >= 7 && id <= 15)) || so + off + len > old.length) continue;
        kept.push({ pid, eid: d.getUint16(r + 2), lang: d.getUint16(r + 4), id, b: [...old.subarray(so + off, so + off + len)] });
      }
    } catch { /* unreadable: no notes */ }
  }
  for (const [id, s] of set) { win(id, s); mac(id, s); }
  recs.push(...kept);
  recs.sort((a, b) => a.pid - b.pid || a.eid - b.eid || a.lang - b.lang || a.id - b.id);
  const head: number[] = []; const data: number[] = []; const u16 = (v: number) => head.push((v >> 8) & 255, v & 255);
  u16(0); u16(recs.length); u16(6 + recs.length * 12);
  for (const r of recs) { u16(r.pid); u16(r.eid); u16(r.lang); u16(r.id); u16(r.b.length); u16(data.length); for (const x of r.b) data.push(x); }
  return new Uint8Array([...head, ...data]);
}

/** A cmap the Windows lookups find: a (3,1) or (3,10) subtable. Where the font has Unicode maps under other
 *  platforms only, the same subtable is listed under (3,1) too. */
function windowsCmap(cm: Uint8Array): Uint8Array | null {
  try {
    const d = dv(cm); const n = d.getUint16(2);
    const recs: { pid: number; eid: number; off: number }[] = [];
    for (let i = 0; i < n; i++) recs.push({ pid: d.getUint16(4 + i * 8), eid: d.getUint16(6 + i * 8), off: d.getUint32(8 + i * 8) });
    if (recs.some((r) => r.pid === 3 && (r.eid === 1 || r.eid === 10 || r.eid === 0))) return cm;
    const uni = recs.find((r) => r.pid === 0 && [4, 12].includes(d.getUint16(r.off))) ?? recs.find((r) => r.pid === 0);
    if (!uni) return null;
    const out = new Uint8Array(cm.length + 8); const o = dv(out);
    o.setUint16(0, 0); o.setUint16(2, n + 1);
    const all = [...recs.map((r) => ({ ...r, off: r.off + 8 })), { pid: 3, eid: 1, off: uni.off + 8 }].sort((a, b) => a.pid - b.pid || a.eid - b.eid);
    all.forEach((r, i) => { o.setUint16(4 + i * 8, r.pid); o.setUint16(6 + i * 8, r.eid); o.setUint32(8 + i * 8, r.off); });
    out.set(cm.subarray(4 + n * 8), 4 + (n + 1) * 8);
    return out;
  } catch { return null; }
}

/** An OS/2 table for a font that has none (version 4), from its other tables. */
function makeOs2(sf: Sfnt, bold: boolean, italic: boolean): Uint8Array {
  const out = new Uint8Array(96); const d = dv(out);
  const upem = unitsPerEm(sf); const hh = sf.tables.get('hhea'); const head = sf.tables.get('head');
  const asc = hh ? dv(hh).getInt16(4) : Math.round(upem * 0.8), desc = hh ? dv(hh).getInt16(6) : -Math.round(upem * 0.2);
  const cs = [...cmapGlyphs(sf).keys()].filter((c) => c <= 0xffff);
  const hm = sf.tables.get('hmtx'); let avg = Math.round(upem / 2);
  if (hm && hh) { const n = dv(hh).getUint16(34); const ws: number[] = []; for (let i = 0; i < n && i * 4 + 2 <= hm.length; i++) { const w = dv(hm).getUint16(i * 4); if (w > 0) ws.push(w); } if (ws.length) avg = Math.round(ws.reduce((a, b) => a + b, 0) / ws.length); }
  const yMin = head ? dv(head).getInt16(38) : desc, yMax = head ? dv(head).getInt16(42) : asc;
  d.setUint16(0, 4); d.setInt16(2, avg); d.setUint16(4, bold ? 700 : 400); d.setUint16(6, 5); d.setUint16(8, 0);
  for (const [i, v] of [0.65, 0.6, 0, 0.075, 0.65, 0.6, 0, 0.48, 0.05, 0.25].entries()) d.setInt16(10 + i * 2, Math.round(upem * v));
  const latin = cs.some((c) => c >= 0x20 && c <= 0x7e), arabic = cs.some((c) => c >= 0x600 && c <= 0x6ff);
  d.setUint32(42, (latin ? 1 : 0) | (arabic ? 1 << 13 : 0)); d.setUint32(78, (latin ? 1 : 0) | (arabic ? 1 << 6 : 0));
  out.set([75, 82, 68, 82], 58); // 'KRDR'
  d.setUint16(62, (bold ? 0x20 : 0) | (italic ? 1 : 0) | (!bold && !italic ? 0x40 : 0));
  d.setUint16(64, cs.length ? Math.min(...cs) : 0x20); d.setUint16(66, cs.length ? Math.max(...cs) : 0x20);
  d.setInt16(68, asc); d.setInt16(70, desc); d.setInt16(72, 0);
  d.setUint16(74, Math.max(0, asc, yMax)); d.setUint16(76, Math.max(0, -desc, -yMin));
  d.setInt16(86, Math.round(upem * 0.5)); d.setInt16(88, Math.round(upem * 0.7)); d.setUint16(92, 0x20);
  return out;
}

/**
 * A PDF's font, rebuilt or carried for the document, as a font file that installs on its own: its name table (family,
 * style, full and PostScript names, a version) under the name the document asks for; the style links that make Word's
 * Bold and Italic buttons find the faces of one family (OS/2 weight and fsSelection, head macStyle; the table made
 * where the font came without one); the Windows cmap; `post` present; the signature that was over the old tables
 * gone. Null when the font cannot be read or lacks what any font needs (its outlines, metrics, character map).
 * (Every face is one of the four classic styles, so the typographic names — 16 and 17 — are never wanted.)
 */
export function standaloneFont(bytes: Uint8Array, family: string, style: string, ps: string): FolderFont | null {
  if (!CLASSIC.includes(style)) return null;
  const sf = readSfnt(bytes); if (!sf) return null;
  const t = sf.tables; const need = sf.cff ? ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'CFF '] : ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'glyf', 'loca'];
  if (need.some((k) => !t.get(k)?.length)) return null;
  const bold = style.includes('Bold'), italic = style.includes('Italic');
  const tables = new Map<string, Uint8Array>();
  for (const [k, v] of t) if (k !== 'DSIG' && k !== 'name') tables.set(k, v.slice());
  tables.set('name', standaloneNames(t.get('name'), family, style, ps));
  const cm = windowsCmap(tables.get('cmap')!); if (!cm) return null; tables.set('cmap', cm);
  const head = tables.get('head')!; if (head.length < 54) return null;
  const ms = (bold ? 1 : 0) | (italic ? 2 : 0); dv(head).setUint16(44, (dv(head).getUint16(44) & ~3) | ms);
  let os2 = tables.get('OS/2');
  if (!os2 || os2.length < 78) os2 = makeOs2(sf, bold, italic);
  else {
    os2 = os2.slice(); const d = dv(os2); d.setUint16(4, bold ? 700 : 400);
    // (Its embedding bits as the document carries it: a font whose maker forbids editing stays so; the others read as editable.)
    const ft = d.getUint16(8); if (!(ft === 0 || (ft & 0x0008) || (ft & 0x0006))) d.setUint16(8, (ft & 0x0300) | 0x0008);
    if (os2.length >= 64) { let f = d.getUint16(62); f &= ~(1 | 0x20 | 0x40); f |= (italic ? 1 : 0) | (bold ? 0x20 : 0) | (!bold && !italic ? 0x40 : 0); d.setUint16(62, f); }
  }
  tables.set('OS/2', os2);
  if (!tables.get('post') || tables.get('post')!.length < 32) { const p = new Uint8Array(32); dv(p).setUint32(0, 0x00030000); tables.set('post', p); }
  if (italic) { const p = tables.get('post')!; const d = dv(p); if (d.getInt32(4) === 0) d.setInt32(4, -12 * 65536); }
  return { family, style, ext: sf.cff ? 'otf' : 'ttf', data: writeSfnt(tables, sf.cff ? 0x4f54544f : 0x00010000) };
}
