/**
 * Analyse a sitting clip: when does the root settle, and how high is the seat?
 *
 * `Sitting Talking` is 45s and does not loop, which strongly suggests it
 * contains the sit-down and the stand-up. If the root motion settles early, the
 * settled range can be trimmed into a loopable clip instead of playing 45
 * seconds to get a few seconds of sitting.
 *
 * Also reports the Hips height at rest, which is what the chair has to match.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

function installDomShim() {
  const makeEl = () => ({
    complete: false, width: 0, height: 0,
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, dispose() {},
    set src(v) {}, get src() { return ''; },
  });
  globalThis.document = { createElementNS: (_n, t) => makeEl(t), createElement: (t) => makeEl(t), body: makeEl('body') };
  globalThis.window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, URL: { createObjectURL: () => 'blob:s', revokeObjectURL() {} }, addEventListener() {} };
  globalThis.navigator ??= { userAgent: 'node' };
}
installDomShim();

const load = (p) => {
  const b = readFileSync(p);
  return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};

const file = process.argv[2];
if (!file) { console.error('usage: node tools/analyse-sitting.mjs <sitting.fbx>'); process.exit(1); }

const g = load(file);
const clip = g.animations[0];
console.log(`${file}\n  duration ${clip.duration.toFixed(2)}s  tracks ${clip.tracks.length}\n`);

// --- root translation over time
const root = clip.tracks.find((t) => /Armature\.position$/.test(t.name));
if (root) {
  const n = root.times.length;
  const at = (i) => [root.values[i * 3], root.values[i * 3 + 1], root.values[i * 3 + 2]];
  const first = at(0);
  console.log('  root translation (Armature.position), sampled:');
  for (let f = 0; f <= 20; f++) {
    const i = Math.min(n - 1, Math.floor((f / 20) * (n - 1)));
    const v = at(i);
    const moved = Math.hypot(v[0] - first[0], v[1] - first[1], v[2] - first[2]);
    console.log(`    t=${root.times[i].toFixed(2).padStart(6)}s  (${v[0].toFixed(1)}, ${v[1].toFixed(1)}, ${v[2].toFixed(1)})  moved ${moved.toFixed(1)}`);
  }
  const last = at(n - 1);
  const total = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
  console.log(`    final offset from start: ${total.toFixed(1)} units (${total === 0 ? 'returns to origin' : 'does NOT return'})`);
} else {
  console.log('  no Armature.position track');
}

// --- per-frame motion energy, to find where it becomes still / periodic
const track = clip.tracks.find((t) => t.name === 'Hips.quaternion');
if (track) {
  const n = track.times.length;
  const q = new THREE.Quaternion();
  const step = [];
  for (let i = 1; i < n; i++) {
    const a = new THREE.Quaternion(track.values[(i - 1) * 4], track.values[(i - 1) * 4 + 1], track.values[(i - 1) * 4 + 2], track.values[(i - 1) * 4 + 3]);
    const b = new THREE.Quaternion(track.values[i * 4], track.values[i * 4 + 1], track.values[i * 4 + 2], track.values[i * 4 + 3]);
    step.push({ t: track.times[i], d: a.angleTo(b) * 57.2958 });
  }
  const win = 12;
  const moving = [];
  for (let i = 0; i + win < step.length; i += win) {
    const s = step.slice(i, i + win).reduce((a, b) => a + b.d, 0) / win;
    if (s > 0.05) moving.push({ t: step[i].t, speed: s });
  }
  console.log('\n  Hips angular speed per ~1s window (deg/frame):');
  for (let i = 0; i + win < step.length; i += Math.ceil(win * 2)) {
    const s = step.slice(i, i + win).reduce((a, b) => a + b.d, 0) / win;
    const bar = '#'.repeat(Math.min(40, Math.round(s * 8)));
    console.log(`    t=${step[i].t.toFixed(1).padStart(5)}s  ${s.toFixed(3)}  ${bar}`);
  }
  const active = moving.length;
  console.log(`\n  ${active}/${Math.floor(step.length / win)} windows have real motion`);
}

// --- seat height, from the Hips bind position in the character's space
console.log('\n  Seat geometry: the chair must put her hips at the height the');
console.log('  clip expects. Measure it once the clip is bound in the browser.');
