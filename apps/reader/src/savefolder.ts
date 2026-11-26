// PDF → Word, «In a folder» and «Save to»: a converted file written into folders the reader chose — the computer's Rust
// shell (bridge `saveFiles`, src-tauri/src/savefiles.rs) and the phone's folder picker (the native plugin's pickTree,
// treePlan, writeDocument, treeUndo). The document goes to one folder, its fonts to another (by default a folder
// «<document name> fonts» made beside the document). A file that is already there with the same bytes is not written
// again; one of the same name with other bytes leaves the new one named « (2)»; nothing is ever written over; what a failed
// save made is taken away. Where no folder is chosen (or there is no way to write to one: the web), the page's ZIP.
// Loaded when a folder is chosen or a result is saved, not at start.
import { folderFiles, folderName, safeFileName, type WithFonts } from './fontfolder';

export type Place = { dir: string; label: string };
export type Places = { doc?: Place; fonts?: Place };
export type Where = 'desktop' | 'android';

type Desk = { pickFolder?(): Promise<string | null>; saveFiles?(o: unknown): Promise<unknown> };
type Plan = { items: { rel: string; action: 'write' | 'same'; parent?: string; name?: string }[]; newDirs: string[] };
type Kr = {
  pickTree?(): Promise<{ uri: string; name: string }>;
  treePlan?(o: { tree: string; items: { rel: string; size: number; sha: string }[] }): Promise<Plan>;
  treeUndo?(o: { tree: string; uris: string[]; dirs: string[] }): Promise<unknown>;
  writeDocument?(o: { tree?: string; parent?: string; uri?: string; name?: string; mime?: string; data: string }): Promise<{ uri: string }>;
};
const desk = (): Desk | undefined => (window as unknown as { kurokawaDesktop?: Desk }).kurokawaDesktop;
const kr = (): Kr | undefined => (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: Kr }; getPlatform?(): string } }).Capacitor?.Plugins?.Kurokawa;
const isAndroid = (): boolean => (window as unknown as { Capacitor?: { getPlatform?(): string } }).Capacitor?.getPlatform?.() === 'android';

/** Where this device can write a converted file to a folder: the computer's Rust shell, an Android phone with the folder
 *  functions; null elsewhere (the web, Electron's shell, an older app build): the ZIP stays. */
export function folderWhere(): Where | null {
  const d = desk();
  if (d) return d.pickFolder && d.saveFiles ? 'desktop' : null;
  const k = kr();
  return isAndroid() && k?.pickTree && k.treePlan && k.writeDocument && k.treeUndo ? 'android' : null;
}

const KEY = 'kr.convert.places';
const sane = (p: unknown): Place | undefined => { const o = p as Place | undefined; return o && typeof o.dir === 'string' && o.dir && typeof o.label === 'string' ? { dir: o.dir, label: o.label } : undefined; };
/** The places chosen before (kept with the convert options); none where the device cannot write to a folder. */
export function readPlaces(): Places {
  if (!folderWhere()) return {};
  try { const o = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Places; return { doc: sane(o.doc), fonts: sane(o.fonts) }; } catch { return {}; }
}
export function writePlaces(p: Places): void { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } }

const lastName = (dir: string): string => { const parts = dir.split(/[\\/]/).filter(Boolean); return parts[parts.length - 1] || dir; };

/** The reader picks a folder: null when they cancel (or this device has no way). */
export async function pickPlace(): Promise<Place | null> {
  const w = folderWhere();
  try {
    if (w === 'desktop') { const dir = await desk()!.pickFolder!(); return dir ? { dir, label: lastName(dir) } : null; }
    if (w === 'android') { const t = await kr()!.pickTree!(); return t?.uri ? { dir: t.uri, label: t.name || lastName(t.uri) } : null; }
  } catch { /* cancelled */ }
  return null;
}

/** The folder the document goes to is chosen, so a save writes real files there (not a ZIP). */
export const hasDestination = (): boolean => !!readPlaces().doc;

/* ---------- the writing ---------- */

const CHUNK = 3 * 1024 * 1024;
const b64 = (bytes: Uint8Array): string => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
async function sha256(data: Blob | Uint8Array): Promise<string> {
  try {
    const buf = data instanceof Blob ? await data.arrayBuffer() : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return ''; } // (no hash: never taken for the same file)
}

type Made = { dir: string; rel: string; uri?: string };
type Job = { dir: string; rel: string; data: Blob; size: number; sha: string; mime: string };

export type Sent = {
  where: Where; docName: string; docSize: number;
  /** The folder the document went to (its name), and its path or address. */
  docIn: string; docDir: string;
  fontsCount: number; fontsIn: string; fontsDir: string;
  /** Files that were already there with the same bytes (nothing written for them). */
  same: number;
  /** Files written under another name because their name was taken. */
  renamed: number;
  /** Everything was already there: nothing was written. */
  nothingNew: boolean;
};

/**
 * Write a result to the folders chosen: the document into the document's folder; its fonts into the fonts folder, or —
 * where none is chosen — into «<document name> fonts» made beside the document. Resolves with what was done; rejects
 * (everything this call made taken away) when a step fails.
 */
export async function sendResult(out: { blob: Blob; name: string } & WithFonts, places: Places = readPlaces()): Promise<Sent> {
  const where = folderWhere();
  if (!where || !places.doc) throw new Error('no folder');
  const files = out.fonts?.length ? folderFiles(out.fonts) : [];
  const docName = safeFileName(out.name, 120);
  const sub = folderName(docName);
  const docDir = places.doc.dir; const fontDir = places.fonts?.dir ?? docDir;
  const jobs: Job[] = [{ dir: docDir, rel: docName, data: out.blob, size: out.blob.size, sha: await sha256(out.blob), mime: out.blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }];
  for (const f of files) jobs.push({ dir: fontDir, rel: places.fonts ? f.name : `${sub}/${f.name}`, data: new Blob([f.data as BlobPart]), size: f.data.length, sha: await sha256(f.data), mime: f.name.endsWith('.otf') ? 'font/otf' : 'font/ttf' });
  const dirs = [...new Set(jobs.map((j) => j.dir))];
  const made: Made[] = []; const madeDirs: { dir: string; name: string; uri?: string }[] = [];
  let same = 0, renamed = 0, written = 0; let docFinal = docName;
  try {
    for (const dir of dirs) {
      const mine = jobs.filter((j) => j.dir === dir);
      const plan = await planFor(where, dir, mine.map((j) => ({ rel: j.rel, size: j.size, sha: j.sha })));
      for (const n of plan.newDirs) madeDirs.push({ dir, name: n, uri: where === 'android' ? n : undefined });
      for (let i = 0; i < mine.length; i++) {
        const j = mine[i]; const p = plan.items[i];
        if (p.rel !== j.rel) renamed++;
        if (j === jobs[0]) docFinal = p.rel;
        if (p.action === 'same') { same++; continue; }
        const m: Made = { dir, rel: p.rel }; made.push(m);
        await writeFile(where, dir, j, p, m); written++;
      }
    }
  } catch (e) {
    await undoAll(where, made, madeDirs);
    throw e;
  }
  const label = (d: string) => (d === places.doc!.dir ? places.doc!.label : places.fonts?.label ?? places.doc!.label);
  return {
    where, docName: docFinal.split('/').pop()!, docSize: out.blob.size, docIn: places.doc.label, docDir,
    fontsCount: files.length, fontsIn: places.fonts ? label(fontDir) : `${places.doc.label}/${sub}`, fontsDir: places.fonts ? fontDir : docDir,
    same, renamed, nothingNew: written === 0,
  };
}

async function planFor(where: Where, dir: string, items: { rel: string; size: number; sha: string }[]): Promise<Plan> {
  const r = where === 'desktop' ? await desk()!.saveFiles!({ op: 'plan', dir, items }) : await kr()!.treePlan!({ tree: dir, items });
  const plan = r as Plan;
  if (!plan?.items || plan.items.length !== items.length) throw new Error('plan');
  return plan;
}

async function writeFile(where: Where, dir: string, j: Job, p: Plan['items'][number], made: Made): Promise<void> {
  let uri: string | undefined;
  for (let off = 0; off < j.size || off === 0; off += CHUNK) {
    const part = new Uint8Array(await j.data.slice(off, off + CHUNK).arrayBuffer());
    const first = off === 0, last = off + CHUNK >= j.size;
    if (where === 'desktop') await desk()!.saveFiles!({ op: 'part', dir, rel: p.rel, b64: b64(part), first, last });
    else {
      const r = await kr()!.writeDocument!(first ? { tree: dir, parent: p.parent, name: p.name ?? p.rel.split('/').pop(), mime: j.mime, data: b64(part) } : { uri, data: b64(part) });
      uri = r.uri; made.uri = uri;
    }
    if (j.size === 0) break;
  }
}

async function undoAll(where: Where, made: Made[], dirs: { dir: string; name: string; uri?: string }[]): Promise<void> {
  const trees = new Set([...made.map((m) => m.dir), ...dirs.map((d) => d.dir)]);
  for (const dir of trees) {
    try {
      if (where === 'desktop') await desk()!.saveFiles!({ op: 'undo', dir, rels: made.filter((m) => m.dir === dir).map((m) => m.rel), dirs: dirs.filter((d) => d.dir === dir).map((d) => d.name) });
      else await kr()!.treeUndo!({ tree: dir, uris: made.filter((m) => m.dir === dir && m.uri).map((m) => m.uri!), dirs: dirs.filter((d) => d.dir === dir && d.uri).map((d) => d.uri!) });
    } catch (e) { console.warn('[kurokawa] undo of a save failed', e); }
  }
}

/** A folder shown in the computer's file manager (the Rust shell only). */
export async function openFolder(dir: string): Promise<boolean> {
  try { return !!(await desk()?.saveFiles?.({ op: 'open', p: dir })); } catch { return false; }
}
export const canOpenFolder = (): boolean => folderWhere() === 'desktop';
