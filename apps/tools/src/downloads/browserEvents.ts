// What the app's browser tells the app, over one channel (Android's plugin event «browser», the desktop shell's
// onBrowser): a file a page downloads, a link renewed, the links «Grab» brought back — and, on Android, that files were
// shared in («Save to device»; the activity opens that sheet itself). Each message is read once, here at the door, into
// one of these shapes: a message without its links (the «shared» one has none) no longer reaches the code that walks
// them — «e.links is not iterable» —, and one of a kind not known here is let go.
import { ktPlugin, listen } from '../native';
import { getEngine } from '../engine';
import { toast } from '../ui/dom';
import { t, countFiles } from '../i18n';
import { relinkTarget, clearRelink, type BrowserLink } from '../browser';

export type BrowserEvent =
  | { kind: 'download'; url: string; name?: string; referer?: string; ua?: string; cookie?: string; trail?: unknown[] }
  | { kind: 'relink'; id: string; ok: boolean; url?: string; referer?: string; ua?: string }
  | { kind: 'links'; url: string; title: string; links: BrowserLink[]; ua?: string }
  | { kind: 'shared'; n: number };
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** A message as the app reads it; null for one it has no use for. */
export function readBrowserEvent(raw: unknown): BrowserEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>; const kind = str(o.kind) ?? (Array.isArray(o.links) ? 'links' : '');
  const ua = str(o.ua);
  switch (kind) {
    case 'download': { const url = str(o.url); return url ? { kind, url, name: str(o.name), referer: str(o.referer), ua, cookie: str(o.cookie), trail: Array.isArray(o.trail) ? o.trail : undefined } : null; }
    case 'relink': return { kind, id: str(o.id) ?? '', ok: !!o.ok, url: str(o.url), referer: str(o.referer), ua };
    case 'shared': return { kind, n: Math.max(0, Number(o.n) || 0) };
    case 'links': {
      const links = (Array.isArray(o.links) ? o.links : []).filter((l): l is BrowserLink => !!l && typeof l === 'object' && typeof (l as BrowserLink).href === 'string')
        .map((l) => ({ ...l, text: typeof l.text === 'string' ? l.text : '', kind: typeof l.kind === 'string' ? l.kind : 'file' }));
      return { kind, url: str(o.url) ?? '', title: str(o.title) ?? '', links, ua };
    }
    default: return null;
  }
}

async function onEvent(raw: unknown): Promise<void> {
  const o = readBrowserEvent(raw); if (!o || o.kind === 'shared') return;
  if (o.kind === 'relink') { const m = await import('./relink'); try { toast((await m.relinked(o)) ? t('relinkedAuto') : t('relinkFailed'), 'info', 5000); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } return; }
  if (o.kind === 'download') {
    const headers: Record<string, string> = {}; if (o.referer) headers.Referer = o.referer; if (o.ua) headers['User-Agent'] = o.ua; if (o.cookie) headers.Cookie = o.cookie;
    if (o.trail?.length) { const tr = o.trail; void import('./relink').then((m) => m.saveTrail(o.url, tr as never)); }
    // (A download whose link ran out waits for a new one from this browser: the first download caught goes to it.)
    const rl = relinkTarget(); if (rl) { clearRelink(); try { await getEngine().setUrl!(rl.id, o.url, Object.keys(headers).length ? headers : undefined); toast(t('relinked', { name: rl.name })); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } return; }
    void import('../views/add').then((m) => m.addSheet(o.url, { headers: Object.keys(headers).length ? headers : undefined, name: o.name }));
    return;
  }
  // (Capture rules: what matches one is added on sight, with the rule's folder and the page as referer; the rest goes to the grabber.)
  const R = await import('./rules'); const rest: BrowserLink[] = []; let caught = 0;
  for (const l of o.links) { const kind = l.kind === 'video' || l.kind === 'media' ? 'video' : 'file'; const rule = /^https?:/i.test(l.href) ? R.match({ url: l.href, size: l.size }, kind) : null; if (rule?.then.capture) { try { await getEngine().add({ source: { url: l.href, headers: { Referer: o.url, ...(o.ua ? { 'User-Agent': o.ua } : {}) } }, dir: rule.then.dir || undefined, connections: rule.then.connections || 8, ...(rule.then.wifiOnly || rule.then.later ? { meta: { wifiOnly: rule.then.wifiOnly || undefined, later: rule.then.later || undefined } } : {}) }); caught++; } catch { rest.push(l); } } else rest.push(l); }
  if (caught) toast(t('captureAdded', { n: countFiles(caught) }));
  if (rest.length || !caught) void import('./prism').then((m) => m.grabberSheet(o.url, undefined, { links: rest, title: o.title, ua: o.ua }));
}

let wired = false;
export function startBrowserEvents(): void {
  if (wired) return; wired = true;
  const on = (raw: unknown) => { void onEvent(raw).catch((e) => toast(String((e as Error)?.message ?? e), 'error')); };
  const d = window.kurokawaTools as unknown as { onBrowser?(cb: (o: unknown) => void): () => void } | undefined;
  if (d?.onBrowser) { d.onBrowser(on); return; }
  const p = ktPlugin(); if (p) void listen<unknown>(p as never, 'browser', on);
}
