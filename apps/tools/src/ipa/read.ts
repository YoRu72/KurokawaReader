// An iOS app package (.ipa) read where it lies: its name, bundle identifier, version and build, the iOS it needs,
// the devices it is for, its icon, what it asks to use (the «…UsageDescription» lines iOS shows), its
// extensions and frameworks, and how it is signed (the provisioning profile inside: who, until when, for
// which devices — or none: then it is to be signed on the phone by SideStore, AltStore or the like).
import { zipEntries, zipRead, type ZipEntry } from './zip';
import { parsePlist, type PValue } from './plist';

export interface IpaProfile { name?: string; team?: string; expires?: Date; devices?: number; allDevices?: boolean; debug?: boolean; kind: 'development' | 'ad-hoc' | 'enterprise' | 'app-store' | 'unknown' }
export interface IpaInfo { name: string; bundleId: string; version: string; build: string; minOS?: string; devices: ('iPhone' | 'iPad' | 'Mac' | 'Vision')[]; size: number; unpacked: number; icon?: Blob; uses: { key: string; text: string }[]; extensions: string[]; frameworks: number; profile?: IpaProfile; signed: boolean; executable?: string }

const obj = (v: PValue | undefined): Record<string, PValue> => (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Date) ? v as Record<string, PValue> : {});
const str = (v: PValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** The icon's file names Info.plist gives (the iPhone's and the iPad's), largest last. */
function iconNames(p: Record<string, PValue>): string[] {
  const out: string[] = [];
  for (const k of ['CFBundleIcons', 'CFBundleIcons~ipad']) { const files = obj(obj(p[k]).CFBundlePrimaryIcon).CFBundleIconFiles; if (Array.isArray(files)) out.push(...files.map(str)); }
  const flat = p.CFBundleIconFiles; if (Array.isArray(flat)) out.push(...flat.map(str));
  if (typeof p.CFBundleIconFile === 'string') out.push(p.CFBundleIconFile);
  return out.filter(Boolean);
}

export async function readIpa(file: Blob): Promise<IpaInfo> {
  const all = await zipEntries(file);
  const plistE = all.find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/i.test(e.name)); if (!plistE) throw new Error('notIpa');
  const appDir = plistE.name.slice(0, plistE.name.length - 'Info.plist'.length);
  const p = obj(parsePlist(await zipRead(file, plistE)));
  const fam = Array.isArray(p.UIDeviceFamily) ? p.UIDeviceFamily.map(Number) : [1];
  const devices = [...new Set(fam.map((n) => (n === 1 ? 'iPhone' : n === 2 ? 'iPad' : n === 6 ? 'Mac' : n === 7 ? 'Vision' : 'iPhone')))] as IpaInfo['devices'];
  const uses = Object.entries(p).filter(([k, v]) => /UsageDescription$/.test(k) && typeof v === 'string').map(([k, v]) => ({ key: k.replace(/^NS|UsageDescription$/g, '').replace(/([a-z])([A-Z])/g, '$1 $2'), text: v as string }));
  const inApp = (e: ZipEntry) => e.name.startsWith(appDir);
  const extensions = [...new Set(all.filter((e) => inApp(e) && /\/PlugIns\/[^/]+\.appex\//.test(e.name)).map((e) => /PlugIns\/([^/]+)\.appex\//.exec(e.name)![1]))];
  const frameworks = new Set(all.filter((e) => inApp(e) && /\/Frameworks\/[^/]+\.(framework|dylib)/.test(e.name)).map((e) => /Frameworks\/([^/]+)/.exec(e.name)![1])).size;
  // The icon: the largest PNG among the names Info.plist gives (any of their @2x/@3x files).
  let icon: Blob | undefined;
  const names = iconNames(p);
  const pngs = all.filter((e) => e.name.startsWith(appDir) && !e.name.slice(appDir.length).includes('/') && /\.png$/i.test(e.name) && (names.some((n) => e.name.slice(appDir.length).startsWith(n)) || /^AppIcon/i.test(e.name.slice(appDir.length))));
  const best = pngs.sort((a, b) => b.usize - a.usize)[0];
  if (best && best.usize < 4 << 20) { try { icon = new Blob([(await zipRead(file, best)) as Uint8Array<ArrayBuffer>], { type: 'image/png' }); } catch { /* none */ } }
  // How it is signed: the profile inside (its XML plist, inside a CMS envelope).
  let profile: IpaProfile | undefined;
  const provE = all.find((e) => e.name === `${appDir}embedded.mobileprovision`);
  if (provE) {
    try {
      const raw = new TextDecoder('latin1').decode(await zipRead(file, provE, 1 << 20)); const a = raw.indexOf('<?xml'), b = raw.indexOf('</plist>');
      if (a >= 0 && b > a) {
        const pp = obj(parsePlist(new TextEncoder().encode(raw.slice(a, b + 8)))); const ent = obj(pp.Entitlements);
        const devicesList = Array.isArray(pp.ProvisionedDevices) ? pp.ProvisionedDevices.length : undefined; const allDevices = pp.ProvisionsAllDevices === true;
        const debug = ent['get-task-allow'] === true;
        profile = { name: str(pp.Name), team: str(pp.TeamName), expires: pp.ExpirationDate instanceof Date ? pp.ExpirationDate : undefined, devices: devicesList, allDevices, debug, kind: allDevices ? 'enterprise' : devicesList !== undefined ? (debug ? 'development' : 'ad-hoc') : 'app-store' };
      }
    } catch { profile = { kind: 'unknown' }; }
  }
  const signed = !!provE || all.some((e) => e.name === `${appDir}_CodeSignature/CodeResources`);
  return { name: str(p.CFBundleDisplayName) || str(p.CFBundleName) || str(p.CFBundleExecutable), bundleId: str(p.CFBundleIdentifier), version: str(p.CFBundleShortVersionString), build: str(p.CFBundleVersion), minOS: str(p.MinimumOSVersion) || undefined, devices, size: file.size, unpacked: all.reduce((n, e) => n + e.usize, 0), icon, uses, extensions, frameworks, profile, signed, executable: str(p.CFBundleExecutable) || undefined };
}
