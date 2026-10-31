// Seanime's online-streaming extensions in a browser: a mock extension written the way the community ones are
// (TypeScript, a `Provider` class, `LoadDoc` scraping, a passphrase-encrypted source decrypted with `CryptoJS`,
// `Buffer` base64) installed from a repository URL, then a show's «Watch online»: matched, episode found, the
// server's qualities listed, Play opening the player with the episode's subtitles and tracking.
const { chromium } = require('playwright');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const MEDIA = { id: 1, idMal: 1, title: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey\'s End', native: '葬送のフリーレン', userPreferred: 'Sousou no Frieren' }, synonyms: [], coverImage: { large: '' }, format: 'TV', status: 'FINISHED', episodes: 28, season: 'FALL', seasonYear: 2023, startDate: { year: 2023, month: 9, day: 29 }, genres: ['Adventure'], averageScore: 90, popularity: 100000, isAdult: false, siteUrl: 'https://anilist.co/anime/1', nextAiringEpisode: null, mediaListEntry: null, duration: 24, description: 'A synopsis.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] } };
// What the site's player page hides: the sources, AES-encrypted with a passphrase (OpenSSL's format, as CryptoJS makes it).
const enc = (text, pass) => { const salt = crypto.randomBytes(8); let d = Buffer.alloc(0), prev = Buffer.alloc(0); while (d.length < 48) { prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(pass), salt])).digest(); d = Buffer.concat([d, prev]); } const c = crypto.createCipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48)); return Buffer.concat([Buffer.from('Salted__'), salt, c.update(text), c.final()]).toString('base64'); };
const PAYLOAD = `/// <reference path="./online-streaming-provider.d.ts" />
interface Hit { slug: string; name: string }
class Provider {
    base: string = "https://mock-anime.test"
    getSettings(): Settings { return { episodeServers: ["alpha", "beta"], supportsDub: true } }
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const res = await fetch(\`\${this.base}/search?q=\${encodeURIComponent(opts.query)}\`, { headers: { "X-Requested-With": "XMLHttpRequest" } })
        const $ = LoadDoc(res.text())
        const out: SearchResult[] = []
        $(".item a").each((i: number, el: DocSelection) => {
            const href = el.attr("href") as string
            out.push({ id: href.split("/").pop()!, title: el.text().trim(), url: this.base + href, subOrDub: el.attr("data-dub") === "1" ? "both" : "sub" })
        })
        return out
    }
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const res = await fetch(\`\${this.base}/anime/\${id}\`)
        const doc = new Doc(res.text())
        return doc.find("ul.eps li").map((i: number, li: DocSelection): EpisodeDetails => ({ id: li.attr("data-id")!, number: parseInt(li.find("span.n").text()), url: this.base + "/watch/" + li.attr("data-id"), title: li.find("span.t").text() }))
    }
    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const res = await fetch(\`\${episode.url}?server=\${server}\`, { headers: { Referer: this.base + "/" } })
        if (res.status !== 200) throw new Error("server " + server + " is down")
        const $ = LoadDoc(res.text())
        const key = Buffer.from($("#player").attr("data-k") as string, "base64").toString("utf8")
        const json = CryptoJS.AES.decrypt($("#player").attr("data-s") as string, key).toString(CryptoJS.enc.Utf8)
        const data = JSON.parse(json) as { file: string; label: string }[]
        return { server, headers: { Referer: this.base + "/" }, videoSources: data.map((d) => ({ url: d.file, type: d.file.includes(".m3u8") ? "m3u8" : "mp4", quality: d.label, subtitles: [{ id: "en", url: this.base + "/subs/en.vtt", language: "English", isDefault: true }] })) }
    }
}`;
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)); });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  await p.route('https://ext.test/**', (r) => { const u = r.request().url(); if (u.endsWith('manifest.json')) return r.fulfill({ headers: cors, json: [{ id: 'mockstream', name: 'Mock Stream', version: '1.0.0', type: 'onlinestream-provider', language: 'typescript', author: 'test', payloadURI: 'https://ext.test/provider.ts' }] }); return r.fulfill({ headers: cors, contentType: 'text/plain', body: PAYLOAD }); });
  const seen = [];
  await p.route('https://mock-anime.test/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(r.request().url()); seen.push(u.pathname + u.search);
    if (u.pathname === '/search') return r.fulfill({ headers: cors, contentType: 'text/html', body: `<div class="item"><a href="/anime/frieren-s2">Sousou no Frieren 2nd Season</a></div><div class="item"><a href="/anime/frieren" data-dub="1">Sousou no Frieren</a></div><div class="item"><a href="/anime/x">Something Else</a></div>` });
    if (u.pathname === '/anime/frieren') return r.fulfill({ headers: cors, contentType: 'text/html', body: `<ul class="eps">${[1, 2, 3, 4, 5, 6].map((n) => `<li data-id="fr-${n}"><span class="n">${n}</span><span class="t">Episode ${n}</span></li>`).join('')}</ul>` });
    if (u.pathname.startsWith('/watch/')) { if (u.searchParams.get('server') === 'alpha') return r.fulfill({ status: 500, headers: cors, body: 'down' }); const key = 'p4ss-' + u.pathname.split('/').pop(); return r.fulfill({ headers: cors, contentType: 'text/html', body: `<div id="player" data-k="${Buffer.from(key).toString('base64')}" data-s="${enc(JSON.stringify([{ file: 'https://cdn.mock-anime.test/v/1080.m3u8', label: '1080p' }, { file: 'https://cdn.mock-anime.test/v/720.mp4', label: '720p' }]), key)}"></div>` }); }
    if (u.pathname === '/subs/en.vtt') return r.fulfill({ headers: cors, contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello from the stream\n' });
    return r.fulfill({ status: 404, headers: cors, body: '' });
  });
  await p.route('https://graphql.anilist.co/**', (r) => r.fulfill({ json: { data: { Media: MEDIA, Page: { pageInfo: { hasNextPage: false }, media: [MEDIA], airingSchedules: [] } } } }));
  await p.route(/arm\.haglund\.dev|api\.ani\.zip|animefillerlist/, (r) => r.fulfill({ status: 404, body: '' }));
  const lang = process.argv[2] || 'en'; const L = lang === 'ar' ? { watch: 'شاهد على الشبكة', matched: /العمل المطابِق: Sousou no Frieren(?! 2nd)/, subs: /الترجمات: English/ } : { watch: 'Watch online', matched: /Matched: Sousou no Frieren(?! 2nd)/, subs: /Subtitles: English/ };
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.evaluate((l) => localStorage.setItem('kr.lang', l), lang); await p.reload(); await p.waitForSelector('.addon-row');
  await p.click('.addon-row:has-text("Anime") .btn, .addon-row:has-text("الأنمي") .btn'); await p.waitForSelector('.toast');
  await p.goto(`http://127.0.0.1:${port}/#/settings/anime`); await p.waitForSelector('.repo-add input');
  await p.fill('.repo-add input', 'https://ext.test/manifest.json'); await p.click('.repo-add button'); await p.waitForSelector('.addon-row:has-text("Mock Stream")', { timeout: 20000 });
  console.log('installed row:', (await p.$eval('.addon-row:has-text("Mock Stream")', (e) => e.innerText)).replace(/\s+/g, ' '));
  await p.goto(`http://127.0.0.1:${port}/#/anime/1`); await p.waitForSelector(`.ep-row button[aria-label="${L.watch}"]`);
  await p.locator('.ep-row').nth(4).locator(`button[aria-label="${L.watch}"]`).click(); await p.waitForSelector('.stream-row', { timeout: 20000 });
  const sheet = await p.$eval('.stream-sheet', (e) => e.innerText);
  console.log('sheet:', sheet.replace(/\s+/g, ' '));
  const ok = L.matched.test(sheet) && /1080p|١٠٨٠p/.test(sheet) && /720p|٧٢٠p/.test(sheet) && /beta/.test(sheet) && L.subs.test(sheet);
  console.log('requests:', seen.join(' '));
  await p.waitForTimeout(600); await p.screenshot({ path: `shot-stream-${lang}.png` });
  await p.locator('.stream-row').first().locator('.btn.primary').click(); await p.waitForSelector('video.kt-video');
  const src = await p.$eval('video.kt-video', (v) => v.getAttribute('src') || v.src);
  await p.waitForTimeout(1500); const subsLoaded = await p.evaluate(() => document.body.innerText.includes('Hello') || !!document.querySelector('.toast'));
  console.log('player src:', src, '| subtitle fetched:', seen.includes('/subs/en.vtt'), subsLoaded);
  // A wrong match corrected by hand, and kept
  const kept = await p.evaluate(() => localStorage.getItem('kt.stream.match')); console.log('kept match:', kept);
  const pass = ok && src.includes('1080.m3u8') && seen.includes('/subs/en.vtt') && /frieren"/.test(kept ?? '') && seen.some((x) => x.includes('server=alpha')) && seen.some((x) => x.includes('server=beta'));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
})();
