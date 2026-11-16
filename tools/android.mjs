/**
 * Android helper.
 *
 * Wraps the parts of the Android toolchain that are awkward from a
 * cross-platform npm script: the Gradle wrapper is a shell script on Unix
 * and a batch file on Windows, and the JDK and the Android SDK have to be
 * found rather than assumed.
 *
 * Usage:
 *   node tools/android.mjs apk       build the debug APK
 *   node tools/android.mjs install   install it on the connected device
 *   node tools/android.mjs run       install, then launch it
 *   node tools/android.mjs logs      tail the app's logcat output
 *   node tools/android.mjs devices   list connected devices
 *
 * The APK lands in android/app/build/outputs/apk/debug/.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_ID = 'dev.anime.companion';
const ANDROID_DIR = 'android';
const SDK = process.env.ANDROID_HOME
  || process.env.ANDROID_SDK_ROOT
  || join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');

const isWindows = process.platform === 'win32';

function findJava() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const candidates = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    'C:\\Program Files\\Java',
    '/usr/lib/jvm',
  ];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (!statSync(full).isDirectory()) continue;
      if (isWindows) {
        if (existsSync(join(full, 'bin', 'java.exe'))) return full;
      } else if (existsSync(join(full, 'bin', 'java'))) {
        return full;
      }
    }
  }
  return null;
}

function adbPath() {
  const p = join(SDK, 'platform-tools', isWindows ? 'adb.exe' : 'adb');
  return existsSync(p) ? p : 'adb';
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: isWindows, ...opts });
}

function gradle(args) {
  const java = findJava();
  const env = { ...process.env, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK };
  if (java) env.JAVA_HOME = java;
  const wrapper = isWindows ? 'gradlew.bat' : './gradlew';
  return spawnSync(wrapper, args, {
    cwd: ANDROID_DIR,
    stdio: 'inherit',
    shell: isWindows,
    env,
  });
}

/** The newest debug APK, so the install step does not hardcode a version. */
function findApk() {
  const dir = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug');
  if (!existsSync(dir)) return null;
  const apks = readdirSync(dir).filter((f) => f.endsWith('.apk'));
  if (!apks.length) return null;
  // Newest first: the build appends a version suffix when it cannot
  // overwrite, so the timestamp is the honest ordering.
  apks.sort((a, b) =>
    statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, apks[0]);
}

function devices() {
  const r = spawnSync(adbPath(), ['devices'], { encoding: 'utf8', shell: isWindows });
  const lines = (r.stdout || '').split(/\r?\n/).slice(1);
  return lines
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0]);
}

const cmd = process.argv[2] || 'apk';

switch (cmd) {
  case 'apk': {
    const r = gradle(['assembleDebug', '--no-daemon']);
    if (r.status !== 0) process.exit(r.status ?? 1);
    const apk = findApk();
    console.log(`\nAPK: ${apk}`);
    if (apk) console.log(`     ${(statSync(apk).size / 1024 / 1024).toFixed(1)} MB`);
    break;
  }

  case 'devices': {
    const list = devices();
    console.log(list.length ? list.join('\n') : 'no devices connected');
    break;
  }

  case 'install':
  case 'run': {
    const list = devices();
    if (!list.length) {
      console.error('No device connected. Start an emulator, or plug in a phone with USB debugging on.');
      process.exit(1);
    }
    const apk = findApk();
    if (!apk) {
      console.error('No APK found. Run: node tools/android.mjs apk');
      process.exit(1);
    }
    for (const serial of list) {
      console.log(`installing on ${serial}...`);
      const r = run(adbPath(), ['-s', serial, 'install', '-r', '-d', apk]);
      if (r.status !== 0) {
        console.error(`install failed on ${serial}`);
        process.exit(r.status ?? 1);
      }
      if (cmd === 'run') {
        run(adbPath(), ['-s', serial, 'shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
        console.log('launched');
      }
    }
    break;
  }

  case 'logs': {
    const r = run(adbPath(), ['logcat', '-v', 'time', 'WebView', 'Capacitor', 'chromium', '*:S']);
    void r;
    break;
  }

  default:
    console.error(`Unknown command "${cmd}". Try: apk | install | run | logs | devices`);
    process.exit(1);
}

export { spawn };
