// What the library page needs of the device scan before anything is scanned (src/ui/scan.ts — fetched when a scan
// is asked for): the format groups of its filter chips, and whether this device can scan a folder or the whole device.
import { t } from '../i18n';
import type { Format } from '../db';
import type { KrScan } from './scan';

export interface Cap { getPlatform?(): string; Plugins?: { Kurokawa?: Partial<KrScan> } }
export const cap = (): Cap | undefined => (window as unknown as { Capacitor?: Cap }).Capacitor;
export type DesktopFound = { root: string; files: { path: string; name: string; size: number }[]; truncated: boolean };
export interface DesktopScan {
  scanDevice?(exts: string[]): Promise<DesktopFound>; readFile?(path: string): Promise<ArrayBuffer>;
  /** The Tauri shell's: the same walk in one folder, by path (Electron has it not: the web view's folder picker). */
  scanFolder?(root: string, exts: string[]): Promise<DesktopFound>; pickFolder?(): Promise<string | null>;
}
export const desktop = (): DesktopScan | undefined => (window as unknown as { kurokawaDesktop?: DesktopScan }).kurokawaDesktop;

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
  { id: 'cbz', label: 'CBZ', formats: ['cbz'], exts: ['cbz', 'cbr', 'cb7', 'cbt'] },
  { id: 'mobi', label: 'Kindle', formats: ['mobi'], exts: ['mobi', 'azw', 'azw3', 'kf8', 'prc'] },
  { id: 'anki', label: 'Anki', formats: ['anki'], exts: ['apkg', 'colpkg'] },
  { id: 'audio', label: t('audiobooks'), formats: ['audio'], exts: ['mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav'] },
  { id: 'image', label: t('images'), formats: ['image'], exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp'] },
];
export const groupOf = (f: Format): string => FORMAT_GROUPS.find((g) => g.formats.includes(f))?.id ?? 'text';

export function canScan(): boolean {
  const c = cap();
  if (c?.getPlatform?.() === 'android' || c?.getPlatform?.() === 'ios') return !!c.Plugins?.Kurokawa?.pickTree;
  return 'showDirectoryPicker' in window || !!desktop()?.scanDevice;
}
/** Whole device (and Download): Android with storage access — "All files access" from Android 11, granted by the
 *  reader in settings when they ask for it — or the desktop app. */
export function canScanWhole(): boolean {
  const c = cap();
  if (c?.getPlatform?.() === 'android') return !!c.Plugins?.Kurokawa?.scanDevice;
  return !!desktop()?.scanDevice;
}
