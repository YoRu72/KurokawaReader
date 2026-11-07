// (The same file is in both apps' src/ui: a change to one goes to both.)
// The window's bar on a computer, the app's own (see desktop/titlebar.cjs): its icon and its name on a strip in the
// colours of the theme, the system's buttons over it (Windows, Linux) or its lights inset (Mac); the page sits below
// it. Hidden in full screen. A window of a browser, or a phone, has none.
interface Bridge {
  titleBar?(o?: { color?: string; symbol?: string }): Promise<{ platform: string; height: number; fullscreen?: boolean } | null>;
  onTitleBarState?(cb: (s: { fullscreen?: boolean }) => void): () => void;
}
const hex = (c: string): string => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : c; };

export function startTitleBar(bridge: Bridge | undefined, name: string): void {
  if (!bridge?.titleBar || location.hash.startsWith('#/mini')) return;
  const root = document.documentElement;
  const logo = document.createElement('img'); logo.alt = ''; logo.setAttribute('data-brand', ''); logo.src = (() => { try { return localStorage.getItem('app.icon'); } catch { return null; } })() || 'icons/icon.svg';
  const title = document.createElement('span'); title.className = 'win-title'; title.dir = 'auto'; title.textContent = name;
  // (Where one is: the place's name after the app's, as a window's title has it — the lit item of the sidebar.)
  const where = document.createElement('span'); where.className = 'win-where';
  const bar = document.createElement('div'); bar.className = 'win-titlebar'; bar.setAttribute('aria-hidden', 'true'); bar.append(logo, title, where);
  const place = () => { const on = document.querySelector<HTMLElement>('.rail-item[aria-current="page"]'); const txt = (on?.querySelector('.rail-label')?.textContent ?? on?.getAttribute('title') ?? '').trim(); where.textContent = txt && txt !== name ? txt : ''; };
  window.addEventListener('hashchange', () => setTimeout(place, 50)); setTimeout(place, 300);
  root.append(bar); root.classList.add('frameless');
  const full = (on?: boolean) => root.classList.toggle('tb-hidden', !!on);
  let last = '';
  const paint = () => { const cs = getComputedStyle(bar); const o = { color: hex(cs.backgroundColor), symbol: hex(cs.color) }; const k = o.color + o.symbol; if (k === last) return; last = k; void Promise.resolve(bridge.titleBar!(o)).catch(() => undefined); };
  void Promise.resolve(bridge.titleBar()).then((info) => {
    if (!info) { bar.remove(); root.classList.remove('frameless'); return; }
    root.dataset.os = info.platform; root.style.setProperty('--tb-h', `${info.height}px`); full(info.fullscreen); paint();
  }).catch(() => { bar.remove(); root.classList.remove('frameless'); });
  bridge.onTitleBarState?.((s) => full(s.fullscreen));
  // (The theme changed — light, dark, an accent —: the system's buttons drawn in its colours too.)
  let t = 0; const later = () => { window.clearTimeout(t); t = window.setTimeout(paint, 60); };
  new MutationObserver(later).observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-accent', 'data-dark'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', later);
}
