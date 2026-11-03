// Apple's property lists, both kinds: binary (bplist00 — what an IPA's Info.plist usually is) and XML (what a
// provisioning profile holds). Values come back as plain JavaScript: objects, arrays, strings, numbers,
// booleans, dates, and bytes as Uint8Array.
export type PValue = string | number | boolean | Date | Uint8Array | null | PValue[] | { [k: string]: PValue };

export function parsePlist(bytes: Uint8Array): PValue {
  if (bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(0, 8)) === 'bplist00') return parseBinary(bytes);
  return parseXml(new TextDecoder().decode(bytes));
}

function parseBinary(b: Uint8Array): PValue {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength); const t = b.length - 32;
  const offSize = b[t + 6], refSize = b[t + 7];
  const num = Number(d.getBigUint64(t + 8)), top = Number(d.getBigUint64(t + 16)), table = Number(d.getBigUint64(t + 24));
  const uint = (o: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; };
  const offs = Array.from({ length: num }, (_, i) => uint(table + i * offSize, offSize));
  const seen = new Set<number>();
  const obj = (i: number): PValue => {
    if (seen.has(i)) return null; seen.add(i);
    try {
      const o = offs[i]; const m = b[o], hi = m >> 4, lo = m & 15;
      const len = (): [number, number] => { if (lo !== 15) return [lo, o + 1]; const ih = b[o + 1] & 15; const n = 1 << ih; return [uint(o + 2, n), o + 2 + n]; };
      switch (hi) {
        case 0: return lo === 8 ? false : lo === 9 ? true : null;
        case 1: { const n = 1 << lo; return n === 8 ? Number(d.getBigInt64(o + 1)) : uint(o + 1, n); }
        case 2: return lo === 2 ? d.getFloat32(o + 1) : d.getFloat64(o + 1);
        case 3: return new Date(Date.UTC(2001, 0, 1) + d.getFloat64(o + 1) * 1000);
        case 4: { const [n, s] = len(); return b.slice(s, s + n); }
        case 5: { const [n, s] = len(); return new TextDecoder('latin1').decode(b.subarray(s, s + n)); }
        case 6: { const [n, s] = len(); let str = ''; for (let k = 0; k < n; k++) str += String.fromCharCode(d.getUint16(s + k * 2)); return str; }
        case 8: return uint(o + 1, lo + 1);
        case 10: { const [n, s] = len(); return Array.from({ length: n }, (_, k) => obj(uint(s + k * refSize, refSize))); }
        case 13: { const [n, s] = len(); const out: { [k: string]: PValue } = {}; for (let k = 0; k < n; k++) { const key = obj(uint(s + k * refSize, refSize)); out[String(key)] = obj(uint(s + (n + k) * refSize, refSize)); } return out; }
        default: return null;
      }
    } finally { seen.delete(i); }
  };
  return obj(top);
}

function parseXml(text: string): PValue {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.querySelector('plist > *'); if (!root) throw new Error('notPlist');
  const val = (e: Element): PValue => {
    switch (e.tagName) {
      case 'dict': { const out: { [k: string]: PValue } = {}; const kids = Array.from(e.children); for (let i = 0; i + 1 < kids.length; i += 2) out[kids[i].textContent ?? ''] = val(kids[i + 1]); return out; }
      case 'array': return Array.from(e.children).map(val);
      case 'string': return e.textContent ?? '';
      case 'integer': return Number(e.textContent);
      case 'real': return Number(e.textContent);
      case 'true': return true; case 'false': return false;
      case 'date': return new Date(e.textContent ?? '');
      case 'data': { try { const s = atob((e.textContent ?? '').replace(/\s+/g, '')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); } catch { return new Uint8Array(); } }
      default: return null;
    }
  };
  return val(root);
}
