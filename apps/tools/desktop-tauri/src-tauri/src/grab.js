(function () {
var o = [], s = {};
function add(u, t, k) {
if (!u || typeof u !== 'string') return;
try { u = new URL(u.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&'), location.href).href; } catch (x) { return; }
if (s[u] || !/^(https?:|magnet:)/i.test(u)) return;
s[u] = 1; o.push({ href: u, text: (t || '').trim().slice(0, 200), kind: k || '' });
}
var media = /\.(m3u8|mpd|mp4|mkv|webm|m4v|mov)(\?|#|$)/i, audio = /\.(mp3|m4a|flac|ogg|opus|aac|wav)(\?|#|$)/i;
var title = document.title;
document.querySelectorAll('video, audio').forEach(function (v) {
var k = v.tagName === 'AUDIO' ? 'music' : 'video', name = v.getAttribute('title') || v.getAttribute('aria-label') || title;
if (v.currentSrc && !/^blob:/.test(v.currentSrc)) add(v.currentSrc, name, k);
if (v.src && !/^blob:/.test(v.src)) add(v.src, name, k);
v.querySelectorAll('source[src]').forEach(function (x) { add(x.src, name, k); });
});
document.querySelectorAll('a[href]').forEach(function (a) { add(a.href, a.textContent || a.title || a.getAttribute('download'), media.test(a.href) ? 'video' : audio.test(a.href) ? 'music' : 'a'); });
document.querySelectorAll('source[src], img[src], iframe[src], track[src], embed[src], object[data]').forEach(function (e) { add(e.currentSrc || e.src || e.data, e.alt || e.title || '', e.tagName.toLowerCase()); });
document.querySelectorAll('[data-src], [data-href], [data-url], [data-file], [data-video], [data-video-src], [data-hls], [data-mp4]').forEach(function (e) {
var d = e.dataset, u = d.video || d.videoSrc || d.hls || d.mp4 || d.src || d.href || d.url || d.file;
add(u, e.textContent || e.title, d.video || d.videoSrc || d.hls || d.mp4 || media.test(u || '') ? 'video' : 'data');
});
document.querySelectorAll('meta[property^="og:video"], meta[name^="og:video"], meta[property="og:audio"], meta[name="twitter:player:stream"], meta[itemprop="contentUrl"], link[rel="video_src"]').forEach(function (m) {
var u = m.getAttribute('content') || m.getAttribute('href') || '', p = (m.getAttribute('property') || m.getAttribute('name') || '');
if (/:(type|width|height|duration|tag|release_date)$/.test(p) || !/^(https?:)?\/\//i.test(u)) return;
add(u, title, /audio/.test(p) ? 'music' : 'video');
});
document.querySelectorAll('script[type="application/ld+json"]').forEach(function (sc) {
(sc.textContent.match(/"(contentUrl|embedUrl)"\s*:\s*"[^"]+"/g) || []).forEach(function (m) { add(m.replace(/^[^:]*:\s*"/, '').replace(/"$/, ''), title, 'video'); });
});
try {
var html = document.documentElement.innerHTML;
(html.match(/https?:(?:\\?\/){2}[^"'\s<>()\\]+(?:\\\/[^"'\s<>()\\]+)*?\.(?:m3u8|mpd|mp4|webm|mkv|m4v|mov|mp3|m4a|flac)(?:\?[^"'\s<>()]*)?/gi) || []).slice(0, 300).forEach(function (u) { add(u, '', audio.test(u) ? 'music' : 'video'); });
} catch (x) {}
try {
performance.getEntriesByType('resource').forEach(function (r) {
if (media.test(r.name) || r.initiatorType === 'video' || /\.m3u8|\.mpd|\/manifest|videoplayback/i.test(r.name)) { if (!/\.(ts|m4s)(\?|$)/i.test(r.name)) add(r.name, '', 'video'); }
else if (audio.test(r.name) || r.initiatorType === 'audio') add(r.name, '', 'music');
else if (/\.(zip|7z|rar|apk|pdf|epub)(\?|$)/i.test(r.name)) add(r.name, '', 'media');
});
} catch (x) {}
return { url: location.href, title: title, links: o.slice(0, 3000) };
})()
