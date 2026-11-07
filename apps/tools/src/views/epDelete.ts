// An episode's download deleted from its show's page (Anime, TV & Movies): when the episode is one file of a larger
// download (a batch, a season pack), only its file — or the whole download, if that is what is wanted.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getEngine } from '../engine';
import type { Task } from '../engine/types';

export async function deleteEpisodeSheet(got: Task, n: number, changed: () => void, season?: number): Promise<void> {
  const D = await import('../downloads/deleteFile'); const fi = await D.fileOfEpisode(got, n, season);
  const one = fi !== undefined && got.files.some((f) => f.index !== fi && f.priority > 0);
  const c = openSheet(t('epDeleteDownload'), t('close'), { stack: true });
  c.body.append(h('p', null, one ? t('epDeleteAskBatch', { n: localDigits(n) }) : t('epDeleteAsk', { n: localDigits(n) })), h('p', { class: 'src', dir: 'auto' }, one ? (got.files.find((f) => f.index === fi)!.path.split('/').pop() ?? '') : got.name));
  const whole = async () => { c.close(); await getEngine().remove(got.id, true).catch((er) => toast(String((er as Error).message ?? er), 'error')); void import('../downloads/episodeCache').then((m) => m.forget(got.id)); toast(t('epDeleted', { n: localDigits(n) })); changed(); };
  const file = async () => { c.close(); try { await D.deleteTaskFile(got, fi!); void import('../downloads/episodeCache').then((m) => m.forget(got.id)); toast(t('epDeleted', { n: localDigits(n) })); } catch (er) { toast(String((er as Error).message ?? er), 'error'); } changed(); };
  c.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => c.close() }, t('cancel')),
    ...(one ? [h('button', { type: 'button', class: 'btn text danger', onclick: () => void whole() }, t('epDeleteWhole')), h('button', { type: 'button', class: 'btn primary danger', onclick: () => void file() }, icon('trash'), t('epDeleteFileOnly'))]
      : [h('button', { type: 'button', class: 'btn primary danger', onclick: () => void whole() }, icon('trash'), t('epDeleteYes'))]));
}
