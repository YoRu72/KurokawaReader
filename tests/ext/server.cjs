// A stand-in for a novel site and two repositories for the tests: "Nova Novels" with popular/latest lists,
// a search, novel pages with chapters and chapter pages; an LNReader-style repository (plugins.min.json and
// a CommonJS plugin written the way the real ones are — cheerio, dayjs, storage, fetchApi, filters); a
// Mangayomi-style repository (novel_index.json and an MProvider extension). A novel behind a "browser check";
// an admin call that adds a chapter, for the update checks.
// node server.cjs <port>
const http = require('http');
const port = Number(process.argv[2] || 5403);
const base = () => `http://localhost:${port}`;
const novels = [
  { slug: 'alpha', title: 'Alpha Ascension', author: 'A. Writer', genres: ['Fantasy', 'Action'], status: 'Ongoing', summary: 'A boy climbs.\nThen climbs more.', chapters: 6, views: 900 },
  { slug: 'beta', title: 'Beta Blossom', author: 'B. Author', genres: ['Romance'], status: 'Completed', summary: 'Flowers and feelings.', chapters: 4, views: 500 },
  { slug: 'gamma', title: 'Gamma Ray', author: 'C. Pen', genres: ['Sci-Fi', 'Action'], status: 'Ongoing', summary: 'Space, mostly.', chapters: 3, views: 100 },
  { slug: 'cf-locked', title: 'Locked Legend', author: 'D. Shield', genres: ['Fantasy'], status: 'Ongoing', summary: 'Behind a check.', chapters: 2, views: 50 },
];
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} - Nova Novels</title></head><body><header><h1>Nova Novels</h1></header>${body}</body></html>`;
const card = (n) => `<div class="novel-item" data-id="${n.slug}"><a href="/novel/${n.slug}" title="${n.title}"><img class="cover" data-src="/cover/${n.slug}.png" src="/x.gif"></a><span class="title">${n.title}</span><p class="status">Status: ${n.status}</p></div>`;
const list = (items, pageNo, per = 2) => { const slice = items.slice((pageNo - 1) * per, pageNo * per); return `<div id="list" class="novels">${slice.map(card).join('')}</div><div class="pagination">${pageNo * per < items.length ? `<a class="next" href="?page=${pageNo + 1}">Next</a>` : ''}</div>`; };
const challenge = () => `<!doctype html><html><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></head><body><div id="cf-chl">Checking your browser before accessing nova.</div></body></html>`;

// The LNReader plugin: what the compiled plugins look like, written by hand.
const lnPlugin = () => `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fetch_1 = require("@libs/fetch");
const cheerio_1 = require("cheerio");
const novelStatus_1 = require("@libs/novelStatus");
const filterInputs_1 = require("@libs/filterInputs");
const storage_1 = require("@libs/storage");
const dayjs_1 = require("dayjs");
class NovaPlugin {
  constructor() {
    this.id = "nova"; this.name = "Nova Novels"; this.icon = "src/en/nova/icon.png"; this.site = "${base()}"; this.version = "1.0.0";
    this.filters = { sort: { label: "Sort by", value: "views", type: filterInputs_1.FilterTypes.Picker, options: [{ label: "Views", value: "views" }, { label: "Name", value: "name" }] }, genres: { label: "Genres", value: [], type: filterInputs_1.FilterTypes.CheckboxGroup, options: [{ label: "Fantasy", value: "fantasy" }, { label: "Romance", value: "romance" }] } };
    this.pluginSettings = { hideLocked: { value: false, label: "Hide locked chapters", type: "Switch" } };
    this.imageRequestInit = { headers: { Referer: "${base()}/" } };
  }
  parseNovels($) {
    const novels = [];
    $(".novel-item").each((i, el) => { const a = $(el).find("a"); novels.push({ name: a.attr("title") || $(el).find(".title").text().trim(), path: a.attr("href"), cover: this.site + $(el).find("img").attr("data-src") }); });
    return novels;
  }
  async popularNovels(pageNo, { showLatestNovels, filters } = {}) {
    const sort = filters && filters.sort ? filters.sort.value : "views";
    const genres = filters && filters.genres ? filters.genres.value : [];
    const url = this.site + (showLatestNovels ? "/latest" : "/popular") + "?page=" + pageNo + "&sort=" + sort + genres.map((g) => "&genre=" + g).join("");
    const body = await (0, fetch_1.fetchApi)(url).then((r) => r.text());
    return this.parseNovels((0, cheerio_1.load)(body));
  }
  async searchNovels(searchTerm, pageNo) {
    const body = await (0, fetch_1.fetchApi)(this.site + "/search?q=" + encodeURIComponent(searchTerm) + "&page=" + pageNo).then((r) => r.text());
    return this.parseNovels((0, cheerio_1.load)(body));
  }
  async parseNovel(novelPath) {
    const body = await (0, fetch_1.fetchApi)(this.site + novelPath).then((r) => r.text());
    const $ = (0, cheerio_1.load)(body);
    const hideLocked = storage_1.storage.get("hideLocked");
    const novel = { path: novelPath, name: $("h2.name").text().trim(), cover: this.site + $("img.big").attr("src"), author: $("td:contains('Author') + td").text().trim(), genres: $(".genres a").map((i, el) => $(el).text()).get().join(", "), summary: $(".summary").text().trim(), status: $(".status").text().includes("Completed") ? novelStatus_1.NovelStatus.Completed : novelStatus_1.NovelStatus.Ongoing, chapters: [] };
    $("ul.chapters li").each((i, el) => { if (hideLocked && $(el).hasClass("locked")) return; const a = $(el).find("a"); novel.chapters.push({ name: a.text().trim(), path: a.attr("href"), releaseTime: (0, dayjs_1.default)($(el).find("time").text()).format("LL"), chapterNumber: i + 1 }); });
    return novel;
  }
  async parseChapter(chapterPath) {
    const body = await (0, fetch_1.fetchApi)(this.site + chapterPath).then((r) => r.text());
    const $ = (0, cheerio_1.load)(body);
    $(".content script, .content .ads").remove();
    return $(".content").html();
  }
  resolveUrl(path, isNovel) { return this.site + path; }
}
exports.default = new NovaPlugin();
`;
// The Mangayomi extension: the shape of the real ones (MProvider, Client, Document, SharedPreferences).
const myExt = () => `const mangayomiSources = [{"name":"Nova (Mangayomi)","lang":"en","baseUrl":"${base()}","apiUrl":"","iconUrl":"${base()}/icon.png","typeSource":"single","itemType":2,"version":"0.0.2","pkgPath":"novel/src/en/nova.js"}];
class DefaultExtension extends MProvider {
  getHeaders(url) { return { Referer: this.getBaseUrl() + "/" }; }
  getBaseUrl() { const p = new SharedPreferences(); const u = p.get("base_url"); return u && u.length ? u : this.source.baseUrl; }
  parseList(res) {
    const doc = new Document(res.body); const list = [];
    for (const el of doc.select("div.novel-item")) list.push({ name: el.selectFirst("span.title").text, imageUrl: this.getBaseUrl() + el.selectFirst("img").getDataSrc, link: this.getBaseUrl() + el.selectFirst("a").getHref });
    return { list, hasNextPage: doc.selectFirst("a.next").text.length > 0 };
  }
  async getPopular(page) { return this.parseList(await new Client().get(this.getBaseUrl() + "/popular?page=" + page, this.getHeaders())); }
  async getLatestUpdates(page) { return this.parseList(await new Client().get(this.getBaseUrl() + "/latest?page=" + page, this.getHeaders())); }
  async search(query, page, filters) {
    let url = this.getBaseUrl() + "/search?q=" + encodeURIComponent(query) + "&page=" + page;
    for (const f of filters) if (f.type === "StatusFilter" && f.values[f.state].value) url += "&status=" + f.values[f.state].value;
    return this.parseList(await new Client().get(url, this.getHeaders()));
  }
  async getDetail(url) {
    const res = await new Client().get(url, this.getHeaders()); const doc = new Document(res.body);
    const chapters = [];
    for (const li of doc.select("ul.chapters li")) chapters.push({ name: li.selectFirst("a").text, url: this.getBaseUrl() + li.selectFirst("a").getHref, dateUpload: String(Date.parse(li.selectFirst("time").text) || Date.now()), scanlator: null });
    return { name: doc.selectFirst("h2.name").text, imageUrl: this.getBaseUrl() + doc.selectFirst("img.big").getSrc, description: doc.selectFirst(".summary").text, author: doc.selectFirst("td:contains('Author') + td").text, status: doc.selectFirst(".status").text.includes("Completed") ? 1 : 0, genre: doc.select(".genres a").map((a) => a.text), chapters: chapters.reverse() };
  }
  async getHtmlContent(name, url) { const res = await new Client().get(url, this.getHeaders()); return this.cleanHtmlContent(res.body); }
  async cleanHtmlContent(html) { const doc = new Document(html); return doc.selectFirst("h3").outerHtml + doc.selectFirst(".content").innerHtml; }
  getFilterList() { return [{ type: "StatusFilter", name: "Status", type_name: "SelectFilter", values: [{ type_name: "SelectOption", name: "All", value: "" }, { type_name: "SelectOption", name: "Ongoing", value: "ongoing" }, { type_name: "SelectOption", name: "Completed", value: "completed" }], state: 0 }]; }
  getSourcePreferences() { return [{ key: "base_url", editTextPreference: { title: "Site address", summary: "", value: this.source.baseUrl, dialogTitle: "Edit", dialogMessage: "" } }]; }
}`;

// (Knobs for the paging tests: a page of the popular list failing a few times, a site that gives page 1 again
// for every page, chapters that come slowly.)
const knobs = { failPage: 0, failTimes: 0, repeat: false, slowMs: 0, formWrap: false };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, base()); const p = u.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const html = (s, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(s); };
  const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  const js = (s) => { res.setHeader('Content-Type', 'text/javascript'); res.end(s); };
  const png = () => { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); };
  // repositories
  if (p === '/repo/plugins.min.json') return json([{ id: 'nova', name: 'Nova Novels', site: base() + '/', lang: 'English', version: '1.0.0', url: base() + '/repo/nova.js', iconUrl: base() + '/icon.png' }, { id: 'other', name: 'Other Site', site: 'https://other.example/', lang: '‎العربية', version: '2.0.0', url: base() + '/repo/other.js', iconUrl: base() + '/icon.png' }]);
  if (p === '/repo/nova.js') return js(lnPlugin());
  if (p === '/repo/other.js') return js('exports.default = { id: "other", name: "Other Site", site: "https://other.example/", version: "2.0.0", popularNovels: async () => [], searchNovels: async () => [], parseNovel: async () => ({ chapters: [] }), parseChapter: async () => "" };');
  if (p === '/myrepo/novel_index.json') return json([{ name: 'Nova (Mangayomi)', id: 7001, baseUrl: base(), lang: 'en', typeSource: 'single', iconUrl: base() + '/icon.png', dateFormat: '', dateFormatLocale: '', isNsfw: false, hasCloudflare: false, sourceCodeUrl: base() + '/myrepo/nova.js', apiUrl: '', version: '0.0.2', isManga: false, itemType: 2, isFullData: false, appMinVerReq: '0.5.0', additionalParams: '', sourceCodeLanguage: 1, notes: '' }, { name: 'Dart One', id: 7002, baseUrl: 'https://dart.example', lang: 'en', typeSource: 'madara', iconUrl: '', sourceCodeUrl: base() + '/myrepo/dart.dart', version: '0.1.0', itemType: 2, sourceCodeLanguage: 0 }]);
  if (p === '/myrepo/index.json') return json([{ name: 'Some Manga', id: 7003, baseUrl: 'https://manga.example', lang: 'en', typeSource: 'single', iconUrl: '', sourceCodeUrl: base() + '/myrepo/manga.js', version: '0.1.0', itemType: 0, sourceCodeLanguage: 1 }]);
  if (p === '/myrepo/repo.json') return json({ name: 'Test Mangayomi repo', website: base() });
  if (p === '/myrepo/nova.js') return js(myExt());
  if (p === '/shosetsu/index.json') return json({ libraries: [], scripts: [{ name: 'Lua One', fileName: 'LuaOne', imageURL: '', id: 1, lang: 'en', ver: '1.0.0', libVer: '1.0.0', md5: '' }] });
  // the site
  if (p === '/icon.png' || p.startsWith('/cover/')) return png();
  if (p === '/x.gif') return png();
  if (p === '/popular' || p === '/latest' || p === '/search') {
    let pageNo = Number(u.searchParams.get('page') || 1);
    if (p === '/popular' && knobs.failPage === pageNo && knobs.failTimes > 0) { knobs.failTimes--; return html('busy', 503); }
    if (knobs.repeat) pageNo = 1;
    let items = novels.slice();
    if (p === '/latest') items = items.slice().reverse();
    if (p === '/popular') items.sort((a, b) => (u.searchParams.get('sort') === 'name' ? a.title.localeCompare(b.title) : b.views - a.views));
    const genres = u.searchParams.getAll('genre'); if (genres.length) items = items.filter((n) => n.genres.some((g) => genres.includes(g.toLowerCase())));
    const q = (u.searchParams.get('q') || '').toLowerCase(); if (p === '/search') items = items.filter((n) => n.title.toLowerCase().includes(q));
    const st = u.searchParams.get('status'); if (st) items = items.filter((n) => n.status.toLowerCase() === st);
    return html(page(p.slice(1), list(items, pageNo)));
  }
  { const m = /^\/novel\/([a-z-]+)$/.exec(p); if (m) {
    const n = novels.find((x) => x.slug === m[1]); if (!n) return html('nope', 404);
    if (n.slug === 'cf-locked') return html(challenge(), 503);
    const chapters = Array.from({ length: n.chapters }, (_, i) => `<li class="${i === n.chapters - 1 && n.slug === 'alpha' ? 'locked' : ''}"><a href="/novel/${n.slug}/chapter-${i + 1}">Chapter ${i + 1}: Part ${i + 1}</a><time>2024-01-${String(i + 1).padStart(2, '0')}</time></li>`).join('');
    return html(page(n.title, `<h2 class="name">${n.title}</h2><img class="big" src="/cover/${n.slug}.png"><table><tr><td>Author</td><td>${n.author}</td></tr></table><div class="genres">${n.genres.map((g) => `<a href="/genre/${g}">${g}</a>`).join(' ')}</div><p class="status">Status: ${n.status}</p><div class="summary">${n.summary.replace(/\n/g, '<br>')}</div><ul class="chapters">${chapters}</ul>`));
  } }
  { const m = /^\/novel\/([a-z-]+)\/chapter-(\d+)$/.exec(p); if (m) {
    if (knobs.slowMs) { setTimeout(() => { const k = knobs.slowMs; knobs.slowMs = 0; server.emit('request', req, res); knobs.slowMs = k; }, knobs.slowMs); return; }
    const n = novels.find((x) => x.slug === m[1]); if (!n) return html('nope', 404);
    const k = Number(m[2]);
    // (formWrap: the chapter inside a form, as ASP.NET sites have their whole page, and its last part in a <template>.)
    const inner = `<p>Chapter ${k} of ${n.title} begins here with words.</p><script>track()</script><p class="ads">BUY</p><p>It goes on, paragraph two of chapter ${k}.</p><img src="/cover/${n.slug}.png" alt="pic"><p>And ends.</p>`;
    return html(page(`${n.title} ${k}`, `<h3>Chapter ${k}: Part ${k}</h3><div class="content">${knobs.formWrap ? `<form id="aspnetForm"><input type="hidden" name="v" value="1">${inner.replace('<p>And ends.</p>', '<template><p>And ends.</p></template>')}</form>` : inner}</div>`));
  } }
  if (p === '/admin/knobs') { for (const k of Object.keys(knobs)) if (u.searchParams.has(k)) knobs[k] = typeof knobs[k] === 'boolean' ? u.searchParams.get(k) === '1' : Number(u.searchParams.get(k)); return json(knobs); }
  if (p === '/admin/add-chapter') { const n = novels.find((x) => x.slug === u.searchParams.get('slug')); if (n) n.chapters++; return json({ ok: !!n, chapters: n && n.chapters }); }
  res.statusCode = 404; res.end('nope');
});
server.listen(port, () => console.log('ext test server on', port));
