// Build script: bundles src/main.ts with esbuild, copies static files,
// vendors the pdf.js worker and writes a precaching service worker so the
// whole app works offline.
import * as esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const serve = args.has('--serve');

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function walk(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, base, out);
    else out.push('/' + path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

async function copyStatic() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
  await copyDir(path.join(root, 'public'), dist);
  // pdf.js worker must be a separate file loaded by the browser.
  // Built from the readable worker with a small patch (ActualText in extracted text; see the script).
  const { buildPdfWorker } = await import('./patch-pdfjs.mjs');
  await buildPdfWorker(path.join(dist, 'assets', 'pdf.worker.min.mjs'));
  // pdf.js side resources: CMaps (CID fonts), standard fonts, image decoders (JPX/JBIG2 as WASM), ICC profiles.
  const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    try { await copyDir(path.join(pdfRoot, dir), path.join(dist, 'assets', 'pdfjs', dir)); } catch { /* optional */ }
  }
}

/**
 * Reading text in pictures (OCR): tesseract.js's worker (built from its source), its WebAssembly core and the
 * compact Arabic and English models (vendor/tessdata, fetched from github.com/tesseract-ocr/tessdata_fast when
 * missing). Without them the app is built without OCR.
 */
async function copyOcr() {
  const out = path.join(dist, 'assets', 'ocr');
  let tjs, core;
  try { tjs = path.dirname(require.resolve('tesseract.js/package.json')); core = path.dirname(require.resolve('tesseract.js-core/package.json')); } catch { console.warn('OCR: tesseract.js not installed — built without OCR'); return; }
  const tess = path.join(root, 'vendor', 'tessdata');
  await fs.mkdir(tess, { recursive: true });
  for (const lang of ['ara', 'eng']) {
    const f = path.join(tess, `${lang}.traineddata`);
    try { await fs.access(f); continue; } catch { /* fetch it */ }
    try {
      const res = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`);
      if (!res.ok) throw new Error(String(res.status));
      await fs.writeFile(f, Buffer.from(await res.arrayBuffer()));
    } catch (e) { console.warn(`OCR: could not fetch ${lang}.traineddata (${e.message}) — built without OCR`); return; }
  }
  await fs.mkdir(path.join(out, 'core'), { recursive: true });
  await fs.mkdir(path.join(out, 'lang'), { recursive: true });
  let cores = 0;
  for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
    try { await fs.copyFile(path.join(core, f), path.join(out, 'core', f)); cores++; } catch { /* not in this build of the core */ }
  }
  if (!cores) { console.warn('OCR: no tesseract core — built without OCR'); await fs.rm(out, { recursive: true, force: true }); return; }
  for (const lang of ['ara', 'eng']) await fs.copyFile(path.join(tess, `${lang}.traineddata`), path.join(out, 'lang', `${lang}.traineddata`));
  await esbuild.build({ entryPoints: [path.join(tjs, 'src/worker-script/browser/index.js')], bundle: true, format: 'iife', platform: 'browser', minify: true, outfile: path.join(out, 'worker.js'), logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"', global: 'self' },
    // (Models are read as they are — not gzipped — and not cached by tesseract.js: its cache and gunzip are left out.)
    plugins: [{ name: 'ocr-stubs', setup(b) {
      b.onResolve({ filter: /^(idb-keyval|zlibjs)$/ }, (a) => ({ path: a.path, namespace: 'ocr-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'ocr-stub' }, (a) => ({ contents: a.path === 'idb-keyval' ? 'module.exports = { set: async () => {}, get: async () => undefined, del: async () => {} };' : 'module.exports = { gunzipSync: (d) => d };', loader: 'js' }));
    } }] });
}

async function writeServiceWorker() {
  // (The OCR models are not fetched ahead of time — tens of megabytes most never use: cached when first used.)
  const files = (await walk(dist)).filter((f) => f !== '/sw.js' && !f.endsWith('.map') && !f.startsWith('/assets/ocr/'));
  const version = Date.now().toString(36);
  const sw = `// Generated by scripts/build.mjs — precaches the whole app for offline use.
const CACHE = 'kurokawa-${version}';
const ASSETS = ${JSON.stringify(['/', ...files], null, 0)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'kurokawa-ext').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Optional components fetched once from a CDN (the Japanese dictionary): cache-first, kept across app updates.
  if (url.host === 'cdn.jsdelivr.net' && (url.pathname.includes('/kuromoji') || url.pathname.includes('/pinyin-pro'))) {
    e.respondWith(caches.open('kurokawa-ext').then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }))));
    return;
  }
  if (url.origin !== location.origin) return;
  // Book files streamed from device storage (Capacitor) and anything that is not an app asset stay out of the cache.
  if (url.pathname.startsWith('/_capacitor_') || !(url.pathname === '/' || ASSETS.includes(url.pathname) || url.pathname.startsWith('/assets/'))) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});
`;
  await fs.writeFile(path.join(dist, 'sw.js'), sw);
}

const buildOptions = {
  entryPoints: { app: path.join(root, 'src/main.ts'), scanworker: path.join(root, 'src/scanworker.ts') },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome100', 'safari16', 'firefox110'],
  outdir: path.join(dist, 'assets'),
  entryNames: '[name]',
  splitting: true,
  chunkNames: 'chunk-[name]-[hash]',
  assetNames: 'fonts/[name]-[hash]',
  minify: !watch && !process.env.NOMINIFY,
  sourcemap: true,
  loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'file' },
  logLevel: 'info',
  plugins: [(await import('./patch-pdfjs.mjs')).pdfjsMainPlugin],
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"', __APP_VERSION__: JSON.stringify(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version) },
};

await copyStatic();
await copyOcr();
if (watch || serve) {
  const ctx = await esbuild.context(buildOptions);
  if (watch) await ctx.watch();
  else await ctx.rebuild();
  await writeServiceWorker();
  if (serve) {
    const { hosts, port } = await ctx.serve({ servedir: dist, port: 5173 });
    console.log(`KurokawaReader → http://${hosts?.[0] ?? '127.0.0.1'}:${port}`);
  }
} else {
  await esbuild.build(buildOptions);
  await writeServiceWorker();
  console.log('Built → dist/');
}
