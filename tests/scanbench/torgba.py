# python3 tests/scanbench/torgba.py <dir> [maxSide]: each photo also as raw RGBA (<name>.rgba + <name>.json with its
# size), scaled to the scanner's working size (1200 by default) as the app decodes it.
import glob, json, os, sys
from PIL import Image

d = sys.argv[1]; mx = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
truth = json.load(open(os.path.join(d, 'truth.json')))
for f in sorted(glob.glob(os.path.join(d, '*.jpg'))):
    name = os.path.splitext(os.path.basename(f))[0]
    if name not in truth: continue
    im = Image.open(f).convert('RGBA'); k = min(1, mx / max(im.size))
    if k < 1: im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    open(os.path.join(d, name + '.rgba'), 'wb').write(im.tobytes())
    json.dump({'w': im.width, 'h': im.height, 'k': k}, open(os.path.join(d, name + '.json'), 'w'))
    if truth[name] is not None: truth[name] = [[x * k, y * k] for x, y in truth[name]]
json.dump(truth, open(os.path.join(d, 'truth.json'), 'w'), indent=1)
