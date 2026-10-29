// Injected into the pdf.js worker by scripts/patch-pdfjs.mjs.
//
// Some PDF writers emit a broken /ToUnicode for shaped (Arabic) fonts: whole runs of glyph ids
// mapped to consecutive code points, so extracted text is nonsense ("ث ٞٮله" for "بقوله").
// The embedded font itself knows better: its cmap names the base letters, and its GSUB rules lead
// from them to every shaped form and ligature. krFontUnicode() rebuilds glyph → text from those,
// and krRepairToUnicode() uses it when the PDF's map clearly disagrees with the font.
function krFontUnicode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o), i16 = (o) => dv.getInt16(o), u32 = (o) => dv.getUint32(o);
  const tables = {};
  const n = u16(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(bytes[r], bytes[r + 1], bytes[r + 2], bytes[r + 3]);
    tables[tag] = u32(r + 8);
  }
  const map = new Map(); // gid → text
  // cmap: Unicode → glyph, inverted (first code point wins, so a letter is not replaced by a variant).
  const cm = tables.cmap;
  if (cm !== undefined) {
    const subs = [];
    for (let i = 0, nn = u16(cm + 2); i < nn; i++) {
      const p = u16(cm + 4 + i * 8), e = u16(cm + 6 + i * 8), off = u32(cm + 8 + i * 8);
      if (p === 3 && (e === 1 || e === 10) || p === 0) subs.push(cm + off);
    }
    for (const s of subs) {
      const fmt = u16(s);
      if (fmt === 4) {
        const seg = u16(s + 6) / 2, ends = s + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ros = deltas + seg * 2;
        for (let k = 0; k < seg; k++) {
          const end = u16(ends + k * 2), start = u16(starts + k * 2), delta = i16(deltas + k * 2), ro = u16(ros + k * 2);
          if (start === 0xffff) continue;
          for (let c = start; c <= end; c++) {
            let g;
            if (ro === 0) g = (c + delta) & 0xffff;
            else { const gp = ros + k * 2 + ro + (c - start) * 2; if (gp + 2 > bytes.length) continue; g = u16(gp); if (g) g = (g + delta) & 0xffff; }
            if (g && !map.has(g) && !(c >= 0xe000 && c <= 0xf8ff)) map.set(g, String.fromCodePoint(c)); // (a symbol font's private codes say nothing)
          }
        }
      } else if (fmt === 12) {
        for (let k = 0, ng = u32(s + 12); k < ng; k++) {
          const st = u32(s + 16 + k * 12), en = u32(s + 20 + k * 12), sg = u32(s + 24 + k * 12);
          for (let c = st; c <= en && c - st < 0x10000; c++) if (!map.has(sg + c - st) && !(c >= 0xe000 && c <= 0xf8ff) && c < 0xf0000) map.set(sg + c - st, String.fromCodePoint(c));
        }
      }
    }
  }
  const gs = tables.GSUB;
  if (gs === undefined || !map.size) return map;
  const coverage = (o) => {
    const out = [];
    const fmt = u16(o);
    if (fmt === 1) for (let i = 0, c = u16(o + 2); i < c; i++) out.push(u16(o + 4 + i * 2));
    else if (fmt === 2) for (let i = 0, c = u16(o + 2); i < c; i++) { const a = u16(o + 4 + i * 6), b = u16(o + 6 + i * 6); for (let g = a; g <= b; g++) out.push(g); }
    return out;
  };
  const subtables = []; // [type, offset]
  const ll = gs + u16(gs + 8);
  for (let i = 0, lc = u16(ll); i < lc; i++) {
    const lk = ll + u16(ll + 2 + i * 2);
    let type = u16(lk);
    for (let j = 0, sc = u16(lk + 4); j < sc; j++) {
      let st = lk + u16(lk + 6 + j * 2);
      let t = type;
      if (t === 7) { t = u16(st + 2); st = st + u32(st + 4); }
      subtables.push([t, st]);
    }
  }
  const set = (g, s) => { if (s && !map.has(g)) { map.set(g, s); return true; } return false; };
  const ligs = new Set();
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [t, st] of subtables) {
      try {
        if (t === 1) {
          const cov = coverage(st + u16(st + 2));
          if (u16(st) === 1) { const d = i16(st + 4); for (const g of cov) if (map.has(g)) changed = set((g + d) & 0xffff, map.get(g)) || changed; }
          else cov.forEach((g, i) => { if (map.has(g)) changed = set(u16(st + 6 + i * 2), map.get(g)) || changed; });
        } else if (t === 2 || t === 3) {
          const cov = coverage(st + u16(st + 2));
          cov.forEach((g, i) => {
            if (!map.has(g)) return;
            const seq = st + u16(st + 6 + i * 2);
            const cnt = u16(seq);
            for (let k = 0; k < cnt; k++) changed = set(u16(seq + 2 + k * 2), t === 3 || k === 0 ? map.get(g) : "\u200c") || changed;
          });
        } else if (t === 4) {
          const cov = coverage(st + u16(st + 2));
          cov.forEach((g, i) => {
            const ls = st + u16(st + 6 + i * 2);
            for (let k = 0, lc = u16(ls); k < lc; k++) {
              const lig = ls + u16(ls + 2 + k * 2);
              const lg = u16(lig), cc = u16(lig + 2);
              const parts = [g];
              for (let m = 1; m < cc; m++) parts.push(u16(lig + 4 + (m - 1) * 2));
              if (!parts.every((p) => map.has(p))) continue;
              const str = parts.map((p) => map.get(p)).join("").replace(/\u200c/g, "");
              // One glyph can close several ligatures ("لله" and "الله"): the shortest reading is the glyph's own.
              const had = map.get(lg);
              if (had === undefined) changed = set(lg, str) || changed;
              else if (ligs.has(lg) && str.length < had.length) { map.set(lg, str); changed = true; }
              ligs.add(lg);
            }
          });
        } else if (t === 8) {
          const cov = coverage(st + u16(st + 2));
          const bc = u16(st + 4), la = st + 6 + bc * 2, lc = u16(la), gcAt = la + 2 + lc * 2;
          cov.forEach((g, i) => { if (map.has(g)) changed = set(u16(gcAt + 2 + i * 2), map.get(g)) || changed; });
        }
      } catch { /* malformed subtable: skip */ }
    }
    if (!changed) break;
  }
  for (const [g, s] of map) if (s === "\u200c") map.delete(g);
  return map;
}


/* A legacy Arabic layout many Gulf books' fonts share (AL-Mohanad, AL-Mateen and the other "AL-…" fonts of their
 * maker): 256 glyphs under a symbol cmap (F0xx/F2xx), each letter's forms side by side — ب at 49–4C, ت at 4D–50 —
 * ligatures at 80–9F, harakat at E3–FE. Writers (Word's PDF export, iLovePDF…) compress its /ToUnicode into
 * ranges that count up a letter per code, so all but the first form of each run reads as the next letters
 * ("الشكس" for "الشكر"). The layout, read off the glyphs themselves: glyph id → text (the same in each of
 * these fonts; their symbol cmap's codes drift from the glyph ids past A5, the glyph ids do not). */
const KR_AL_LAYOUT = {16:"لمح",17:"لمج",22:"تر",23:"ير",24:"سم",26:"له",29:"بي",30:"تي",31:"ني",65:"ا",66:"ا",67:"أ",68:"أ",71:"إ",72:"إ",73:"ب",74:"ب",75:"ب",76:"ب",77:"ت",78:"ت",79:"ت",80:"ت",81:"ث",82:"ث",83:"ث",84:"ث",85:"ج",86:"ج",87:"ج",88:"ج",89:"ح",90:"ح",96:"ح",97:"خ",98:"خ",99:"خ",101:"د",102:"د",103:"ذ",104:"ذ",105:"ر",106:"ر",107:"ز",108:"ز",109:"س",110:"س",111:"س",112:"س",113:"ش",114:"ش",115:"ش",116:"ش",117:"ص",118:"ص",119:"ص",120:"ص",121:"ض",122:"ض",123:"ض",124:"ض",127:"ط",129:"بح",131:"تج",132:"تح",133:"تخ",134:"لج",135:"لح",136:"لخ",137:"مج",138:"مح",141:"نح",143:"يج",148:"ين",149:"لى",150:"بم",154:"جم",155:"حم",156:"خم",157:"لم",158:"مم",159:"في",161:"ط",162:"ظ",163:"ظ",166:"ع",167:"ع",168:"ع",169:"ع",170:"غ",171:"غ",172:"غ",173:"غ",174:"ف",175:"ف",176:"ف",177:"ف",178:"ق",179:"ق",180:"ق",181:"ق",182:"ك",183:"ك",184:"ك",185:"ك",186:"ل",187:"ل",188:"ل",189:"ل",190:"م",191:"م",192:"م",193:"م",194:"ن",195:"ن",196:"ن",197:"ن",198:"ه",199:"ه",200:"ه",201:"ه",202:"و",203:"و",204:"ي",205:"ي",206:"ي",207:"ي",208:"ة",209:"ة",210:"ى",211:"ى",212:"ء",213:"ئ",214:"ئ",219:"لا",220:"لا",221:"لأ",223:"لآ",225:"لإ",226:"لإ",227:"َ",228:"ُ",229:"ْ",230:"ً",232:"ّ",233:"ِ",234:"ٍ",235:"َّ",236:"ُّ",238:"ٌّ",239:"ِّ",240:"ط",241:"َ",242:"ُ",243:"ْ",244:"ً",245:"ٌ",247:"ِ",248:"ٍ",249:"َّ",250:"ُّ",251:"ًّ",254:"ٍّ"};
/** Whether a font is of that layout — a symbol cmap (no Unicode one), and the PDF's own map agreeing with the
 *  layout on most of its glyphs (the run starts and the single entries) — and if so its map put right. */
function krLegacyLayout(font, raw, properties) {
  try {
    const tu = font.toUnicode;
    if (!tu || !Array.isArray(tu._map) || !properties.composite) return false;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let cm = -1;
    for (let i = 0, n = dv.getUint16(4); i < n; i++) { const r = 12 + i * 16; if (raw[r] === 0x63 && raw[r + 1] === 0x6d && raw[r + 2] === 0x61 && raw[r + 3] === 0x70) cm = dv.getUint32(r + 8); }
    if (cm < 0) return false;
    // (The symbol subtable: the glyphs it reaches.)
    const lowOf = new Map();
    for (let i = 0, nn = dv.getUint16(cm + 2); i < nn; i++) {
      const p = dv.getUint16(cm + 4 + i * 8), e = dv.getUint16(cm + 6 + i * 8), s = cm + dv.getUint32(cm + 8 + i * 8);
      if (p !== 3 || e !== 0 || dv.getUint16(s) !== 4) continue;
      const seg = dv.getUint16(s + 6) / 2, ends = s + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ros = deltas + seg * 2;
      for (let k = 0; k < seg; k++) {
        const end = dv.getUint16(ends + k * 2), start = dv.getUint16(starts + k * 2), delta = dv.getInt16(deltas + k * 2), ro = dv.getUint16(ros + k * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) {
          let g; if (ro === 0) g = (c + delta) & 0xffff; else { const gp = ros + k * 2 + ro + (c - start) * 2; if (gp + 2 > raw.length) continue; g = dv.getUint16(gp); if (g) g = (g + delta) & 0xffff; }
          if (g && (c & 0xff00) >= 0xf000 && !lowOf.has(g)) lowOf.set(g, g);
        }
      }
    }
    if (lowOf.size < 12) return false;
    const gidOf = (code) => { const m = properties.cidToGidMap; return m && m.length ? m[code] ?? code : code; };
    const base = (s) => (s || "").normalize("NFKC").replace(/[\u064b-\u065f\u0670\s]/g, "");
    let compared = 0, agree = 0, wrong = 0;
    for (const code in tu._map) {
      const g = gidOf(+code); const low = lowOf.get(g);
      if (low === undefined) continue;
      const want = KR_AL_LAYOUT[low]; if (want === undefined || !/[\u0621-\u064a]/.test(want)) continue;
      compared++;
      if (base(want) === base(tu._map[code])) agree++; else wrong++;
    }
    // (Not this layout: few letters in common, or nothing to put right.)
    if (compared < 12 || agree / compared < 0.5 || !wrong) return false;
    for (const code in tu._map) {
      const low = lowOf.get(gidOf(+code)); if (low === undefined) continue;
      const want = KR_AL_LAYOUT[low]; if (want !== undefined) tu._map[code] = want;
    }
    // (Brackets as drawn: turned back in right-to-left text, as for any map rebuilt from the font.)
    for (const code in tu._map) { const low = lowOf.get(gidOf(+code)); if (low === 0x28) tu._map[code] = "("; else if (low === 0x29) tu._map[code] = ")"; }
    font.krToUnicodeRepaired = true;
    if (globalThis.KR_FONT_DEBUG) console.log("KRF layout", properties.loadedName, properties.name, "compared", compared, "agree", agree, "fixed", wrong);
    return true;
  } catch { return false; }
}

function krRepairToUnicode(font, raw, properties) {
  try {
    let tu = font.toUnicode;
    if (!raw || raw.length < 12 || !properties.composite || !tu) return;
    const gidOf = (code) => { const m = properties.cidToGidMap; return m && m.length ? m[code] ?? code : code; };
    const derived = krFontUnicode(raw);
    if (derived.size < 4) { krLegacyLayout(font, raw, properties); return; }
    const plainOf = (d) => d.replace(/[\ufb50-\ufdff\ufe70-\ufefc]+/g, (m) => m.normalize("NFKC"));
    // No /ToUnicode at all (an identity map stands in): the text is whatever the font says its glyphs are.
    if (!Array.isArray(tu._map)) {
      if (properties.hasIncludedToUnicodeMap) return;
      const map = [];
      const cid2gid = properties.cidToGidMap;
      if (cid2gid && cid2gid.length) { for (let code = 0; code < cid2gid.length; code++) { const d = derived.get(cid2gid[code]); if (d !== undefined) map[code] = plainOf(d); } }
      else for (const [gid, d] of derived) map[gid] = plainOf(d);
      if (map.length < 4) return;
      font.toUnicode = properties.toUnicode = tu = new ToUnicodeMap(map); // (the font takes properties.toUnicode again right after)
      font.krToUnicodeRepaired = true;
      return;
    }
    let compared = 0, agree = 0;
    const norm = (s) => (s || "").normalize("NFKC").replace(/\s+/g, "");
    for (const code in tu._map) {
      const d = derived.get(gidOf(+code));
      if (d === undefined) continue;
      compared++;
      if (norm(d) === norm(tu._map[code])) agree++;
    }
    // Presentation forms (the font's shaped glyphs) become plain letters.
    const plain = (d) => d.replace(/[\ufb50-\ufdff\ufe70-\ufefc]+/g, (m) => m.normalize("NFKC"));
    // A sound /ToUnicode agrees with the font almost everywhere; a broken one hardly anywhere.
    if (compared >= 12 && agree / compared <= 0.6) {
      for (const code in tu._map) {
        const d = derived.get(gidOf(+code)); if (d === undefined) continue;
        const cur = tu._map[code] || "";
        // The PDF names this glyph as the tail of what the font says ("لله" for the "الله" ligature): the PDF is precise here.
        if (cur.length > 1 && /^[\u0600-\u06ff]+$/.test(cur) && norm(d) !== norm(cur) && norm(d).endsWith(norm(cur))) continue;
        tu._map[code] = plain(d);
      }
      font.krToUnicodeRepaired = true;
      return;
    }
    // Mostly sound: still correct single Arabic glyphs the PDF names wrongly (a lam read as meem), glyphs it
    // names nothing or a private-use character (a ligature such as "الل" left out, which loses the word's
    // start), a space it names a mark (which glues the words), and a letter it names a lone mark.
    const ar = /^[\u0600-\u06ff\ufb50-\ufdff\ufe70-\ufefc]+$/;
    const markOnly = /^[\u064b-\u065f\u0670\u06d6-\u06ed]+$/;
    const nothing = /^[\u0000-\u001f\ue000-\uf8ff\ufffd]*$/;
    let fixed = 0;
    for (const code in tu._map) {
      const d = derived.get(gidOf(+code)); const cur = tu._map[code] || "";
      if (d === undefined) continue;
      if (d === " " || d === "\u00a0") { if (cur !== " " && (markOnly.test(cur) || nothing.test(cur))) { tu._map[code] = " "; fixed++; } continue; }
      if (!ar.test(d)) continue;
      if (nothing.test(cur)) { tu._map[code] = plain(d); fixed++; continue; }
      if (markOnly.test(cur) && !markOnly.test(plain(d))) { tu._map[code] = plain(d); fixed++; continue; }
      if (!ar.test(cur)) continue;
      if (norm(d) !== norm(cur) && norm(d).length === norm(cur).length) { tu._map[code] = plain(d); fixed++; }
    }
    // Glyphs the PDF's map leaves out altogether (a ligature it has no name for) take the font's word.
    const m = properties.cidToGidMap; let codesOf = null;
    if (m && m.length) { codesOf = new Map(); for (let code = 0; code < m.length; code++) { const g = m[code]; if (!codesOf.has(g)) codesOf.set(g, []); codesOf.get(g).push(code); } }
    for (const [gid, d] of derived) {
      if (!ar.test(d)) continue;
      for (const code of codesOf ? codesOf.get(gid) || [] : [gid]) if (tu._map[code] === undefined) { tu._map[code] = plain(d); fixed++; }
    }
    // Digits: the PDF says "1" where the font draws "١" (Word's context numerals) — keep what is drawn.
    for (const code in tu._map) {
      const d = derived.get(gidOf(+code)); const cur = tu._map[code];
      if (d && /^[\u0660-\u0669\u06f0-\u06f9]$/.test(d) && /^[0-9]$/.test(cur || "")) { tu._map[code] = d; fixed++; }
    }
    if (globalThis.KR_FONT_DEBUG) { const miss = []; for (const code in tu._map) if (nothing.test(tu._map[code] || '') && derived.get(gidOf(+code)) === undefined) miss.push(code); console.log('KRF', properties.loadedName, 'fixed', fixed, 'still nothing', miss.length, miss.slice(0, 12).join(','), 'derived', derived.size, 'compared', compared, 'agree', agree); }
    if (fixed) font.krToUnicodeRepaired = true;
  } catch { /* leave the PDF's map alone */ }
}

/** Horizontal centre of a glyph's outline (font units, relative to its origin), from the TrueType glyf/loca
 *  tables — where a mark actually shows, as opposed to where it is drawn from. Cached per font. */
function krGlyphCentre(font, gid) {
  const raw = font.krRawAll;
  if (!raw) return null;
  let t = font.krGlyf;
  if (t === undefined) {
    t = null;
    try {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const tables = {};
      for (let i = 0, n = dv.getUint16(4); i < n; i++) { const r = 12 + i * 16; tables[String.fromCharCode(raw[r], raw[r + 1], raw[r + 2], raw[r + 3])] = dv.getUint32(r + 8); }
      if (tables.head !== undefined && tables.loca !== undefined && tables.glyf !== undefined && tables.maxp !== undefined) {
        t = { dv, long: dv.getInt16(tables.head + 50) === 1, loca: tables.loca, glyf: tables.glyf, n: dv.getUint16(tables.maxp + 4), upm: dv.getUint16(tables.head + 18) || 1000, cache: new Map() };
      }
    } catch { t = null; }
    font.krGlyf = t;
  }
  if (!t || gid < 0 || gid >= t.n) return null;
  if (t.cache.has(gid)) return t.cache.get(gid);
  let c = null;
  try {
    const off = t.long ? t.dv.getUint32(t.loca + gid * 4) : t.dv.getUint16(t.loca + gid * 2) * 2;
    const next = t.long ? t.dv.getUint32(t.loca + gid * 4 + 4) : t.dv.getUint16(t.loca + gid * 2 + 2) * 2;
    if (next > off) { const g = t.glyf + off; c = ((t.dv.getInt16(g + 2) + t.dv.getInt16(g + 6)) / 2) / t.upm; }
  } catch { c = null; }
  t.cache.set(gid, c);
  return c;
}
