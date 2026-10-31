// cheerio as the LNReader plugins use it, over the browser's own parser: `load(html)` gives `$`, and `$(sel)`
// a set with jQuery's traversal, reading and editing methods. The nodes handed to callbacks (`each`, `map`)
// and `get()` wear the shape cheerio's domhandler nodes have — `name`, `attribs`, `children`, `data`,
// `type` — since plugins read those straight.
import { select, matches, splitGroups } from './select';

/** A node as cheerio shows it to plugin code. */
export interface DomNode {
  readonly node: Node;
  readonly type: 'tag' | 'text' | 'comment' | 'script' | 'style' | 'root' | 'directive';
  readonly name: string; readonly tagName: string;
  readonly attribs: Record<string, string>;
  readonly data: string; readonly nodeValue: string | null;
  readonly children: DomNode[]; readonly childNodes: DomNode[];
  readonly firstChild: DomNode | null; readonly lastChild: DomNode | null;
  readonly parent: DomNode | null; readonly parentNode: DomNode | null;
  readonly prev: DomNode | null; readonly next: DomNode | null;
  readonly nextSibling: DomNode | null; readonly previousSibling: DomNode | null;
  readonly nodeType: number;
}
const wraps = new WeakMap<Node, DomNode>();
export function wrap(n: Node): DomNode {
  let w = wraps.get(n); if (w) return w;
  const kids = () => Array.from(n.childNodes).map(wrap);
  w = {
    node: n,
    get type() { if (n.nodeType === 3) return 'text'; if (n.nodeType === 8) return 'comment'; if (n.nodeType === 9 || n.nodeType === 11) return 'root'; if (n.nodeType === 10) return 'directive'; const t = (n as Element).tagName.toLowerCase(); return t === 'script' ? 'script' : t === 'style' ? 'style' : 'tag'; },
    get name() { return n.nodeType === 1 ? (n as Element).tagName.toLowerCase() : n.nodeType === 3 ? 'text' : n.nodeType === 8 ? 'comment' : 'root'; },
    get tagName() { return n.nodeType === 1 ? (n as Element).tagName.toLowerCase() : ''; },
    get attribs() { const o: Record<string, string> = {}; if (n.nodeType === 1) for (const a of Array.from((n as Element).attributes)) o[a.name] = a.value; return o; },
    get data() { return n.nodeType === 3 || n.nodeType === 8 ? n.nodeValue ?? '' : ''; },
    get nodeValue() { return n.nodeValue; },
    get children() { return kids(); }, get childNodes() { return kids(); },
    get firstChild() { return n.firstChild ? wrap(n.firstChild) : null; }, get lastChild() { return n.lastChild ? wrap(n.lastChild) : null; },
    get parent() { return n.parentNode ? wrap(n.parentNode) : null; }, get parentNode() { return n.parentNode ? wrap(n.parentNode) : null; },
    get prev() { return n.previousSibling ? wrap(n.previousSibling) : null; }, get next() { return n.nextSibling ? wrap(n.nextSibling) : null; },
    get previousSibling() { return n.previousSibling ? wrap(n.previousSibling) : null; }, get nextSibling() { return n.nextSibling ? wrap(n.nextSibling) : null; },
    get nodeType() { return n.nodeType; },
  } as DomNode;
  wraps.set(n, w);
  return w;
}
const unwrap = (x: unknown): Node | null => {
  if (!x) return null;
  if (x instanceof Node) return x;
  if (typeof x === 'object' && 'node' in (x as object) && (x as DomNode).node instanceof Node) return (x as DomNode).node;
  return null;
};

type Content = string | Node | DomNode | Cheerio | (string | Node | DomNode | Cheerio)[];
type Selector = string | Node | DomNode | Cheerio | Node[] | DomNode[] | ((this: DomNode, i: number, el: DomNode) => boolean);

export interface CheerioAPI {
  (sel?: Selector | null, context?: Selector | null): Cheerio;
  html(x?: Selector): string;
  text(x?: Selector): string;
  root(): Cheerio;
  load: typeof load;
  _root: Node;
  xml(x?: Selector): string;
  contains(container: Node | DomNode, contained: Node | DomNode): boolean;
}

const isHtml = (s: string) => /^\s*</.test(s);
const toText = (nodes: Node[]) => nodes.map((n) => (n.nodeType === 9 ? (n as Document).documentElement?.textContent ?? '' : n.nodeType === 11 ? Array.from(n.childNodes).map((c) => c.textContent ?? '').join('') : n.textContent ?? '')).join('');
const outer = (n: Node): string => {
  if (n.nodeType === 1) return (n as Element).outerHTML;
  if (n.nodeType === 3) { const d = document.createElement('div'); d.append(n.cloneNode()); return d.innerHTML; }
  if (n.nodeType === 8) return `<!--${n.nodeValue ?? ''}-->`;
  if (n.nodeType === 9) { const doc = n as Document; return (doc.doctype ? '<!DOCTYPE html>' : '') + (doc.documentElement?.outerHTML ?? ''); }
  if (n.nodeType === 11) return Array.from(n.childNodes).map(outer).join('');
  return '';
};

export class Cheerio {
  readonly length: number;
  [index: number]: DomNode;
  prevObject?: Cheerio;
  constructor(readonly nodes: Node[], private readonly api: CheerioAPI, readonly values?: unknown[]) {
    this.length = values ? values.length : nodes.length;
    if (values) for (let i = 0; i < values.length; i++) (this as unknown as Record<number, unknown>)[i] = values[i];
    else for (let i = 0; i < nodes.length; i++) this[i] = wrap(nodes[i]);
  }
  private make(nodes: Node[]): Cheerio { const c = new Cheerio(nodes, this.api); c.prevObject = this; return c; }
  private els(): Element[] { return this.nodes.filter((n) => n.nodeType === 1) as Element[]; }
  private firstEl(): Element | null { return this.els()[0] ?? null; }
  [Symbol.iterator](): Iterator<DomNode> { const self = this; let i = 0; return { next: () => (i < self.length ? { value: self[i++], done: false } : { value: undefined as unknown as DomNode, done: true }) }; }

  /* ---------- reading ---------- */
  text(value?: string | ((i: number, old: string) => string)): string | Cheerio {
    if (value !== undefined) { this.els().forEach((e, i) => { e.textContent = typeof value === 'function' ? value(i, e.textContent ?? '') : String(value); }); return this; }
    return toText(this.nodes);
  }
  html(value?: string | ((i: number, old: string) => string)): string | null | Cheerio {
    if (value !== undefined) { this.els().forEach((e, i) => { e.innerHTML = typeof value === 'function' ? value(i, e.innerHTML) : String(value); }); return this; }
    const n = this.nodes[0]; if (!n) return null;
    if (n.nodeType === 1) return (n as Element).innerHTML;
    if (n.nodeType === 9 || n.nodeType === 11) return Array.from(n.childNodes).map(outer).join('');
    return outer(n);
  }
  toString(): string { return this.nodes.map(outer).join(''); }
  attr(name?: string | Record<string, string | null>, value?: string | null | ((i: number, old: string) => string)): string | undefined | Record<string, string> | Cheerio {
    const el = this.firstEl();
    if (name === undefined) return el ? wrap(el).attribs : undefined;
    if (typeof name === 'object') { for (const [k, v] of Object.entries(name)) this.attr(k, v); return this; }
    if (value === undefined) { if (!el) return undefined; const v = el.getAttribute(name); return v === null ? undefined : v; }
    for (const [i, e] of this.els().entries()) { const v = typeof value === 'function' ? value(i, e.getAttribute(name) ?? '') : value; if (v === null) e.removeAttribute(name); else e.setAttribute(name, String(v)); }
    return this;
  }
  removeAttr(name: string): Cheerio { for (const n of name.split(/\s+/)) this.els().forEach((e) => e.removeAttribute(n)); return this; }
  prop(name: string, value?: unknown): unknown {
    const el = this.firstEl();
    if (value !== undefined) { this.els().forEach((e) => { (e as unknown as Record<string, unknown>)[name] = value; }); return this; }
    if (!el) return undefined;
    if (name === 'tagName' || name === 'nodeName') return el.tagName.toUpperCase();
    if (name === 'innerHTML') return el.innerHTML; if (name === 'outerHTML') return el.outerHTML;
    if (name === 'textContent' || name === 'innerText') return el.textContent;
    if (name in el) return (el as unknown as Record<string, unknown>)[name];
    return el.getAttribute(name) ?? undefined;
  }
  data(name?: string, value?: unknown): unknown {
    const el = this.firstEl(); if (!el) return undefined;
    const parse = (v: string): unknown => { if (v === 'true') return true; if (v === 'false') return false; if (v === 'null') return null; if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v); if (/^[{[]/.test(v)) { try { return JSON.parse(v); } catch { return v; } } return v; };
    if (name === undefined) { const o: Record<string, unknown> = {}; for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) o[a.name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = parse(a.value); return o; }
    const attr = 'data-' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    if (value !== undefined) { this.els().forEach((e) => e.setAttribute(attr, typeof value === 'string' ? value : JSON.stringify(value))); return this; }
    const v = el.getAttribute(attr) ?? el.getAttribute('data-' + name); return v === null ? undefined : parse(v);
  }
  val(value?: string): string | undefined | Cheerio {
    const el = this.firstEl() as HTMLInputElement | null;
    if (value !== undefined) { this.els().forEach((e) => { (e as HTMLInputElement).value = value; e.setAttribute('value', value); }); return this; }
    if (!el) return undefined;
    if (el.tagName === 'SELECT') { const o = (el as unknown as HTMLSelectElement).querySelector('option[selected]') ?? (el as unknown as HTMLSelectElement).querySelector('option'); return o ? (o.getAttribute('value') ?? o.textContent ?? '') : undefined; }
    if (el.tagName === 'TEXTAREA') return el.textContent ?? '';
    return el.getAttribute('value') ?? undefined;
  }
  css(name?: string): string | undefined | Record<string, string> {
    const el = this.firstEl(); if (!el) return undefined;
    const style: Record<string, string> = {};
    for (const part of (el.getAttribute('style') ?? '').split(';')) { const i = part.indexOf(':'); if (i > 0) style[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    return name === undefined ? style : style[name];
  }
  hasClass(c: string): boolean { return this.els().some((e) => e.classList.contains(c)); }
  addClass(c: string): Cheerio { const cs = c.split(/\s+/).filter(Boolean); this.els().forEach((e) => e.classList.add(...cs)); return this; }
  removeClass(c?: string): Cheerio { if (c === undefined) { this.els().forEach((e) => e.removeAttribute('class')); return this; } const cs = c.split(/\s+/).filter(Boolean); this.els().forEach((e) => e.classList.remove(...cs)); return this; }
  toggleClass(c: string, state?: boolean): Cheerio { this.els().forEach((e) => e.classList.toggle(c, state)); return this; }

  /* ---------- the set ---------- */
  get(): unknown[]; get(i: number): unknown;
  get(i?: number): unknown {
    if (this.values) return i === undefined ? [...this.values] : this.values[i < 0 ? this.values.length + i : i];
    if (i === undefined) return this.nodes.map(wrap);
    const n = this.nodes[i < 0 ? this.nodes.length + i : i]; return n ? wrap(n) : undefined;
  }
  toArray(): unknown[] { return this.get() as unknown[]; }
  eq(i: number): Cheerio { const n = this.nodes[i < 0 ? this.nodes.length + i : i]; return this.make(n ? [n] : []); }
  first(): Cheerio { return this.make(this.nodes.slice(0, 1)); }
  last(): Cheerio { return this.make(this.nodes.slice(-1)); }
  slice(a?: number, b?: number): Cheerio { return this.make(this.nodes.slice(a, b)); }
  each(fn: (this: DomNode, i: number, el: DomNode) => unknown): Cheerio { for (let i = 0; i < this.nodes.length; i++) { const w = wrap(this.nodes[i]); if (fn.call(w, i, w) === false) break; } return this; }
  map(fn: (this: DomNode, i: number, el: DomNode) => unknown): Cheerio {
    const out: unknown[] = [];
    for (let i = 0; i < this.nodes.length; i++) { const w = wrap(this.nodes[i]); const v = fn.call(w, i, w); if (v === null || v === undefined) continue; if (Array.isArray(v)) out.push(...v); else out.push(v); }
    if (out.every((v) => unwrap(v))) { const c = new Cheerio(out.map((v) => unwrap(v)!), this.api); c.prevObject = this; return c; }
    const c = new Cheerio([], this.api, out); c.prevObject = this; return c;
  }
  index(x?: Selector): number {
    const el = this.nodes[0]; if (!el) return -1;
    if (x === undefined) return el.parentNode ? Array.from(el.parentNode.children ?? []).indexOf(el as Element) : -1;
    if (typeof x === 'string') return this.api(x).nodes.indexOf(el);
    const target = x instanceof Cheerio ? x.nodes[0] : unwrap(x); return target ? this.nodes.indexOf(target) : -1;
  }
  add(x: Selector, context?: Selector): Cheerio { const extra = this.api(x, context).nodes; return this.make(sortNodes([...new Set([...this.nodes, ...extra])])); }
  end(): Cheerio { return this.prevObject ?? new Cheerio([], this.api); }
  addBack(sel?: string): Cheerio { const prev = this.prevObject?.nodes ?? []; return this.make(sortNodes([...new Set([...this.nodes, ...(sel ? prev.filter((n) => n.nodeType === 1 && matches(n as Element, sel)) : prev)])])); }

  /* ---------- filtering ---------- */
  private test(x: Selector): (n: Node, i: number) => boolean {
    if (typeof x === 'function') return (n, i) => { const w = wrap(n); return !!x.call(w, i, w); };
    if (typeof x === 'string') return (n) => n.nodeType === 1 && matches(n as Element, x);
    const set = new Set(x instanceof Cheerio ? x.nodes : Array.isArray(x) ? x.map((y) => unwrap(y)).filter(Boolean) as Node[] : [unwrap(x)].filter(Boolean) as Node[]);
    return (n) => set.has(n);
  }
  filter(x: Selector): Cheerio { const t = this.test(x); return this.make(this.nodes.filter((n, i) => t(n, i))); }
  not(x: Selector): Cheerio { const t = this.test(x); return this.make(this.nodes.filter((n, i) => !t(n, i))); }
  is(x: Selector): boolean { const t = this.test(x); return this.nodes.some((n, i) => t(n, i)); }
  has(x: string | Node | DomNode): Cheerio {
    if (typeof x === 'string') return this.make(this.els().filter((e) => select([e], x).length > 0));
    const target = unwrap(x); return this.make(this.els().filter((e) => !!target && e.contains(target) && e !== target));
  }

  /* ---------- traversal ---------- */
  find(x: string | Cheerio | Node | DomNode): Cheerio {
    if (typeof x === 'string') return this.make(select(this.els(), x));
    const targets = x instanceof Cheerio ? x.nodes : [unwrap(x)].filter(Boolean) as Node[];
    return this.make(targets.filter((t) => this.els().some((e) => e !== t && e.contains(t))));
  }
  children(sel?: string): Cheerio { const out: Node[] = []; for (const e of this.els()) for (const c of Array.from(e.children)) if (!sel || matches(c, sel)) out.push(c); return this.make(out); }
  contents(): Cheerio { const out: Node[] = []; for (const n of this.nodes) out.push(...Array.from(n.childNodes)); return this.make(out); }
  parent(sel?: string): Cheerio { const out: Node[] = []; for (const n of this.nodes) { const p = n.parentNode; if (p && p.nodeType !== 11 && (!sel || (p.nodeType === 1 && matches(p as Element, sel))) && !out.includes(p)) out.push(p); } return this.make(out); }
  parents(sel?: string): Cheerio { const out: Node[] = []; for (const n of this.nodes) { let p = n.parentNode; while (p && p.nodeType === 1) { if ((!sel || matches(p as Element, sel)) && !out.includes(p)) out.push(p); p = p.parentNode; } } return this.make(out); }
  parentsUntil(until?: Selector, filter?: string): Cheerio { const stop = until === undefined ? () => false : this.test(until); const out: Node[] = []; for (const n of this.nodes) { let p = n.parentNode; while (p && p.nodeType === 1 && !stop(p, 0)) { if ((!filter || matches(p as Element, filter)) && !out.includes(p)) out.push(p); p = p.parentNode; } } return this.make(out); }
  closest(sel: string): Cheerio { const out: Node[] = []; for (const n of this.nodes) { let p: Node | null = n.nodeType === 1 ? n : n.parentNode; while (p && p.nodeType === 1) { if (matches(p as Element, sel)) { if (!out.includes(p)) out.push(p); break; } p = p.parentNode; } } return this.make(out); }
  siblings(sel?: string): Cheerio { const out: Node[] = []; for (const e of this.els()) { if (!e.parentNode) continue; for (const s of Array.from(e.parentNode.children)) if (s !== e && (!sel || matches(s, sel)) && !out.includes(s)) out.push(s); } return this.make(out); }
  next(sel?: string): Cheerio { const out: Node[] = []; for (const e of this.els()) { const s = e.nextElementSibling; if (s && (!sel || matches(s, sel))) out.push(s); } return this.make(out); }
  prev(sel?: string): Cheerio { const out: Node[] = []; for (const e of this.els()) { const s = e.previousElementSibling; if (s && (!sel || matches(s, sel))) out.push(s); } return this.make(out); }
  nextAll(sel?: string): Cheerio { const out: Node[] = []; for (const e of this.els()) { let s = e.nextElementSibling; while (s) { if (!sel || matches(s, sel)) out.push(s); s = s.nextElementSibling; } } return this.make(out); }
  prevAll(sel?: string): Cheerio { const out: Node[] = []; for (const e of this.els()) { let s = e.previousElementSibling; while (s) { if (!sel || matches(s, sel)) out.push(s); s = s.previousElementSibling; } } return this.make(out); }
  nextUntil(until?: Selector, filter?: string): Cheerio { const stop = until === undefined ? () => false : this.test(until); const out: Node[] = []; for (const e of this.els()) { let s = e.nextElementSibling; while (s && !stop(s, 0)) { if (!filter || matches(s, filter)) out.push(s); s = s.nextElementSibling; } } return this.make(out); }
  prevUntil(until?: Selector, filter?: string): Cheerio { const stop = until === undefined ? () => false : this.test(until); const out: Node[] = []; for (const e of this.els()) { let s = e.previousElementSibling; while (s && !stop(s, 0)) { if (!filter || matches(s, filter)) out.push(s); s = s.previousElementSibling; } } return this.make(out); }

  /* ---------- editing ---------- */
  private materialize(content: Content | ((i: number, html: string) => Content), i: number, el: Element, clone: boolean): Node[] {
    const c = typeof content === 'function' ? content(i, el.innerHTML) : content;
    const list = Array.isArray(c) ? c : [c];
    const out: Node[] = [];
    for (const item of list) {
      if (typeof item === 'string') { const t = document.createElement('template'); t.innerHTML = item; out.push(...Array.from(t.content.childNodes)); }
      else if (item instanceof Cheerio) out.push(...item.nodes.map((n) => (clone ? n.cloneNode(true) : n)));
      else { const n = unwrap(item); if (n) out.push(clone ? n.cloneNode(true) : n); }
    }
    return out;
  }
  append(...contents: (Content | ((i: number, html: string) => Content))[]): Cheerio { const els = this.els(); els.forEach((e, i) => { for (const c of contents) e.append(...this.materialize(c, i, e, i < els.length - 1)); }); return this; }
  prepend(...contents: (Content | ((i: number, html: string) => Content))[]): Cheerio { const els = this.els(); els.forEach((e, i) => { for (const c of contents) e.prepend(...this.materialize(c, i, e, i < els.length - 1)); }); return this; }
  before(...contents: (Content | ((i: number, html: string) => Content))[]): Cheerio { const els = this.els(); els.forEach((e, i) => { for (const c of contents) e.before(...this.materialize(c, i, e, i < els.length - 1)); }); return this; }
  after(...contents: (Content | ((i: number, html: string) => Content))[]): Cheerio { const els = this.els(); els.forEach((e, i) => { for (const c of contents) e.after(...this.materialize(c, i, e, i < els.length - 1)); }); return this; }
  replaceWith(content: Content | ((i: number, html: string) => Content)): Cheerio { const els = this.els(); els.forEach((e, i) => { e.replaceWith(...this.materialize(content, i, e, i < els.length - 1)); }); return this; }
  remove(sel?: string): Cheerio { for (const n of this.nodes) { if (sel && !(n.nodeType === 1 && matches(n as Element, sel))) continue; if (n.parentNode) n.parentNode.removeChild(n); } return this; }
  empty(): Cheerio { this.els().forEach((e) => e.replaceChildren()); return this; }
  clone(): Cheerio { return this.make(this.nodes.map((n) => n.cloneNode(true))); }
  wrap(content: Content): Cheerio { this.els().forEach((e, i) => { const [w] = this.materialize(content, i, e, true); if (w && w.nodeType === 1) { e.replaceWith(w); let inner: Element = w as Element; while (inner.firstElementChild) inner = inner.firstElementChild; inner.append(e); } }); return this; }
  unwrap(): Cheerio { this.els().forEach((e) => { const p = e.parentNode; if (p && p.nodeType === 1 && p.parentNode) (p as Element).replaceWith(...Array.from(p.childNodes)); }); return this; }
  wrapInner(content: Content): Cheerio { this.els().forEach((e, i) => { const [w] = this.materialize(content, i, e, true); if (w && w.nodeType === 1) { (w as Element).append(...Array.from(e.childNodes)); e.append(w); } }); return this; }
  serialize(): string { return this.els().filter((e) => e.tagName === 'FORM').flatMap((f) => Array.from(f.querySelectorAll('input[name], select[name], textarea[name]'))).map((i) => `${encodeURIComponent(i.getAttribute('name')!)}=${encodeURIComponent((i as HTMLInputElement).value ?? i.getAttribute('value') ?? '')}`).join('&'); }
}

function sortNodes(nodes: Node[]): Node[] {
  return nodes.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
}

/** cheerio.load: `$` over the document the HTML makes (a fragment when `isDocument` is false). */
export function load(html: string | Node, options?: { xmlMode?: boolean; xml?: boolean | object } | null, isDocument = true): CheerioAPI {
  let root: Node;
  if (html instanceof Node) root = html;
  else if (options && (options.xmlMode || options.xml)) root = new DOMParser().parseFromString(String(html), 'text/xml');
  else if (isDocument === false) { const t = document.createElement('template'); t.innerHTML = String(html); root = t.content; }
  else root = new DOMParser().parseFromString(String(html), 'text/html');
  const api = ((sel?: Selector | null, context?: Selector | null): Cheerio => {
    if (sel === undefined || sel === null || sel === '') return new Cheerio([], api);
    if (sel instanceof Cheerio) return new Cheerio([...sel.nodes], api);
    if (typeof sel === 'function') return new Cheerio([], api);
    if (typeof sel === 'string') {
      if (isHtml(sel)) { const t = document.createElement('template'); t.innerHTML = sel; return new Cheerio(Array.from(t.content.childNodes), api); }
      let roots: (Element | Document | DocumentFragment)[];
      if (context === undefined || context === null) roots = [root as Element];
      else if (typeof context === 'string') roots = select([root as Element], context);
      else if (context instanceof Cheerio) roots = context.nodes.filter((n) => n.nodeType === 1 || n.nodeType === 9 || n.nodeType === 11) as Element[];
      else { const n = unwrap(context); roots = n ? [n as Element] : []; }
      return new Cheerio(select(roots, sel), api);
    }
    if (Array.isArray(sel)) return new Cheerio(sel.map((x) => unwrap(x)).filter(Boolean) as Node[], api);
    const n = unwrap(sel); return new Cheerio(n ? [n] : [], api);
  }) as CheerioAPI;
  api._root = root;
  api.root = () => new Cheerio([root], api);
  api.html = (x?: Selector) => (x === undefined ? outer(root) : api(x).toString());
  api.xml = api.html;
  api.text = (x?: Selector) => (x === undefined ? toText([root]) : (api(x).text() as string));
  api.load = load;
  api.contains = (a, b) => { const x = unwrap(a), y = unwrap(b); return !!x && !!y && x !== y && x.contains(y); };
  return api;
}

export const cheerio = { load, Cheerio, splitGroups };
