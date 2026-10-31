// The downloads, as a download manager lists them: what runs (its progress, speed, a stop), what waits its
// turn, what came and what failed (asked for again or cleared). Opened from Settings and from the library.
import { h, icon, openSheet, toast } from './dom';
import { t, formatBytes, localDigits } from '../i18n';
import { downloadsNow, onDownloads, cancelDownload, retryDownload, clearDownloads, describeProgress, type Download } from '../downloads';
import { navigate } from '../router';

export function downloadsSheet(): void {
  const sh = openSheet(t('downloads'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const list = h('div', { class: 'dl-list' });
  const clear = h('button', { type: 'button', class: 'btn small tonal', onclick: () => { clearDownloads(); } }, icon('trash'), t('clearFinished')) as HTMLButtonElement;
  sh.body.append(list);
  sh.actions.append(clear);
  const row = (d: Download): HTMLElement => {
    const running = d.state === 'running';
    const line = running ? (d.queued ? t('waitingTurn') : describeProgress(d) || t('starting')) : d.state === 'done' ? t('downloadDone') : d.state === 'failed' ? `${t('downloadFailed')}${d.error ? ` — ${d.error.slice(0, 80)}` : ''}` : t('cancelled');
    const bar = h('span', { style: { width: `${running ? d.pct : d.state === 'done' ? 100 : 0}%` } });
    const act = running
      ? h('button', { type: 'button', class: 'icon-btn', title: t('cancel'), 'aria-label': t('cancel'), onclick: () => cancelDownload(d.id) }, icon('close'))
      : d.state === 'done' && d.bookId
        ? h('button', { type: 'button', class: 'icon-btn', title: t('open'), 'aria-label': t('open'), onclick: () => { sh.close(); navigate(`/read/${d.bookId}`); } }, icon('play'))
        : h('button', { type: 'button', class: 'icon-btn', title: t('tryAgain'), 'aria-label': t('tryAgain'), onclick: () => { const p = retryDownload(d.id); if (p) { p.catch(() => undefined); } else toast(t('downloadFailed'), 'error'); } }, icon('refresh'));
    return h('div', { class: `dl-row ${d.state}${d.queued ? ' queued' : ''}` },
      h('div', { class: 'dl-text' }, h('b', { dir: 'auto' }, d.title), h('small', { dir: 'auto' }, `${d.name}${d.total ? ` · ${formatBytes(d.total)}` : ''}`), h('small', { class: 'dl-line' }, line), h('div', { class: 'progress-bar small', hidden: !running || !!d.queued }, bar)),
      act);
  };
  const draw = () => {
    const ds = downloadsNow();
    list.replaceChildren(...(ds.length ? ds.map(row) : [h('p', { class: 'hint' }, t('noDownloads'))]));
    const running = ds.filter((d) => d.state === 'running').length;
    sh.el.querySelector('.sheet-head h3')?.replaceChildren(running ? `${t('downloads')} · ${t('runningN', { n: localDigits(running) })}` : t('downloads'));
    clear.disabled = !ds.some((d) => d.state !== 'running');
  };
  draw();
  const off = onDownloads(draw);
  const obs = new MutationObserver(() => { if (!document.body.contains(sh.el)) { obs.disconnect(); off(); } });
  obs.observe(document.body, { childList: true, subtree: true });
}
