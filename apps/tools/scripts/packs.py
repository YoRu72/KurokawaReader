#!/usr/bin/env python3
"""The packs the Android app downloads instead of carrying: Python and ffmpeg, per ABI, made from the very bundles
youtubedl-android puts in an APK (found in Gradle's cache after the build). The ffmpeg pack also gets the few
libraries ffmpeg needs that youtubedl-android keeps in Python's bundle (libc++, libcrypto, …), so it stands alone.
Writes out/KurokawaTools-pack-<name>-<ydl>-<abi>.zip and out/KurokawaTools-packs.json (sizes and SHA-256)."""
import glob, hashlib, json, os, re, subprocess, sys, tempfile, zipfile

ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64']
OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
cache = os.path.expanduser('~/.gradle/caches/modules-2/files-2.1/io.github.junkfood02.youtubedl-android')

def aar(name):
    found = sorted(glob.glob(f'{cache}/{name}/*/*/{name}-*.aar'))
    if not found: sys.exit(f'no {name} AAR in the Gradle cache')
    return found[-1]

lib_aar, ff_aar = aar('library'), aar('ffmpeg')
ydl = re.search(r'/(\d+\.\d+\.\d+)/', lib_aar).group(1)
SYSTEM = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libz.so', 'libandroid.so', 'libEGL.so', 'libGLESv1_CM.so', 'libGLESv2.so', 'libGLESv3.so',
          'libmediandk.so', 'libOpenSLES.so', 'libvulkan.so', 'libjnigraphics.so', 'libnativewindow.so', 'libcamera2ndk.so', 'libaaudio.so', 'libsync.so', 'libbinder_ndk.so', 'libstdc++.so'}

def needed(path):
    out = subprocess.run(['readelf', '-d', path], capture_output=True, text=True).stdout
    return re.findall(r'NEEDED.*\[(.+?)\]', out)

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

os.makedirs(OUT, exist_ok=True)
manifest = {'ydl': ydl, 'packs': {'python': {}, 'ffmpeg': {}}}
for abi in ABIS:
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(lib_aar) as z: z.extract(f'jni/{abi}/libpython.zip.so', tmp)
        with zipfile.ZipFile(ff_aar) as z:
            for n in ('libffmpeg.zip.so', 'libffmpeg.so', 'libffprobe.so'): z.extract(f'jni/{abi}/{n}', tmp)
        py_zip, ff_zip = f'{tmp}/jni/{abi}/libpython.zip.so', f'{tmp}/jni/{abi}/libffmpeg.zip.so'
        # Python: its bundle as it is.
        py_out = f'{OUT}/KurokawaTools-pack-python-{ydl}-{abi}.zip'
        with open(py_zip, 'rb') as a, open(py_out, 'wb') as b: b.write(a.read())
        # ffmpeg: its bundle, and what it needs from Python's (found by following the libraries' NEEDED entries).
        ffdir, pydir = f'{tmp}/ff', f'{tmp}/py'
        subprocess.run(['unzip', '-q', '-o', ff_zip, '-d', ffdir], check=True)
        subprocess.run(['unzip', '-q', '-o', py_zip, '-d', pydir], check=True)
        have = set(os.listdir(f'{ffdir}/usr/lib')); pyhave = set(os.listdir(f'{pydir}/usr/lib'))
        todo = [f'{tmp}/jni/{abi}/libffmpeg.so', f'{tmp}/jni/{abi}/libffprobe.so']; seen = set(); borrow = set()
        while todo:
            for n in needed(todo.pop()):
                if n in seen: continue
                seen.add(n)
                if n in have: todo.append(f'{ffdir}/usr/lib/{n}')
                elif n in pyhave: borrow.add(n); todo.append(f'{pydir}/usr/lib/{n}')
                elif n not in SYSTEM: print(f'  {abi}: {n} found in neither bundle (a system library?)')
        ff_out = f'{OUT}/KurokawaTools-pack-ffmpeg-{ydl}-{abi}.zip'
        with zipfile.ZipFile(ff_zip) as zin, zipfile.ZipFile(py_zip) as zpy, zipfile.ZipFile(ff_out, 'w', zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist(): zout.writestr(info, zin.read(info))   # (entries copied whole: symlinks stay symlinks)
            names = set(zin.namelist())
            for info in zpy.infolist():
                base = os.path.basename(info.filename)
                # the borrowed library and any versioned name of it (libexpat.so.1 → libexpat.so.1.11.1)
                if info.filename.startswith('usr/lib/') and any(base == b or base.startswith(b + '.') for b in borrow) and info.filename not in names:
                    zout.writestr(info, zpy.read(info))
        print(f'{abi}: ffmpeg borrows {sorted(borrow)}')
        for name, path in (('python', py_out), ('ffmpeg', ff_out)):
            manifest['packs'][name][abi] = {'file': os.path.basename(path), 'size': os.path.getsize(path), 'sha256': sha(path)}
with open(f'{OUT}/KurokawaTools-packs.json', 'w') as f: json.dump(manifest, f, indent=1)
print(json.dumps(manifest, indent=1))
