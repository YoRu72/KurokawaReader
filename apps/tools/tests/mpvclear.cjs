// mpv's picture is drawn under the page: while it plays, nothing on the page may paint over it (the black picture
// with sound came from the stand-in element's own black background). Every element over the mpv stand-in that paints an opaque or tinted background while mpv plays.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const srv = http.createServer((q, r) => { let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(r); }).listen(0);
(async () => { const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 400, height: 860 } });
  await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForTimeout(800);
  const out = await p.evaluate(async () => {
    document.documentElement.classList.add('kt-mpv-on');
    const root = document.createElement('div'); root.className = 'player-view kt-player';
    root.innerHTML = '<div class="kt-stage"><div class="kt-video kt-mpv-video"></div><canvas class="kt-ass"></canvas><div class="kt-subs"></div><div class="kt-subs top"></div></div><div class="kt-top"></div><div class="kt-bottom"></div>';
    document.body.append(root); await new Promise((r) => setTimeout(r, 1500));
    const bad = []; const x = 200, y = 400;
    for (const el of [document.documentElement, document.body, ...root.querySelectorAll('*'), root]) { const rc = el.getBoundingClientRect(); if (rc.width < 300 || rc.height < 500) continue; const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue; const bg = cs.backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') bad.push(`${el.tagName}.${el.className} ${bg}`); if (cs.backgroundImage !== 'none') bad.push(`${el.tagName}.${el.className} image`); if (cs.boxShadow !== 'none') bad.push(`${el.tagName}.${el.className} shadow`); }
    return bad; });
  console.log(out.length ? 'FAIL opaque layers: ' + out.join(' | ') : 'ok   nothing paints over mpv'); console.log(out.length ? 'errors' : 'all passed'); await br.close(); srv.close(); process.exit(out.length ? 1 : 0); })();
