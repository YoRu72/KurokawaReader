// Furigana for ordinary Japanese books: readings come from the kuromoji
// morphological analyser and its IPADIC dictionary, which the reader downloads once (src/readingdict.ts: a button
// in the notice over the book and in the options) and keeps on the device; the analyser is built from that copy, so
// it works offline afterwards. Paragraphs are annotated lazily as they scroll into view; a setting hides or
// shows the readings instantly (the ruby stays in the DOM).
import { diagEvent } from './diag';
import { onDictVerify, shortDetail, requireDict, dictScriptUrl, withLocalKuromoji, onDictForget, missingDict, loadFailed, withTimeout, abandonLocalKuromoji, KUROMOJI_DICT, KUROMOJI_CDN_JS } from './readingdict';

interface Token { surface_form: string; reading?: string; word_type: string }
interface Tokenizer { tokenize(text: string): Token[] }
interface KuromojiGlobal { builder(o: { dicPath: string }): { build(cb: (err: Error | null, tk: Tokenizer) => void): void } }

let tokenizerPromise: Promise<Tokenizer> | null = null;
/** This session: building from the copy on the device failed, so the way before 0.64.2 (straight from the CDN) is used. */
let storedBroken = false;
export function furiganaReady(): boolean { return !!tokenizerPromise; }
onDictForget('ja', () => { tokenizerPromise = null; storedBroken = false; });
/** After a download: build the analyser from the copy on the device (no CDN fallback) and read 日本語 → にほんご; anything else throws,
 *  and the download is not called done. The analyser built is kept for the readings. */
onDictVerify('ja', async () => {
  try {
    const tk = await withTimeout(buildStored(), 'self-check');
    const got = tk.tokenize('日本語').map((x) => x.reading ?? '').join('');
    if (kataToHira(got) !== 'にほんご') throw new Error(`self-check: 日本語 read as «${got || 'nothing'}»`);
    tokenizerPromise ??= Promise.resolve(tk);
  } catch (e) { abandonLocalKuromoji(); throw e; }
});

const loadScript = (src: string, revoke = false): Promise<void> => new Promise<void>((res, rej) => {
  const sc = document.createElement('script'); sc.src = src;
  sc.onload = () => { if (revoke) URL.revokeObjectURL(src); res(); }; sc.onerror = () => { if (revoke) URL.revokeObjectURL(src); sc.remove(); rej(new Error('kuromoji script')); };
  document.head.appendChild(sc);
});
const kuromoji = () => (window as unknown as { kuromoji?: KuromojiGlobal }).kuromoji;
const build = (dicPath: string) => new Promise<Tokenizer>((res, rej) => kuromoji()!.builder({ dicPath }).build((err, tk) => (err ? rej(err) : res(tk))));

/** From the copy on the device: its script, and the dictionary files answered from the cache. */
async function buildStored(onStatus?: (s: string) => void): Promise<Tokenizer> {
  onStatus?.('script');
  if (!kuromoji()) await loadScript(await dictScriptUrl('ja'), true);
  if (!kuromoji()) throw new Error('kuromoji missing');
  onStatus?.('dict');
  return withLocalKuromoji(() => build(KUROMOJI_DICT));
}
/** The way before 0.64.2: the script and the dictionary straight from the CDN (online only). */
async function buildFromCdn(): Promise<Tokenizer> {
  if (!kuromoji()) await loadScript(KUROMOJI_CDN_JS);
  if (!kuromoji()) throw new Error('kuromoji missing');
  return build(KUROMOJI_DICT);
}

/** Builds the analyser from the dictionary on the device (once). Rejects with 'dict-missing' while it is not downloaded.
 *  If the copy on the device cannot be built from (script error, a loader that never answers, a file that will not
 *  unzip), the old way is tried once when online; when that fails too, or offline, 'dict-load' (the state says why). */
export function ensureTokenizer(onStatus?: (s: string) => void): Promise<Tokenizer> {
  tokenizerPromise ??= (async () => {
    await requireDict('ja');
    if (!storedBroken) {
      try { return await withTimeout(buildStored(onStatus), 'stored dictionary'); }
      catch (e) { abandonLocalKuromoji(); if (missingDict(e)) throw e; storedBroken = true; console.warn('kuromoji from the stored copy failed', e); diagEvent('dict', { kind: 'ja', fail: 'stored', detail: shortDetail(e) }); }
    }
    if (navigator.onLine === false) throw loadFailed('ja', new Error('offline'));
    try { return await withTimeout(buildFromCdn(), 'dictionary from the CDN'); }
    catch (e) { throw loadFailed('ja', e); }
  })();
  tokenizerPromise.catch(() => { tokenizerPromise = null; });
  return tokenizerPromise;
}

const KANJI = /[㐀-鿿豈-﫿々]/;
const kataToHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Looks like Japanese: kana present, or kanji without Chinese-only punctuation. */
export function isJapanese(text: string, lang?: string): boolean {
  if (lang && /^ja/i.test(lang)) return true;
  if (lang && /^zh/i.test(lang)) return false;
  return /[぀-ヿ]/.test(text);
}

/** Wrap the kanji of a token in <ruby>, each run of kanji with its own reading: the kana between and around
 *  them (okurigana: 取り扱い → 取[と]り扱[あつか]い) stay outside, matched against the reading; a token the
 *  reading cannot be split along is given one reading over its kanji part, as before. */
function rubyFor(surface: string, readingKata: string): Node {
  const reading = kataToHira(readingKata);
  if (!KANJI.test(surface) || !reading || reading === kataToHira(surface)) return document.createTextNode(surface);
  // The token in runs: kanji, and the rest (kana, signs).
  const runs = surface.match(new RegExp(`${KANJI.source}+|[^${KANJI.source.slice(1, -1)}]+`, 'g')) ?? [surface];
  if (runs.length > 1) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${runs.map((r) => (KANJI.test(r) ? '(.+?)' : `(${esc(kataToHira(r))})`)).join('')}$`);
    const m = re.exec(reading);
    if (m) {
      const frag = document.createDocumentFragment();
      runs.forEach((r, i) => {
        if (!KANJI.test(r)) { frag.appendChild(document.createTextNode(r)); return; }
        const ruby = document.createElement('ruby'); ruby.appendChild(document.createTextNode(r));
        const rt = document.createElement('rt'); rt.textContent = m[i + 1]; ruby.appendChild(rt);
        frag.appendChild(ruby);
      });
      return frag;
    }
  }
  // common trailing kana (okurigana) and leading kana stay outside the ruby
  let head = 0; while (head < surface.length && !KANJI.test(surface[head]) && reading[head] === kataToHira(surface[head])) head++;
  let tail = 0; while (tail < surface.length - head && !KANJI.test(surface[surface.length - 1 - tail]) && reading[reading.length - 1 - tail] === kataToHira(surface[surface.length - 1 - tail])) tail++;
  const base = surface.slice(head, surface.length - tail);
  const rt = reading.slice(head, reading.length - tail);
  if (!base || !rt) return document.createTextNode(surface);
  const frag = document.createDocumentFragment();
  if (head) frag.appendChild(document.createTextNode(surface.slice(0, head)));
  const ruby = document.createElement('ruby');
  ruby.appendChild(document.createTextNode(base));
  const rtEl = document.createElement('rt'); rtEl.textContent = rt; ruby.appendChild(rtEl);
  frag.appendChild(ruby);
  if (tail) frag.appendChild(document.createTextNode(surface.slice(surface.length - tail)));
  return frag;
}

/** Annotate every kanji-bearing text node under `root` that is not already inside <ruby>. */
export function annotate(root: HTMLElement, tk: Tokenizer): void {
  if (root.dataset.furi) return;
  root.dataset.furi = '1';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (KANJI.test(n.textContent ?? '') && !(n.parentElement?.closest('ruby, rt, rp, code, pre')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const nodes: Text[] = []; let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.textContent ?? '';
    const frag = document.createDocumentFragment();
    for (const tok of tk.tokenize(text)) frag.appendChild(tok.reading ? rubyFor(tok.surface_form, tok.reading) : document.createTextNode(tok.surface_form));
    node.replaceWith(frag);
  }
}

/** Annotates blocks as they come into view; returns a disposer. */
export function attachFurigana(scroll: HTMLElement, blocks: () => HTMLElement[], onError?: (e: Error) => void): () => void {
  let tk: Tokenizer | null = null; let disposed = false;
  const io = new IntersectionObserver((entries) => { if (!tk) return; for (const e of entries) if (e.isIntersecting) { annotate(e.target as HTMLElement, tk); io.unobserve(e.target); } }, { root: scroll, rootMargin: '120% 0px' });
  ensureTokenizer().then((t) => { if (disposed) return; tk = t; blocks().forEach((b) => { if (!b.dataset.furi) io.observe(b); }); }).catch((e) => onError?.(e as Error));
  const refresh = () => { if (tk) blocks().forEach((b) => { if (!b.dataset.furi) io.observe(b); }); };
  return Object.assign(() => { disposed = true; io.disconnect(); }, { refresh });
}
