// A Word document written straight as its XML parts — what PDF → DOCX needs of WordprocessingML and nothing
// more: paragraphs with their properties and runs, tables, pictures inline and anchored to the page, sections
// with their headers and footers, embedded fonts. The docx library built the same from objects and turned
// them to XML with a generic serializer, which for a book of a thousand pages took twenty seconds; strings
// appended take a fraction of one. The parts come out as JSZip entries so the finishing pass (fonts' other
// faces, settings) runs on them as before.

import type JSZip from 'jszip';

const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS_ALL = `xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" ${NS_W} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14 w15 wp14"`;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** Text made safe for XML: the five characters escaped, and the control characters XML cannot hold dropped. */

/**
 * A font's embedding permission (OS/2 fsType) made one an editable document's reader honours, when the font
 * allows embedding at all: old font makers (Fontographer…) wrote reserved bits there — "1" — which LibreOffice
 * reads as "not editable" and so leaves the font out, drawing the fallback's letters (a calligraphic heading
 * whose "K" draws «تصدير» shown as a plain K). Such a value becomes "editable embedding" (with its subsetting and
 * bitmap bits kept); one that is installable (0), editable, or restricted / print-only is left as it is.
 */
export function editableEmbedding(bytes: Uint8Array): Uint8Array {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0, n = dv.getUint16(4); i < n; i++) {
      const r = 12 + i * 16;
      if (bytes[r] !== 0x4f || bytes[r + 1] !== 0x53 || bytes[r + 2] !== 0x2f || bytes[r + 3] !== 0x32) continue; // 'OS/2'
      const at = dv.getUint32(r + 8) + 8;
      if (at + 2 > bytes.length) return bytes;
      const t = dv.getUint16(at);
      if (t === 0 || (t & 0x0008) || (t & 0x0006)) return bytes;
      dv.setUint16(at, (t & 0x0300) | 0x0008);
      return bytes;
    }
  } catch { /* not a font this reads: as it is */ }
  return bytes;
}

export function esc(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}
const att = (s: string) => esc(s);

export type Fonts = { ascii: string; hAnsi: string; cs: string; eastAsia: string };
const fontsXml = (f: Fonts | string) => (typeof f === 'string' ? `<w:rFonts w:ascii="${att(f)}" w:cs="${att(f)}" w:eastAsia="${att(f)}" w:hAnsi="${att(f)}"/>` : `<w:rFonts w:ascii="${att(f.ascii)}" w:cs="${att(f.cs)}" w:eastAsia="${att(f.eastAsia)}" w:hAnsi="${att(f.hAnsi)}"/>`);

/** A run's look (what docx's TextRun took). Sizes in half-points; `position` in half-points; `spacing` (letter
 *  spacing) in twips; `scale` a percentage. */
export type RunProps = { font?: Fonts | string; size?: number; bold?: boolean; italic?: boolean; color?: string; rtl?: boolean; scale?: number; spacing?: number; position?: number; superScript?: boolean; eastAsiaRun?: boolean };

export function rPr(p: RunProps): string {
  let x = '';
  if (p.font) x += fontsXml(p.font);
  if (p.bold !== undefined) x += p.bold ? '<w:b/><w:bCs/>' : '<w:b w:val="false"/><w:bCs w:val="false"/>';
  if (p.italic !== undefined) x += p.italic ? '<w:i/><w:iCs/>' : '<w:i w:val="false"/><w:iCs w:val="false"/>';
  if (p.color) x += `<w:color w:val="${att(p.color)}"/>`;
  if (p.spacing) x += `<w:spacing w:val="${Math.round(p.spacing)}"/>`;
  if (p.scale && p.scale !== 100) x += `<w:w w:val="${Math.round(p.scale)}"/>`;
  if (p.position) x += `<w:position w:val="${Math.round(p.position)}"/>`;
  if (p.size) x += `<w:sz w:val="${Math.round(p.size)}"/><w:szCs w:val="${Math.round(p.size)}"/>`;
  if (p.superScript) x += '<w:vertAlign w:val="superscript"/>';
  if (p.rtl) x += '<w:rtl/>';
  return x ? `<w:rPr>${x}</w:rPr>` : '';
}

/** A run of text: a line break before it when asked, a tab before it when asked, then the text. */
export function textRun(text: string, p: RunProps, opts: { br?: boolean; tab?: boolean } = {}): string {
  let inner = '';
  if (opts.br) inner += '<w:br/>';
  if (opts.tab) inner += '<w:tab/>';
  if (text) inner += `<w:t xml:space="preserve">${esc(text)}</w:t>`;
  return `<w:r>${rPr(p)}${inner}</w:r>`;
}
export const tabRun = (): string => '<w:r><w:tab/></w:r>';
export const columnBreak = (): string => '<w:r><w:br w:type="column"/></w:r>';
export const footnoteRef = (id: number): string => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;

export type Align = 'start' | 'end' | 'center' | 'both' | 'distribute' | 'left' | 'right';
export type Frame = { x: number; y: number; w: number; h: number; rule?: 'auto' | 'atLeast' | 'exact'; anchorLock?: boolean };
/** A paragraph's properties (twips throughout). */
export type ParaProps = {
  bidi?: boolean; widowControl?: boolean; align?: Align;
  indent?: { start?: number; end?: number; left?: number; right?: number; firstLine?: number; hanging?: number };
  spacing?: { before?: number; after?: number; line?: number; lineRule?: 'exact' | 'auto' | 'atLeast' };
  tabs?: { type: 'left' | 'right' | 'center'; pos: number }[];
  frame?: Frame;
  /** The paragraph mark's run properties. */
  mark?: RunProps;
  /** Section properties this paragraph carries (the last paragraph of a section that another follows). */
  sectPr?: string;
};

export function pPr(p: ParaProps): string {
  let x = '';
  if (p.frame) { const f = p.frame; x += `<w:framePr${f.anchorLock ? ' w:anchorLock="true"' : ''} w:w="${Math.round(f.w)}" w:h="${Math.round(f.h)}" w:x="${Math.round(f.x)}" w:y="${Math.round(f.y)}" w:hAnchor="page" w:vAnchor="page" w:hRule="${f.rule ?? 'auto'}" w:wrap="none"/>`; }
  if (p.widowControl === false) x += '<w:widowControl w:val="false"/>';
  if (p.bidi) x += '<w:bidi/>';
  if (p.spacing) { const s = p.spacing; x += `<w:spacing${s.after !== undefined ? ` w:after="${Math.round(s.after)}"` : ''}${s.before !== undefined ? ` w:before="${Math.round(s.before)}"` : ''}${s.line !== undefined ? ` w:line="${Math.round(s.line)}"` : ''}${s.lineRule ? ` w:lineRule="${s.lineRule}"` : ''}/>`; }
  if (p.indent) { const i = p.indent; x += `<w:ind${i.start !== undefined ? ` w:start="${Math.round(i.start)}"` : ''}${i.end !== undefined ? ` w:end="${Math.round(i.end)}"` : ''}${i.left !== undefined ? ` w:left="${Math.round(i.left)}"` : ''}${i.right !== undefined ? ` w:right="${Math.round(i.right)}"` : ''}${i.firstLine !== undefined ? ` w:firstLine="${Math.round(i.firstLine)}"` : ''}${i.hanging !== undefined ? ` w:hanging="${Math.round(i.hanging)}"` : ''}/>`; }
  if (p.align) x += `<w:jc w:val="${p.align}"/>`;
  if (p.tabs?.length) x += `<w:tabs>${p.tabs.map((t) => `<w:tab w:val="${t.type}" w:pos="${Math.round(t.pos)}"/>`).join('')}</w:tabs>`;
  if (p.sectPr) x += p.sectPr;
  if (p.mark) x += rPr(p.mark);
  return x ? `<w:pPr>${x}</w:pPr>` : '';
}
export const paragraph = (p: ParaProps, children: string): string => `<w:p>${pPr(p)}${children}</w:p>`;

/* ---------- tables ---------- */

export type Border = { style: 'none' | 'single'; size: number; color: string };
export type CellProps = { width: number; span?: number; vMerge?: 'restart' | 'continue'; vAlign?: 'top' | 'center' | 'bottom'; fill?: string; margins?: { top: number; bottom: number; left: number; right: number } };
export type TableProps = { width: number; columns: number[]; indent?: number; rtl?: boolean; borders: Border; layoutFixed?: boolean };
export type RowProps = { height?: { value: number; rule: 'atLeast' | 'exact' | 'auto' } };

const borderXml = (name: string, b: Border) => `<w:${name} w:val="${b.style}" w:color="${att(b.color)}" w:sz="${b.size}"/>`;
export function table(p: TableProps, rows: string): string {
  const b = p.borders;
  const borders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((n) => borderXml(n, b)).join('')}</w:tblBorders>`;
  return `<w:tbl><w:tblPr>${p.rtl ? '<w:bidiVisual/>' : ''}<w:tblW w:type="dxa" w:w="${Math.round(p.width)}"/>${p.indent !== undefined ? `<w:tblInd w:type="dxa" w:w="${Math.round(p.indent)}"/>` : ''}${borders}${p.layoutFixed !== false ? '<w:tblLayout w:type="fixed"/>' : ''}</w:tblPr><w:tblGrid>${p.columns.map((w) => `<w:gridCol w:w="${Math.round(w)}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}
export const tableRow = (p: RowProps, cells: string): string => `<w:tr>${p.height ? `<w:trPr><w:trHeight w:val="${Math.round(p.height.value)}" w:hRule="${p.height.rule}"/></w:trPr>` : ''}${cells}</w:tr>`;
export function tableCell(p: CellProps, content: string): string {
  let x = `<w:tcW w:type="dxa" w:w="${Math.round(p.width)}"/>`;
  if (p.span && p.span > 1) x += `<w:gridSpan w:val="${p.span}"/>`;
  if (p.vMerge) x += p.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
  if (p.fill) x += `<w:shd w:val="clear" w:color="auto" w:fill="${att(p.fill)}"/>`;
  if (p.margins) { const m = p.margins; x += `<w:tcMar><w:top w:type="dxa" w:w="${Math.round(m.top)}"/><w:left w:type="dxa" w:w="${Math.round(m.left)}"/><w:bottom w:type="dxa" w:w="${Math.round(m.bottom)}"/><w:right w:type="dxa" w:w="${Math.round(m.right)}"/></w:tcMar>`; }
  if (p.vAlign) x += `<w:vAlign w:val="${p.vAlign}"/>`;
  // (A cell holds a paragraph at least.)
  return `<w:tc><w:tcPr>${x}</w:tcPr>${content || '<w:p/>'}</w:tc>`;
}

/* ---------- pictures ---------- */

/** A part of the package that holds paragraphs: the document's body, a header, a footer, the footnotes. Each
 *  keeps its own pictures (relationships are per part). */
export class Part {
  readonly rels: { id: string; type: string; target: string }[] = [];
  readonly images: { name: string; data: Uint8Array }[] = [];
  constructor(readonly doc: DocxWriter) {}
  /** A picture filed under the part: its relationship id for the drawing. */
  image(data: Uint8Array, kind: 'png' | 'jpg'): string {
    const name = `${this.doc.mediaName(data, kind)}`;
    const had = this.rels.find((r) => r.target === `media/${name}`);
    if (had) return had.id;
    const id = `rId${this.doc.nextRel++}`;
    this.rels.push({ id, type: R_IMAGE, target: `media/${name}` });
    this.doc.media.set(name, data);
    return id;
  }
  relsXml(): string { return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${this.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${att(r.target)}"/>`).join('')}</Relationships>`; }
}

const EMU_PX = 9525; // EMU per CSS pixel (96 dpi)
function picXml(rId: string, cx: number, cy: number, id: number): string {
  return `<wp:docPr id="${id}" name="" descr="" title=""/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="" descr=""/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}" cstate="none"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
}
/** A picture in the line, `w`×`h` CSS pixels. */
export function inlineImage(part: Part, data: Uint8Array, kind: 'png' | 'jpg', w: number, h: number): string {
  const rId = part.image(data, kind); const cx = Math.round(w * EMU_PX), cy = Math.round(h * EMU_PX);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent t="0" r="0" b="0" l="0"/>${picXml(rId, cx, cy, part.doc.nextDrawing++)}</wp:inline></w:drawing></w:r>`;
}
/** A picture behind the text at a place on the page (EMU offsets from the page's corner), `w`×`h` CSS pixels. */
export function anchoredImage(part: Part, data: Uint8Array, kind: 'png' | 'jpg', w: number, h: number, xEmu: number, yEmu: number, z: number): string {
  const rId = part.image(data, kind); const cx = Math.round(w * EMU_PX), cy = Math.round(h * EMU_PX);
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" allowOverlap="1" behindDoc="1" locked="1" layoutInCell="1" relativeHeight="${z}"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(xEmu)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(yEmu)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent t="0" r="0" b="0" l="0"/><wp:wrapNone/>${picXml(rId, cx, cy, part.doc.nextDrawing++)}</wp:anchor></w:drawing></w:r>`;
}

/* ---------- sections ---------- */

export type PageSetup = { width: number; height: number; margin: { top: number; right: number; bottom: number; left: number; header: number; footer: number; gutter?: number }; textDirection?: 'tbRl' };
export type Columns = { space: number; widths: number[] };
export type Section = {
  type: 'nextPage' | 'continuous'; page: PageSetup; columns?: Columns;
  /** The header's and footer's paragraphs (their own parts). */
  header?: { xml: string; part: Part }; footer?: { xml: string; part: Part };
  children: string[];
};

/* ---------- the document ---------- */

export type EmbeddedFont = { name: string; data: Uint8Array; arabic?: boolean };

export class DocxWriter {
  nextRel = 100; nextDrawing = 1;
  readonly media = new Map<string, Uint8Array>();
  readonly body = new Part(this);
  constructor(readonly opts: { title?: string; creator?: string; rtl: boolean; defaultFont: Fonts | string }) {}
  newPart(): Part { return new Part(this); }
  mediaName(data: Uint8Array, kind: 'png' | 'jpg'): string {
    // (Named by a quick hash of the bytes, so one picture used twice is filed once.)
    let h = 0x811c9dc5; const step = (i: number) => { h ^= data[i]; h = Math.imul(h, 0x01000193); };
    for (let i = 0; i < Math.min(2048, data.length); i++) step(i);
    for (let i = Math.max(2048, data.length - 2048); i < data.length; i++) step(i);
    return `img${(h >>> 0).toString(16)}-${data.length}.${kind === 'jpg' ? 'jpeg' : 'png'}`;
  }

  private sectPrXml(s: Section, refs: { header?: string; footer?: string }): string {
    const pg = s.page; const m = pg.margin;
    let x = '<w:sectPr>';
    if (refs.header) x += `<w:headerReference w:type="default" r:id="${refs.header}"/>`;
    if (refs.footer) x += `<w:footerReference w:type="default" r:id="${refs.footer}"/>`;
    x += `<w:type w:val="${s.type}"/>`;
    x += `<w:pgSz w:w="${Math.round(pg.width)}" w:h="${Math.round(pg.height)}" w:orient="${pg.width > pg.height ? 'landscape' : 'portrait'}"/>`;
    x += `<w:pgMar w:top="${Math.round(m.top)}" w:right="${Math.round(m.right)}" w:bottom="${Math.round(m.bottom)}" w:left="${Math.round(m.left)}" w:header="${Math.round(m.header)}" w:footer="${Math.round(m.footer)}" w:gutter="${Math.round(m.gutter ?? 0)}"/>`;
    if (s.columns) { const c = s.columns; x += `<w:cols w:space="${Math.round(c.space)}" w:num="${c.widths.length}" w:equalWidth="false">${c.widths.map((w, i) => `<w:col w:w="${Math.round(w)}"${i < c.widths.length - 1 ? ` w:space="${Math.round(c.space)}"` : ''}/>`).join('')}</w:cols>`; }
    x += '<w:pgNumType/><w:docGrid w:linePitch="360"/>';
    if (pg.textDirection) x += `<w:textDirection w:val="${pg.textDirection}"/>`;
    x += '</w:sectPr>';
    return x;
  }

  /** The package as a JSZip (its parts and pictures in place), ready for the finishing pass and the zip. */
  async pack(sections: Section[], fonts: EmbeddedFont[] = []): Promise<JSZip> {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const parts: { name: string; xml: string; part: Part; kind: 'header' | 'footer' }[] = [];
    const bodyRels: { id: string; type: string; target: string }[] = [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', target: 'styles.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', target: 'settings.xml' },
      { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable', target: 'fontTable.xml' },
    ];
    const out: string[] = [];
    sections.forEach((s, i) => {
      const refs: { header?: string; footer?: string } = {};
      if (s.header) { const n = parts.filter((p) => p.kind === 'header').length + 1; const id = `rIdH${n}`; parts.push({ name: `header${n}.xml`, xml: s.header.xml, part: s.header.part, kind: 'header' }); bodyRels.push({ id, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header', target: `header${n}.xml` }); refs.header = id; }
      if (s.footer) { const n = parts.filter((p) => p.kind === 'footer').length + 1; const id = `rIdF${n}`; parts.push({ name: `footer${n}.xml`, xml: s.footer.xml, part: s.footer.part, kind: 'footer' }); bodyRels.push({ id, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', target: `footer${n}.xml` }); refs.footer = id; }
      const sect = this.sectPrXml(s, refs);
      out.push(...s.children);
      // (The section's properties ride in a paragraph of their own at its end, as Word writes them; the last
      // section's close the body.)
      if (i < sections.length - 1) out.push(`<w:p><w:pPr>${sect}</w:pPr></w:p>`); else out.push(sect);
    });
    const docXml = `${XML_HEAD}<w:document ${NS_ALL}><w:body>${out.join('')}</w:body></w:document>`;
    zip.file('word/document.xml', docXml);
    for (const r of this.body.rels) bodyRels.push(r);
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${bodyRels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${att(r.target)}"/>`).join('')}</Relationships>`);
    for (const p of parts) {
      const tag = p.kind === 'header' ? 'w:hdr' : 'w:ftr';
      zip.file(`word/${p.name}`, `${XML_HEAD}<${tag} ${NS_ALL}>${p.xml || '<w:p/>'}</${tag}>`);
      if (p.part.rels.length) zip.file(`word/_rels/${p.name}.rels`, p.part.relsXml());
    }
    for (const [name, data] of this.media) zip.file(`word/media/${name}`, data);
    // Styles: the document's default run and paragraph, and a Normal style.
    const df = this.opts.defaultFont;
    zip.file('word/styles.xml', `${XML_HEAD}<w:styles xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ${NS_W} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" mc:Ignorable="w14 w15"><w:docDefaults><w:rPrDefault><w:rPr>${fontsXml(df)}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`);
    zip.file('word/settings.xml', `${XML_HEAD}<w:settings ${NS_ALL}><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
    // Fonts carried in the file: each obfuscated as Word wants it (its first 32 bytes XORed with a key the
    // table names).
    const fontRels: string[] = [];
    let fontsXmlOut = '';
    fonts.forEach((f, i) => {
      const guid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      const key = `{${guid.slice(0, 8)}-${guid.slice(8, 12)}-${guid.slice(12, 16)}-${guid.slice(16, 20)}-${guid.slice(20)}}`;
      const kb = (guid.match(/../g) ?? []).map((h) => parseInt(h, 16)).reverse();
      const ob = editableEmbedding(f.data.slice()); for (let k = 0; k < 32 && k < ob.length; k++) ob[k] ^= kb[k % 16];
      const id = `rId${i + 1}`;
      zip.file(`word/fonts/font${i + 1}.odttf`, ob);
      fontRels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font${i + 1}.odttf"/>`);
      fontsXmlOut += `<w:font w:name="${att(f.name)}"><w:charset w:val="${f.arabic ? 'B2' : '00'}"/><w:family w:val="auto"/><w:pitch w:val="variable"/><w:sig w:usb0="00000000" w:usb1="00000000" w:usb2="00000000" w:usb3="00000000" w:csb0="00000000" w:csb1="00000000"/><w:embedRegular r:id="${id}" w:fontKey="${key}"/></w:font>`;
    });
    zip.file('word/fontTable.xml', `${XML_HEAD}<w:fonts xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ${NS_W} mc:Ignorable="w14 w15">${fontsXmlOut}</w:fonts>`);
    zip.file('word/_rels/fontTable.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${fontRels.join('')}</Relationships>`);
    // The package's own parts.
    const title = esc(this.opts.title ?? ''); const creator = esc(this.opts.creator ?? 'KurokawaReader'); const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    zip.file('docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${title}</dc:title><dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${creator}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
    zip.file('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${creator}</Application></Properties>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
    const overrides = [
      ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
      ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
      ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
      ['/word/fontTable.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'],
      ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
      ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
      ...parts.map((p) => [`/word/${p.name}`, `application/vnd.openxmlformats-officedocument.wordprocessingml.${p.kind}+xml`]),
    ];
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="image/png" Extension="png"/><Default ContentType="image/jpeg" Extension="jpeg"/><Default ContentType="image/jpeg" Extension="jpg"/><Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/><Default ContentType="application/xml" Extension="xml"/><Default ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont" Extension="odttf"/>${overrides.map(([n, c]) => `<Override ContentType="${c}" PartName="${n}"/>`).join('')}</Types>`);
    return zip;
  }
}
