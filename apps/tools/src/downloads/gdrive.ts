// Google Drive links shared with «anyone with the link»: a file, a whole folder (its subfolders too), or a Google
// Doc / Sheet / Slides. No sign-in and no API key: a folder's files are read from Drive's embeddable folder view, a
// file's real address from Drive's download endpoint (past the «can't scan this file for viruses» page that large files
// get, by its own form), and each file is then downloaded like any other — several connections, resumable. The
// address Drive gives can run out; a failed Drive download is given a fresh one and taken up again.
import { request } from '../http';
import type { AddOptions, Engine, Task } from '../engine/types';
import type { CloudFile, CloudInfo } from './cloud';

export type DocKind = 'document' | 'spreadsheets' | 'presentation' | 'drawings';
type Link = { kind: 'file' | 'folder' | 'open'; id: string; rk?: string } | { kind: 'doc'; doc: DocKind; id: string; rk?: string };
export interface DriveFile extends CloudFile { rk?: string; doc?: DocKind }

/** A Drive link of any form: drive.google.com/file/d/…, /open?id=…, /uc?id=…, drive.usercontent.google.com/download?id=…,
 *  /drive/folders/… (also /u/0/, /mobile/, a Workspace domain's /a/<domain>/), /folderview?id=…, /embeddedfolderview?id=…,
 *  and docs.google.com's documents, spreadsheets, presentations and drawings. */
export function parseDrive(u: string): Link | null {
  let url: URL; try { url = new URL(u.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase(); const rk = url.searchParams.get('resourcekey') || undefined;
  const p = url.pathname.replace(/^\/a\/[^/]+/, '').replace(/\/u\/\d+(?=\/)/, '');
  const idParam = url.searchParams.get('id'); const okId = (x: string | null | undefined): x is string => !!x && /^[\w-]{10,}$/.test(x);
  if (host === 'docs.google.com') {
    const m = /^\/(document|spreadsheets|presentation|drawings)\/d\/([\w-]{10,})/.exec(p); if (m) return { kind: 'doc', doc: m[1] as DocKind, id: m[2], rk };
    const f = /^\/file\/d\/([\w-]{10,})/.exec(p); if (f) return { kind: 'file', id: f[1], rk };
    if (/^\/(uc|open)$/.test(p) && okId(idParam)) return { kind: p === '/uc' ? 'file' : 'open', id: idParam, rk };
    return null;
  }
  if (host === 'drive.usercontent.google.com') return /^\/(download|uc|open)/.test(p) && okId(idParam) ? { kind: 'file', id: idParam, rk } : null;
  if (host !== 'drive.google.com') return null;
  let m = /^\/file\/d\/([\w-]{10,})/.exec(p); if (m) return { kind: 'file', id: m[1], rk };
  m = /^\/drive\/(?:mobile\/)?folders\/([\w-]{10,})/.exec(p); if (m) return { kind: 'folder', id: m[1], rk };
  if (/^\/(embedded)?folderview$/.test(p) && okId(idParam)) return { kind: 'folder', id: idParam, rk };
  if (/^\/(uc|download)$/.test(p) && okId(idParam)) return { kind: 'file', id: idParam, rk };
  if (p === '/open' && okId(idParam)) return { kind: 'open', id: idParam, rk };
  return null;
}
export const isDrive = (u: string): boolean => parseDrive(u) !== null;
/** Every Drive link in a text (a page's, a pasted list), links or not. */
export function driveLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/(?:drive|docs|drive\.usercontent)\.google\.com\/[^\s"'<>()[\]{}\\]+/gi)) { const u = m[0].replace(/[.,;:!?]+$/, ''); if (isDrive(u)) out.add(u); }
  return [...out];
}

export class DriveError extends Error { constructor(key: 'driveErrGone' | 'driveErrPrivate' | 'driveErrQuota' | 'driveErrBusy' | 'driveErrPage') { super(key); } }

const DOC_EXT: Record<DocKind, string> = { document: 'docx', spreadsheets: 'xlsx', presentation: 'pptx', drawings: 'png' };
const docUrl = (doc: DocKind, id: string): string => doc === 'presentation' || doc === 'drawings' ? `https://docs.google.com/${doc}/d/${id}/export/${DOC_EXT[doc]}` : `https://docs.google.com/${doc}/d/${id}/export?format=${DOC_EXT[doc]}`;
const dlUrl = (id: string, rk?: string): string => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download${rk ? `&resourcekey=${encodeURIComponent(rk)}` : ''}`;

async function get(url: string, headers: Record<string, string> = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await request(url, { headers });
    if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((ok) => setTimeout(ok, 900 * (attempt + 1))); continue; }
    return r;
  }
}
const signIn = (r: { url: string; body: string }) => /accounts\.google\.com\/(?:v3\/signin|ServiceLogin|AccountChooser)/i.test(r.url) || /<form[^>]+accounts\.google\.com|accounts\.google\.com\/ServiceLogin/i.test(r.body.slice(0, 20000));
const decodeHtml = (s: string): string => { const d = new DOMParser().parseFromString(`<!doctype html><body>${s}`, 'text/html'); return (d.body.textContent ?? '').trim(); };
function nameFrom(cd: string | undefined): string | undefined {
  if (!cd) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd); if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* the plain one */ } }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(cd); const v = (plain?.[1] ?? plain?.[2])?.trim(); return v || undefined;
}
function sizeFrom(h: Record<string, string>): number {
  const cr = /\/(\d+)\s*$/.exec(h['content-range'] ?? ''); if (cr) return Number(cr[1]);
  return h['content-range'] ? 0 : Number(h['content-length'] ?? 0) || 0;
}
/** «(1.2G)» on Drive's large-file page: its size, roughly. */
function roughSize(s: string): number { const m = /\(([\d.]+)\s*([KMGT])B?\)/i.exec(s); return m ? Math.round(Number(m[1]) * 1024 ** ('KMGT'.indexOf(m[2].toUpperCase()) + 1)) : 0; }

export interface Resolved { url: string; name?: string; size: number }
const resolved = new Map<string, Promise<Resolved>>();
/** A file's real download address, name and size: Drive's download endpoint asked for its first byte — the file
 *  itself (a small one), or Drive's «can't scan for viruses» page (a large one), whose form gives the address. */
export function resolveFile(f: { id: string; rk?: string; doc?: DocKind }, fresh = false): Promise<Resolved> {
  const key = `${f.id}:${f.doc ?? ''}`; let p = fresh ? undefined : resolved.get(key);
  if (!p) { p = doResolve(f); resolved.set(key, p); p.catch(() => resolved.delete(key)); }
  return p;
}
async function doResolve(f: { id: string; rk?: string; doc?: DocKind }): Promise<Resolved> {
  const first = f.doc ? docUrl(f.doc, f.id) : dlUrl(f.id, f.rk);
  const probe = async (url: string) => {
    const r = await get(url, { Range: 'bytes=0-0', ...(f.rk ? { 'X-Goog-Drive-Resource-Keys': `${f.id}/${f.rk}` } : {}) });
    if (r.status === 404) throw new DriveError('driveErrGone');
    if (r.status === 429) throw new DriveError('driveErrBusy');
    if (r.status === 401 || r.status === 403 && !/text\/html/i.test(r.headers['content-type'] ?? '')) throw new DriveError('driveErrPrivate');
    return r;
  };
  const r = await probe(first);
  const html = /text\/html/i.test(r.headers['content-type'] ?? '');
  if (!html) return { url: first, name: nameFrom(r.headers['content-disposition']), size: sizeFrom(r.headers) };
  if (/Too many users have viewed or downloaded|Google Drive - Quota exceeded|exceeded.{0,40}quota|quotaExceeded|download quota/i.test(r.body)) throw new DriveError('driveErrQuota');
  if (signIn(r)) throw new DriveError('driveErrPrivate');
  // (Drive's page for a file too large to scan: its form, filled as Drive fills it, is the address.)
  const doc = new DOMParser().parseFromString(r.body, 'text/html');
  const form = doc.querySelector<HTMLFormElement>('form#download-form, form[action*="download"], form[action*="/uc"]');
  if (!form) { if (r.status === 403) throw new DriveError('driveErrPrivate'); throw new DriveError('driveErrPage'); }
  const action = new URL(form.getAttribute('action') || '/download', r.url || first);
  for (const i of form.querySelectorAll<HTMLInputElement>('input[name]')) action.searchParams.set(i.name, i.getAttribute('value') ?? '');
  if (!action.searchParams.get('id')) action.searchParams.set('id', f.id);
  const label = doc.querySelector('.uc-name-size')?.textContent ?? ''; const name = doc.querySelector('.uc-name-size a')?.textContent?.trim() || undefined;
  const url = action.toString();
  // (The address asked once more for the file's own name and exact size.)
  try { const r2 = await probe(url); if (!/text\/html/i.test(r2.headers['content-type'] ?? '')) return { url, name: nameFrom(r2.headers['content-disposition']) ?? name, size: sizeFrom(r2.headers) || roughSize(label) }; } catch (e) { if (e instanceof DriveError && e.message !== 'driveErrPage') throw e; }
  return { url, name, size: roughSize(label) };
}

/** A folder's entries, from Drive's embeddable view of it (what «anyone with the link» sees). */
async function listFolder(id: string, rk?: string): Promise<{ title: string; entries: { id: string; name: string; href: string; rk?: string }[] }> {
  const r = await get(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}${rk ? `&resourcekey=${encodeURIComponent(rk)}` : ''}`, rk ? { 'X-Goog-Drive-Resource-Keys': `${id}/${rk}` } : {});
  if (r.status === 404) throw new DriveError('driveErrGone');
  if (r.status === 429) throw new DriveError('driveErrBusy');
  if (r.status === 401 || r.status === 403 || signIn(r)) throw new DriveError('driveErrPrivate');
  if (r.status >= 400) throw new Error(`Google Drive: HTTP ${r.status}`);
  const doc = new DOMParser().parseFromString(r.body, 'text/html');
  if (!doc.querySelector('.flip-entries, .flip-entry, .folder-view')) throw new DriveError(/Sign in|accounts\.google/i.test(r.body) ? 'driveErrPrivate' : 'driveErrPage');
  const entries = [...doc.querySelectorAll('.flip-entry')].map((e) => {
    const a = e.querySelector('a[href]'); const href = a?.getAttribute('href') ?? '';
    const eid = /^entry-([\w-]{10,})$/.exec(e.id)?.[1] ?? parseDrive(href)?.id ?? '';
    let erk: string | undefined; try { erk = new URL(href, 'https://drive.google.com').searchParams.get('resourcekey') || undefined; } catch { /* none */ }
    return { id: eid, name: (e.querySelector('.flip-entry-title')?.textContent ?? a?.textContent ?? '').trim(), href, rk: erk };
  }).filter((x) => x.id);
  return { title: (doc.querySelector('title')?.textContent ?? '').replace(/\s*[-–]\s*Google Drive\s*$/i, '').trim(), entries };
}
/** A folder's own name, when its view has none: its sharing page's title. */
async function folderTitle(id: string, rk?: string): Promise<string> {
  try {
    const r = await get(`https://drive.google.com/drive/folders/${encodeURIComponent(id)}${rk ? `?resourcekey=${encodeURIComponent(rk)}` : ''}`);
    const og = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(r.body)?.[1] ?? /<title>([^<]+)<\/title>/i.exec(r.body)?.[1] ?? '';
    return decodeHtml(og).replace(/\s*[-–]\s*Google Drive\s*$/i, '').trim();
  } catch { return ''; }
}

const MAX_FILES = 5000, MAX_DEPTH = 25;
/** What a link holds: its name and its files (a folder's, subfolders included, with their place in it). */
export async function driveInfo(u: string): Promise<CloudInfo<DriveFile>> {
  const l = parseDrive(u); if (!l) throw new Error('drive-link');
  if (l.kind === 'doc') { const r = await resolveFile({ id: l.id, doc: l.doc }); const name = r.name ?? `${l.id}.${DOC_EXT[l.doc]}`; return { service: 'Google Drive', name, folder: false, files: [{ id: l.id, name, path: name, size: r.size, doc: l.doc }] }; }
  if (l.kind !== 'folder') {
    try { const r = await resolveFile(l); const name = r.name ?? l.id; return { service: 'Google Drive', name, folder: false, files: [{ id: l.id, name, path: name, size: r.size, rk: l.rk }] }; }
    catch (e) { if (l.kind !== 'open' || !(e instanceof DriveError) || e.message === 'driveErrQuota') throw e; /* («open?id=» is a folder's too) */ }
  }
  const files: DriveFile[] = []; let more = false; const seen = new Set<string>();
  const top = await listFolder(l.id, l.rk); const name = top.title || (await folderTitle(l.id, l.rk)) || l.id;
  const walk = async (list: typeof top, at: string[], depth: number): Promise<void> => {
    const subs: { e: (typeof top.entries)[number]; path: string[] }[] = [];
    for (const e of list.entries) {
      if (seen.has(e.id)) continue; seen.add(e.id);
      const kind = parseDrive(/^https?:/.test(e.href) ? e.href : `https://drive.google.com${e.href}`);
      if (kind?.kind === 'folder') { subs.push({ e, path: [...at, e.name || e.id] }); continue; }
      if (files.length >= MAX_FILES) { more = true; return; }
      const doc = kind?.kind === 'doc' ? kind.doc : undefined;
      const fname = doc && !new RegExp(`\\.${DOC_EXT[doc]}$`, 'i').test(e.name) ? `${e.name || e.id}.${DOC_EXT[doc]}` : e.name || e.id;
      files.push({ id: e.id, name: fname, path: [...at, fname].join('/'), size: 0, rk: e.rk, doc });
    }
    if (depth >= MAX_DEPTH) { if (subs.length) more = true; return; }
    // (Subfolders read a few at a time.)
    for (let i = 0; i < subs.length; i += 4) {
      const got = await Promise.all(subs.slice(i, i + 4).map(async (s) => ({ s, list: await listFolder(s.e.id, s.e.rk).catch(() => null) })));
      for (const g of got) { if (g.list) await walk(g.list, g.s.path, depth + 1); else more = true; }
    }
  };
  await walk(top, [], 0);
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { service: 'Google Drive', name, folder: true, files, more };
}

/** The listed files' sizes, a few at a time (a folder's view gives none), each told as it is known. */
export async function driveSizes(files: DriveFile[], onSize: (f: DriveFile, size: number, name?: string) => void, stop: () => boolean): Promise<void> {
  for (const f of files) if (f.doc) onSize(f, -1); // (A Doc is made when downloaded: no size before.)
  let i = 0; const todo = files.filter((f) => !f.size && !f.doc).slice(0, 400);
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < todo.length && !stop()) { const f = todo[i++]; try { const r = await resolveFile(f); onSize(f, r.size, r.name); } catch { onSize(f, -1); } } }));
}

/** The files added as downloads (a folder's in its own folder, its tree kept); those Drive would not give, counted. */
export async function addDriveFiles(eng: Engine, info: CloudInfo<DriveFile>, files: DriveFile[], base: Omit<AddOptions, 'source'>, link: string, dirFor: (f: CloudFile) => string | undefined): Promise<{ tasks: Task[]; failed: number; error?: string }> {
  const got: (Resolved | Error)[] = new Array(files.length); let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < files.length) { const k = i++; got[k] = await resolveFile(files[k]).catch((e: Error) => e); } }));
  const tasks: Task[] = []; let failed = 0; let error: string | undefined;
  for (let k = 0; k < files.length; k++) {
    const f = files[k]; const r = got[k];
    if (r instanceof Error) { failed++; error ??= r.message; continue; }
    tasks.push(await eng.add({ ...base, source: { url: r.url }, dir: dirFor(f), name: f.name, meta: { ...(base.meta ?? {}), gdrive: f.id, gdriveLink: link, ...(f.rk ? { gdriveRk: f.rk } : {}), ...(f.doc ? { gdriveDoc: f.doc } : {}) } }));
  }
  return { tasks, failed, error };
}

/** A Drive download whose address stopped working (Drive's addresses can run out): a fresh one asked for and the
 *  download taken up again — once per download while the app runs. */
const renewed = new Set<string>();
export async function renewFailed(eng: Engine, tasks: Task[]): Promise<void> {
  for (const x of tasks) {
    if (x.state !== 'failed' || !x.meta?.gdrive || renewed.has(x.id) || !eng.setUrl) continue; renewed.add(x.id);
    try { const r = await resolveFile({ id: x.meta.gdrive, rk: x.meta.gdriveRk, doc: x.meta.gdriveDoc as DocKind | undefined }, true); await eng.setUrl(x.id, r.url); await eng.resume(x.id); } catch { /* left failed: its error stays */ }
  }
}
