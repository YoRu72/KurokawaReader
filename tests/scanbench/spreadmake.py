# python3 tests/scanbench/spreadmake.py --out <dir> <left.png> <right.png> [<left> <right>...]: photos of a book open
# on two pages — each page curling down into the spine (a cylinder-ish fold, darker as it turns away), the pair
# seen by a phone camera at a slant, on a table; some turned a quarter (the phone held upright over a wide book).
import argparse, math, os, random
import numpy as np, cv2
from scipy.interpolate import griddata

ap = argparse.ArgumentParser(); ap.add_argument('pages', nargs='+'); ap.add_argument('--out', required=True); ap.add_argument('--seed', type=int, default=5)
a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); rnd = random.Random(a.seed)
pairs = list(zip(a.pages[0::2], a.pages[1::2]))
for pi, (lp, rp) in enumerate(pairs):
    for variant in range(3):
        L = cv2.imread(lp); R = cv2.imread(rp)
        H = max(L.shape[0], R.shape[0]); L = cv2.resize(L, (int(L.shape[1] * H / L.shape[0]), H)); R = cv2.resize(R, (int(R.shape[1] * H / R.shape[0]), H))
        m = int(0.04 * L.shape[1]); L = cv2.copyMakeBorder(L, m, m, m, m // 2, cv2.BORDER_CONSTANT, value=(248, 247, 242)); R = cv2.copyMakeBorder(R, m, m, m // 2, m, cv2.BORDER_CONSTANT, value=(248, 247, 242))
        page = np.hstack([L, R]); H, W = page.shape[:2]; mid = L.shape[1]
        # Height of the paper above the table, along x: each page rises from the spine and flattens out (a book's fold).
        N = 500; Xs = np.linspace(0, W, N); d = np.abs(Xs - mid) / mid
        depth = rnd.uniform(0.05, 0.12) * W * [0.6, 1, 1.4][variant]
        zs = -depth * np.exp(-d / rnd.uniform(0.12, 0.25))
        # Arc length → x (paper length is kept, so the spine side is foreshortened as it dips).
        dz = np.gradient(zs) / np.gradient(Xs); dx = np.gradient(Xs) / np.sqrt(1 + dz ** 2); xs = np.cumsum(dx); xs -= xs[np.argmin(np.abs(Xs - mid))]
        gx, gy = 120, 90
        X = np.linspace(0, W, gx); Y = np.linspace(0, H, gy)
        px = np.interp(X, Xs, xs); pz = np.interp(X, Xs, zs)
        P = np.stack(np.meshgrid(px, Y - H / 2), -1).reshape(-1, 2); Z = np.tile(pz, gy)
        pts = np.column_stack([P[:, 0], P[:, 1], Z])
        ax, ay, az = [math.radians(rnd.uniform(-s, s)) for s in (14, 10, 5)]
        cx, sx, cy, sy, cz, sz = math.cos(ax), math.sin(ax), math.cos(ay), math.sin(ay), math.cos(az), math.sin(az)
        Rm = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]) @ np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]) @ np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
        cam = pts @ Rm.T + np.array([0, 0, rnd.uniform(1.0, 1.3) * W])
        upright = variant == 2  # the phone held upright: the spread is across the photo's height
        OW, OH = (1200, 1600) if upright else (1600, 1200)
        u = cam[:, 0] / cam[:, 2]; v = cam[:, 1] / cam[:, 2]
        if upright: u, v = -v, u
        sc = 0.88 * min(OW / (u.max() - u.min()), OH / (v.max() - v.min())); u = (u - (u.max() + u.min()) / 2) * sc + OW / 2; v = (v - (v.max() + v.min()) / 2) * sc + OH / 2
        src = np.column_stack([np.repeat(X[None], gy, 0).ravel(), np.repeat(Y[:, None], gx, 1).ravel()])
        gxo, gyo = np.meshgrid(np.arange(OW), np.arange(OH))
        mapx = griddata(np.column_stack([u, v]), src[:, 0], (gxo, gyo), method='linear').astype(np.float32)
        mapy = griddata(np.column_stack([u, v]), src[:, 1], (gxo, gyo), method='linear').astype(np.float32)
        inside = ~np.isnan(mapx); mapx[~inside] = -1; mapy[~inside] = -1
        warped = cv2.remap(page, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        slope = np.abs(np.gradient(zs) / np.gradient(Xs)); tilt = np.interp(np.nan_to_num(mapx, nan=0), Xs, slope)
        shade = (1 - 0.6 * np.tanh(tilt * 1.4)) * (1 - 0.15 * gxo / OW)
        bg = np.zeros((OH, OW, 3), np.float32); bg[:] = np.array(rnd.choice([(40, 60, 95), (70, 70, 72), (120, 80, 50)]), np.float32)
        img = np.where(inside[..., None], warped.astype(np.float32) * shade[..., None], bg)
        img = cv2.GaussianBlur(img, (0, 0), 0.8) + np.random.default_rng(pi * 3 + variant).normal(0, 2.5, img.shape)
        cv2.imwrite(os.path.join(a.out, f'spread-{pi:02d}-{variant}.jpg'), np.clip(img, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 88])
print('made', len(pairs) * 3)
