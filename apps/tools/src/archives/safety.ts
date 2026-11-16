// The page's side of safe extraction: the pre-flight report the sheet shows before anything changes. On the computer
// the engine gathers the facts and decides (desktop/inplace.cjs over archsafe.cjs, through kt:archivePreflight); on
// the phone the page decides from what the archive's listing says with the very same rules (archsafe.cjs — the twin
// of KtNameSafe.java that the phone's engine checks again before its first change). The shelf: jobs left unfinished.
import * as S from '../../desktop/archsafe.cjs';
import type { Answers, Choice, Facts, Report, Platform } from '../../desktop/archsafe.cjs';
import type { ArchiveInfo } from '../archives';
import { ktPlugin } from '../native';
export type { Answers, Choice, Report };

type Desk = { archivePreflight?(o: { path: string; dest: string; password?: string; verify?: boolean; keepFree?: number }): Promise<{ report: Report; facts: Partial<Facts> }>; archiveShelf?(o?: { atStart?: boolean }): Promise<ShelfJob[]>; archiveJob?(o: { id?: string; journal: string; act: string; password?: string }): Promise<unknown> };
const desk = (): Desk | null => { const k = window.kurokawaTools as unknown as Desk | undefined; return k?.archivePreflight ? k : null; };
export interface ShelfJob { journal: string; id: string; archive: string; dest: string; mode: 'inplace' | 'normal'; state: string; why?: string; done: number; total: number; can: string[] }

/** The volume a phone path is on: an SD card or USB stick (/storage/XXXX-XXXX), or the phone's own storage. */
const volumeOf = (p: string): string => (/^\/(storage|mnt\/media_rw)\/[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}/.exec(p)?.[0] ?? (p.startsWith('content:') ? 'saf' : 'internal'));
/** The phone's name rules for a folder: FAT/exFAT on a removable volume. */
export const phonePlatform = (dest: string): Platform => (volumeOf(dest).startsWith('/') ? 'android-fat' : 'android');

/** The report for one archive and one destination; nothing is written. */
export async function preflightFor(info: ArchiveInfo, path: string, dest: string, o: { password?: string; verify?: boolean; free: number; keepFree: number; existing: string[] }): Promise<Report> {
  const d = desk(); if (d?.archivePreflight) { try { return (await d.archivePreflight({ path, dest, password: o.password, verify: o.verify, keepFree: o.keepFree })).report; } catch { /* the computer's older engine: the page decides */ } }
  const p = ktPlugin() ? phonePlatform(dest) : ((info as ArchiveInfo & { platform?: Platform }).platform ?? 'linux');
  const entries = info.entries.map((e) => ({ path: e.path, dir: e.dir, usize: Math.max(0, e.size), csize: e.compressed ?? 0, method: (e as { method?: number }).method, offset: (e as { offset?: number }).offset, encrypted: (e as { encrypted?: boolean }).encrypted }));
  const zipLike = info.format === 'zip' || info.format === 'tar';
  const f: Facts = { format: info.format, platform: p, entries, supported: info.format === 'zip' ? [0, 8, 9, 12, 14, 95] : entries.map((e) => e.method ?? 0), external: [], encrypted: info.encrypted, password: info.encrypted ? (o.password ? 'ok' : 'missing') : 'none', layoutBad: info.duplicate ? [] : [], archiveWritable: !path.startsWith('content:'), destWritable: true, saf: path.startsWith('content:'), sameVolume: volumeOf(path) === volumeOf(dest), free: o.free, existing: o.existing, inPlaceFormat: zipLike && info.inPlaceOk, blockSize: 4096 };
  return S.preflight(f, { margin: o.keepFree });
}
/** «name (2).ext» the first a folder does not hold (the batch rename's numbering). */
export const keepBothName = (name: string, taken: (n: string) => boolean): string => S.keepBothName(name, taken);

/** The jobs left unfinished (the computer keeps their list; the phone has only the one beside an archive opened). */
export async function shelfJobs(atStart = false): Promise<ShelfJob[]> { const d = desk(); try { return d?.archiveShelf ? await d.archiveShelf({ atStart }) : []; } catch { return []; } }
export async function shelfAct(journal: string, act: 'finish' | 'restore' | 'undo' | 'dismiss' | 'restoreV1' | 'leave', id?: string, password?: string): Promise<unknown> { const d = desk(); if (!d?.archiveJob) throw new Error('unsupported'); return d.archiveJob({ journal, act, id, ...(password ? { password } : {}) }); }
export const choiceOf = (a: Answers | undefined, path: string, dir: boolean): Choice | null => S.conflictChoice(a, path, dir);
