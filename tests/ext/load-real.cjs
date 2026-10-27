// Every real plugin loaded in the runtime (no network): the LNReader plugins of a checkout of the published
// branch (plugins/v3.0.0, .js/src/plugins/<lang>/*.js) and the Mangayomi JavaScript novel extensions of a
// repo — their code evaluated with the shims, their card and filters read. Catches a missing module, a
// global the runtime lacks, a constructor that breaks.
// node tests/ext/load-real.cjs <lnreader-plugins checkout> [<mangayomi repo>…]
const path = require('path'); const fs = require('fs'); const os = require('os');
const esbuild = require(path.join(__dirname, '../../node_modules/esbuild'));
const { chromium } = require('playwright');
(async () => {
  const [lnDir, ...myDirs] = process.argv.slice(2);
  const root = path.join(__dirname, '../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-real-'));
  const entry = path.join(tmp, 'entry.ts');
  const u = (p) => path.join(root, p).replace(/\\/g, '/');
  fs.writeFileSync(entry, `
    import { loadLnPlugin, describeLn } from '${u('src/sources/ext/rt/lnreader.ts')}';
    import { loadMangayomi } from '${u('src/sources/ext/rt/mangayomi.ts')}';
    (window as any).RT = { loadLnPlugin, describeLn, loadMangayomi };
    window.parent.postMessage = () => {};
  `);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', outfile: path.join(tmp, 'rt.js'), platform: 'browser', target: 'es2020', logLevel: 'error' });
  const browser = await chromium.launch(); const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: path.join(tmp, 'rt.js') });
  const fails = [];
  if (lnDir) {
    const base = path.join(lnDir, '.js/src/plugins');
    const files = fs.readdirSync(base).flatMap((lang) => fs.readdirSync(path.join(base, lang)).filter((f) => f.endsWith('.js')).map((f) => path.join(base, lang, f)));
    let ok = 0;
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8');
      const r = await page.evaluate(([code, id]) => { try { const p = window.RT.loadLnPlugin(code, id, {}); const d = window.RT.describeLn(p); return { ok: true, id: d.id, name: d.name, filters: d.filters ? Object.keys(d.filters).length : 0, settings: d.pluginSettings ? Object.keys(d.pluginSettings).length : 0 }; } catch (e) { return { ok: false, error: String(e && e.stack || e).slice(0, 300) }; } }, [code, path.basename(f, '.js')]);
      if (r.ok) ok++; else fails.push(`${path.relative(base, f)}: ${r.error}`);
    }
    console.log(`LNReader: ${ok}/${files.length} plugins load`);
  }
  for (const dir of myDirs) {
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.js') && /novel/.test(path.join(d, e.name))) files.push(path.join(d, e.name)); } }; walk(dir);
    let ok = 0;
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8');
      const r = await page.evaluate(([code, key]) => { try { const m = /const\s+mangayomiSources\s*=\s*(\[[\s\S]*?\]);/.exec(code); let src; try { src = m ? JSON.parse(m[1].replace(/,\s*([}\]])/g, '$1'))[0] : null; } catch (e) { src = null; } src = src || { name: key, lang: 'en', baseUrl: 'https://example.com', itemType: 2 }; const { ext } = window.RT.loadMangayomi(code, src, key, {}); let filters = 0, prefs = 0, headers = null; try { filters = (ext.getFilterList() || []).length; } catch (e) { filters = -1; } try { prefs = (ext.getSourcePreferences() || []).length; } catch (e) { prefs = -1; } try { headers = ext.getHeaders(src.baseUrl); } catch (e) { headers = String(e.message); } return { ok: true, name: ext.source.name, filters, prefs, headers: typeof headers }; } catch (e) { return { ok: false, error: String(e && e.stack || e).slice(0, 300) }; } }, [code, path.basename(f, '.js')]);
      if (r.ok) ok++; else fails.push(`${path.relative(dir, f)}: ${r.error}`);
    }
    console.log(`Mangayomi ${path.basename(dir)}: ${ok}/${files.length} novel extensions load`);
  }
  for (const f of fails) console.log('FAIL', f);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
