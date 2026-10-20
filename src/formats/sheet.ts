// XLSX and CSV viewing. XLSX is read directly from its XML parts: shared
// strings, number formats (for dates) and each worksheet's cells.
import JSZip from 'jszip';
import type { FlowHandler, FlowRender, RenderContext, TocItem } from './types';
import { titleFromFileName } from './types';
import { decodeText, el, parseXml, resolveZipPath, zipFile } from './shared';
import { t } from '../i18n';

interface Cell { v: string; num: boolean; bold?: boolean }
interface Sheet { name: string; rows: Cell[][]; cols: number }

const ROWS_PER_CHUNK = 500;

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
}
function colName(i: number): string {
  let s = '';
  i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

const DATE_BUILTIN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function excelDate(serial: number, withTime: boolean): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const date = d.toISOString().slice(0, 10);
  return withTime && serial % 1 !== 0 ? `${date} ${d.toISOString().slice(11, 16)}` : date;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

async function parseXlsx(file: Blob): Promise<Sheet[]> {
  const zip = await JSZip.loadAsync(file);
  const wbPath = 'xl/workbook.xml';
  const wb = parseXml(await zipFile(zip, wbPath)!.async('text'));
  const relsDoc = parseXml(await (zipFile(zip, 'xl/_rels/workbook.xml.rels')?.async('text') ?? '<r/>'));
  const rels = new Map<string, string>();
  relsDoc.querySelectorAll('Relationship').forEach((r) => rels.set(r.getAttribute('Id') ?? '', resolveZipPath(wbPath, r.getAttribute('Target') ?? '')));

  // Shared strings (rich text runs are flattened).
  const shared: string[] = [];
  const ssFile = zipFile(zip, 'xl/sharedStrings.xml');
  if (ssFile) {
    const sd = parseXml(await ssFile.async('text'));
    sd.documentElement.childNodes.forEach((si) => {
      if (si.nodeType !== 1 || (si as Element).localName !== 'si') return;
      let s = '';
      (si as Element).querySelectorAll('t').forEach((tn) => (s += tn.textContent ?? ''));
      shared.push(s);
    });
  }

  // Styles: which cellXfs are date formats, which are bold.
  const dateXf: boolean[] = [];
  const boldXf: boolean[] = [];
  const stFile = zipFile(zip, 'xl/styles.xml');
  if (stFile) {
    const sd = parseXml(await stFile.async('text'));
    const custom = new Map<number, string>();
    sd.querySelectorAll('numFmts > numFmt').forEach((nf) => custom.set(Number(nf.getAttribute('numFmtId')), nf.getAttribute('formatCode') ?? ''));
    const fonts: boolean[] = [];
    sd.querySelectorAll('fonts > font').forEach((f) => fonts.push(!!f.querySelector('b')));
    sd.querySelectorAll('cellXfs > xf').forEach((xf) => {
      const id = Number(xf.getAttribute('numFmtId') ?? 0);
      const code = custom.get(id);
      const isDate = DATE_BUILTIN.has(id) || (!!code && /[dmyh]/i.test(code.replace(/\[[^\]]*]/g, '').replace(/"[^"]*"/g, '')) && !/#|0/.test(code.replace(/\[[^\]]*]/g, '')));
      dateXf.push(isDate);
      boldXf.push(fonts[Number(xf.getAttribute('fontId') ?? 0)] ?? false);
    });
  }

  const sheets: Sheet[] = [];
  for (const s of wb.querySelectorAll('sheets > sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? s.getAttribute('r:id') ?? '';
    const path = rels.get(rid);
    const f = path ? zipFile(zip, path) : null;
    if (!f) continue;
    const sd = parseXml(await f.async('text'));
    const rows: Cell[][] = [];
    let cols = 0;
    sd.querySelectorAll('sheetData > row').forEach((rowEl) => {
      const r = Number(rowEl.getAttribute('r') ?? rows.length + 1) - 1;
      while (rows.length <= r) rows.push([]);
      const row = rows[r];
      rowEl.querySelectorAll('c').forEach((c) => {
        const ref = c.getAttribute('r') ?? '';
        const ci = ref ? colIndex(ref) : row.length;
        const type = c.getAttribute('t');
        const styleIdx = Number(c.getAttribute('s') ?? -1);
        const vEl = c.querySelector('v');
        let v = vEl?.textContent ?? '';
        let num = false;
        if (type === 's') v = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') v = c.querySelector('is')?.textContent ?? '';
        else if (type === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') { /* formula string / error */ }
        else if (v === '' && c.querySelector('f')) v = '=' + (c.querySelector('f')?.textContent ?? '');
        else if (v !== '') {
          const n = Number(v);
          if (!Number.isNaN(n)) {
            num = true;
            v = dateXf[styleIdx] ? excelDate(n, true) : formatNumber(n);
            if (dateXf[styleIdx]) num = false;
          }
        }
        while (row.length < ci) row.push({ v: '', num: false });
        row[ci] = { v, num, bold: boldXf[styleIdx] };
        if (ci + 1 > cols) cols = ci + 1;
      });
    });
    // Drop trailing empty rows.
    while (rows.length && rows[rows.length - 1].every((c) => !c.v)) rows.pop();
    sheets.push({ name: s.getAttribute('name') ?? `Sheet ${sheets.length + 1}`, rows, cols });
  }
  return sheets;
}

export function parseCsv(text: string): string[][] {
  const delim = (text.match(/\t/g)?.length ?? 0) > (text.match(/,/g)?.length ?? 0) ? '\t' : (text.match(/;/g)?.length ?? 0) > (text.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function renderSheet(sheet: Sheet, container: HTMLElement): void {
  const wrap = el('div', 'kr-sheet-wrap');
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th'));
  for (let c = 0; c < sheet.cols; c++) hr.appendChild(el('th', undefined, colName(c)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  table.appendChild(tbody);
  let rendered = 0;
  const more = el('button', 'btn small', t('showMoreRows'));
  const renderChunk = () => {
    const end = Math.min(sheet.rows.length, rendered + ROWS_PER_CHUNK);
    const frag = document.createDocumentFragment();
    for (let r = rendered; r < end; r++) {
      const tr = el('tr');
      tr.appendChild(el('td', 'rh', String(r + 1)));
      const row = sheet.rows[r];
      for (let c = 0; c < sheet.cols; c++) {
        const cell = row[c];
        const td = el('td', cell?.num ? 'num' : undefined, cell?.v ?? '');
        if (cell?.bold) td.classList.add('kr-bold');
        if (cell?.v) td.setAttribute('dir', 'auto');
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    rendered = end;
    more.hidden = rendered >= sheet.rows.length;
  };
  renderChunk();
  more.addEventListener('click', renderChunk);
  wrap.appendChild(table);
  container.appendChild(el('p', undefined, t('rows', { n: sheet.rows.length })));
  container.appendChild(wrap);
  container.appendChild(more);
}

function renderWorkbook(sheets: Sheet[], ctx: RenderContext): FlowRender {
  const root = el('div', 'kr-content kr-sheet');
  root.setAttribute('dir', 'ltr');
  const tabs = el('div', 'kr-sheet-tabs');
  tabs.setAttribute('role', 'tablist');
  const panes: HTMLElement[] = [];
  const toc: TocItem[] = [];
  sheets.forEach((s, i) => {
    const pane = el('div');
    pane.id = ctx.id(`sheet${i}`);
    pane.hidden = i !== 0;
    const b = el('button', undefined, s.name);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === 0));
    b.addEventListener('click', () => {
      panes.forEach((p, j) => (p.hidden = j !== i));
      tabs.querySelectorAll('button').forEach((bb, j) => bb.setAttribute('aria-selected', String(j === i)));
    });
    tabs.appendChild(b);
    panes.push(pane);
    toc.push({ label: `${t('sheet')}: ${s.name}`, depth: 0, anchor: pane.id });
  });
  if (sheets.length > 1) root.appendChild(tabs);
  panes.forEach((p, i) => { renderSheet(sheets[i], p); root.appendChild(p); });
  // Jumping to a sheet from the TOC should also reveal it.
  root.addEventListener('kr-reveal', (e) => {
    const id = (e as CustomEvent<string>).detail;
    const i = panes.findIndex((p) => p.id === id);
    if (i >= 0) (tabs.children[i] as HTMLElement).click();
  });
  return { element: root, toc, images: [], rtl: false, dispose: () => undefined };
}

export const xlsxHandler: FlowHandler = {
  kind: 'flow',
  format: 'xlsx',
  async readMeta(file, fileName) {
    try {
      const zip = await JSZip.loadAsync(file);
      const core = zipFile(zip, 'docProps/core.xml');
      if (core) {
        const cd = parseXml(await core.async('text'));
        return { title: cd.getElementsByTagName('dc:title')[0]?.textContent?.trim() || titleFromFileName(fileName), author: cd.getElementsByTagName('dc:creator')[0]?.textContent?.trim() || undefined };
      }
    } catch { /* ignore */ }
    return { title: titleFromFileName(fileName) };
  },
  async render(file, ctx) {
    return renderWorkbook(await parseXlsx(file), ctx);
  },
};

export const csvHandler: FlowHandler = {
  kind: 'flow',
  format: 'csv',
  async readMeta(_file, fileName) { return { title: titleFromFileName(fileName) }; },
  async render(file, ctx) {
    const rows = parseCsv(await decodeText(file));
    const cols = Math.max(0, ...rows.map((r) => r.length));
    const sheet: Sheet = { name: 'CSV', cols, rows: rows.map((r) => r.map((v) => ({ v, num: v !== '' && !Number.isNaN(Number(v)) }))) };
    return renderWorkbook([sheet], ctx);
  },
};
