// The app's icon in every size every platform asks for, drawn from the SVGs beside this file (run: node
// native/icon/render.cjs; needs Playwright's Chromium and Python's Pillow for the .ico).
const { chromium } = require('playwright'); const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const HERE = __dirname; const ROOT = path.join(HERE, '..', '..'); const RES = path.join(ROOT, 'native', 'android', 'res');
// (Kurokawa Reader's: an open book with its bookmark, drawn like Kurokawa Tools' arrow and K.)
const svg = (n) => fs.readFileSync(path.join(HERE, `${n}.svg`), 'utf8');
(async () => {
  const br = await chromium.launch(); const p = await br.newPage();
  const draw = async (src, size, out, clip = 'none') => {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;${clip === 'circle' ? 'border-radius:50%;overflow:hidden;' : ''}">${src.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
    fs.mkdirSync(path.dirname(out), { recursive: true }); await p.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  // The web app and the desktop.
  fs.copyFileSync(path.join(HERE, 'icon.svg'), path.join(ROOT, 'public', 'icons', 'icon.svg'));
  await draw(svg('icon'), 192, path.join(ROOT, 'public', 'icons', 'icon-192.png'));
  await draw(svg('icon'), 512, path.join(ROOT, 'public', 'icons', 'icon-512.png'));
  await draw(svg('maskable'), 512, path.join(ROOT, 'public', 'icons', 'icon-512-maskable.png'));
  await draw(svg('icon'), 512, path.join(ROOT, 'desktop', 'icon.png'));
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kt-ico-')); await draw(svg('icon'), 256, path.join(tmp, '256.png'));
  execFileSync('python3', ['-c', `from PIL import Image; Image.open(${JSON.stringify(path.join(tmp, '256.png'))}).save(${JSON.stringify(path.join(ROOT, 'desktop', 'icon.ico'))}, sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(256,256)])`]);
  // iOS: one 1024 px picture (Xcode makes the rest), with no transparency.
  await draw(svg('maskable'), 1024, path.join(ROOT, 'native', 'ios', 'AppIcon-1024.png'));
  // Android: the adaptive icon's layers (108 dp), the themed (monochrome) layer, and the older launchers' icons.
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(RES, `mipmap-${d}`);
    await draw(svg('background'), 108 * k, path.join(dir, 'ic_launcher_background.png'));
    await draw(svg('foreground'), 108 * k, path.join(dir, 'ic_launcher_foreground.png'));
    await draw(svg('monochrome'), 108 * k, path.join(dir, 'ic_launcher_monochrome.png'));
    await draw(svg('icon'), 48 * k, path.join(dir, 'ic_launcher.png'));
    await draw(svg('maskable'), 48 * k, path.join(dir, 'ic_launcher_round.png'), 'circle');
  }
  const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@mipmap/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n';
  fs.mkdirSync(path.join(RES, 'mipmap-anydpi-v26'), { recursive: true });
  for (const n of ['ic_launcher', 'ic_launcher_round']) fs.writeFileSync(path.join(RES, 'mipmap-anydpi-v26', `${n}.xml`), adaptive);
  // A preview of them all, for a look.
  const prev = `<html><body style="margin:0;padding:24px;background:#dfe6ee;display:flex;gap:28px;align-items:center;font:14px sans-serif">
    ${[['icon', 0], ['maskable', 50], ['maskable', 22], ['maskable', 32]].map(([n, r]) => `<div style="width:160px;height:160px;border-radius:${r}%;overflow:hidden;box-shadow:0 4px 14px #0003">${svg(n).replace('<svg ', '<svg width="160" height="160" ')}</div>`).join('')}
    <div style="width:160px;height:160px;border-radius:50%;background:#25384f;display:grid;place-items:center;overflow:hidden">${svg('monochrome').replace('<svg ', '<svg width="160" height="160" style="filter:none;opacity:.9" ')}</div>
    <div style="background:#111;padding:20px;border-radius:16px;display:flex;gap:18px">${[48, 32, 16].map((s) => `<div style="width:${s}px;height:${s}px">${svg('icon').replace('<svg ', `<svg width="${s}" height="${s}" `)}</div>`).join('')}</div></body></html>`;
  await p.setViewportSize({ width: 1240, height: 210 }); await p.setContent(prev); await p.screenshot({ path: path.join(process.argv[2] || HERE, 'preview.png') });
  await br.close(); console.log('drawn');
})();
