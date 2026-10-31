// htmlparser2's Parser for the plugins that stream a page: the handler's onopentag/ontext/onclosetag are
// called in document order, from the browser's own parse of what was written. The implied html/head/body of
// a fragment are not reported, as htmlparser2 would not report tags the source does not have.

export interface Handler {
  onopentag?(name: string, attribs: Record<string, string>): void;
  onopentagname?(name: string): void;
  onattribute?(name: string, value: string): void;
  ontext?(data: string): void;
  onclosetag?(name: string, isImplied?: boolean): void;
  oncomment?(data: string): void;
  oncommentend?(): void;
  onprocessinginstruction?(name: string, data: string): void;
  onend?(): void;
  onreset?(): void;
  onerror?(e: Error): void;
  onparserinit?(parser: Parser): void;
}

export class Parser {
  private ended = false;
  constructor(private readonly handler: Handler = {}, readonly options: { decodeEntities?: boolean; lowerCaseTags?: boolean; xmlMode?: boolean } = {}) { handler.onparserinit?.(this); }
  write(chunk: string): void { if (this.ended) throw new Error('.write() after done!'); if (chunk) this.walkHtml(String(chunk)); }
  end(chunk?: string): void { if (chunk) this.write(chunk); this.ended = true; this.handler.onend?.(); }
  parseComplete(data: string): void { this.reset(); this.end(data); }
  reset(): void { this.ended = false; this.handler.onreset?.(); }
  pause(): void { /* the whole chunk is reported at once */ }
  resume(): void { /* likewise */ }
  parseChunk(chunk: string): void { this.write(chunk); }
  done(chunk?: string): void { this.end(chunk); }

  private walkHtml(html: string): void {
    const h = this.handler;
    if (this.options.xmlMode) {
      const doc = new DOMParser().parseFromString(html, 'text/xml');
      for (const n of Array.from(doc.childNodes)) this.walk(n);
      return;
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.doctype) h.onprocessinginstruction?.('!doctype', `!DOCTYPE ${doc.doctype.name}`);
    const hasHtml = /<html[\s>]/i.test(html), hasHead = /<head[\s>]/i.test(html), hasBody = /<body[\s>]/i.test(html);
    const root = doc.documentElement;
    if (hasHtml) { this.open(root); }
    for (const part of [doc.head, doc.body]) {
      if (!part) continue;
      const explicit = part === doc.head ? hasHead : hasBody;
      if (explicit) this.open(part);
      for (const n of Array.from(part.childNodes)) this.walk(n);
      if (explicit) this.close(part);
    }
    if (hasHtml) this.close(root);
  }
  private open(el: Element): void {
    const name = el.tagName.toLowerCase(); const attribs: Record<string, string> = {};
    this.handler.onopentagname?.(name);
    for (const a of Array.from(el.attributes)) { attribs[a.name] = a.value; this.handler.onattribute?.(a.name, a.value); }
    this.handler.onopentag?.(name, attribs);
  }
  private close(el: Element): void { this.handler.onclosetag?.(el.tagName.toLowerCase()); }
  private walk(n: Node): void {
    if (n.nodeType === 3) { if (n.nodeValue) this.handler.ontext?.(n.nodeValue); return; }
    if (n.nodeType === 8) { this.handler.oncomment?.(n.nodeValue ?? ''); this.handler.oncommentend?.(); return; }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    this.open(el);
    for (const c of Array.from(el.childNodes)) this.walk(c);
    this.close(el);
  }
}

export const htmlparser2 = { Parser };
