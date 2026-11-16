// A small XML reader for pet packs (Shimeji's conf/actions.xml and conf/behaviors.xml): elements, attributes, text,
// comments, CDATA. Deliberately narrow, never the platform's parser: a document type (<!DOCTYPE …>) or an entity
// declaration is refused outright — so no entity can be defined, expanded or fetched —, only the five predefined
// entities and numeric character references are read, and size, depth, node and attribute counts are capped.
// Element and attribute names lose any namespace prefix (Shimeji's files carry a default namespace).

export interface XNode { name: string; attrs: Record<string, string>; kids: XNode[]; text: string }
export const XML_MAX_BYTES = 1 << 20;
export const XML_MAX_NODES = 20000;
export const XML_MAX_DEPTH = 64;
const MAX_ATTRS = 64;

export class XmlError extends Error {}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s: string): string {
  if (!s.includes('&')) return s;
  if (/&(?!(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,8});)/.test(s)) throw new XmlError('badAmp');
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,8});/g, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new XmlError('badCharRef'); return String.fromCodePoint(n); }
    const v = Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : undefined; if (v === undefined) throw new XmlError('unknownEntity'); return v;
  });
}
const local = (n: string): string => { const i = n.indexOf(':'); return i >= 0 ? n.slice(i + 1) : n; };
const NAME = /^[^\s<>"'=/!?]+/;

/** The document's root element; throws XmlError on anything outside the subset. */
export function parseXml(src: string): XNode {
  if (src.length > XML_MAX_BYTES) throw new XmlError('tooBig');
  if (/<!DOCTYPE/i.test(src) || /<!ENTITY/i.test(src)) throw new XmlError('doctype');
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0; const n = src.length;
  const root: XNode = { name: '#doc', attrs: {}, kids: [], text: '' };
  const stack: XNode[] = [root]; let nodes = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) { const t = src.slice(i, textEnd); if (stack.length > 1) stack[stack.length - 1].text += decode(t); else if (t.trim()) throw new XmlError('textOutside'); }
    if (lt < 0) break;
    i = lt;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); if (e < 0) throw new XmlError('openComment'); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', i)) { const e = src.indexOf(']]>', i + 9); if (e < 0) throw new XmlError('openCdata'); if (stack.length > 1) stack[stack.length - 1].text += src.slice(i + 9, e); i = e + 3; continue; }
    if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i + 2); if (e < 0) throw new XmlError('openPi'); i = e + 2; continue; }
    if (src.startsWith('<!', i)) throw new XmlError('declaration');
    if (src[i + 1] === '/') {
      const e = src.indexOf('>', i); if (e < 0) throw new XmlError('openTag');
      const nm = local(src.slice(i + 2, e).trim()); const top = stack.pop();
      if (!top || top === root || top.name !== nm) throw new XmlError('mismatch');
      i = e + 1; continue;
    }
    // An opening tag.
    let j = i + 1; const m = NAME.exec(src.slice(j, j + 200)); if (!m) throw new XmlError('badName');
    const el: XNode = { name: local(m[0]), attrs: {}, kids: [], text: '' }; j += m[0].length;
    let count = 0; let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) throw new XmlError('openTag');
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { j += 2; selfClose = true; break; }
      const an = NAME.exec(src.slice(j, j + 200)); if (!an) throw new XmlError('badAttr');
      j += an[0].length; while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== '=') throw new XmlError('badAttr'); j++; while (j < n && /\s/.test(src[j])) j++;
      const q = src[j]; if (q !== '"' && q !== "'") throw new XmlError('badAttr');
      const e = src.indexOf(q, j + 1); if (e < 0) throw new XmlError('badAttr');
      const raw = src.slice(j + 1, e); if (raw.includes('<')) throw new XmlError('badAttr');
      if (++count > MAX_ATTRS) throw new XmlError('tooManyAttrs');
      const key = local(an[0]); if (an[0].startsWith('xmlns')) { j = e + 1; continue; }
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') { j = e + 1; continue; }
      el.attrs[key] = decode(raw); j = e + 1;
    }
    if (++nodes > XML_MAX_NODES) throw new XmlError('tooManyNodes');
    const parent = stack[stack.length - 1];
    if (parent === root && root.kids.length) throw new XmlError('twoRoots');
    parent.kids.push(el);
    if (!selfClose) { stack.push(el); if (stack.length - 1 > XML_MAX_DEPTH) throw new XmlError('tooDeep'); }
    i = j;
  }
  if (stack.length !== 1) throw new XmlError('unclosed');
  if (!root.kids.length) throw new XmlError('empty');
  return root.kids[0];
}

/** Every descendant (depth first) named `name`. */
export function findAll(n: XNode, name: string, out: XNode[] = []): XNode[] { for (const k of n.kids) { if (k.name === name) out.push(k); findAll(k, name, out); } return out; }
