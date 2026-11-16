// The text editor of Files (and of «Edit with Kurokawa»): the file's characters told from its bytes and written back the
// very way — never spoilt (src/views/textCodec.ts) —, with line numbers, find and replace (plain or pattern, case, whole
// word, counted, undone), go to line, wrapping, the font's size, the character set (read again as…, saved as…), the
// line endings (kept, or turned to LF / CRLF), and a big file shown read-only, a part at a time. Subtitle files
// (.ass .srt …) are not monospace and each line follows its own direction.
import { h, icon, iconButton, toast, openSheet, pickSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { dirtyGuard } from '../ui/undo';
import { decodeText, decodeAs, encodeText, charsetName, canWrite, detectEol, toLf, withEol, type Charset, type Eol, type Decoded } from './textCodec';
import type { Entry } from './files';
import type { EditorIo } from './filesMore';

/* ---------- find and replace (pure) ---------- */
export interface FindOpts { q: string; regex: boolean; matchCase: boolean; word: boolean }
export interface Hit { i: number; len: number; m: RegExpExecArray }
const WORD_U = '[\\p{L}\\p{N}_]';
/** The pattern asked for: null for nothing typed, 'bad' for a pattern that does not parse. */
export function buildRe(o: FindOpts): RegExp | null | 'bad' {
  if (!o.q) return null;
  const body = o.regex ? o.q : o.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = o.matchCase ? 'g' : 'gi';
  try { return new RegExp(o.word ? `(?<!${WORD_U})(?:${body})(?!${WORD_U})` : body, flags + 'u'); } catch { /* retry without «u» */ }
  try { return new RegExp(o.word ? `(?<![\\w])(?:${body})(?![\\w])` : body, flags); } catch { return 'bad'; }
}
/** Every match, in order (an empty match moves on one character; at most `cap`). */
export function findAll(text: string, re: RegExp, cap = 100000): Hit[] {
  const out: Hit[] = []; re.lastIndex = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < cap) { out.push({ i: m.index, len: m[0].length, m }); if (m[0].length === 0) re.lastIndex++; }
  return out;
}
/** A replacement's text for a match: literal for a plain search; $1 $& $<name> $$ for a pattern. */
export const expand = (m: RegExpExecArray, repl: string, regex: boolean): string => (!regex ? repl : repl.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (_x, k: string) => (k === '$' ? '$' : k === '&' ? m[0] : k[0] === '<' ? (m.groups?.[k.slice(1, -1)] ?? '') : (m[+k] ?? ''))));
export function replaceAll(text: string, hits: Hit[], repl: string, regex: boolean): string {
  let out = '', at = 0; for (const x of hits) { out += text.slice(at, x.i) + expand(x.m, repl, regex); at = x.i + x.len; } return out + text.slice(at);
}
/** The pixel height of the text before an index in a textarea (a hidden copy laid out the same way). */
function caretTop(ta: HTMLTextAreaElement, idx: number): number {
  const cs = getComputedStyle(ta); const d = document.createElement('div');
  d.style.cssText = `position:absolute;visibility:hidden;top:0;left:-9999px;white-space:${cs.whiteSpace};overflow-wrap:break-word;width:${ta.clientWidth}px;font:${cs.font};padding:${cs.padding};box-sizing:border-box;letter-spacing:${cs.letterSpacing};unicode-bidi:${cs.unicodeBidi};direction:${cs.direction};tab-size:${cs.tabSize}`;
  d.textContent = ta.value.slice(0, idx); const s = document.createElement('span'); s.textContent = '.'; d.append(s); document.body.append(d); const top = s.offsetTop; d.remove(); return top;
}
const FONT_KEY = 'kt.files.editorFont'; const FONTS = [12, 13, 14, 16, 18, 20, 24];
const fontNow = (): number => { try { const n = Number(localStorage.getItem(FONT_KEY)); return FONTS.includes(n) ? n : 14; } catch { return 14; } };
const CHARSETS: [string, Charset, boolean][] = [['UTF-8', 'utf-8', false], ['UTF-8 BOM', 'utf-8', true], ['UTF-16 LE', 'utf-16le', true], ['UTF-16 BE', 'utf-16be', true], ['Windows-1256', 'windows-1256', false], ['Windows-1252', 'windows-1252', false], ['Shift_JIS', 'shift_jis', false]];
const SUBTITLE = /\.(ass|ssa|srt|vtt|sub|lrc)$/i; const PART = 500_000;
const eolName = (e: Eol): string => (e === 'crlf' ? 'CRLF' : e === 'cr' ? 'CR' : e === 'mixed' ? t('filesEolMixed') : 'LF');

export async function openEditor(e: Entry, refresh: () => void, io: EditorIo | null, onClose: (() => void) | undefined, pl: { filesWrite(o: { path: string; text: string }): Promise<unknown>; filesHead(o: { path: string; max?: number }): Promise<{ text: string; size: number }>; openWith(o: { path: string; mime: string; title: string }): Promise<void> }): Promise<void> {
  const sh = openSheet(e.name, t('close'), { onClose: () => { for (const f of cleanup.splice(0)) f(); onClose?.(); }, beforeClose: dirtyGuard(() => dirty(), () => doSave(), () => e.name) });
  const cleanup: (() => void)[] = []; sh.el.classList.add('files-editor');
  const ta = h('textarea', { class: 'files-ta' + (SUBTITLE.test(e.name) ? ' sub' : ''), dir: 'auto', spellcheck: 'false' }) as HTMLTextAreaElement; let original = '';
  ta.style.fontSize = `${fontNow()}px`;
  const status = h('small', { class: 'src files-ed-status' });
  let enc: { charset: Charset; bom: boolean } | null = null; let eol: Eol = 'lf'; let rawBytes: Uint8Array | null = null; let rawWhole = true; let big: { next: number; size: number } | null = null; let forced: Eol | null = null;
  const dirty = () => !ta.readOnly && (ta.value !== original || !!pendingEnc || (forced !== null && forced !== eol));
  let pendingEnc: { charset: Charset; bom: boolean } | null = null;
  const refreshSave = () => { save.disabled = ta.readOnly || !dirty(); };
  const outEol = (): Eol => forced ?? (eol === 'mixed' ? 'lf' : eol);
  const doSave = async (): Promise<boolean> => { try {
    if (ta.readOnly) return false;
    const text = withEol(ta.value, outEol());
    if (io) { const target = pendingEnc ?? enc; const b = target ? encodeText(text, target.charset, target.bom) : null; if (!b || !io.write) { toast(target && !b ? t('owCharsetCannot', { cs: charsetName(target.charset) }) : t('filesReadOnly'), 'error', 4000); return false; } await io.write(b); if (pendingEnc) { enc = pendingEnc; pendingEnc = null; } if (forced) { eol = forced; forced = null; } rawBytes = b; }
    else await pl.filesWrite({ path: e.path, text });
    original = ta.value; refreshSave(); paintStatus(); toast(t('filesSaved')); refresh(); return true; } catch (err) { toast(String((err as Error).message ?? err), 'error'); return false; } };
  const save = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => void doSave() }, icon('check'), t('save')) as HTMLButtonElement;
  const paintStatus = () => {
    const cs = pendingEnc ?? enc;
    status.textContent = [`${localDigits(ta.value.length)} ${t('filesChars')}`, cs ? `${charsetName(cs.charset)}${cs.bom && cs.charset === 'utf-8' ? ' BOM' : ''}` : '', io ? eolName(forced ?? eol) : '', io?.caption ?? ''].filter(Boolean).join(' · ');
  };

  // ---- the toolbar
  const tools = h('div', { class: 'row files-ed-tools' });
  const toggle = (btn: HTMLButtonElement, on: boolean) => { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); };
  const gutter = h('div', { class: 'files-ed-gutter', 'aria-hidden': 'true', dir: 'ltr', hidden: true }); const wrap = h('div', { class: 'files-ed-wrap' }, gutter, ta);
  let numbers = false; let wrapOn = true;
  const sizeGutter = () => { gutter.style.fontSize = ta.style.fontSize; };
  const paintNumbers = () => {
    if (!numbers) return; const n = ta.value.split('\n').length;
    if (n > 30000) { numbers = false; gutter.hidden = true; toggle(numBtn, false); toast(t('filesLineNumbersBig')); return; }
    let s = ''; for (let i = 1; i <= n; i++) s += (i > 1 ? '\n' : '') + i; if (gutter.firstChild?.textContent !== s) gutter.textContent = s; gutter.scrollTop = ta.scrollTop; sizeGutter();
  };
  const setWrap = (on: boolean) => { wrapOn = on; ta.classList.toggle('nowrap', !on); toggle(wrapBtn, on); if (on && numbers) setNumbers(false); };
  const setNumbers = (on: boolean) => { numbers = on; gutter.hidden = !on; toggle(numBtn, on); if (on) { if (wrapOn) { setWrap(false); toast(t('filesLineNumbersWrap')); } paintNumbers(); } };
  const wrapBtn = iconButton('wrapText', t('filesWrap'), () => setWrap(!wrapOn));
  const numBtn = iconButton('list', t('filesLineNumbers'), () => setNumbers(!numbers));
  const monoBtn = iconButton('type', t('filesMono'), () => { ta.classList.toggle('mono'); toggle(monoBtn, ta.classList.contains('mono')); if (numbers) paintNumbers(); });
  const findBtn = iconButton('search', t('filesFind'), () => { panel.hidden = !panel.hidden; toggle(findBtn, !panel.hidden); if (!panel.hidden) { findIn.focus(); recount(); } });
  const gotoBtn = iconButton('hash', t('filesGoToLine'), () => goToSheet());
  const moreBtn = iconButton('more', t('more'), () => moreSheet());
  toggle(wrapBtn, true); toggle(numBtn, false); toggle(monoBtn, false); toggle(findBtn, false);
  tools.append(findBtn, gotoBtn, numBtn, wrapBtn, monoBtn, moreBtn);

  // ---- find and replace
  const opts: FindOpts = { q: '', regex: false, matchCase: false, word: false };
  const findIn = h('input', { type: 'search', class: 'files-find-in', placeholder: t('filesFind'), dir: 'auto', 'aria-label': t('filesFind') }) as HTMLInputElement;
  const replIn = h('input', { type: 'text', class: 'files-find-in', placeholder: t('filesReplaceWith'), dir: 'auto', 'aria-label': t('filesReplaceWith') }) as HTMLInputElement;
  const countEl = h('small', { class: 'src files-find-count', 'aria-live': 'polite' });
  const chip = (label: string, key: 'regex' | 'matchCase' | 'word', cls: string) => { const b = h('button', { type: 'button', class: `chip small files-find-opt ${cls}`, 'aria-pressed': 'false', title: label, 'aria-label': label, onclick: () => { opts[key] = !opts[key]; b.classList.toggle('on', opts[key]); b.setAttribute('aria-pressed', String(opts[key])); recount(); } }, label === t('filesRegex') ? '.*' : label === t('filesMatchCase') ? 'Aa' : 'ab|') as HTMLButtonElement; return b; };
  let hits: Hit[] = []; let bad = false; let cur = -1;
  const recount = () => {
    opts.q = findIn.value; const re = buildRe(opts); bad = re === 'bad'; hits = re && re !== 'bad' ? findAll(ta.value, re) : []; cur = -1;
    countEl.textContent = bad ? t('filesFindBad') : opts.q ? t('filesFindCount', { n: localDigits(hits.length) }) : ''; countEl.classList.toggle('bad', bad);
    prev.disabled = next.disabled = !hits.length; rep1.disabled = repAll.disabled = !hits.length || ta.readOnly;
  };
  const show = (k: number) => { if (!hits.length) return; cur = (k + hits.length) % hits.length; const x = hits[cur]; ta.focus({ preventScroll: true }); ta.setSelectionRange(x.i, x.i + x.len); ta.scrollTop = Math.max(0, caretTop(ta, x.i) - ta.clientHeight / 3); if (numbers) gutter.scrollTop = ta.scrollTop; };
  const fromCaret = (): number => { const at = ta.selectionStart; const k = hits.findIndex((x) => x.i >= at); return k < 0 ? 0 : k; };
  const next = iconButton('chevronDown', t('filesFindNext'), () => show(cur >= 0 && ta.selectionStart === hits[cur]?.i ? cur + 1 : fromCaret())) as HTMLButtonElement;
  const prev = iconButton('chevronUp', t('filesFindPrev'), () => { const at = ta.selectionStart; let k = -1; for (let i = hits.length - 1; i >= 0; i--) if (hits[i].i < at) { k = i; break; } show(k < 0 ? hits.length - 1 : k); }) as HTMLButtonElement;
  // (Edits made here are kept on a stack of their own — the textarea's own undo is lost when its text is set —: Undo takes the last back.)
  const undoStack: { v: string; s: number; e: number }[] = [];
  const undoBtn = h('button', { type: 'button', class: 'btn text small', disabled: true, onclick: () => { const u = undoStack.pop(); if (!u) return; ta.value = u.v; ta.setSelectionRange(u.s, u.e); afterEdit(); undoBtn.disabled = !undoStack.length; } }, icon('rewind'), t('undo')) as HTMLButtonElement;
  const setText = (v: string, s: number, e2: number) => { undoStack.push({ v: ta.value, s: ta.selectionStart, e: ta.selectionEnd }); if (undoStack.length > 50) undoStack.shift(); ta.value = v; ta.setSelectionRange(s, e2); undoBtn.disabled = false; afterEdit(); };
  const afterEdit = () => { refreshSave(); paintStatus(); paintNumbers(); recount(); };
  const rep1 = h('button', { type: 'button', class: 'btn tonal small', disabled: true, onclick: () => {
    if (!hits.length || ta.readOnly) return; const s0 = ta.selectionStart, e0 = ta.selectionEnd; const k = hits.findIndex((x) => x.i === s0 && x.i + x.len === e0);
    if (k < 0) { show(fromCaret()); return; } const x = hits[k]; const r = expand(x.m, replIn.value, opts.regex); const v = ta.value.slice(0, x.i) + r + ta.value.slice(x.i + x.len);
    setText(v, x.i + r.length, x.i + r.length); if (hits.length) { const at = hits.findIndex((y) => y.i >= x.i + r.length); show(at < 0 ? 0 : at); }
  } }, t('replace')) as HTMLButtonElement;
  const repAll = h('button', { type: 'button', class: 'btn tonal small', disabled: true, onclick: () => { if (!hits.length || ta.readOnly) return; const n = hits.length; setText(replaceAll(ta.value, hits, replIn.value, opts.regex), 0, 0); toast(t('filesReplaced', { n: localDigits(n) })); } }, t('filesReplaceAll')) as HTMLButtonElement;
  findIn.addEventListener('input', recount); findIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); show(ev.shiftKey ? cur - 1 : cur >= 0 ? cur + 1 : fromCaret()); } });
  const panel = h('div', { class: 'files-find', hidden: true },
    h('div', { class: 'files-find-row' }, findIn, prev, next),
    h('div', { class: 'files-find-row' }, replIn),
    h('div', { class: 'files-find-row opts' }, chip(t('filesMatchCase'), 'matchCase', 'case'), chip(t('filesWholeWord'), 'word', 'word'), chip(t('filesRegex'), 'regex', 'rx'), countEl),
    h('div', { class: 'files-find-row acts' }, rep1, repAll, undoBtn));

  // ---- go to line
  const goToSheet = () => {
    const n = ta.value.split('\n').length; const g = openSheet(t('filesGoToLine'), t('cancel'), { stack: true });
    const inp = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', class: 'files-goto', dir: 'ltr', 'aria-label': t('filesGoToLine'), placeholder: t('filesGoToLineRange', { n: localDigits(n) }) }) as HTMLInputElement;
    const go = () => { const k = Math.max(1, Math.min(n, parseInt(inp.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), 10) || 1)); g.close(); let idx = 0; for (let i = 1; i < k; i++) idx = ta.value.indexOf('\n', idx) + 1; ta.focus({ preventScroll: true }); ta.setSelectionRange(idx, idx); ta.scrollTop = Math.max(0, caretTop(ta, idx) - ta.clientHeight / 3); if (numbers) gutter.scrollTop = ta.scrollTop; };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
    g.body.append(h('label', { class: 'field' }, h('span', null, t('filesGoToLineRange', { n: localDigits(n) })), inp)); g.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: go }, icon('check'), t('filesGo'))); setTimeout(() => inp.focus(), 60);
  };

  // ---- the more sheet: font size, character set, line endings
  const applyDecoded = (d: Decoded, whole: boolean) => {
    original = ''; ta.value = d.text; enc = { charset: d.charset, bom: d.bom }; pendingEnc = null; forced = null; eol = detectEol(d.text); const lf = toLf(d.text); ta.value = lf; original = lf; undoStack.length = 0; undoBtn.disabled = true;
    const unsafe = !d.safe || !io?.write; ta.readOnly = unsafe || eol === 'mixed' || !!big; notice.hidden = !ta.readOnly;
    notice.textContent = !io?.write ? t('owReadOnlyLink') : big ? t('filesBigNotice', { size: formatBytes(big.size) }) : !whole || d.why === 'partial' ? t('owTooBigReadOnly', { size: formatBytes(rawBytes?.length ?? 0) }) : d.why === 'binary' ? t('owBinaryReadOnly') : !d.safe ? t('owCharsetReadOnly') : eol === 'mixed' ? t('filesEolMixedNotice') : '';
    afterEdit();
  };
  const reopenAs = async (cs: Charset, bom: boolean) => {
    if (!rawBytes) return;
    if (dirty()) { const ok = await new Promise<boolean>((res) => { const q = openSheet(t('unsavedTitle'), t('cancel'), { stack: true, onClose: () => res(false) }); q.body.append(h('p', null, t('filesDiscardReopen', { cs: charsetName(cs) }))); q.actions.append(h('button', { type: 'button', class: 'btn primary danger', onclick: () => { res(true); q.close(); } }, t('unsavedDiscard'))); }); if (!ok) return; }
    applyDecoded(decodeAs(rawBytes, cs, bom, rawWhole), rawWhole);
  };
  const moreSheet = () => {
    const m = openSheet(t('more'), t('close'), { stack: true }); const act = (ic: string, label: string, fn: () => void, sub?: string) => h('button', { type: 'button', class: 'dest-row', onclick: () => { m.close(); fn(); } }, icon(ic), h('span', { class: 'grow files-main' }, h('span', { class: 'name' }, label), sub ? h('small', { class: 'src' }, sub) : null));
    const csList = (label: string, writing: boolean) => () => pickSheet(label, CHARSETS.map(([name, cs, bom]) => [`${cs}|${bom ? 1 : 0}`, writing && !canWrite(cs) ? t('filesCharsetReadOnly', { cs: name }) : name] as [string, string]), '', (v) => {
      const [cs, b] = v.split('|'); const c = cs as Charset; if (writing) { if (!canWrite(c)) return void toast(t('owCharsetCannot', { cs: charsetName(c) }), 'error', 4000); if (ta.readOnly) return void toast(t('filesReadOnly'), 'error'); pendingEnc = { charset: c, bom: b === '1' }; refreshSave(); paintStatus(); toast(t('filesCharsetChosen', { cs: charsetName(c) })); } else void reopenAs(c, b === '1');
    }, t('close'));
    const eolList = () => pickSheet(t('filesEol'), [['', t('filesEolKeep', { eol: eolName(eol) })], ['lf', t('filesEolLf')], ['crlf', t('filesEolCrlf')]] as [string, string][], forced ?? '', (v) => { forced = v ? (v as Eol) : null; if (eol === 'mixed' && forced) { ta.readOnly = !!big || !io?.write; notice.hidden = !ta.readOnly; } refreshSave(); paintStatus(); }, t('close'));
    m.body.append(h('div', { class: 'dest-list' },
      ...(io && rawBytes ? [act('type', t('filesReopenAs'), csList(t('filesReopenAs'), false), `${enc ? charsetName(enc.charset) : ''}`), act('check', t('filesSaveAsCharset'), csList(t('filesSaveAsCharset'), true))] : []),
      ...(io ? [act('lineBreak', t('filesEol'), eolList, eolName(forced ?? eol))] : []),
      h('div', { class: 'row files-fontrow' }, h('span', { class: 'grow' }, t('filesFontSize')),
        iconButton('zoomOut', t('filesFontSize') + ' −', () => step(-1)), h('b', { class: 'files-fontnow' }, localDigits(fontNow())), iconButton('zoomIn', t('filesFontSize') + ' +', () => step(1)))));
    const fontNowEl = m.body.querySelector('.files-fontnow') as HTMLElement;
    const step = (d: number) => { const k = Math.max(0, Math.min(FONTS.length - 1, FONTS.indexOf(fontNow()) + d)); try { localStorage.setItem(FONT_KEY, String(FONTS[k])); } catch { /* none */ } ta.style.fontSize = `${FONTS[k]}px`; fontNowEl.textContent = localDigits(FONTS[k]); sizeGutter(); };
  };

  ta.addEventListener('input', () => { refreshSave(); paintStatus(); paintNumbers(); if (!panel.hidden && opts.q) recount(); });
  ta.addEventListener('scroll', () => { if (numbers) gutter.scrollTop = ta.scrollTop; }, { passive: true });
  const notice = h('p', { class: 'hint files-ed-notice', hidden: true });
  const moreBar = h('div', { class: 'files-ed-more', hidden: true });
  sh.body.append(tools, h('div', { class: 'files-ed-statusrow' }, status), panel, notice, wrap, moreBar);
  sh.actions.append(...(io && !io.openWith && !/^\//.test(e.path) ? [] : [h('button', { type: 'button', class: 'btn tonal', onclick: () => { if (io?.openWith) io.openWith(); else void pl.openWith({ path: e.path, mime: 'text/plain', title: e.name }); } }, icon('external'), t('openWith'))]), save);

  // ---- a big file: read-only, one part at a time (the page holds a part, not the file)
  const starts: number[] = [0]; let part = 0;
  const usable = (b: Uint8Array, cs: Charset, whole: boolean): number => {
    if (whole) return b.length; let n = b.length;
    if (cs === 'utf-8') { let k = 0; while (k < 3 && n - 1 - k >= 0 && (b[n - 1 - k] & 0xc0) === 0x80) k++; if (n - 1 - k >= 0 && b[n - 1 - k] >= 0xc0) n = n - 1 - k; }
    else if (cs === 'utf-16le' || cs === 'utf-16be') n -= n % 2;
    return n;
  };
  const showPart = async (k: number) => {
    if (!big || !io || !dec0) return; const r = await io.read({ offset: starts[k], max: PART }); const cs = enc?.charset ?? 'utf-8';
    const use = usable(r.bytes, cs, r.whole); const text = new TextDecoder(dec0.encoding, { ignoreBOM: k > 0 }).decode(r.bytes.subarray(0, use)); starts[k + 1] = starts[k] + use; part = k;
    ta.value = toLf(text); ta.scrollTop = 0; original = ta.value; paintStatus(); moreBar.hidden = false;
    moreBar.replaceChildren(h('small', { class: 'src grow' }, t('filesBigShown', { shown: formatBytes(Math.min(starts[k + 1], big.size)), size: formatBytes(big.size) })),
      ...(k > 0 ? [h('button', { type: 'button', class: 'btn tonal small files-part-prev', onclick: () => void showPart(k - 1) }, icon('arrowUp'), t('filesLoadPrev'))] : []),
      ...(r.whole || !r.bytes.length ? [] : [h('button', { type: 'button', class: 'btn tonal small files-part-next', onclick: () => void showPart(k + 1) }, icon('arrowDown'), t('filesLoadMore'))]));
  };
  let dec0: TextDecoder | null = null;

  // ---- the file's bytes
  if (io) {
    try {
      const r = await io.read(); rawBytes = r.bytes; rawWhole = r.whole; const d = decodeText(r.bytes, r.whole);
      if (!r.whole) {
        // (Five megabytes and more: the first part, read-only; the next parts on request, each decoded where the last stopped.)
        big = { next: 0, size: Math.max(r.size, r.bytes.length) }; enc = { charset: d.charset, bom: d.bom }; dec0 = new TextDecoder(d.charset === 'shift_jis' || d.charset === 'windows-1256' || d.charset === 'windows-1252' || d.charset === 'utf-16le' || d.charset === 'utf-16be' ? d.charset : 'utf-8');
        ta.readOnly = true; ta.value = ''; rawBytes = null; setWrap(false); notice.hidden = false; notice.textContent = t('filesBigNotice', { size: formatBytes(r.size) }); eol = 'lf'; await showPart(0); return;
      }
      applyDecoded(d, r.whole);
      return;
    } catch (err) {
      if ((err as Error)?.message !== 'noBytes') { ta.value = String((err as Error).message ?? err); ta.readOnly = true; original = ta.value; return; }
      io = null;
    }
  }
  try { const r = await pl.filesHead({ path: e.path, max: 2_000_000 }); eol = detectEol(r.text); const lf = toLf(r.text); original = lf; ta.value = lf; afterEdit(); status.textContent += r.size > 2_000_000 ? ' · ' + t('filesTooBigToEdit') : ''; if (r.size > 2_000_000 || eol === 'mixed') { ta.readOnly = true; if (eol === 'mixed') { notice.hidden = false; notice.textContent = t('filesEolMixedNotice'); } } } catch (err) { ta.value = String((err as Error).message ?? err); ta.readOnly = true; original = ta.value; }
}
