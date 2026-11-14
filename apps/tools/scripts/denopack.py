#!/usr/bin/env python3
"""The «deno» pack for the PC's Tauri build (yt-dlp's JavaScript runtime; desktop-tauri/PORTING.md «yt-dlp's
JavaScript runtime»). Usage: denopack.py <folder with deno's release zips> <out folder> <deno version>.
Each zip of the table below (deno's own GitHub release files) → out/KurokawaTools-pack-deno-<platform>-<arch>.gz (the
program alone, gzipped: what src-tauri/src/vtffmpeg.rs installs), and out/KurokawaTools-packs.json gets
packs.deno[<platform>-<arch>] = { file, size, sha256 } and versions.deno (merged into the file when it is there).
The table is kt-core's videotools.rs deno_asset (tests/videotauri.cjs keeps them equal). Run by the release workflow
at the switch-over (switch-over/release-tools-yml.NOTES.md); never by a test."""
import gzip, hashlib, json, os, sys, zipfile

ASSETS = {
    'win32-x64': 'deno-x86_64-pc-windows-msvc.zip',
    'darwin-x64': 'deno-x86_64-apple-darwin.zip',
    'darwin-arm64': 'deno-aarch64-apple-darwin.zip',
    'linux-x64': 'deno-x86_64-unknown-linux-gnu.zip',
    'linux-arm64': 'deno-aarch64-unknown-linux-gnu.zip',
}

def main():
    src, out, version = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, 'KurokawaTools-packs.json')
    m = json.load(open(path)) if os.path.exists(path) else {'packs': {}}
    m.setdefault('packs', {}).setdefault('deno', {})
    m.setdefault('versions', {})['deno'] = version
    for key, asset in ASSETS.items():
        z = os.path.join(src, asset)
        if not os.path.exists(z):
            print('missing', asset); continue
        with zipfile.ZipFile(z) as zf:
            name = 'deno.exe' if key.startswith('win32') else 'deno'
            data = zf.read(name)
        f = f'KurokawaTools-pack-deno-{key}.gz'
        with open(os.path.join(out, f), 'wb') as o:
            o.write(gzip.compress(data, 9, mtime=0))
        b = open(os.path.join(out, f), 'rb').read()
        m['packs']['deno'][key] = {'file': f, 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
        print(key, f, len(b))
    json.dump(m, open(path, 'w'), indent=1)

if __name__ == '__main__':
    main()
