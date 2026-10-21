// Device scan importer: pick a folder on the device, list every readable file
// in it (filtered by type), tick what to import and choose where it goes.
//  - Android: Storage Access Framework through the Kurokawa plugin (pickTree / listTree / readDocument)
//  - Desktop & Chromium browsers: the File System Access API (showDirectoryPicker)
//  - Elsewhere: the ordinary multi-file picker takes over.
import { h, icon, openSheet, toast, clear } from './dom';
import { t, formatBytes, localDigits } from '../i18n';
import { detectFormat } from '../formats';
import type { Format, Folder } from '../db';

export interface ScanEntry { name: string; path: string; size: number; format: Format; read: () => Promise<File> }
export interface ScanResult { folderName: string; files: ScanEntry[]; truncated: boolean }

import { destinationList, type Destination } from './destination';
export type { Destination };

interface ScanFile { uri: string; tree?: string; name: string; path: string; mime: string; size: number }
interface KrScan {
  storageAccess(): Promise<{ granted: boolean; needsSettings: boolean }>;
  requestStorageAccess(): Promise<{ granted: boolean }>;
  scanDevice(o: { exts: string[] }): Promise<{ files: ScanFile[]; truncated: boolean }>;
  pickTree(): Promise<{ uri: string; name: string }>;
  listTree(o: { uri: string; exts: string[] }): Promise<{ files: ScanFile[]; truncated: boolean }>;
  readDocument(o: { uri: string; tree?: string }): Promise<{ data: string }>;
}
interface Cap { getPlatform?(): string; Plugins?: { Kurokawa?: Partial<KrScan> } }
const cap = (): Cap | undefined => (window as unknown as { Capacitor?: Cap }).Capacitor;
interface DesktopScan { scanDevice?(exts: string[]): Promise<{ root: string; files: { path: string; name: string; size: number }[]; truncated: boolean }>; readFile?(path: string): Promise<ArrayBuffer> }
const desktop = (): DesktopScan | undefined => (window as unknown as { kurokawaDesktop?: DesktopScan }).kurokawaDesktop;

/** Groups shown as filter chips, in display order. */
export const FORMAT_GROUPS: { id: string; label: string; formats: Format[]; exts: string[] }[] = [
  { id: 'epub', label: 'EPUB', formats: ['epub'], exts: ['epub'] },
  { id: 'pdf', label: 'PDF', formats: ['pdf'], exts: ['pdf'] },
  { id: 'docx', label: 'Word', formats: ['docx'], exts: ['docx', 'docm', 'dotx'] },
  { id: 'sheet', label: 'Excel · CSV', formats: ['xlsx', 'csv'], exts: ['xlsx', 'xlsm', 'csv', 'tsv'] },
  { id: 'pptx', label: 'PowerPoint', formats: ['pptx'], exts: ['pptx', 'ppsx'] },
  { id: 'text', label: 'TXT · MD · HTML', formats: ['txt', 'md', 'html'], exts: ['txt', 'text', 'log', 'md', 'markdown', 'html', 'htm', 'xhtml'] },
  { id: 'fb2', label: 'FB2', formats: ['fb2'], exts: ['fb2'] },
  { id: 'odt', label: 'ODT', formats: ['odt'], exts: ['odt'] },
  { id: 'cbz', label: 'CBZ', formats: ['cbz'], exts: ['cbz'] },
  { id: 'image', label: t('images'), formats: ['image'], exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp'] },
];
export const groupOf = (f: Format): string => FORMAT_GROUPS.find((g) => g.formats.includes(f))?.id ?? 'text';

export function canScan(): boolean {
  const c = cap();
  if (c?.getPlatform?.() === 'android' || c?.getPlatform?.() === 'ios') return !!c.Plugins?.Kurokawa?.pickTree;
  return 'showDirectoryPicker' in window || !!desktop()?.scanDevice;
}
/** Whole-device scanning: Android with storage access, or the desktop app. */
export function canScanWhole(): boolean {
  const c = cap();
  if (c?.getPlatform?.() === 'android') return !!c.Plugins?.Kurokawa?.scanDevice;
  return !!desktop()?.scanDevice;
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const ALL_EXTS = FORMAT_GROUPS.flatMap((g) => g.exts);

function toEntries(plugin: KrScan, files: ScanFile[]): ScanEntry[] {
  return files.map((f) => ({
    name: f.name, path: f.path, size: f.size, format: detectFormat(f.name, f.mime),
    read: async () => { const { data } = await plugin.readDocument({ uri: f.uri, tree: f.tree }); return new File([base64ToBlob(data, f.mime)], f.name, { type: f.mime }); },
  }));
}

/** Android: every readable file on shared storage (needs "All files access" on Android 11+). Returns 'denied' when the grant is missing. */
async function scanAndroidWhole(exts: string[]): Promise<ScanResult | 'denied'> {
  const plugin = cap()!.Plugins!.Kurokawa as KrScan;
  const access = await plugin.storageAccess();
  if (!access.granted) {
    const r = await plugin.requestStorageAccess().catch(() => ({ granted: false }));
    if (!r.granted) return 'denied';
  }
  const res = await plugin.scanDevice({ exts });
  return { folderName: t('wholeDevice'), truncated: res.truncated, files: toEntries(plugin, res.files) };
}

async function scanDesktopWhole(exts: string[]): Promise<ScanResult | null> {
  const d = desktop();
  if (!d?.scanDevice || !d.readFile) return null;
  const res = await d.scanDevice(exts);
  return { folderName: res.root, truncated: res.truncated, files: res.files.map((f) => ({ name: f.name, path: f.path, size: f.size, format: detectFormat(f.name), read: async () => new File([await d.readFile!(f.path)], f.name) })) };
}

async function scanAndroid(exts: string[]): Promise<ScanResult | null> {
  const plugin = cap()!.Plugins!.Kurokawa as KrScan;
  let tree: { uri: string; name: string };
  try { tree = await plugin.pickTree(); } catch { return null; }
  const res = await plugin.listTree({ uri: tree.uri, exts });
  return { folderName: tree.name, truncated: res.truncated, files: toEntries(plugin, res.files) };
}

type DirHandle = { name: string; values(): AsyncIterable<DirHandle | FileHandle>; kind: 'directory' };
type FileHandle = { name: string; kind: 'file'; getFile(): Promise<File> };

async function scanWeb(exts: string[]): Promise<ScanResult | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: { mode?: string }) => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) return null;
  let root: DirHandle;
  try { root = await picker({ mode: 'read' }); } catch { return null; }
  const files: ScanEntry[] = [];
  let visited = 0; let truncated = false;
  const walk = async (dir: DirHandle, prefix: string): Promise<void> => {
    if (++visited > 4000 || files.length >= 5000) { truncated = true; return; }
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') { if (!entry.name.startsWith('.') && entry.name !== 'node_modules') await walk(entry, `${prefix}${entry.name}/`); continue; }
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (!exts.includes(ext)) continue;
      const fh = entry;
      let size = 0;
      try { size = (await fh.getFile()).size; } catch { continue; }
      files.push({ name: entry.name, path: `${prefix}${entry.name}`, size, format: detectFormat(entry.name), read: () => fh.getFile() });
    }
  };
  await walk(root, '');
  return { folderName: root.name, files, truncated };
}

export interface ScanSheetOptions {
  folders: Folder[];
  activeFolder: string | null;
  existing: Set<string>;                       // `${fileName}:${size}` of books already in the library
  onImport(files: File[], dest: Destination): Promise<void>;
  fallbackPick(): void;                        // plain file picker when scanning is unavailable
}

export function openScanSheet(o: ScanSheetOptions): void {
  if (!canScan()) { toast(t('notSupportedHere')); o.fallbackPick(); return; }
  const sheet = openSheet(t('scanDevice'), t('close'));
  sheet.body.style.fontFamily = 'var(--font-ui)';
  const picked = new Set<string>(FORMAT_GROUPS.map((g) => g.id));
  const typeRow = h('div', { class: 'chip-row wrap' });
  const renderTypes = () => {
    clear(typeRow);
    for (const g of FORMAT_GROUPS) typeRow.append(h('button', { type: 'button', class: 'chip small' + (picked.has(g.id) ? ' on' : ''), 'aria-pressed': String(picked.has(g.id)), onclick: () => { if (picked.has(g.id)) picked.delete(g.id); else picked.add(g.id); renderTypes(); renderList(); } }, picked.has(g.id) ? icon('check') : null, h('span', { lang: g.id === 'image' ? undefined : 'en', dir: 'ltr' }, g.label)));
  };
  renderTypes();
  const status = h('p', { class: 'src' }, t('scanBody'));
  const list = h('div', { class: 'scan-list' });
  const pickBtn = h('button', { class: 'btn small tonal', type: 'button', onclick: () => void scan('folder') }, icon('folder'), t('pickFolder'));
  const wholeBtn = canScanWhole() ? h('button', { class: 'btn small primary', type: 'button', onclick: () => void scan('whole') }, icon('search'), t('wholeDevice')) : null;
  sheet.body.append(h('div', { class: 'field' }, h('span', { class: 'label' }, t('filterFormats')), typeRow), status, h('div', { class: 'actions-row' }, wholeBtn, pickBtn), list);

  let result: ScanResult | null = null;
  const selected = new Set<string>();
  const destInit: Destination = o.activeFolder ? { kind: 'folder', id: o.activeFolder } : { kind: 'library' };
  const destList = destinationList(o.folders, destInit);

  const importSel = h('button', { class: 'btn small primary', type: 'button', disabled: true, onclick: () => void run(false) }, icon('import'), t('importSelected'));
  const importAll = h('button', { class: 'btn small', type: 'button', disabled: true, onclick: () => void run(true) }, t('importAll'));
  sheet.body.append(h('div', { class: 'field', style: { marginTop: '12px' } }, h('span', { class: 'label' }, t('destination')), destList.el));
  sheet.actions.append(importAll, importSel);

  const visible = (): ScanEntry[] => (result?.files ?? []).filter((f) => picked.has(groupOf(f.format)));

  function renderList() {
    clear(list);
    const files = visible();
    importAll.disabled = !files.length;
    importSel.disabled = ![...selected].some((p) => files.some((f) => f.path === p));
    if (!result) return;
    status.textContent = files.length ? `${result.folderName} · ${t('found', { n: localDigits(files.length) })}${result.truncated ? ' +' : ''}` : t('nothingFound');
    if (!files.length) return;
    const allOn = files.every((f) => selected.has(f.path));
    list.append(h('label', { class: 'scan-row head' }, h('input', { type: 'checkbox', checked: allOn, onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; files.forEach((f) => (on ? selected.add(f.path) : selected.delete(f.path))); renderList(); } }), h('span', { class: 'name' }, t('selectAll'))));
    for (const f of files) {
      const dup = o.existing.has(`${f.name}:${f.size}`);
      list.append(h('label', { class: 'scan-row' + (dup ? ' dup' : '') },
        h('input', { type: 'checkbox', checked: selected.has(f.path), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) selected.add(f.path); else selected.delete(f.path); importSel.disabled = !selected.size; } }),
        h('span', { class: 'fmt' }, f.format.toUpperCase()),
        h('span', { class: 'name', dir: 'auto', title: f.path }, f.name),
        h('span', { class: 'meta' }, dup ? t('alreadyInLibrary') : formatBytes(f.size))));
    }
  }

  async function scan(mode: 'folder' | 'whole') {
    pickBtn.disabled = true; if (wholeBtn) wholeBtn.disabled = true;
    status.textContent = t('scanning');
    const exts = ALL_EXTS;
    try {
      const plat = cap()?.getPlatform?.();
      const mobile = plat === 'android' || plat === 'ios';
      let r: ScanResult | 'denied' | null;
      if (mode === 'whole') r = plat === 'android' ? await scanAndroidWhole(exts) : await scanDesktopWhole(exts);
      else r = mobile ? await scanAndroid(exts) : await scanWeb(exts);
      if (r === 'denied') { status.textContent = t('storageDenied'); result = null; return; }
      result = r;
      if (!result) { status.textContent = t('scanBody'); return; }
      selected.clear();
      result.files.forEach((f) => { if (!o.existing.has(`${f.name}:${f.size}`)) selected.add(f.path); });
      renderList();
    } catch (err) { status.textContent = String((err as Error).message ?? err); }
    finally { pickBtn.disabled = false; if (wholeBtn) wholeBtn.disabled = false; }
  }

  async function run(all: boolean) {
    const entries = visible().filter((f) => all || selected.has(f.path));
    if (!entries.length) return;
    const dest = destList.get();
    if (!dest) { destList.focusName(); return; }
    importSel.disabled = importAll.disabled = true;
    toast(t('importing', { n: localDigits(entries.length) }), 'info', 60000);
    const files: File[] = [];
    for (const e of entries) { try { files.push(await e.read()); } catch (err) { toast(t('importFailed', { name: e.name, error: String((err as Error).message ?? err) }), 'error', 4000); } }
    sheet.close();
    await o.onImport(files, dest);
  }
}

