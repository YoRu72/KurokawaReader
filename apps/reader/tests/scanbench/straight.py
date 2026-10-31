# python3 tests/scanbench/straight.py <image...>: how straight the lines of print are in each picture — lines followed
# strip by strip (each strip's ink profile peaks once per line), each fitted with a straight line; the deviation from
# it, as a share of the line spacing (0 = perfectly straight and level). Also the lines' mean slope in degrees.
import sys
import numpy as np, cv2

def measure(path):
    g = cv2.imread(path, cv2.IMREAD_GRAYSCALE).astype(np.float32)
    k = 1000 / max(g.shape); g = cv2.resize(g, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    light = cv2.blur(cv2.dilate(g, np.ones((25, 25))), (41, 41))
    ink = (g < light * 0.7).astype(np.float32)
    h, w = ink.shape
    rows = ink[:, int(w * 0.2):int(w * 0.8)].sum(1); r = rows - rows.mean()
    ac = np.correlate(r, r, 'full')[len(r) - 1:]; ac /= ac[0] + 1e-9
    dip = 2
    while dip < len(ac) - 1 and ac[dip + 1] < ac[dip]: dip += 1
    P = dip + int(np.argmax(ac[dip:len(ac) // 5])) if dip < len(ac) // 5 else 30
    sw = max(8, int(P * 1.2)); chains = []; ends = []
    for x0 in range(0, w - sw, sw // 2):
        pr = cv2.GaussianBlur(ink[:, x0:x0 + sw].sum(1).reshape(-1, 1), (1, 0), max(1.5, P / 5)).ravel()
        pr = pr - np.percentile(pr, 20); typ = np.percentile(pr[pr > 0], 75) if (pr > 0).any() else 0
        peaks = [y for y in range(1, h - 1) if pr[y] > typ * 0.3 and pr[y] >= pr[y - 1] and pr[y] >= pr[y + 1]]
        xc = x0 + sw / 2
        for y in peaks:
            best, bd = None, P * 0.33
            for e in ends:
                if xc - e[0] > sw * 2.5: continue
                if abs(e[1] - y) < bd: bd, best = abs(e[1] - y), e
            if best is not None: chains[best[2]].append((xc, y)); best[0], best[1] = xc, y
            else: chains.append([(xc, y)]); ends.append([xc, y, len(chains) - 1])
    devs, slopes, n = [], [], 0
    for c in chains:
        if len(c) < 6: continue
        c = np.array(c); p = np.polyfit(c[:, 0], c[:, 1], 1)
        devs.append(np.sqrt(np.mean((c[:, 1] - np.polyval(p, c[:, 0])) ** 2)) / P); slopes.append(math_deg(p[0])); n += 1
    return n, P, (float(np.median(devs)) if devs else float('nan')), (float(np.percentile(devs, 90)) if devs else float('nan')), (float(np.median(np.abs(slopes))) if slopes else float('nan'))

def math_deg(s): return float(np.degrees(np.arctan(s)))

for f in sys.argv[1:]:
    n, P, med, p90, sl = measure(f)
    print(f'{f.split("/")[-1]:28s} lines {n:3d}  spacing {P:3d}  bend median {med:.3f}  p90 {p90:.3f}  |slope| {sl:.2f}°')
