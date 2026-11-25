// A comic archive (RAR, 7z, tar — or a protected zip) met on import: made into a CBZ (src/comic/repack.ts) as a job —
// «Preparing <name>» with the pages done, a Cancel in the jobs sheet the chip opens —, asking for a password in the
// app's own dialog when the archive wants one (never kept). One at a time: each holds its archive in memory while it
// is read. Whatever goes wrong is said plainly and the original is left as it was; a cancel leaves nothing at all
// (the book is only made after the whole zip is). The error thrown is marked `handled`: it has been told already.
import { t, localDigits } from '../i18n';
import { toast, askPassword } from '../ui/dom';
import { runJob } from '../jobs';
import { RepackError, repackToCbz } from './repack';
import { comicStem, type ArchiveKind } from './archives';
import { canArchive } from '../archives';

export interface Prepared { file: File; madeFrom: string; pages: number; peakMB: number }
const handled = (msg: string): Error => Object.assign(new Error(msg), { handled: true });
export const isHandled = (e: unknown): boolean => !!(e as { handled?: boolean } | null)?.handled;

let turn: Promise<unknown> = Promise.resolve();
/** Make the archive a CBZ. Resolves with the new file; rejects with a handled error after saying why (or cancelled). */
export function prepareComic(file: File & { krSource?: { path?: string } }, kind: ArchiveKind): Promise<Prepared> {
  const run = turn.then(() => work(file, kind));
  turn = run.catch(() => undefined);
  return run;
}

async function work(file: File & { krSource?: { path?: string } }, kind: ArchiveKind): Promise<Prepared> {
  let stop: (() => void) | null = null; let out: { blob: Blob; label: string; pages: number; peakMB: number } | null = null; let why: RepackError | null = null;
  const title = t('archPreparing', { name: file.name });
  await runJob(title, async (report) => {
    report(0, t('archPages', { n: localDigits(0), total: '…' }));
    try {
      out = await repackToCbz(file, file.name, kind, {
        progress: (n, total) => report(total ? (n / total) * 100 : 0, t('archPages', { n: localDigits(n), total: localDigits(total) })),
        // (The «Adding…» note of the import is let go: it would sit over the dialog's field.)
        password: (wrong) => { document.querySelectorAll('.toast').forEach((x) => x.remove()); return askPassword({ title: t('archProtected'), hint: wrong ? t('archPasswordWrong') : t('archPasswordPrompt'), wrong, label: t('password'), open: t('open'), cancel: t('cancel') }); },
        onCancel: (c) => { stop = c; },
      });
    } catch (e) { why = e instanceof RepackError ? e : new RepackError('failed', String((e as Error)?.message ?? e)); return null; }
    // (The zip itself stays here, not in the job's record: a job keeps what it returns for the jobs sheet.)
    return { blob: new Blob([]), name: file.name };
  }, () => false, { quiet: true, cancel: () => stop?.(), doneText: () => t('jobDoneQuiet', { name: file.name }) });
  const err = why as RepackError | null; const got = out as { blob: Blob; label: string; pages: number; peakMB: number } | null;
  if (err) {
    if (err.code === 'cancelled') { toast(t('cancelled')); throw handled('cancelled'); }
    if (err.code === 'nopictures') {
      const path = file.krSource?.path;
      toast(t('archNoPictures'), 'info', canArchive() ? { ms: 9000, action: { label: t('archOpenInArchives'), run: () => void import('../ui/archives').then((m) => (path ? m.extractSheet(path) : m.openArchivePicker())) } } : 6000);
      throw handled('nopictures');
    }
    toast(t(err.code === 'memory' ? 'archTooBig' : 'archFailed', { name: file.name }), 'error', 7000);
    throw handled(err.code);
  }
  if (!got) throw handled('cancelled');
  // (For the tests: what the last one cost.)
  (window as unknown as { __krPrepared?: unknown }).__krPrepared = { pages: got.pages, peakMB: got.peakMB };
  return { file: new File([got.blob], `${comicStem(file.name)}.cbz`, { type: 'application/vnd.comicbook+zip' }), madeFrom: got.label, pages: got.pages, peakMB: got.peakMB };
}
