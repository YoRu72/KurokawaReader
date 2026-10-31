// The rest of Prism's download manager: a file's checksums to compare with the site's; the grabber (every link
// of a page, filtered by kind, added together); what a ZIP holds before it is downloaded (its directory read
// from the end of the file with two small range requests); the clipboard monitor (a copied link offered for
// download when the app comes to the front); and the scheduler (downloads marked «later» run in the hours set).
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, countFiles, localDigits } from '../i18n';
import { ktPlugin } from '../native';
import { request } from '../http';
import { getEngine, parseSources } from '../engine';
import { getSettings } from '../settings';
import { categoryOf } from './categories';

/* ---------- checksums ---------- */
export async function hashFile(path: string): Promise<{ md5: string; sha1: string; sha256: string; size: number }> {
  const d = window.kurokawaTools as unknown as { hashFile?(p: string): Promise<{ md5: string; sha1: string; sha256: string; size: number }> } | undefined; if (d?.hashFile) return d.hashFile(path);
  const p = ktPlugin() as unknown as { hashFile?(o: { path: string }): Promise<{ md5: string; sha1: string; sha256: string; size: number }> } | null; if (p?.hashFile) return p.hashFile({ path });
  throw new Error('unsupported');
}
export async function verifySheet(path: string): Promise<void> {
  const sh = openSheet(t('verifyTitle'), t('close')); const name = path.split(/[\\/]/).pop() ?? path;
  const want = h('input', { type: 'text', dir: 'ltr', placeholder: t('verifyPaste'), spellcheck: 'false', autocapitalize: 'off' }) as HTMLInputElement;
  const out = h('div', { class: 'hash-list' }, h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('verifyReading')}`));
  sh.body.append(h('p', { class: 'src', dir: 'ltr' }, name), want, out);
  try {
    const r = await hashFile(path);
    const rows = (['md5', 'sha1', 'sha256'] as const).map((k) => h('div', { class: 'hash-row', dataset: { v: r[k] } }, h('b', null, k.toUpperCase()), h('code', { dir: 'ltr' }, r[k]), h('button', { type: 'button', class: 'icon-btn small', title: t('copyLink'), onclick: () => void navigator.clipboard?.writeText(r[k]).then(() => toast(t('copied'))) }, icon('copy'))));
    const check = () => { const v = want.value.trim().toLowerCase().replace(/[^0-9a-f]/g, ''); rows.forEach((x) => x.classList.toggle('match', !!v && x.dataset.v === v)); want.classList.toggle('bad', !!v && !rows.some((x) => x.dataset.v === v)); want.classList.toggle('good', !!v && rows.some((x) => x.dataset.v === v)); };
    want.addEventListener('input', check);
    out.replaceChildren(h('p', { class: 'src' }, formatBytes(r.size)), ...rows);
  } catch (e) { out.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
}

/* ---------- the grabber ---------- */
const KINDS: [string, string, RegExp][] = [['video', 'catVideo', /\.(mkv|mp4|m4v|webm|avi|mov|ts|wmv|flv)(\?|$)/i], ['music', 'catMusic', /\.(mp3|m4a|flac|ogg|opus|wav|aac)(\?|$)/i], ['compressed', 'catCompressed', /\.(zip|7z|rar|tar|gz|xz|bz2|iso)(\?|$)/i], ['documents', 'catDocuments', /\.(pdf|epub|docx?|xlsx?|pptx?|txt|cbz|cbr|mobi|azw3)(\?|$)/i], ['images', 'catImages', /\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i], ['programs', 'catPrograms', /\.(apk|apks|xapk|exe|msi|dmg|appimage|deb|rpm)(\?|$)/i], ['torrents', 'grabTorrents', /^magnet:|\.torrent(\?|$)/i]];
export async function grabberSheet(start = ''): Promise<void> {
  const sh = openSheet(t('grabTitle'), t('close'));
  const url = h('input', { type: 'url', dir: 'ltr', value: start, placeholder: 'https://…', spellcheck: 'false', autocapitalize: 'off' }) as HTMLInputElement;
  const chips = h('div', { class: 'chip-row wrap' }); const list = h('div', { class: 'grab-list' }); let links: { href: string; text: string }[] = []; let kind = ''; const chosen = new Set<string>();
  const go = h('button', { type: 'button', class: 'btn primary', disabled: true }, icon('download'), t('grabAdd')) as HTMLButtonElement;
  sh.body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); void load(); } }, url), chips, list); sh.actions.append(go);
  const load = async () => {
    const u = url.value.trim(); if (!/^https?:\/\//i.test(u)) return; list.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' })));
    try {
      const r = await request(u); if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      const doc = new DOMParser().parseFromString(r.body, 'text/html'); const seen = new Set<string>(); links = [];
      for (const el of Array.from(doc.querySelectorAll('a[href], source[src], video[src], audio[src], img[src]'))) { const raw = el.getAttribute('href') ?? el.getAttribute('src') ?? ''; let href: string; try { href = raw.startsWith('magnet:') ? raw : new URL(raw, u).href; } catch { continue; } if (seen.has(href) || /^(javascript|mailto|tel):/i.test(href) || href.split('#')[0] === u) continue; seen.add(href); links.push({ href, text: (el.textContent ?? '').trim() || decodeURIComponent(href.split('?')[0].split('/').pop() ?? href) }); }
      const counts = KINDS.map(([k, label, re]) => [k, label, links.filter((x) => re.test(x.href)).length] as const).filter((x) => x[2] > 0);
      kind = counts[0]?.[0] ?? ''; drawChips(counts); draw();
    } catch (e) { list.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  };
  const drawChips = (counts: readonly (readonly [string, string, number])[]) => chips.replaceChildren(...counts.map(([k, label, n]) => h('button', { type: 'button', class: 'chip small' + (kind === k ? ' on' : ''), onclick: () => { kind = k; chosen.clear(); drawChips(counts); draw(); } }, `${t(label as 'catVideo')} · ${localDigits(n)}`)), h('button', { type: 'button', class: 'chip small' + (kind === '' ? ' on' : ''), onclick: () => { kind = ''; chosen.clear(); drawChips(counts); draw(); } }, `${t('grabAll')} · ${localDigits(links.length)}`));
  const shown = () => (kind ? links.filter((x) => KINDS.find((k) => k[0] === kind)![2].test(x.href)) : links);
  const draw = () => {
    const xs = shown(); if (kind) xs.forEach((x) => chosen.add(x.href));
    list.replaceChildren(h('button', { type: 'button', class: 'btn text small', onclick: () => { const all = xs.every((x) => chosen.has(x.href)); xs.forEach((x) => (all ? chosen.delete(x.href) : chosen.add(x.href))); draw(); } }, t('allFiles')),
      ...xs.slice(0, 500).map((x) => h('label', { class: 'check-row file-row' }, h('input', { type: 'checkbox', checked: chosen.has(x.href), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(x.href); else chosen.delete(x.href); go.disabled = !chosen.size; go.lastChild!.textContent = t('grabAddN', { n: countFiles(chosen.size) }); } }), h('span', { class: 'grow', dir: 'auto' }, x.text, h('small', { class: 'src', dir: 'ltr' }, x.href)))));
    go.disabled = !chosen.size; go.lastChild!.textContent = t('grabAddN', { n: countFiles(chosen.size) });
  };
  go.addEventListener('click', async () => { go.disabled = true; let n = 0; for (const href of chosen) { try { const [src] = parseSources(href); if (src) { await getEngine().add({ source: src, connections: 8 }); n++; } } catch { /* the next */ } } toast(t('grabAdded', { n: countFiles(n) })); sh.close(); });
  if (start) void load();
}

/* ---------- what a ZIP holds, before downloading it ---------- */
export async function remoteZipEntries(url: string): Promise<{ total: number; entries: { path: string; size: number }[] } | null> {
  const head = await request(url, { method: 'HEAD' }).catch(() => null); const len = Number(head?.headers?.['content-length'] ?? head?.headers?.['Content-Length'] ?? 0);
  if (!len || len < 22) return null;
  const tailLen = Math.min(len, 65557 + 22);
  const tail = await request(url, { headers: { Range: `bytes=${len - tailLen}-${len - 1}` }, binary: true }).catch(() => null); if (!tail || (tail.status !== 206 && tail.status !== 200)) return null;
  let tb = Uint8Array.from(atob(tail.body), (c) => c.charCodeAt(0)); if (tail.status === 200 && tb.length === len) tb = tb.subarray(len - tailLen);
  const dv = new DataView(tb.buffer, tb.byteOffset, tb.byteLength); let eocd = -1; for (let i = tb.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } if (eocd < 0) return null;
  let count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  if ((cdOff === 0xffffffff || count === 0xffff) && eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = Number(dv.getBigUint64(eocd - 12, true)); const r = await request(url, { headers: { Range: `bytes=${z64}-${z64 + 55}` }, binary: true }).catch(() => null); if (!r) return null; const zb = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)); const zd = new DataView(zb.buffer); count = Number(zd.getBigUint64(32, true)); cdSize = Number(zd.getBigUint64(40, true)); cdOff = Number(zd.getBigUint64(48, true));
  }
  let cd: Uint8Array; const tailStart = len - tailLen;
  if (cdOff >= tailStart) cd = tb.subarray(cdOff - tailStart, cdOff - tailStart + cdSize);
  else { if (cdSize > 8 << 20) return null; const r = await request(url, { headers: { Range: `bytes=${cdOff}-${cdOff + cdSize - 1}` }, binary: true }).catch(() => null); if (!r || r.status !== 206) return null; cd = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)); }
  const c = new DataView(cd.buffer, cd.byteOffset, cd.byteLength); const out: { path: string; size: number }[] = []; let p = 0, total = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (c.getUint32(p, true) !== 0x02014b50) break; const flags = c.getUint16(p + 8, true); let usize = c.getUint32(p + 24, true); const nl = c.getUint16(p + 28, true), xl = c.getUint16(p + 30, true), cl = c.getUint16(p + 32, true);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(cd.subarray(p + 46, p + 46 + nl));
    if (usize === 0xffffffff) { let xp = p + 46 + nl; const xe = xp + xl; while (xp + 4 <= xe) { if (c.getUint16(xp, true) === 1) { usize = Number(c.getBigUint64(xp + 4, true)); break; } xp += 4 + c.getUint16(xp + 2, true); } }
    if (!name.endsWith('/')) { out.push({ path: name, size: usize }); total += usize; } p += 46 + nl + xl + cl;
  }
  return { total, entries: out };
}

/* ---------- the clipboard monitor ---------- */
let lastClip = ''; let clipWired = false;
export function startClipboardWatch(open: (text: string) => void): void {
  if (clipWired) return; clipWired = true;
  const read = async (): Promise<string> => { const d = window.kurokawaTools as unknown as { clipboardText?(): Promise<string> } | undefined; if (d?.clipboardText) return d.clipboardText(); const p = ktPlugin() as unknown as { clipboardText?(): Promise<{ text: string }> } | null; if (p?.clipboardText) return (await p.clipboardText()).text; return ''; };
  const check = async () => {
    if (!getSettings().clipboardWatch || document.visibilityState !== 'visible') return;
    let text = ''; try { text = (await read()).trim(); } catch { return; }
    if (!text || text === lastClip) return; const first = lastClip === ''; lastClip = text; if (first && !sessionStorage.getItem('kt.clip.armed')) { sessionStorage.setItem('kt.clip.armed', '1'); }
    if (!parseSources(text).length) return;
    let seen: string[] = []; try { seen = JSON.parse(localStorage.getItem('kt.clip.seen') ?? '[]') as string[]; } catch { /* none */ }
    if (seen.includes(text)) return; seen = [text, ...seen].slice(0, 50); try { localStorage.setItem('kt.clip.seen', JSON.stringify(seen)); } catch { /* full */ }
    if (document.querySelector('.add-sheet')) return; open(text);
  };
  document.addEventListener('visibilitychange', () => void check()); window.addEventListener('focus', () => void check());
  setInterval(() => void check(), 2500); void check();
}

/* ---------- the scheduler ---------- */
/** Inside the hours and days set (a window may cross midnight). */
export function inWindow(now = new Date()): boolean {
  const s = getSettings().schedule; if (!s.enabled) return true;
  const [sh, sm] = s.start.split(':').map(Number), [eh, em] = s.stop.split(':').map(Number); const m = now.getHours() * 60 + now.getMinutes(), a = sh * 60 + sm, b = eh * 60 + em;
  const dayOk = !s.days.length || s.days.includes(now.getDay()); return dayOk && (a <= b ? m >= a && m < b : m >= a || m < b);
}
let schedTimer = 0;
/** Downloads added «later» start when the window opens and pause when it closes. */
export function startScheduler(): void {
  window.clearInterval(schedTimer);
  const tick = async () => {
    if (!getSettings().schedule.enabled) return; const eng = getEngine(); let tasks; try { tasks = await eng.list(); } catch { return; }
    const open = inWindow();
    for (const x of tasks) { const later = (x.meta as { later?: boolean } | undefined)?.later; if (!later || x.state === 'done') continue; try { if (open && x.state === 'paused') await eng.resume(x.id); else if (!open && (x.state === 'downloading' || x.state === 'queued' || x.state === 'metadata')) await eng.pause(x.id); } catch { /* the next */ } }
  };
  schedTimer = window.setInterval(() => void tick(), 60000); void tick();
}
export const categoryLabelOf = (name: string) => categoryOf(name).name;
