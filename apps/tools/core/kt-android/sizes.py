#!/usr/bin/env python3
"""The Rust core in the APKs: checks each APK carries lib/<abi>/libkt_android.so for its ABI (the universal one all
three) and prints a Markdown size table for the job summary — each .so as built and after llvm-strip, and each APK
with the library and without it. «Without» is the APK's size less the library's entry (its local header, compressed
data, data descriptor and central-directory record), read from the zip itself: exact to the byte, with no second
Gradle build. Exit 1 when a library is missing.

Usage: sizes.py --jni <dir with <abi>/libkt_android.so> --apks <dir of .apk> [--strip <llvm-strip>]
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64']
LIB = 'libkt_android.so'


def kb(n):
    return f'{n / 1024:,.1f} KB' if n < 1024 * 1024 else f'{n / 1048576:,.2f} MB'


def entry_cost(zf, info):
    """Bytes the entry takes in the archive: local header + data (+ descriptor) + central record."""
    with open(zf.filename, 'rb') as f:
        f.seek(info.header_offset + 26)
        n, m = int.from_bytes(f.read(2), 'little'), int.from_bytes(f.read(2), 'little')
    local = 30 + n + m + info.compress_size + (16 if info.flag_bits & 0x08 else 0)
    central = 46 + len(info.orig_filename.encode('utf-8')) + len(info.extra) + len(info.comment)
    return local + central


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--jni', required=True)
    ap.add_argument('--apks', required=True)
    ap.add_argument('--strip', default='')
    a = ap.parse_args()
    ok = True
    print('### Rust core (libkt_android.so) — sizes\n')
    print('| ABI | .so as built (strip = true) | after llvm-strip --strip-all | in the APK (compressed) |')
    print('|---|---:|---:|---:|')
    for abi in ABIS:
        p = os.path.join(a.jni, abi, LIB)
        if not os.path.isfile(p):
            print(f'| {abi} | missing | | |')
            ok = False
            continue
        built = os.path.getsize(p)
        stripped = ''
        if a.strip and os.path.isfile(a.strip):
            with tempfile.TemporaryDirectory() as t:
                q = os.path.join(t, LIB)
                shutil.copy(p, q)
                if subprocess.run([a.strip, '--strip-all', q]).returncode == 0:
                    stripped = kb(os.path.getsize(q))
        inapk = ''
        for f in sorted(os.listdir(a.apks)):
            if f.endswith('.apk') and abi in f:
                with zipfile.ZipFile(os.path.join(a.apks, f)) as z:
                    try:
                        inapk = kb(z.getinfo(f'lib/{abi}/{LIB}').compress_size)
                    except KeyError:
                        pass
        print(f'| {abi} | {kb(built)} | {stripped or "—"} | {inapk or "—"} |')
    print('\n| APK | with the library | without (computed) | added | libraries inside |')
    print('|---|---:|---:|---:|---|')
    apks = sorted(f for f in os.listdir(a.apks) if f.endswith('.apk'))
    if not apks:
        print('| (no APK built) | | | | |')
        ok = False
    for f in apks:
        path = os.path.join(a.apks, f)
        size = os.path.getsize(path)
        want = [x for x in ABIS if x in f] or ABIS   # (the universal APK: all three)
        with zipfile.ZipFile(path) as z:
            found, cost = [], 0
            for abi in ABIS:
                try:
                    info = z.getinfo(f'lib/{abi}/{LIB}')
                except KeyError:
                    continue
                found.append(abi)
                cost += entry_cost(z, info)
        missing = [x for x in want if x not in found]
        if missing:
            ok = False
        print(f'| {f} | {kb(size)} | {kb(size - cost)} | {kb(cost)} | {", ".join(found) or "none"}{" — MISSING " + ", ".join(missing) if missing else ""} |')
    print('\n' + ('Every APK carries the library for its ABI.' if ok else '**A library is missing from an APK (see above).**'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
