/**
 * Targeted rig probe: eye bones and root motion.
 *
 * The character carries TWO pairs of eye bones (Left_eye/Right_eye and
 * LeftEye/RightEye). Saccades and blinks need to target the right one, and
 * Mixamo clips frequently animate Hips translation, which would slide the
 * character out of frame. Both are answered here rather than guessed.
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

const model = load('public/models/character/mika.fbx');

console.log('=== HEAD HIERARCHY (eye candidates) ===');
const head = model.getObjectByName('Head');
if (head) {
  const dump = (n, d = 0) => {
    const wp = new THREE.Vector3(); n.getWorldPosition(wp);
    console.log('  '.repeat(d + 1) + `${n.name}  type=${n.type}  worldPos=(${wp.x.toFixed(3)}, ${wp.y.toFixed(3)}, ${wp.z.toFixed(3)})`);
    n.children.filter((c) => c.isBone).forEach((c) => dump(c, d + 1));
  };
  dump(head);
} else console.log('  no Head bone');

console.log('\n=== WORLD POSITIONS OF ALL *_eye* BONES ===');
const eyeBones = [];
model.traverse((o) => { if (o.isBone && /eye/i.test(o.name)) eyeBones.push(o); });
for (const b of eyeBones) {
  const wp = new THREE.Vector3(); b.getWorldPosition(wp);
  const lp = b.position;
  console.log(`  ${b.name.padEnd(14)} parent=${(b.parent?.name || '-').padEnd(12)} children=${b.children.length}  local=(${lp.x.toFixed(3)},${lp.y.toFixed(3)},${lp.z.toFixed(3)})  world=(${wp.x.toFixed(3)},${wp.y.toFixed(3)},${wp.z.toFixed(3)})`);
}
const headWp = new THREE.Vector3(); head?.getWorldPosition(headWp);
console.log(`  Head world=(${headWp.x.toFixed(3)},${headWp.y.toFixed(3)},${headWp.z.toFixed(3)})`);

console.log('\n=== ROOT MOTION CHECK (Hips translation per clip) ===');
for (const p of ['idle', 'talking', 'bored']) {
  const a = load(`public/models/animations/${p}.fbx`);
  const clip = a.animations[0];
  const hips = clip.tracks.filter((t) => t.name.endsWith('.bones.Hips.position') || t.name === '.bones.Hips.position');
  if (!hips.length) { console.log(`  ${p}: no Hips position track`); continue; }
  for (const t of hips) {
    const vals = [];
    for (let i = 0; i < t.values.length; i += 3) vals.push(new THREE.Vector3(t.values[i], t.values[i + 1], t.values[i + 2]));
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const v of vals) { min.min(v); max.max(v); }
    console.log(`  ${p.padEnd(8)} Hips  x:[${min.x.toFixed(3)},${max.x.toFixed(3)}]  y:[${min.y.toFixed(3)},${max.y.toFixed(3)}]  z:[${min.z.toFixed(3)},${max.z.toFixed(3)}]  (delta y=${(max.y - min.y).toFixed(3)})`);
  }
}

console.log('\n=== MODEL BOUNDS / GROUNDING ===');
const box = new THREE.Box3().setFromObject(model);
console.log(`  min=(${box.min.x.toFixed(3)}, ${box.min.y.toFixed(3)}, ${box.min.z.toFixed(3)})`);
console.log(`  max=(${box.max.x.toFixed(3)}, ${box.max.y.toFixed(3)}, ${box.max.z.toFixed(3)})`);
console.log(`  height=${(box.max.y - box.min.y).toFixed(3)}  centerY=${((box.max.y + box.min.y) / 2).toFixed(3)}`);
