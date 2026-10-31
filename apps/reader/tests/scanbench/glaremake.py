# python3 tests/scanbench/glaremake.py --out <dir> <page.png...>: photos made hard by light, from flat pages —
#   glare-*: glossy paper catching a lamp (a bright patch, added light that washes the print out, its middle
#            near white), the page a little in perspective on a table;
#   moire-*: a page photographed off a screen (the screen's red/green/blue cells seen at a slant and too fine for
#            the camera: rainbow interference bands over everything), lightly blurred and noisy.
import argparse, math, os, random
import numpy as np, cv2

ap = argparse.ArgumentParser(); ap.add_argument('pages', nargs='+'); ap.add_argument('--out', required=True)
a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); rnd = random.Random(11)
for pi, path in enumerate(a.pages):
    page = cv2.imread(path).astype(np.float32); H, W = page.shape[:2]
    k = 1400 / max(H, W); page = cv2.resize(page, None, fx=k, fy=k, interpolation=cv2.INTER_AREA); H, W = page.shape[:2]
    # Glare: added light, a soft blob (sometimes two), up to near white at its heart.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = np.zeros((H, W), np.float32)
    for _ in range(rnd.choice([1, 1, 2])):
        cx, cy, r = rnd.uniform(0.25, 0.75) * W, rnd.uniform(0.25, 0.75) * H, rnd.uniform(0.12, 0.25) * max(W, H)
        g += np.exp(-(((xx - cx) / r) ** 2 + ((yy - cy) / (r * rnd.uniform(0.6, 1.4))) ** 2)) * rnd.uniform(0.75, 0.95)
    g = np.clip(g, 0, 1)
    base = page * 0.78  # the room's light: paper a little grey, so the lamp has room to wash it out
    img = base * (1 - g[..., None] * 0.5) + 255 * g[..., None] * 0.85
    img = cv2.GaussianBlur(img, (0, 0), 0.7) + np.random.default_rng(pi).normal(0, 2.5, img.shape)
    pad = 120; out = np.full((H + 2 * pad, W + 2 * pad, 3), (60, 70, 85), np.float32); out[pad:pad + H, pad:pad + W] = np.clip(img, 0, 255)
    src = np.float32([[pad, pad], [pad + W, pad], [pad + W, pad + H], [pad, pad + H]])
    j = lambda: rnd.uniform(-0.04, 0.04) * W
    dst = np.float32([[pad + j(), pad + j()], [pad + W + j(), pad + j()], [pad + W + j(), pad + H + j()], [pad + j(), pad + H + j()]])
    M = cv2.getPerspectiveTransform(src, dst); out = cv2.warpPerspective(out, M, (out.shape[1], out.shape[0]), borderValue=(60, 70, 85))
    cv2.imwrite(os.path.join(a.out, f'glare-{pi:02d}.jpg'), np.clip(out, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
    # Moiré: the page shown on a screen of RGB stripes (triads of sub-pixels), photographed at a slight angle and
    # scale, so the stripes alias into slow coloured bands; a little defocus and the sensor's noise.
    # Each screen pixel is three sub-pixel stripes; the photo samples the screen at a pitch close to its own
    # (≈1.1–1.3 photo pixels per screen pixel), turned a few degrees: the stripes beat into slow coloured bands.
    S = 6
    big = cv2.resize(page, (W * S, H * S), interpolation=cv2.INTER_NEAREST)
    X = np.arange(W * S) % S; Y = np.arange(H * S) % S
    mask = np.zeros((1, W * S, 3), np.float32)
    for c, ch in enumerate([2, 1, 0]): mask[0, (X >= 2 * c) & (X < 2 * c + 2), ch] = 1
    lit = big * mask * 2.6; lit[(Y == S - 1)] *= 0.3
    pitch = rnd.uniform(1.08, 1.3); ang = rnd.uniform(1.5, 5)
    M2 = cv2.getRotationMatrix2D((W * S / 2, H * S / 2), ang, 1.0); lit = cv2.warpAffine(lit, M2, (W * S, H * S), flags=cv2.INTER_LINEAR, borderValue=(20, 20, 20))
    shot = cv2.resize(lit, (round(W * pitch), round(H * pitch)), interpolation=cv2.INTER_AREA)
    shot = cv2.resize(shot, (W, H), interpolation=cv2.INTER_NEAREST)  # (the sensor's grid: no further smoothing)
    shot = cv2.GaussianBlur(shot, (0, 0), 0.5) + np.random.default_rng(pi + 50).normal(0, 3, shot.shape)
    out = np.full((H + 2 * pad, W + 2 * pad, 3), (25, 25, 28), np.float32); out[pad:pad + H, pad:pad + W] = np.clip(shot, 0, 255)
    cv2.imwrite(os.path.join(a.out, f'moire-{pi:02d}.jpg'), np.clip(out, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
print('made', 2 * len(a.pages))
