# python3 tests/scanbench/curl.py <page.png...> --out <dir>: photos of book pages, made from flat page images:
# each page is bent as a book's page bends at its spine (a curl whose angle fades away from the spine), turned a
# little in space, seen by a phone camera (perspective), lit unevenly, on a table — with the page's true corners
# (in the photo) written to truth.json. For measuring the scanner's flattening on print we know is straight.
import argparse, json, math, os, random
import numpy as np, cv2
from scipy.interpolate import griddata

ap = argparse.ArgumentParser(); ap.add_argument('pages', nargs='+'); ap.add_argument('--out', required=True); ap.add_argument('--seed', type=int, default=3)
a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); rnd = random.Random(a.seed)
truth = {}

def rot(ax, ay, az):
    cx, sx, cy, sy, cz, sz = math.cos(ax), math.sin(ax), math.cos(ay), math.sin(ay), math.cos(az), math.sin(az)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]]); Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx

for pi, path in enumerate(a.pages):
    for variant in range(2):
        page = cv2.imread(path); H, W = page.shape[:2]
        m = int(0.05 * W); page = cv2.copyMakeBorder(page, m, m, m, m, cv2.BORDER_CONSTANT, value=(250, 250, 248)); H, W = page.shape[:2]
        # The curl: the page's angle out of the table, largest at the spine, fading over s; the spine on the left or right.
        spine_left = rnd.random() < 0.5
        th0 = math.radians(rnd.uniform(25, 55) if variant else rnd.uniform(12, 30)); s = W * rnd.uniform(0.12, 0.3)
        N = 400; Xs = np.linspace(0, W, N)
        d = Xs if spine_left else (W - Xs)
        theta = th0 * np.exp(-d / s) * (1 if spine_left else -1)
        # Arc length along X → position (x, z) in space (z < 0: away from the camera, into the gutter).
        dx = np.gradient(Xs); xs = np.cumsum(np.cos(theta) * dx); xs -= xs[0]; zs = -np.cumsum(np.abs(np.sin(theta)) * dx)
        zs -= zs[np.argmin(np.abs(theta))] if not spine_left else zs[-1]
        # Grid of page points → 3D → camera.
        gx, gy = 80, 110
        X = np.linspace(0, W, gx); Y = np.linspace(0, H, gy)
        px = np.interp(X, Xs, xs); pz = np.interp(X, Xs, zs)
        P = np.stack(np.meshgrid(px - px.mean(), Y - H / 2), -1).reshape(-1, 2)
        Z = np.tile(pz, gy)
        pts = np.column_stack([P[:, 0], P[:, 1], Z])
        R = rot(math.radians(rnd.uniform(-12, 12)), math.radians(rnd.uniform(-12, 12)), math.radians(rnd.uniform(-6, 6)))
        f = 1.0; D = 1.25 * max(W, H)
        cam = pts @ R.T + np.array([0, 0, D])
        OW, OH = (1200, 1600) if rnd.random() < 0.7 else (1600, 1200)
        fpx = max(OW, OH) * 0.95
        u = fpx * cam[:, 0] / cam[:, 2] + OW / 2; v = fpx * cam[:, 1] / cam[:, 2] + OH / 2
        # Fit the page in the frame with a margin.
        sc = 0.86 * min(OW / (u.max() - u.min()), OH / (v.max() - v.min())); u = (u - (u.max() + u.min()) / 2) * sc + OW / 2; v = (v - (v.max() + v.min()) / 2) * sc + OH / 2
        src = np.column_stack([np.repeat(X[None], gy, 0).ravel(), np.repeat(Y[:, None], gx, 1).ravel()])
        gxo, gyo = np.meshgrid(np.arange(OW), np.arange(OH))
        mapx = griddata(np.column_stack([u, v]), src[:, 0], (gxo, gyo), method='linear').astype(np.float32)
        mapy = griddata(np.column_stack([u, v]), src[:, 1], (gxo, gyo), method='linear').astype(np.float32)
        inside = ~np.isnan(mapx)
        mapx[~inside] = -1; mapy[~inside] = -1
        warped = cv2.remap(page, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
        # Light: darker where the page turns away (into the gutter), and a gradient across the frame.
        tilt = np.interp(np.nan_to_num(mapx, nan=0), Xs, np.abs(theta))
        shade = (1 - 0.55 * np.sin(tilt)) * (1 - 0.18 * (gxo / OW)) * (0.92 + 0.08 * gyo / OH)
        bg = np.zeros((OH, OW, 3), np.float32); bgc = np.array(rnd.choice([(40, 60, 95), (70, 70, 72), (120, 80, 50), (200, 195, 190)]), np.float32)
        bg[:] = bgc; bg += np.random.default_rng(pi * 7 + variant).normal(0, 5, bg.shape)
        img = np.where(inside[..., None], warped.astype(np.float32) * shade[..., None], bg)
        img = cv2.GaussianBlur(img, (0, 0), 0.8) + np.random.default_rng(pi + 100 * variant).normal(0, 2.5, img.shape)
        name = f'curl-{pi:02d}-{variant}'
        cv2.imwrite(os.path.join(a.out, name + '.jpg'), np.clip(img, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 88])
        cs = [(0, 0), (W, 0), (W, H), (0, H)]
        corners = []
        for (cx_, cy_) in cs:
            k = np.argmin((src[:, 0] - cx_) ** 2 + (src[:, 1] - cy_) ** 2); corners.append([float(u[k]), float(v[k])])
        truth[name] = {'corners': corners, 'spine': 'left' if spine_left else 'right', 'angle': round(math.degrees(th0), 1)}
json.dump(truth, open(os.path.join(a.out, 'truth.json'), 'w'), indent=1)
print('made', len(truth))
