# A small IPA for the installer test: binary Info.plist, an icon, a provisioning profile (ad hoc, expired), an
# extension and a framework.
import zipfile, plistlib, sys, struct, zlib, datetime
out = sys.argv[1]
def png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
info = {'CFBundleDisplayName': 'Demo Reader', 'CFBundleIdentifier': 'app.kurokawa.demo', 'CFBundleShortVersionString': '1.4.2', 'CFBundleVersion': '142', 'MinimumOSVersion': '15.0', 'UIDeviceFamily': [1, 2], 'CFBundleExecutable': 'Demo',
        'CFBundleIcons': {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['AppIcon60x60']}}, 'NSCameraUsageDescription': 'To scan pages', 'NSPhotoLibraryUsageDescription': 'To save pictures'}
prof = {'Name': 'Demo AdHoc', 'TeamName': 'Kurokawa Team', 'ExpirationDate': datetime.datetime(2020, 1, 1), 'ProvisionedDevices': ['a', 'b', 'c'], 'Entitlements': {'get-task-allow': False}}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('Payload/Demo.app/Info.plist', plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
    z.writestr('Payload/Demo.app/AppIcon60x60@2x.png', png(120, 120, (200, 40, 60)))
    z.writestr('Payload/Demo.app/AppIcon60x60@3x.png', png(180, 180, (40, 120, 200)))
    z.writestr('Payload/Demo.app/embedded.mobileprovision', b'\x30\x82CMSJUNK' + plistlib.dumps(prof) + b'\x00SIGNATURE')
    z.writestr('Payload/Demo.app/_CodeSignature/CodeResources', b'x')
    z.writestr('Payload/Demo.app/Demo', b'\xcf\xfa\xed\xfe' + b'\x00' * 4000)
    z.writestr('Payload/Demo.app/PlugIns/Widget.appex/Info.plist', plistlib.dumps({'CFBundleIdentifier': 'app.kurokawa.demo.widget'}))
    z.writestr('Payload/Demo.app/Frameworks/Kit.framework/Kit', b'x' * 100)
