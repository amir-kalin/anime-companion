/**
 * Does each clip loop seamlessly?
 *
 * A looping clip pops visibly unless its last keyframe matches its first. A
 * 3.3s pop matches the reported "her neck snaps every 3 seconds", and the idle
 * clip is 3.30s long, so this checks first-vs-last keyframes per bone.
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

const D = 180 / Math.PI;

for (const name of ['idle', 'talking', 'bored', 'jinx-idle', 'jinx-talking', 'jinx-talking-alt']) {
  const g = load(`public/models/animations/${name}.fbx`);
  const clip = g.animations[0];
  const dur = clip.duration;

  console.log(`\n=== ${name}  duration=${dur.toFixed(3)}s  tracks=${clip.tracks.length}`);

  const rows = [];
  for (const t of clip.tracks) {
    const n = t.times.length;
    if (n < 2) continue;
    const first = t.values.slice(0, t.values.length / n);
    const last = t.values.slice(t.values.length - t.values.length / n);
    let diff;
    if (t.isQuaternionKeyframedTrack) {
      const qa = new THREE.Quaternion(...first);
      const qb = new THREE.Quaternion(...last);
      diff = qa.angleTo(qb) * D;
    } else {
      let m = 0;
      for (let i = 0; i < first.length; i++) m = Math.max(m, Math.abs(first[i] - last[i]));
      diff = m;
    }
    // also the actual time step across the seam
    rows.push({ bone: t.name, diff, lastTime: t.times[n - 1], stepAfter: dur - t.times[n - 1] });
  }

  rows.sort((a, b) => b.diff - a.diff);
  console.log('  worst loop-seam mismatches (first keyframe vs last keyframe):');
  for (const r of rows.slice(0, 8)) {
    console.log(`    ${r.bone.padEnd(26)} delta=${r.diff.toFixed(3)}  lastKeyAt=${r.lastTime.toFixed(3)}s  gapToEnd=${r.stepAfter.toFixed(3)}s`);
  }
  const seamless = rows.filter((r) => r.diff < 0.5).length;
  console.log(`  -> ${seamless}/${rows.length} tracks within 0.5deg/0.5units of seamless`);
}
