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
import { canBrowse, openBrowser } from '../browser';

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
const KINDS: [string, string, RegExp][] = [['video', 'catVideo', /\.(mkv|mp4|m4v|webm|avi|mov|ts|wmv|flv|m3u8|mpd)(\?|$)/i], ['music', 'catMusic', /\.(mp3|m4a|flac|ogg|opus|wav|aac)(\?|$)/i], ['compressed', 'catCompressed', /\.(zip|7z|rar|tar|gz|xz|bz2|iso)(\?|$)/i], ['documents', 'catDocuments', /\.(pdf|epub|docx?|xlsx?|pptx?|txt|cbz|cbr|mobi|azw3)(\?|$)/i], ['images', 'catImages', /\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i], ['programs', 'catPrograms', /\.(apk|apks|xapk|exe|msi|dmg|appimage|deb|rpm)(\?|$)/i], ['torrents', 'grabTorrents', /^magnet:|\.torrent(\?|$)/i]];
/** A grabber project (Prism's): a page, how deep to follow its links, the kind of file wanted — kept to run again. */
export interface GrabProject { url: string; depth: number; below: boolean; kind: string; at: number }
const PKEY = 'kt.grab.projects';
export const grabProjects = (): GrabProject[] => { try { return JSON.parse(localStorage.getItem(PKEY) ?? '[]') as GrabProject[]; } catch { return []; } };
const saveProjects = (l: GrabProject[]) => { try { localStorage.setItem(PKEY, JSON.stringify(l.slice(0, 20))); } catch { /* full */ } };
const FILE_RE = new RegExp(KINDS.map((k) => k[2].source).join('|'), 'i');
/** A page worth following: the same site, under the start's folder if asked, not a file. */
export function followable(href: string, startUrl: string, below: boolean): boolean {
  let a: URL, b: URL; try { a = new URL(href); b = new URL(startUrl); } catch { return false; }
  if (!/^https?:$/.test(a.protocol) || a.host !== b.host || FILE_RE.test(href)) return false;
  if (/\.(css|js|json|xml|rss|ico|woff2?|ttf)(\?|$)/i.test(a.pathname)) return false;
  return !below || a.pathname.startsWith(b.pathname.replace(/[^/]*$/, ''));
}
/** A link found: on a page, or a post's media (with the name to save it under, a thumbnail, and whether it is a
 *  stream for the Video add-on). */
type Link = { href: string; text: string; kind?: string; name?: string; thumb?: string; viaVideo?: boolean };
export async function grabberSheet(start = '', project?: GrabProject, pre?: { links: { href: string; text: string; kind?: string }[]; title?: string; ua?: string }): Promise<void> {
  const sh = openSheet(t('grabTitle'), t('close'));
  const url = h('input', { type: 'url', dir: 'ltr', value: project?.url ?? start, placeholder: t('grabPasteHint'), title: t('grabPasteHint'), spellcheck: 'false', autocapitalize: 'off' }) as HTMLInputElement;
  let depth = project?.depth ?? 0; let below = project?.below ?? true;
  const depthPick = h('div', { class: 'chip-row' }, h('span', { class: 'label' }, t('grabDepth')), ...[0, 1, 2, 3].map((d) => h('button', { type: 'button', class: 'chip small' + (d === depth ? ' on' : ''), 'data-d': String(d), onclick: (e: Event) => { depth = d; for (const c of Array.from((e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.chip'))) c.classList.toggle('on', c === e.currentTarget); belowRow.hidden = depth === 0; } }, d === 0 ? t('grabDepth0') : localDigits(d))));
  const belowBox = h('input', { type: 'checkbox', checked: below, onchange: (e: Event) => { below = (e.target as HTMLInputElement).checked; } });
  const belowRow = h('label', { class: 'check-row small', hidden: depth === 0 }, belowBox, h('span', null, t('grabBelow')));
  const projRow = h('div', { class: 'chip-row wrap grab-projects' });
  const chips = h('div', { class: 'chip-row wrap' }); const list = h('div', { class: 'grab-list' }); let links: Link[] = []; let kind = project?.kind ?? ''; const chosen = new Set<string>();
  const go = h('button', { type: 'button', class: 'btn primary', disabled: true }, icon('download'), t('grabAdd')) as HTMLButtonElement;
  const keep = h('button', { type: 'button', class: 'btn text', disabled: true, onclick: () => { const u = url.value.trim(); saveProjects([{ url: u, depth, below, kind, at: Date.now() }, ...grabProjects().filter((x) => x.url !== u)]); drawProjects(); toast(t('grabKept')); } }, icon('star'), t('grabKeep')) as HTMLButtonElement;
  const drawProjects = () => { const ps = grabProjects(); projRow.hidden = !ps.length; projRow.replaceChildren(h('span', { class: 'label' }, t('grabProjects')), ...ps.map((x) => h('span', { class: 'chip small proj' }, h('button', { type: 'button', class: 'proj-go', dir: 'ltr', title: x.url, onclick: () => { url.value = x.url; depth = x.depth; below = x.below; kind = x.kind; belowBox.checked = below; belowRow.hidden = depth === 0; for (const c of Array.from(depthPick.querySelectorAll('.chip'))) c.classList.toggle('on', (c as HTMLElement).dataset.d === String(depth)); void load(); } }, (() => { try { const u = new URL(x.url); return u.host + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '').slice(-24) : ''); } catch { return x.url; } })()), h('button', { type: 'button', class: 'proj-x', 'aria-label': t('remove'), onclick: () => { saveProjects(grabProjects().filter((p) => p.url !== x.url)); drawProjects(); } }, icon('close'))))); };
  const inBrowser = canBrowse() ? h('button', { type: 'button', class: 'btn tonal small', title: t('grabInBrowser'), onclick: () => { sh.close(); openBrowser(url.value.trim()); } }, icon('globe'), t('browserShort')) : null;
  sh.body.append(projRow, h('form', { class: 'search-form row', onsubmit: (e: Event) => { e.preventDefault(); void load(); } }, url, inBrowser), ...(pre ? [] : [depthPick, belowRow]), chips, list); sh.actions.append(keep, go);
  drawProjects();
  const load = async () => {
    const u = url.value.trim(); if (!/^https?:\/\//i.test(u)) return;
    const status = h('small', { class: 'src' }); list.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), status));
    // (A post on X, Bluesky or Reddit: its media read from the site's API, at full quality — no page to crawl.)
    const social = await import('./social'); const isPost = !!social.socialOf(u); depthPick.hidden = isPost; if (isPost) belowRow.hidden = true; else belowRow.hidden = depth === 0;
    if (isPost) {
      status.textContent = ` ${t('grabSocial')}`;
      try { const post = (await social.socialPost(u))!; if (!post.items.length) { list.replaceChildren(h('p', { class: 'empty small' }, t('grabSocialNone'))); return; }
        fromPage(post.items.map((x) => ({ href: x.href, text: x.text, kind: x.kind === 'image' ? 'images' : 'video', name: x.name, thumb: x.thumb, viaVideo: x.viaVideo })));
        list.prepend(h('p', { class: 'hint', dir: 'auto' }, [post.author, post.title].filter(Boolean).join(' · ')));
      } catch (e) { list.replaceChildren(h('div', { class: 'empty small' }, h('p', null, t('grabSocialFailed', { error: String((e as Error).message ?? e) })), ...(canBrowse() ? [h('button', { type: 'button', class: 'btn primary small', onclick: () => { sh.close(); openBrowser(u); } }, icon('globe'), t('grabInBrowser'))] : []))); }
      return;
    }
    const pages: [string, number][] = [[u, 0]]; const visited = new Set<string>([u.split('#')[0]]); const seen = new Set<string>(); links = []; let read = 0; let firstErr: unknown = null;
    const MAX_PAGES = 60;
    while (pages.length && read < MAX_PAGES && sh.el.isConnected) {
      const [page, d] = pages.shift()!; read++; status.textContent = ` ${t('grabReading', { n: localDigits(read), files: localDigits(links.length) })}`;
      let r; try { r = await request(page); if (r.status >= 400) throw new Error(`HTTP ${r.status}`); } catch (e) { if (read === 1) firstErr = e; continue; }
      if (r.headers['content-type'] && !/html|xml|text/i.test(r.headers['content-type'])) continue;
      const doc = new DOMParser().parseFromString(r.body, 'text/html');
      for (const el of Array.from(doc.querySelectorAll('a[href], source[src], video[src], audio[src], img[src]'))) {
        const raw = el.getAttribute('href') ?? el.getAttribute('src') ?? ''; let href: string;
        try { href = raw.startsWith('magnet:') ? raw : new URL(raw, page).href; } catch { continue; }
        if (/^(javascript|mailto|tel|data):/i.test(href)) continue;
        const bare = href.split('#')[0];
        if (depth > d && el.tagName === 'A' && followable(bare, u, below) && !visited.has(bare)) { visited.add(bare); pages.push([bare, d + 1]); }
        if (seen.has(bare) || bare === page.split('#')[0]) continue;
        // (Pages followed are not offered as files; with no depth, everything the page links to is, as before.)
        if (depth > 0 && !FILE_RE.test(bare)) continue;
        seen.add(bare); links.push({ href: bare, text: (el.textContent ?? '').trim() || decodeURIComponent(bare.split('?')[0].split('/').pop() ?? bare) });
      }
    }
    if (firstErr && !links.length) { list.replaceChildren(h('p', { class: 'empty small' }, String((firstErr as Error).message ?? firstErr))); return; }
    const want = kind; fromPage(links); if (want && links.some((x) => kindL(x) === want)) { kind = want; chosen.clear(); for (const x of shown()) chosen.add(x.href); draw(); }
    if (!links.length && canBrowse()) list.replaceChildren(h('div', { class: 'empty small' }, h('p', null, t('grabNothing')), h('button', { type: 'button', class: 'btn primary small', onclick: () => { sh.close(); openBrowser(u); } }, icon('globe'), t('grabInBrowser'))));
    if (read > 1) list.prepend(h('p', { class: 'hint' }, t('grabRead', { n: localDigits(read), files: localDigits(links.length) })));
  };
  /** The kinds found, with «All» first and the links that are none of them (pages) under «Other». */
  const kindOf = (href: string) => KINDS.find((k) => k[2].test(href))?.[0] ?? 'other';
  const kindL = (x: Link) => x.kind ?? kindOf(x.href);
  const drawChips = (counts: readonly (readonly [string, string, number])[]) => chips.replaceChildren(
    h('button', { type: 'button', class: 'chip small' + (kind === '' ? ' on' : ''), onclick: () => { kind = ''; drawChips(counts); draw(); } }, `${t('allFiles')} · ${localDigits(links.length)}`),
    ...counts.map(([k, label, n]) => h('button', { type: 'button', class: 'chip small' + (kind === k ? ' on' : ''), onclick: () => { kind = k; chosen.clear(); for (const x of shown()) chosen.add(x.href); drawChips(counts); draw(); } }, `${t(label as 'catVideo')} · ${localDigits(n)}`)));
  const shown = () => (kind ? links.filter((x) => kindL(x) === kind) : links);
  const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
  const sync = () => { go.disabled = !chosen.size; go.lastChild!.textContent = t('grabAddN', { n: countFiles(chosen.size) }); };
  const draw = () => {
    const xs = shown();
    list.replaceChildren(h('button', { type: 'button', class: 'btn text small', onclick: () => { const all = xs.every((x) => chosen.has(x.href)); xs.forEach((x) => (all ? chosen.delete(x.href) : chosen.add(x.href))); draw(); } }, t('allFiles')),
      ...xs.slice(0, 600).map((x) => { const nm = x.name ?? decodeURIComponent(((/[?&](?:f|filename|name|file)=([^&]+)/.exec(x.href)?.[1]) ?? x.href.split('?')[0].split('/').pop() ?? x.href).replace(/\+/g, ' ')); return h('label', { class: 'check-row file-row grab-row' }, h('input', { type: 'checkbox', checked: chosen.has(x.href), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(x.href); else chosen.delete(x.href); sync(); } }),
        x.thumb ? h('img', { class: 'grab-thumb', src: x.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        h('span', { class: 'grow' }, h('span', { class: 'result-title', dir: 'auto' }, x.text && x.text.length < 120 && x.text !== x.href ? x.text : nm || x.href), h('small', { class: 'src', dir: 'ltr' }, [nm !== x.text ? nm : '', host(x.href)].filter(Boolean).join(' · ')))); }));
    sync();
  };
  const fromPage = (ls: Link[]) => {
    const seen = new Set<string>(); links = [];
    for (const l of ls) { const bare = l.href.startsWith('magnet:') ? l.href : l.href.split('#')[0]; if (seen.has(bare) || /^(javascript|mailto|tel|data):/i.test(bare)) continue; seen.add(bare); links.push({ ...l, href: bare, text: (l.text ?? '').trim(), kind: l.kind && KINDS.some((k) => k[0] === l.kind) ? l.kind : undefined }); }
    const counts = [...KINDS.map(([k, label]) => [k, label, links.filter((x) => kindL(x) === k).length] as const), ['other', 'grabOther', links.filter((x) => kindL(x) === 'other').length] as const].filter((x) => x[2] > 0);
    kind = counts.find((c) => c[0] !== 'other')?.[0] ?? ''; chosen.clear(); for (const x of shown()) chosen.add(x.href);
    keep.disabled = false; drawChips(counts); draw();
  };
  // Links handed by a page opened in the app's browser (its scripts ran: what a plain read misses is there).
  const hdrs: Record<string, string> = {}; if (pre?.ua) hdrs['User-Agent'] = pre.ua; if (pre && start) hdrs.Referer = start;
  // (A post's media keep the names given them; a stream — a Bluesky or Reddit video — goes to the Video add-on.)
  go.addEventListener('click', async () => {
    go.disabled = true; let n = 0; let noVideo = 0;
    const vid = await import('../video/ytdlp'); const { preferredFormat } = await import('../views/addVideo');
    for (const href of chosen) {
      const l = links.find((x) => x.href === href);
      try {
        if (l?.viaVideo) { if (!vid.videoEnabled()) { noVideo++; continue; } await getEngine().add({ source: { url: href }, video: { ...preferredFormat(), embedThumb: getSettings().videoEmbedThumb } }); n++; continue; }
        const [src] = parseSources(href); if (src) { await getEngine().add({ source: src.url && pre ? { ...src, headers: hdrs } : src, name: l?.name, connections: 8 }); n++; }
      } catch { /* the next */ }
    }
    toast(t('grabAdded', { n: countFiles(n) })); if (noVideo) toast(t('grabNeedsVideo'), 'error', 6000); sh.close();
  });
  if (pre) { if (pre.title) sh.body.prepend(h('p', { class: 'hint', dir: 'auto' }, pre.title)); fromPage(pre.links); }
  else if (start) void load();
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
