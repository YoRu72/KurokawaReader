// A video whose picture this Chromium cannot decode — H.264 in 10 bits (most older anime releases), HEVC with no
// decoder in the graphics card or on Linux, MPEG-4 Part 2 (XviD/DivX), MPEG-2, VC-1, WMV, RealVideo — turned into
// H.264 (8 bits) and AAC by ffmpeg as it plays, from `ss` seconds, as fragmented MP4 the page's <video> plays.
// The graphics card's encoder when one works (NVENC, Quick Sync, AMF, VideoToolbox), else x264 at its fast presets.
// `c=vp9` gives VP9 and Opus in WebM instead, for a Chromium built without H.264.
'use strict';
const { spawn, execFile } = require('node:child_process');
const Ffmpeg = require('./ffmpeg.cjs');

const CANDIDATES = { win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'], darwin: ['h264_videotoolbox'], linux: ['h264_nvenc'] };
let chosen = null; // Promise<string>

/** One encoder tried on a second of test picture: fine when ffmpeg ends well. */
function works(enc) {
  return new Promise((res) => {
    execFile(Ffmpeg.binary(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=1', ...encArgs(enc), '-f', 'null', '-'], { timeout: 15000, windowsHide: true }, (err) => res(!err));
  });
}
/** The first of the graphics card's encoders that works here, else x264 (asked once). */
function encoder() {
  if (process.env.KT_TRANSCODE_ENCODER) return Promise.resolve(process.env.KT_TRANSCODE_ENCODER);
  if (!chosen) chosen = (async () => { for (const e of CANDIDATES[process.platform] || []) if (await works(e)) return e; return 'libx264'; })();
  return chosen;
}
function encArgs(enc) {
  const even = "scale='min(1920,iw)':-2"; // (wider than 1080p made 1080p: the encoder keeps pace on any machine)
  switch (enc) {
    case 'h264_nvenc': return ['-vf', `${even},format=yuv420p`, '-c:v', 'h264_nvenc', '-preset', 'fast', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-g', '48', '-bf', '0'];
    case 'h264_qsv': return ['-vf', `${even},format=nv12`, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '22', '-g', '48', '-bf', '0'];
    case 'h264_amf': return ['-vf', `${even},format=yuv420p`, '-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-g', '48', '-bf', '0'];
    case 'h264_videotoolbox': return ['-vf', `${even},format=yuv420p`, '-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '8M', '-g', '48'];
    case 'libvpx-vp9': return ['-vf', `${even},format=yuv420p`, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '2M', '-g', '48'];
    default: return ['-vf', `${even},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '21', '-g', '48', '-bf', '0'];
  }
}
/** ffmpeg's arguments for one request (exported for the tests). */
function args(src, ss, a, enc) {
  const vp9 = enc === 'libvpx-vp9';
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', ...(ss > 0 ? ['-ss', String(ss)] : []), '-i', src,
    '-map', '0:v:0', '-map', `0:a:${a}?`, '-sn', '-dn', ...encArgs(enc),
    ...(vp9 ? ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2', '-f', 'webm', '-cluster_time_limit', '1000'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000']),
    'pipe:1'];
}
/** The handler for /video?src=&ss=&a=&c= — the answer's head is sent with ffmpeg's first bytes, so an encoder that
 *  fails at once is replaced by x264 within the same request. */
async function serve(q, req, out) {
  const src = q.searchParams.get('src') || ''; const ss = Math.max(0, Number(q.searchParams.get('ss')) || 0); const a = Math.max(0, Math.floor(Number(q.searchParams.get('a')) || 0));
  const vp9 = q.searchParams.get('c') === 'vp9'; const type = vp9 ? 'video/webm' : 'video/mp4';
  if (req.method === 'HEAD' || !src) { out.writeHead(src ? 200 : 400, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); out.end(); return; }
  let enc = vp9 ? 'libvpx-vp9' : await encoder(); let gone = false; let p = null;
  req.on('close', () => { gone = true; try { p?.kill('SIGKILL'); } catch { /* gone */ } });
  for (let attempt = 0; attempt < 2 && !gone; attempt++) {
    const sent = await new Promise((done) => {
      p = spawn(Ffmpeg.binary(), args(src, ss, a, enc), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let err = ''; let any = false;
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.stdout.on('data', (d) => { if (!any) { any = true; out.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-kt-encoder': enc }); } if (!out.write(d)) { p.stdout.pause(); out.once('drain', () => p.stdout.resume()); } });
      p.on('error', (e) => { err = e.code === 'ENOENT' ? 'pack:ffmpeg' : String(e.message); });
      p.on('close', (code) => { if (any) { out.end(); done(true); return; } if (code && err) console.warn(`transcode (${enc}):`, err.trim().split('\n').pop()); done(err || `ffmpeg ${code}`); });
    });
    if (sent === true) return;
    if (enc === 'libx264' || enc === 'libvpx-vp9' || /pack:ffmpeg/.test(sent)) { if (!gone) { out.writeHead(502, { 'access-control-allow-origin': '*' }); out.end(String(sent)); } return; }
    chosen = Promise.resolve('libx264'); enc = 'libx264'; // (the card's encoder refused this file: x264 from now on)
  }
}
module.exports = { serve, encoder, args };
