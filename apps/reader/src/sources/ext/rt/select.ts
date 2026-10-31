// Selectors as the plugins write them: the browser's own, plus the jQuery/jsoup pseudo-classes cheerio and
// Mangayomi accept — :contains(text), :icontains, :containsOwn, :matches(regex), :eq(n), :lt(n), :gt(n),
// :first, :last, :even, :odd, :header, :parent, :inot(sel) — which the browser does not know. A selector
// without them goes straight to querySelectorAll; with them, each compound is matched by the browser with
// the extras stripped, and the extras are applied in order on what came back (positional ones on the set,
// the way jQuery applies them).

type Root = Element | Document | DocumentFragment;
export interface SelectOptions { icontains?: boolean }

const CUSTOM = /:(contains|icontains|containsOwn|containsData|containsWholeText|matches|matchesOwn|eq|lt|gt|nth|first|last|even|odd|header|parent|inot|has|not|is|where)\b/;
const HEADER = /^h[1-6]$/i;

export function hasCustom(sel: string): boolean {
  if (!CUSTOM.test(sel)) return false;
  // :has/:not/:is are the browser's own unless something custom sits inside them.
  return /:(contains|icontains|containsOwn|containsData|containsWholeText|matches|matchesOwn|eq|lt|gt|nth|first|last|even|odd|header|parent|inot)\b/.test(sel);
}

/** The comma-separated groups of a selector (commas inside parentheses or quotes do not count). */
export function splitGroups(sel: string): string[] {
  const out: string[] = []; let depth = 0, q = '', cur = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (q) { cur += c; if (c === q && sel[i - 1] !== '\\') q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A group as a sequence of compounds with the combinator before each. */
function splitCompounds(group: string): { comb: string; compound: string }[] {
  const out: { comb: string; compound: string }[] = []; let depth = 0, q = '', cur = '', comb = ' ', pendingComb = '';
  const push = () => { if (cur.trim()) { out.push({ comb, compound: cur.trim() }); cur = ''; } };
  for (let i = 0; i < group.length; i++) {
    const c = group[i];
    if (q) { cur += c; if (c === q && group[i - 1] !== '\\') q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~' || c === '\t' || c === '\n')) {
      if (c === '>' || c === '+' || c === '~') pendingComb = c;
      else if (!pendingComb && cur.trim()) pendingComb = ' ';
      if (cur.trim()) { push(); }
      continue;
    }
    if (pendingComb) { comb = pendingComb; pendingComb = ''; }
    cur += c;
  }
  push();
  if (out.length) out[0].comb = ' ';
  return out;
}

interface Custom { name: string; arg: string }
/** The compound with its custom pseudo-classes taken out (`*` when nothing is left), and those pseudo-classes. */
function stripCustom(compound: string): { base: string; customs: Custom[] } {
  const customs: Custom[] = []; let base = ''; let i = 0;
  while (i < compound.length) {
    const c = compound[i];
    if (c === ':') {
      const m = /^:([a-zA-Z-]+)/.exec(compound.slice(i));
      if (m) {
        const name = m[1]; let j = i + m[0].length; let arg = '';
        if (compound[j] === '(') {
          let depth = 0, q = '', k = j;
          for (; k < compound.length; k++) {
            const ch = compound[k];
            if (q) { if (ch === q && compound[k - 1] !== '\\') q = ''; continue; }
            if (ch === '"' || ch === "'") { q = ch; continue; }
            if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth === 0) break; }
          }
          arg = compound.slice(j + 1, k); j = k + 1;
        }
        const custom = /^(contains|icontains|containsOwn|containsData|containsWholeText|matches|matchesOwn|eq|lt|gt|nth|first|last|even|odd|header|parent|inot)$/.test(name)
          || ((name === 'not' || name === 'has' || name === 'is' || name === 'where') && hasCustom(arg));
        if (custom) { customs.push({ name, arg }); i = j; continue; }
        base += compound.slice(i, j); i = j; continue;
      }
    }
    if (c === '[' ) { const end = compound.indexOf(']', i); if (end > 0) { base += compound.slice(i, end + 1); i = end + 1; continue; } }
    base += c; i++;
  }
  return { base: base.trim() || '*', customs };
}

const unquote = (s: string) => { const t = s.trim(); return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t; };
const ownText = (el: Element) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? '').join('');

function applyCustom(list: Element[], customs: Custom[], opts: SelectOptions): Element[] {
  let cur = list;
  for (const c of customs) {
    const arg = unquote(c.arg);
    switch (c.name) {
      case 'contains': { const ci = !!opts.icontains; const needle = ci ? arg.toLowerCase() : arg; cur = cur.filter((e) => (ci ? (e.textContent ?? '').toLowerCase() : e.textContent ?? '').includes(needle)); break; }
      case 'icontains': { const needle = arg.toLowerCase(); cur = cur.filter((e) => (e.textContent ?? '').toLowerCase().includes(needle)); break; }
      case 'containsOwn': { const needle = opts.icontains ? arg.toLowerCase() : arg; cur = cur.filter((e) => (opts.icontains ? ownText(e).toLowerCase() : ownText(e)).includes(needle)); break; }
      case 'containsData': { const needle = arg.toLowerCase(); cur = cur.filter((e) => /^(script|style)$/i.test(e.tagName) && (e.textContent ?? '').toLowerCase().includes(needle)); break; }
      case 'containsWholeText': cur = cur.filter((e) => (e.textContent ?? '').includes(arg)); break;
      case 'matches': { let re: RegExp | null = null; try { re = new RegExp(arg, 'i'); } catch { re = null; } cur = re ? cur.filter((e) => re!.test(e.textContent ?? '')) : []; break; }
      case 'matchesOwn': { let re: RegExp | null = null; try { re = new RegExp(arg, 'i'); } catch { re = null; } cur = re ? cur.filter((e) => re!.test(ownText(e))) : []; break; }
      case 'eq': case 'nth': { const n = Number(arg); cur = n < 0 ? (cur[cur.length + n] ? [cur[cur.length + n]] : []) : (cur[n] ? [cur[n]] : []); break; }
      case 'lt': cur = cur.slice(0, Math.max(0, Number(arg))); break;
      case 'gt': cur = cur.slice(Number(arg) + 1); break;
      case 'first': cur = cur.slice(0, 1); break;
      case 'last': cur = cur.slice(-1); break;
      case 'even': cur = cur.filter((_, i) => i % 2 === 0); break;
      case 'odd': cur = cur.filter((_, i) => i % 2 === 1); break;
      case 'header': cur = cur.filter((e) => HEADER.test(e.tagName)); break;
      case 'parent': cur = cur.filter((e) => e.childNodes.length > 0); break;
      case 'inot': case 'not': cur = cur.filter((e) => !matches(e, c.arg, opts)); break;
      case 'has': cur = cur.filter((e) => select([e], c.arg, opts).length > 0); break;
      case 'is': case 'where': cur = cur.filter((e) => matches(e, c.arg, opts)); break;
    }
  }
  return cur;
}

function scoped(root: Root, comb: string, base: string): Element[] {
  try {
    if (comb === ' ') return Array.from((root as Element).querySelectorAll(base));
    if (comb === '>') {
      const kids = root.nodeType === 9 ? [(root as Document).documentElement].filter(Boolean) : Array.from((root as Element | DocumentFragment).children);
      return kids.filter((k) => k.matches(base));
    }
    if (root.nodeType !== 1) return [];
    const out: Element[] = [];
    let s = (root as Element).nextElementSibling;
    while (s) { if (s.matches(base)) out.push(s); if (comb === '+') break; s = s.nextElementSibling; }
    return out;
  } catch { return []; }
}

function uniqueInOrder(list: Element[]): Element[] {
  if (list.length < 2) return list;
  const set = new Set(list); const out = Array.from(set);
  out.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
  return out;
}

/** Everything under `roots` the selector names, in document order. */
export function select(roots: Root[], selector: string, opts: SelectOptions = {}): Element[] {
  const sel = selector.trim(); if (!sel) return [];
  if (!hasCustom(sel)) {
    const out: Element[] = [];
    for (const r of roots) { try { out.push(...Array.from(r.querySelectorAll(sel))); } catch { /* an unknown selector names nothing */ } }
    return roots.length > 1 ? uniqueInOrder(out) : out;
  }
  const out: Element[] = [];
  for (const group of splitGroups(sel)) {
    const parts = splitCompounds(group);
    let cur: Root[] = roots;
    for (const p of parts) {
      const { base, customs } = stripCustom(p.compound);
      let next: Element[] = [];
      for (const r of cur) next.push(...scoped(r, p.comb, base));
      next = uniqueInOrder(next);
      cur = applyCustom(next, customs, opts);
    }
    out.push(...(cur as Element[]));
  }
  return uniqueInOrder(out);
}

/** Does the element match the selector (custom pseudo-classes included)? */
export function matches(el: Element, selector: string, opts: SelectOptions = {}): boolean {
  const sel = selector.trim(); if (!sel) return false;
  if (!hasCustom(sel)) { try { return el.matches(sel); } catch { return false; } }
  for (const group of splitGroups(sel)) {
    const parts = splitCompounds(group);
    if (parts.length === 1) {
      const { base, customs } = stripCustom(parts[0].compound);
      try { if (!el.matches(base)) continue; } catch { continue; }
      // (Positional pseudo-classes on a lone element: judged among its siblings of the same base.)
      const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => { try { return c.matches(base); } catch { return false; } }) : [el];
      if (applyCustom(siblings, customs, opts).includes(el)) return true;
      continue;
    }
    const root = el.getRootNode() as Root;
    if (select([root.nodeType === 9 || root.nodeType === 11 ? root : (root as Element)], group, opts).includes(el)) return true;
  }
  return false;
}
