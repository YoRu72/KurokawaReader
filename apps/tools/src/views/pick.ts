// Another app asked for a file and chose Kurokawa Tools (Android: KtPickActivity → #/pick): the Files page as a
// picker — the storages, the path, the kinds, search, sort, grid or list, the pictures — with what was asked
// (one file or several, of which kinds, by which app) and Cancel / Select at the bottom. Select hands the files back
// (content:// links the asking app may read) and the app steps aside; Cancel, or Back at the top, hands back nothing.
// Phones only: a computer has no such request, and the page says nobody is waiting.
import { h, icon } from '../ui/dom';
import { t } from '../i18n';
import { ktPlugin } from '../native';
import { navigate, previousPath } from '../router';
import { filesPane } from './files';
import { parsePick } from './pickLogic';

type PickPlug = { pickRequest?(): Promise<{ request: string | null }>; pickDone?(o: { paths: string[]; id: string }): Promise<void> };

export function pickView(): HTMLElement & { dispose?: () => void } {
  document.documentElement.classList.add('picking');
  const host = h('div', { class: 'pick-host', style: { display: 'contents' } }, h('div', { class: 'center' }, h('div', { class: 'spinner' }))) as HTMLElement & { dispose?: () => void };
  const p = ktPlugin() as unknown as PickPlug | null;
  let inner: (HTMLElement & { dispose?: () => void }) | null = null; let answered = false; let gone = false; let id = '';
  const leave = () => { document.documentElement.classList.remove('picking'); if (previousPath()) history.back(); else navigate('/', true); };
  /** The answer, once: the paths chosen, or none. */
  const answer = (paths: string[]) => { if (answered) return; answered = true; void p?.pickDone?.({ paths, id }).catch(() => undefined); };
  void (async () => {
    const got = p?.pickRequest ? await p.pickRequest().catch(() => null) : null; if (gone) return;
    const req = parsePick(got?.request ?? null); if (req) id = req.id;
    if (!req) {
      answered = true;
      host.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'body' }, h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('folder')), h('p', null, t('pickNothingAsked')), h('button', { type: 'button', class: 'btn tonal', onclick: leave }, t('close'))))));
      return;
    }
    inner = filesPane({}, { pick: { req, done: (paths) => { answer(paths); leave(); }, cancel: () => { answer([]); leave(); } } });
    host.replaceChildren(inner);
  })();
  // (Left another way — the page moved on —: the asking app is not kept waiting.)
  host.dispose = () => { gone = true; document.documentElement.classList.remove('picking'); inner?.dispose?.(); if (id) answer([]); };
  return host;
}
