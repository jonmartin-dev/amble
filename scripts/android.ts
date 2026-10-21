// The Android app: `node scripts/android.ts build` builds the device app for it, copies it into
// android/ and builds a debug APK; `node scripts/android.ts run` also installs it on the phone or
// emulator adb sees and opens it; `node scripts/android.ts release` builds the bundle (AAB) to
// upload to Google Play, signed with the upload key android/keystore.properties names. Needs a JDK
// (21) and the Android SDK, which ANDROID_HOME points at (it defaults to where Android Studio puts it).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const [command = 'build'] = process.argv.slice(2);
const win = process.platform === 'win32';
const appId = 'dev.jonmartin.amble';

const env = { ...process.env };
env.ANDROID_HOME ??=
  win ? path.join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Android/sdk') : path.join(os.homedir(), 'Android/Sdk');
// A JAVA_HOME left behind by an uninstalled JDK breaks Gradle; the java on PATH says where it lives.
if (!env.JAVA_HOME || !fs.existsSync(env.JAVA_HOME)) {
  const settings = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8', shell: win }).stderr ?? '';
  const home = /java\.home = (.+)/.exec(settings)?.[1]?.trim();
  if (!home) throw new Error('Gradle needs a JDK: install one (21) or set JAVA_HOME.');
  env.JAVA_HOME = home;
}
const adb = path.join(env.ANDROID_HOME, 'platform-tools', win ? 'adb.exe' : 'adb');

function run(cmd: string, args: string[], cwd = root, extra: Record<string, string> = {}) {
  // pnpm and gradlew are scripts on Windows, which only run through the shell.
  const shell = win && !cmd.endsWith('.exe');
  const r = spawnSync(shell && cmd.includes(' ') ? `"${cmd}"` : cmd, args, { cwd, stdio: 'inherit', shell, env: { ...env, ...extra } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// The app is served from the root of its own origin inside the app.
run('pnpm', ['build'], root, { AMBLE_BASE: '/' });
run('pnpm', ['exec', 'cap', 'sync', 'android']);
const project = path.join(root, 'android');
// By full path: Windows can be set not to run programs from the current folder.
const gradlew = path.join(project, win ? 'gradlew.bat' : 'gradlew');
if (command === 'release') {
  if (!fs.existsSync(path.join(project, 'keystore.properties'))) throw new Error('No android/keystore.properties: see docs/android.md, Releasing on Google Play.');
  run(gradlew, ['bundleRelease', '--console=plain', '-q'], project);
  console.log(`Built ${path.relative(root, path.join(project, 'app/build/outputs/bundle/release/app-release.aab'))}`);
  process.exit(0);
}
run(gradlew, ['assembleDebug', '--console=plain', '-q'], project);
const apk = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
console.log(`Built ${path.relative(root, apk)}`);

if (command === 'run') {
  const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' }).split('\n').filter((l) => /\tdevice\s*$/.test(l));
  if (devices.length === 0) throw new Error('No phone or emulator: plug one in with USB debugging on, or start an emulator.');
  run(adb, ['install', '-r', apk]);
  run(adb, ['shell', 'am', 'start', '-n', `${appId}/.MainActivity`]);
}
