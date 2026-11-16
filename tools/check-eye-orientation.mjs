/**
 * Why do the eyes only look right in IDLE?
 *
 * The character rig carries two eye-bone pairs (Left_eye/Right_eye and
 * LeftEye/RightEye) and all three Mixamo clips animate both. If a clip's eye
 * tracks were authored against a different rest orientation, the mixer writes
 * absolute quaternions and the eyeballs end up rolled. This measures the
 * actual rotation each clip asks for, relative to the bind pose, so the fix is
 * based on evidence rather than guesswork.
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

const EYES = ['Left_eye', 'Right_eye', 'LeftEye', 'RightEye'];
const D = 180 / Math.PI;

// Bind-pose quaternions from the character (the "correct" eye orientation).
const model = load('public/models/character/mika.fbx');
const bind = {};
for (const name of EYES) {
  const b = model.getObjectByName(name);
  bind[name] = b ? b.quaternion.clone() : null;
}

console.log('=== per-clip eye rotation relative to BIND pose (degrees) ===\n');

for (const state of ['idle', 'talking', 'bored']) {
  const g = load(`public/models/animations/${state}.fbx`);
  const clip = g.animations[0];
  console.log(`--- ${state}`);

  for (const eye of EYES) {
    const track = clip.tracks.find((t) => t.name === `${eye}.quaternion`);
    if (!track) { console.log(`    ${eye.padEnd(11)} no track`); continue; }

    // Decode the quaternion track at a few times and compare to bind.
    const times = track.times;
    const vals = track.values;
    const nKeys = times.length;
    let worst = 0;
    let worstT = 0;
    const samples = [];
    const q = new THREE.Quaternion();
    const rel = new THREE.Quaternion();
    const e = new THREE.Euler();

    const probeTs = [0, 0.25, 0.5, 0.75, 1].map((f) => times[Math.min(nKeys - 1, Math.floor(f * (nKeys - 1)))]);

    for (const t of probeTs) {
      // find keyframe
      let i = 0;
      while (i < nKeys - 1 && times[i + 1] <= t) i++;
      const span = times[i + 1] - times[i] || 1;
      const a = (t - times[i]) / span;
      // slerp between key i and i+1
      const q0 = new THREE.Quaternion(vals[i * 4], vals[i * 4 + 1], vals[i * 4 + 2], vals[i * 4 + 3]);
      const q1 = new THREE.Quaternion(vals[(i + 1) * 4], vals[(i + 1) * 4 + 1], vals[(i + 1) * 4 + 2], vals[(i + 1) * 4 + 3]);
      q.copy(q0).slerp(q1, Math.max(0, Math.min(1, a)));
      if (bind[eye]) {
        rel.copy(bind[eye]).invert().multiply(q);
        e.setFromQuaternion(rel, 'YXZ');
        const mag = Math.hypot(e.x, e.y, e.z) * D;
        if (mag > worst) { worst = mag; worstT = t; }
        if (samples.length < 3) samples.push([+t.toFixed(2), +(e.x * D).toFixed(1), +(e.y * D).toFixed(1), +(e.z * D).toFixed(1)]);
      }
    }
    const isIdentity = nKeys === 1 && Math.abs(vals[0] - bind[eye]?.x ?? 0) < 1e-6;
    console.log(
      `    ${eye.padEnd(11)} keys=${String(nKeys).padEnd(4)} worstRelAngle=${worst.toFixed(1)}deg @t=${worstT.toFixed(2)}s  samples(x,y,z)=${JSON.stringify(samples)}`
    );
  }
  console.log();
}

// Also: is the eye mesh actually skinned to Left_eye / LeftEye?
console.log('=== skin weights: which bones drive the eye vertices? ===');
const mesh = model.children.find((c) => c.isMesh) || (() => { let m = null; model.traverse(o => { if (o.isMesh) m = o; }); return m; })();
const eyeIndices = EYES.map((n) => {
  const b = model.getObjectByName(n);
  return b ? b.index : -1;
});
console.log('  mesh:', mesh?.name, ' bone indices for eyes:', eyeIndices.join(', '));

if (mesh?.skeleton) {
  const bones = mesh.skeleton.bones;
  const tracked = new Map();
  mesh.geometry.attributes.skinIndex && mesh.geometry.attributes.position && (() => {
    const si = mesh.geometry.attributes.skinIndex;
    const pos = mesh.geometry.attributes.position;
    // vertices near the front of the head
    const count = Math.min(pos.count, 20000);
    for (let i = 0; i < count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (z < 100 || z > 260) continue;      // eye depth band
      if (y < 1850 || y > 2060) continue;    // eye height band
      for (let k = 0; k < 4; k++) {
        const bi = si.getX(i, k);
        const bone = bones[bi];
        if (!bone) continue;
        if (!tracked.has(bone.name)) tracked.set(bone.name, 0);
        tracked.set(bone.name, tracked.get(bone.name) + 1);
      }
    }
  })();
  const top = [...tracked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('  top bones weighting eye-region vertices:');
  for (const [n, c] of top) console.log(`    ${n.padEnd(20)} ${c}`);
}
