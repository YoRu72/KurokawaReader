# python3 tests/scanbench/overlay.py <dir>: the photos with the found page (green) and the truth (red), on one sheet.
import glob, json, os, sys
from PIL import Image, ImageDraw
d = sys.argv[1]; found = json.load(open(os.path.join(d, 'found.json'))); truth = json.load(open(os.path.join(d, 'truth.json')))
names = sorted(found); W, H = 400, 300; cols = 4
sheet = Image.new('RGB', (W * cols, H * ((len(names) + cols - 1) // cols)))
for i, n in enumerate(names):
    im = Image.open(os.path.join(d, n + '.jpg')).convert('RGB'); k = W / im.width
    m = json.load(open(os.path.join(d, n + '.json')))['k']
    im = im.resize((W, H)); g = ImageDraw.Draw(im)
    if truth[n]: g.polygon([(x / m * k, y / m * k) for x, y in truth[n]], outline=(255, 0, 0), width=2)
    g.polygon([(x * k, y * k) for x, y in found[n]], outline=(0, 230, 0), width=2)
    g.text((6, 6), n, fill=(255, 255, 0))
    sheet.paste(im, ((i % cols) * W, (i // cols) * H))
sheet.save(os.path.join(d, 'overlay.png'))
