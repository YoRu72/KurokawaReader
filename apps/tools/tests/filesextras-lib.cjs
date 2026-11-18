// Shared by the Files tests that run on the pretend phone (tests/filesphone-fixture.cjs): the page with a counted filesList, its row helpers, and a paste.
const F = require('./filesphone-fixture.cjs'); const { K, SD, P } = F;
/** The page on the pretend phone with a counted filesList (and an optional pause per listing). */
async function page(browser, port, z, lang, o = {}) {
  const { page: p, errors } = await F.open(browser, { lang, pc: !!o.pc, z, many: o.many ?? 0, width: 360, height: 780 });
  await p.addInitScript(() => {
    const kt = window.Capacitor.Plugins.KurokawaTools; const orig = kt.filesList; window.__lists = 0; window.__listPause = 0;
    // (File bytes for the editor: window.__bytes[path] = Uint8Array; uriRead honours max and offset, uriWrite stores.)
    window.__bytes = {}; window.__writes = []; const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
    kt.uriRead = async ({ path, max = 4000000, offset = 0 }) => { const u = window.__bytes[path]; if (!u) throw new Error('missing'); const part = u.subarray(offset, Math.min(u.length, offset + max)); return { b64: b64(part), size: u.length, whole: offset + max >= u.length }; };
    kt.uriWrite = async ({ path, b64: d }) => { const bin = atob(d); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__bytes[path] = u; window.__writes.push(path); return { size: u.length }; };
    // (A checksum of a file: its size and a mark carried by copies; a name in __badNames differs once copied into a Full check's stage.)
    window.__badNames = []; window.__hashPause = 0; window.__hashed = [];
    kt.hashFile = async ({ path }) => { const n = window.__tree.get(path); if (!n || n.dir) throw new Error('unreadable'); window.__hashed.push(path); if (window.__hashPause) await new Promise((r) => setTimeout(r, window.__hashPause)); const bad = window.__badNames.includes(path.split('/').pop()) && path.includes('.kurokawa-extract-v-'); const sig = (n.sig ?? 'c' + n.size) + (bad ? 'X' : ''); return { md5: sig, sha1: sig, sha256: sig, size: n.size }; };
    kt.appsFor = async () => ({ apps: [] });
    window.__thumbs = []; kt.filesThumb = async (o) => { window.__thumbs.push(o.path); if (!/\.(jpe?g|mp4)$/.test(o.path)) return { url: null }; const c = document.createElement('canvas'); c.width = 8; c.height = 8; const g = c.getContext('2d'); g.fillStyle = 'hsl(' + (o.path.length * 37 % 360) + ',55%,55%)'; g.fillRect(0, 0, 8, 8); return { url: c.toDataURL() }; };
    kt.filesList = async (o) => { window.__lists++; if (window.__listPause) await new Promise((r) => setTimeout(r, window.__listPause)); return orig(o); };
  });
  if (o.seed) await p.addInitScript(o.seed, K);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(o.at ?? K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(400);
  return { p, errors };
}
const rowOf = (p, name) => p.locator('.files-row', { has: p.locator(`.files-name[title="${name}"]`) });
const menu = async (p, name) => { await rowOf(p, name).locator('button.icon-btn[data-icon="more"]').click(); await p.waitForSelector('.sheet .dest-row'); };
const meta = (p, name) => rowOf(p, name).locator('.src').first().textContent();

/** Copy or cut `names` from the folder now open, then open `dest` and paste. */
const pasteTo = async (p, names, how, dest) => {
  if (names.length === 1) { await menu(p, names[0]); await p.locator('.sheet .dest-row', { hasText: how === 'copy' ? /^\s*(Copy|نسخ)\s*$/ : /^\s*(Cut|قص)\s*$/ }).first().click(); }
  else { await rowOf(p, names[0]).locator('.files-main').click({ delay: 700 }).catch(() => undefined); }
  await p.waitForTimeout(250);
  await p.evaluate((d) => { location.hash = '#/files?p=' + encodeURIComponent(d); }, dest); await p.waitForSelector('.files-clip-paste:not([disabled])', { timeout: 5000 }); await p.click('.files-clip-paste');
};
module.exports = { page, rowOf, menu, meta, pasteTo, K, SD, P, F };
