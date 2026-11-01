// When the app ended badly last time (a crash it wrote down, or what Android recorded: a crash in native code,
// not answering, memory), a card says so once, with the report to copy or to send as a GitHub issue.
import { h, icon, toast } from './dom';
import { t } from '../i18n';
import { ktPlugin, openExternal } from '../native';
import { APP_VERSION, REPO } from '../repo';

export async function showLastCrash(): Promise<void> {
  const p = ktPlugin() as unknown as { lastCrash?(): Promise<{ text: string | null }> } | null;
  let text: string | null = null; try { text = (await p?.lastCrash?.())?.text ?? null; } catch { return; }
  if (!text) return;
  const report = `Kurokawa Tools ${APP_VERSION}\n\n${text}`.slice(0, 6000);
  const close = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 180); };
  const el = h('div', { class: 'get-card crash-card', role: 'alert' },
    h('div', { class: 'get-head' }, h('span', { class: 'get-ic bad' }, icon('alert')), h('div', { class: 'grow' }, h('b', null, t('appCrashTitle')), h('small', null, t('crashHint'))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: close }, icon('close'))),
    h('pre', { class: 'crash-text', dir: 'ltr' }, report.split('\n').slice(0, 8).join('\n')),
    h('div', { class: 'get-actions' }, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn small tonal', onclick: () => void navigator.clipboard?.writeText(report).then(() => toast(t('copied'))) }, icon('copy'), t('crashCopy')),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => { void navigator.clipboard?.writeText(report).catch(() => undefined); void openExternal(`https://github.com/${REPO}/issues/new?title=${encodeURIComponent(`Tools ${APP_VERSION}: the app closed`)}&body=${encodeURIComponent('```\n' + report.slice(0, 3500) + '\n```')}`); close(); } }, icon('external'), t('crashSend'))));
  document.body.append(el);
}
