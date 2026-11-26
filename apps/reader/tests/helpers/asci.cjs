// «As CI» modes for a local test run, opt-in by environment. One line in a test, after or before its own require of playwright:
//
//   require('./helpers/asci.cjs');
//
// With neither variable set it does nothing at all (it does not even load Playwright). With them, every browser the test launches
// from then on has its pages changed the way GitHub's machines would change them:
//
//   KR_SLOW=4   the page's CPU runs 4 times slower (CDP Emulation.setCPUThrottlingRate) — what a busy 2-core runner does to a
//               timing that only just holds here: a wait that is long enough on this computer, a deadline that is not.
//   KR_WIDE=3   a style injected as the page starts, «* { letter-spacing: .03em !important }» (the number is the hundredths
//               of an em) — text a little wider, to show the labels that only just fit (another font, another renderer,
//               a longer translation) before a machine with other fonts does.
//
// How it hooks in: tests make their pages straight from Playwright (chromium.launch(), browser.newPage() / newContext()), there is
// no shared helper to put it in, so this patches the launched browser's newContext / newPage and the context's newPage in place
// (the BrowserType object is the same one the test destructured, so the order of the requires does not matter). Pages that a page
// opens (popups) are covered too. Exports: { slow, wide, active, apply(page), CSS } for a test that wants to call it itself.
'use strict';

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const slow = num(process.env.KR_SLOW);
const wide = num(process.env.KR_WIDE);
const CSS = wide ? `* { letter-spacing: ${(wide / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}em !important }` : '';
// (runs in the page before its own scripts; the style goes in as soon as the document has a root element)
const initScript = (css) => `(() => { const add = () => { const s = document.createElement('style'); s.setAttribute('data-asci', '1'); s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(s); }; if (document.documentElement) add(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true }); })();`;

// CPU slowdown of one page (a CDP session per page; Chromium only)
async function throttle(page) {
  if (!slow) return;
  try { const s = await page.context().newCDPSession(page); await s.send('Emulation.setCPUThrottlingRate', { rate: slow }); } catch (e) { console.warn('KR_SLOW: could not throttle a page: ' + (e && e.message)); }
}
const apply = async (page) => { await throttle(page); };

const wrapped = new WeakSet();
async function wrapContext(ctx) {
  if (!ctx || wrapped.has(ctx)) return ctx; wrapped.add(ctx);
  if (CSS) await ctx.addInitScript(initScript(CSS)); // every page and frame of this context, from its first document
  if (slow) {
    const np = ctx.newPage.bind(ctx);
    ctx.newPage = async (...a) => { const p = await np(...a); await apply(p); return p; };
    ctx.on('page', (p) => { apply(p); }); // popups and pages the page opens itself
    for (const p of ctx.pages()) await apply(p);
  }
  return ctx;
}
function wrapBrowser(b) {
  if (!b || wrapped.has(b)) return b; wrapped.add(b);
  const nc = b.newContext.bind(b);
  b.newContext = async (...a) => wrapContext(await nc(...a)); // (browser.newPage() calls this.newContext(), so it is covered)
  const np = b.newPage.bind(b);
  b.newPage = async (...a) => { const p = await np(...a); await apply(p); return p; };
  return b;
}
function install() {
  let pw = null; for (const n of ['playwright', 'playwright-core']) { try { pw = require(n); break; } catch {} }
  if (!pw || !pw.chromium) { console.warn('asci: Playwright was not found; KR_SLOW / KR_WIDE have no effect'); return; }
  const bt = pw.chromium; if (bt.__asci) return; bt.__asci = true;
  const launch = bt.launch.bind(bt); bt.launch = async (...a) => wrapBrowser(await launch(...a));
  if (bt.launchPersistentContext) { const lp = bt.launchPersistentContext.bind(bt); bt.launchPersistentContext = async (...a) => wrapContext(await lp(...a)); }
  console.log(`asci: pages run as on GitHub — ${[slow && `CPU x${slow} slower (KR_SLOW)`, wide && `letters ${wide}% wider apart (KR_WIDE)`].filter(Boolean).join(', ')}`);
}

const active = !!(slow || wide);
if (active) install();
module.exports = { slow, wide, active, apply, CSS };
