// The screen translator's accessibility service, declared in the manifest of the «-a11y» build only (Play Protect
// blocks an app installed from a file that declares one). Run on a prepared Android project (after overlay.mjs) to
// turn it into the a11y variant: `node native/android/a11y.mjs`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
export const A11Y_SERVICE = `    <service android:name=".KtScreenA11y" android:exported="false" android:label="@string/kt_screen_a11y_label" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
      <intent-filter><action android:name="android.accessibilityservice.AccessibilityService" /></intent-filter>
      <meta-data android:name="android.accessibilityservice" android:resource="@xml/kt_screen_a11y" />
    </service>
`;
if (process.argv[1] && path.basename(process.argv[1]) === 'a11y.mjs') {
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  const file = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  let m = await fs.readFile(file, 'utf8');
  if (!m.includes('KtScreenA11y')) { m = m.replace('</application>', A11Y_SERVICE + '  </application>'); await fs.writeFile(file, m); console.log('a11y: service declared'); } else console.log('a11y: already declared');
}
