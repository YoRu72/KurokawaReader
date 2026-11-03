#!/usr/bin/env python3
"""The mpv pack (the Player add-on's engine on Android): libmpv and its libraries as mpv-android builds them
(github.com/mpv-android/mpv-android — MIT; its libmpv and FFmpeg under the GPL, their sources there), taken from
the APKs of its latest release, per ABI: usr/lib/*.so, with the notices. Adds them to out/KurokawaTools-packs.json
(packs.mpv.<abi> and versions.mpv). Needs `gh` (GH_TOKEN) and the packs file packs.py wrote."""
import glob, hashlib, json, os, subprocess, sys, tempfile, zipfile

ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64']
OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
REPO = 'mpv-android/mpv-android'

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

tag = subprocess.run(['gh', 'release', 'view', '-R', REPO, '--json', 'tagName', '-q', '.tagName'], capture_output=True, text=True, check=True).stdout.strip()
print('mpv-android', tag)
NOTICE = f"""libmpv and the libraries with it, as built by mpv-android ({tag}): https://github.com/{REPO}
mpv-android is under the MIT licence; mpv, FFmpeg and the other libraries it builds are under the GPL / LGPL.
Their sources: https://github.com/{REPO}/tree/{tag}/buildscripts (and the projects it fetches).
"""
manifest_path = os.path.join(OUT, 'KurokawaTools-packs.json')
m = json.load(open(manifest_path))
m.setdefault('packs', {})['mpv'] = {}; m.setdefault('versions', {})['mpv'] = tag
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(['gh', 'release', 'download', tag, '-R', REPO, '--pattern', '*.apk', '--dir', tmp], check=True)
    apks = sorted(glob.glob(f'{tmp}/*.apk')); print('APKs:', [os.path.basename(a) for a in apks])
    for abi in ABIS:
        src = None
        # (Its own APK first — the ABI's name in the file's —, else any that carries that ABI's libraries.)
        for a in sorted(apks, key=lambda p: (abi not in os.path.basename(p), p)):
            with zipfile.ZipFile(a) as z:
                if f'lib/{abi}/libmpv.so' in z.namelist(): src = a; break
        if not src: print(f'  {abi}: not in this release'); continue
        out = f'{OUT}/KurokawaTools-pack-mpv-{tag}-{abi}.zip'
        with zipfile.ZipFile(src) as z, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zo:
            libs = [n for n in z.namelist() if n.startswith(f'lib/{abi}/') and n.endswith('.so')]
            for n in libs: zo.writestr('usr/lib/' + os.path.basename(n), z.read(n))
            zo.writestr('NOTICE.txt', NOTICE)
        m['packs']['mpv'][abi] = {'file': os.path.basename(out), 'size': os.path.getsize(out), 'sha256': sha(out)}
        print(f'  {abi}: {len(libs)} libraries, {os.path.getsize(out) / 1048576:.1f} MB from {os.path.basename(src)}')
json.dump(m, open(manifest_path, 'w'), indent=1)
if not m['packs']['mpv']: sys.exit('no mpv pack made')
