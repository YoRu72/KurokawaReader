#!/usr/bin/env python3
"""Stage M3's size table (the number the owner must see): per ABI, libkt_torrent.so as built and compressed in the
APK, and each APK with both Rust libraries, without the torrent library, and without either — «without» computed from
the zip itself (each entry's local header, data, descriptor and central record), as ../kt-android/sizes.py does.
libtorrent4j's own native library (libtorrent4j.so / libjlibtorrent.so) is shown beside it for scale.
Usage: sizes.py --jni <dir with <abi>/libkt_torrent.so> --apks <dir of .apk>   (exit 1 when an APK lacks the library)
"""
import argparse, importlib.util, os, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ktsizes', os.path.join(HERE, '..', 'kt-android', 'sizes.py'))
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
ABIS, kb, entry_cost = base.ABIS, base.kb, base.entry_cost
TOR, CORE = 'libkt_torrent.so', 'libkt_android.so'


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--jni', required=True); ap.add_argument('--apks', required=True); a = ap.parse_args()
    ok = True
    print('### Rust torrent engine (libkt_torrent.so, stage M3) — sizes\n')
    print('| ABI | .so as built | in the APK (compressed) | libtorrent4j\'s native library in the APK (compressed) |')
    print('|---|---:|---:|---:|')
    apks = sorted(f for f in os.listdir(a.apks) if f.endswith('.apk')) if os.path.isdir(a.apks) else []
    for abi in ABIS:
        p = os.path.join(a.jni, abi, TOR)
        built = kb(os.path.getsize(p)) if os.path.isfile(p) else 'missing'
        inapk, lt = '—', '—'
        for f in apks:
            if abi not in f:
                continue
            with zipfile.ZipFile(os.path.join(a.apks, f)) as z:
                for i in z.infolist():
                    if i.filename == f'lib/{abi}/{TOR}':
                        inapk = kb(i.compress_size)
                    elif i.filename.startswith(f'lib/{abi}/') and 'torrent' in i.filename and TOR not in i.filename:
                        lt = f'{kb(i.compress_size)} ({os.path.basename(i.filename)})'
        print(f'| {abi} | {built} | {inapk} | {lt} |')
    print('\n| APK | with both Rust libraries | without libkt_torrent | without either | the torrent library adds |')
    print('|---|---:|---:|---:|---:|')
    for f in apks:
        path = os.path.join(a.apks, f); size = os.path.getsize(path); want = [x for x in ABIS if x in f] or ABIS
        tor = core = 0; found = []
        with zipfile.ZipFile(path) as z:
            for abi in ABIS:
                for lib in (TOR, CORE):
                    try:
                        info = z.getinfo(f'lib/{abi}/{lib}')
                    except KeyError:
                        continue
                    c = entry_cost(z, info)
                    if lib == TOR:
                        tor += c; found.append(abi)
                    else:
                        core += c
        if [x for x in want if x not in found]:
            ok = False
        print(f'| {f} | {kb(size)} | {kb(size - tor)} | {kb(size - tor - core)} | {kb(tor)} |')
    print('\n' + ('Every APK carries the torrent library for its ABI.' if ok else '**The torrent library is missing from an APK.**'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
