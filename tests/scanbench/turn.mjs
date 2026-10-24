import { build } from 'esbuild'; import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
await build({ entryPoints: ['/home/claude/KurokawaReader/src/scan.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '/tmp/tt.mjs', logLevel: 'silent' });
const S = await import('/tmp/tt.mjs?' + Date.now()); globalThis.KR_TURN_DEBUG = !!process.env.DBG;
for (const f of process.argv.slice(2)) for (const r of (process.env.R ? [+process.env.R] : [0, 90, 180, 270])) {
  const meta = JSON.parse(execFileSync('python3', ['-c', `
import sys,json
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA').rotate(int(sys.argv[2]), expand=True); k=min(1,900/max(im.size)); im=im.resize((round(im.width*k),round(im.height*k)))
open('/tmp/tt.rgba','wb').write(im.tobytes()); print(json.dumps([im.width,im.height]))`, f, String(r)]).toString());
  const img = { data: new Uint8ClampedArray(fs.readFileSync('/tmp/tt.rgba')), width: meta[0], height: meta[1] };
  // PIL rotate(r) turns counter-clockwise by r; the turn that undoes it is r/90 quarters clockwise.
  console.log(f.split('/').pop(), 'ccw', r, '→ turn', S.pageTurn(img), 'want', r / 90);
}
