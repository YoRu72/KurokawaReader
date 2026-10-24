# Synthetic phone photos of documents, with the page's true corners, for measuring automatic page finding.
# python3 tests/scanbench/make.py <outdir>  →  <name>.jpg + truth.json ({name: [[x,y]×4 (tl,tr,br,bl)] or null})
import json, math, os, random, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
W, H = 1600, 1200


def coeffs(src, dst):
    # PIL perspective coefficients mapping output (dst) points back to input (src) points.
    A = []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = [c for p in src for c in p]
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()


def page(w, h, rnd, kind='text', tint=(250, 249, 245)):
    im = Image.new('RGB', (w, h), tint); d = ImageDraw.Draw(im)
    m = int(w * 0.09); y = m
    if kind == 'frame':
        d.rectangle([m * 0.6, m * 0.6, w - m * 0.6, h - m * 0.6], outline=(30, 30, 30), width=max(3, w // 200))
    if kind == 'photo':
        d.rectangle([m, m, w - m, h * 0.45], fill=(40 + rnd.randint(0, 60), 90, 140))
        y = int(h * 0.5)
    if kind == 'table':
        for i in range(9):
            yy = m + i * (h - 2 * m) / 8; d.line([m, yy, w - m, yy], fill=(20, 20, 20), width=3)
        for i in range(5):
            xx = m + i * (w - 2 * m) / 4; d.line([xx, m, xx, h - m], fill=(20, 20, 20), width=3)
        return im
    lh = max(10, h // 42)
    while y < h - m:
        x = m
        while x < w - m:
            ww = rnd.randint(lh, lh * 5)
            if x + ww > w - m: break
            d.rectangle([x, y, x + ww, y + lh * 0.55], fill=(35, 35, 40))
            x += ww + lh // 2
        y += lh
    return im


def background(kind, rnd):
    a = np.zeros((H, W, 3), np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    if kind == 'wood':
        base = np.array([120, 78, 45], np.float32)
        g = 0.75 + 0.25 * np.sin(xx / 13.0 + 3 * np.sin(yy / 90.0)) * np.sin(yy / 700.0 + 1)
        a[:] = base * g[..., None]
    elif kind == 'grey':
        a[:] = np.array([196, 193, 188], np.float32)
    elif kind == 'white':
        a[:] = np.array([228, 228, 226], np.float32)
    elif kind == 'blue':
        a[:] = np.array([40, 70, 140], np.float32)
    elif kind == 'cloth':
        c = ((xx // 24 + yy // 24) % 2).astype(np.float32)
        a[:] = (np.array([200, 60, 60], np.float32) * c[..., None] + np.array([235, 225, 210], np.float32) * (1 - c[..., None]))
    elif kind == 'dark':
        a[:] = np.array([45, 45, 50], np.float32)
    a += np.random.default_rng(rnd.randint(0, 9999)).normal(0, 6, a.shape).astype(np.float32)
    return a


def clutter(img, rnd):
    d = ImageDraw.Draw(img)
    for _ in range(9):
        x, y = rnd.randint(-100, W), rnd.randint(-100, H)
        c = tuple(rnd.randint(0, 255) for _ in range(3))
        if rnd.random() < 0.5: d.ellipse([x, y, x + rnd.randint(60, 260), y + rnd.randint(60, 260)], fill=c)
        else: d.rectangle([x, y, x + rnd.randint(60, 320), y + rnd.randint(30, 200)], fill=c)
    # a dark keyboard-ish block and a pen
    d.rectangle([W * 0.02, H * 0.78, W * 0.4, H * 1.0], fill=(25, 25, 28))
    d.line([W * 0.8, H * 0.1, W * 0.97, H * 0.4], fill=(10, 30, 160), width=14)


def shoot(name, bgk, quad, rnd, kind='text', clut=False, shadow=None, curve=0.0, spread=False, ar=1.414, tint=(250, 249, 245), blur=1.0):
    bg = background(bgk, rnd)
    img = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))
    if clut: clutter(img, rnd)
    pw = 1000; ph = int(pw * ar)
    if spread:
        p = Image.new('RGB', (pw * 2, ph), tint)
        p.paste(page(pw, ph, rnd, kind, tint), (0, 0)); p.paste(page(pw, ph, rnd, kind, tint), (pw, 0))
        d = ImageDraw.Draw(p); d.rectangle([pw - 6, 0, pw + 6, ph], fill=(200, 198, 192))
        pw *= 2
    else:
        p = page(pw, ph, rnd, kind, tint)
    # a bent page: rows shifted with a smooth bow (the top and bottom edges curve)
    if curve:
        a = np.asarray(p).copy(); out = np.zeros_like(a); out[:] = 0
        mask = np.zeros(a.shape[:2], np.uint8)
        for x in range(a.shape[1]):
            t = x / a.shape[1]
            off = int(curve * ph * (math.sin(math.pi * (t * 2 % 1)) if spread else math.sin(math.pi * t)))
            col = a[:, x]; o = max(0, off)
            out[o:, x] = col[: a.shape[0] - o]; mask[o:, x] = 255
        p = Image.fromarray(out); m = Image.fromarray(mask)
    else:
        m = Image.new('L', p.size, 255)
    src = [(0, 0), (p.size[0], 0), (p.size[0], p.size[1]), (0, p.size[1])]
    c = coeffs(src, quad)
    pp = p.transform((W, H), Image.PERSPECTIVE, c, Image.BICUBIC)
    mm = m.transform((W, H), Image.PERSPECTIVE, c, Image.BILINEAR)
    # a soft drop shadow under the page
    sh = mm.filter(ImageFilter.GaussianBlur(12)).point(lambda v: int(v * 0.35))
    dark = Image.new('RGB', (W, H), (0, 0, 0))
    img = Image.composite(dark, img, sh)
    img = Image.composite(pp, img, mm)
    a = np.asarray(img).astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    # light: vignette, and a shadow across part of the frame
    a *= (1 - 0.25 * (((xx - W / 2) / W) ** 2 + ((yy - H / 2) / H) ** 2) * 2)[..., None]
    if shadow:
        x0, x1, k = shadow
        s = np.clip((xx - x0) / max(1, (x1 - x0)), 0, 1)
        a *= (1 - k * (1 - s))[..., None]
    a += np.random.default_rng(rnd.randint(0, 9999)).normal(0, 3, a.shape)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
    img.save(os.path.join(OUT, name + '.jpg'), quality=88)
    return [list(map(float, q)) for q in quad]


rnd = random.Random(7)
truth = {}
def J(*pts): return [(float(x), float(y)) for x, y in pts]
truth['01-wood'] = shoot('01-wood', 'wood', J((420, 140), (1150, 170), (1210, 1100), (380, 1060)), rnd)
truth['02-grey-table'] = shoot('02-grey-table', 'grey', J((350, 120), (1200, 100), (1260, 1120), (300, 1150)), rnd)
truth['03-white-desk'] = shoot('03-white-desk', 'white', J((360, 90), (1180, 130), (1150, 1120), (330, 1090)), rnd)
truth['04-clutter'] = shoot('04-clutter', 'grey', J((520, 180), (1130, 140), (1190, 980), (560, 1030)), rnd, clut=True)
truth['05-spread'] = shoot('05-spread', 'dark', J((120, 260), (1480, 230), (1500, 1080), (100, 1110)), rnd, spread=True, curve=0.03, ar=1.4)
truth['06-cut-corner'] = shoot('06-cut-corner', 'wood', J((500, -80), (1400, 60), (1350, 1150), (420, 1080)), rnd)
truth['07-shadow'] = shoot('07-shadow', 'grey', J((380, 110), (1180, 120), (1230, 1110), (340, 1090)), rnd, shadow=(300, 900, 0.55))
truth['08-cloth'] = shoot('08-cloth', 'cloth', J((440, 150), (1140, 180), (1180, 1080), (400, 1060)), rnd)
truth['09-frame-printed'] = shoot('09-frame-printed', 'wood', J((400, 120), (1180, 140), (1220, 1110), (360, 1080)), rnd, kind='frame')
truth['10-steep'] = shoot('10-steep', 'wood', J((560, 260), (1060, 250), (1380, 1130), (220, 1140)), rnd)
truth['11-receipt'] = shoot('11-receipt', 'dark', J((680, 60), (960, 70), (980, 1150), (650, 1140)), rnd, ar=3.5)
truth['12-blue-photo'] = shoot('12-blue-photo', 'blue', J((420, 130), (1160, 150), (1190, 1090), (390, 1070)), rnd, kind='photo')
truth['13-table'] = shoot('13-table', 'white', J((380, 120), (1200, 110), (1230, 1100), (350, 1110)), rnd, kind='table')
truth['14-curved'] = shoot('14-curved', 'wood', J((380, 150), (1180, 140), (1210, 1110), (360, 1100)), rnd, curve=0.04)
truth['15-cream-on-white'] = shoot('15-cream-on-white', 'white', J((330, 100), (1230, 90), (1260, 1140), (300, 1150)), rnd, tint=(244, 236, 214))
truth['16-fills-frame'] = shoot('16-fills-frame', 'grey', J((-20, -20), (1620, -15), (1625, 1220), (-25, 1215)), rnd)
truth['16-fills-frame'] = None  # the page is the whole photo
# Harder: a thumb over one edge; a second sheet beside the page; a dim, warm photo; a page on a desk with a
# laptop edge and a shadowed corner; grey recycled paper on a grey table.
def thumb(name):
    im = Image.open(os.path.join(OUT, name + '.jpg')); d = ImageDraw.Draw(im)
    d.ellipse([1080, 560, 1330, 760], fill=(214, 160, 130)); d.rectangle([1200, 600, 1600, 720], fill=(205, 150, 120))
    im.save(os.path.join(OUT, name + '.jpg'), quality=88)
truth['17-thumb'] = shoot('17-thumb', 'wood', J((420, 130), (1170, 160), (1200, 1100), (390, 1080)), rnd); thumb('17-thumb')
def second(name):
    pass
truth['18-two-sheets'] = shoot('18-two-sheets', 'dark', J((560, 150), (1250, 170), (1270, 1100), (540, 1080)), rnd)
im = Image.open(os.path.join(OUT, '18-two-sheets.jpg')); d = ImageDraw.Draw(im)
d.polygon([(40, 300), (470, 280), (500, 1150), (60, 1170)], fill=(236, 236, 232)); im.save(os.path.join(OUT, '18-two-sheets.jpg'), quality=88)
truth['19-dim-warm'] = shoot('19-dim-warm', 'grey', J((380, 140), (1180, 120), (1220, 1110), (350, 1100)), rnd, shadow=(0, 1600, 0.45), tint=(235, 222, 196))
truth['20-grey-on-grey'] = shoot('20-grey-on-grey', 'grey', J((400, 130), (1170, 150), (1200, 1090), (370, 1070)), rnd, tint=(214, 212, 206))

json.dump(truth, open(os.path.join(OUT, 'truth.json'), 'w'), indent=1)
print('made', len(truth))
