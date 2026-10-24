# python3 tests/scanner/camvideo.py <photo-a> <photo-b> <out.y4m>: a fake camera feed for Chromium
# (--use-file-for-fake-video-capture): the first photo sliding into view and then held still, then moved away
# and the second photo sliding in and held — what a phone over two pages in turn sees. 960×720, 15 fps.
import sys
import numpy as np, cv2
a, b, out = sys.argv[1:4]
W, H, FPS = 960, 720, 15
def frame_of(img, dx, dy, ang):
    M = cv2.getRotationMatrix2D((img.shape[1] / 2, img.shape[0] / 2), ang, 1.0); M[0, 2] += dx; M[1, 2] += dy
    return cv2.warpAffine(img, M, (W, H), borderValue=(40, 45, 50))
def fit(p):
    im = cv2.imread(p); k = min(W / im.shape[1], H / im.shape[0]); im = cv2.resize(im, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    c = np.full((H, W, 3), (40, 45, 50), np.uint8); y, x = (H - im.shape[0]) // 2, (W - im.shape[1]) // 2; c[y:y + im.shape[0], x:x + im.shape[1]] = im; return c
A, B = fit(a), fit(b)
frames = []
rng = np.random.default_rng(1)
def seq(img, n_move, n_hold, start):
    for i in range(n_move):  # slides in from `start` (a share of the frame) to rest
        t = 1 - i / max(1, n_move - 1); frames.append(frame_of(img, start[0] * W * t, start[1] * H * t, 6 * t))
    for i in range(n_hold):  # held: a hand's tremor of a fraction of a pixel
        frames.append(frame_of(img, rng.normal(0, 0.3), rng.normal(0, 0.3), 0))
seq(A, 20, 45, (0.35, 0.1))
for i in range(15): frames.append(frame_of(A, -W * 0.8 * i / 14, 0, 0))  # moved away
seq(B, 20, 45, (0.4, -0.15))
with open(out, 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
    for fr in frames:
        f.write(b'FRAME\n'); f.write(cv2.cvtColor(fr, cv2.COLOR_BGR2YUV_I420).tobytes())
print('frames', len(frames), 'seconds', len(frames) / FPS)
