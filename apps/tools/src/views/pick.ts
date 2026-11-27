// Another app asked for a file and chose Kurokawa Tools (Android: KtPickActivity → #/pick): the Files page as a
// picker — the storages, the path, the kinds, search, sort, grid or list, the pictures — with what was asked
// (one file or several, of which kinds, by which app) and Cancel / Select at the bottom. Select hands the files back
// (content:// links the asking app may read) and the app steps aside; Cancel, or Back at the top, hands back nothing.
// Phones only: a computer has no such request, and the page says nobody is waiting.
import { h, icon, toast } from '../ui/dom';
import { t } from '../i18n';
import { ktPlugin } from '../native';
import { navigate, previousPath } from '../router';
import { filesPane } from './files';
import { parsePick } from './pickLogic';

type PickPlug = { pickRequest?(): Promise<{ request: string | null }>; pickDone?(o: { paths: string[]; id: string }): Promise<{ refused?: unknown; why?: unknown } | void> };

/** A picker left while its request is still open: its «none» held a moment — the same request shown again (Android's
 *  hand-over and the page's own look at start can both bring it) goes on; another one, or none, sends it. */
let held: { id: string; send: () => void; timer: number } | null = null;
const sendHeld = (keep?: string) => { const x = held; held = null; if (!x) return; window.clearTimeout(x.timer); if (x.id !== keep) x.send(); };

export function pickView(): HTMLElement & { dispose?: () => void } {
  document.documentElement.classList.add('picking');
  const host = h('div', { class: 'pick-host', style: { display: 'contents' } }, h('div', { class: 'center' }, h('div', { class: 'spinner' }))) as HTMLElement & { dispose?: () => void };
  const p = ktPlugin() as unknown as PickPlug | null;
  let inner: (HTMLElement & { dispose?: () => void }) | null = null; let answered = false; let gone = false; let id = '';
  const leave = () => { document.documentElement.classList.remove('picking'); if (previousPath()) history.back(); else navigate('/', true); };
  /** The answer, once: the paths chosen, or none. */
  const answer = (paths: string[]) => { if (answered) return; answered = true; void p?.pickDone?.({ paths, id }).catch(() => undefined); };
  /** The files chosen handed back — unless one cannot be given a link, or is no longer there (Android says which and
   *  why): then nothing is, those are returned for the screen to say so, and the request stays open. The asking app no
   *  longer waiting (closed, or gone back to without an answer) is said, and the picker left. */
  const hand = async (paths: string[]): Promise<{ refused: string[]; why: string }> => {
    if (answered) return { refused: [], why: '' }; answered = true;
    try { const r = await p?.pickDone?.({ paths, id }); const ref = r && Array.isArray(r.refused) ? r.refused.filter((x): x is string => typeof x === 'string' && !!x) : []; if (ref.length && !gone) { answered = false; return { refused: ref, why: r && typeof r.why === 'string' ? r.why : 'nolink' }; } }
    catch (e) { if (/no request/i.test(String((e as Error)?.message ?? e))) toast(t('pickAskerGone'), 'error', 6000); }
    return { refused: [], why: '' };
  };
  void (async () => {
    const got = p?.pickRequest ? await p.pickRequest().catch(() => null) : null; if (gone) return;
    const req = parsePick(got?.request ?? null); if (req) id = req.id;
    sendHeld(req?.id);
    if (!req) {
      answered = true;
      host.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'body' }, h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('folder')), h('p', null, t('pickNothingAsked')), h('button', { type: 'button', class: 'btn tonal', onclick: leave }, t('close'))))));
      return;
    }
    inner = filesPane({}, { pick: { req, done: async (paths) => { const r = await hand(paths); if (r.refused.length) return r; leave(); return []; }, cancel: () => { answer([]); leave(); } } });
    host.replaceChildren(inner);
  })();
  // (Left another way — the page moved on —: the asking app is not kept waiting.)
  host.dispose = () => { gone = true; document.documentElement.classList.remove('picking'); inner?.dispose?.(); if (id && !answered) { sendHeld(); const mine = id; held = { id: mine, send: () => answer([]), timer: window.setTimeout(() => sendHeld(), 1500) }; } };
  return host;
}
