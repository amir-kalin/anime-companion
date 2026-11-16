/**
 * Measure the baked hip height of EACH sitting clip, in rig units.
 *
 * The chair fitting depends on this number, and it was originally taken from
 * sitting-talking only. If sitting-idle parks the hips higher or lower, a
 * single constant makes one of the two states visibly float or sink. This
 * reports both, plus the spread across the clip, so the constant can be checked
 * against reality rather than assumed.
 *
 * Run: node tools/measure-sit-hips.mjs
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const TARGET_HEIGHT = 1.62;

function installDomShim() {
  const makeEl = () => ({
    complete: false, width: 0, height: 0,
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, dispose() {},
    set src(v) {}, get src() { return ''; },
  });
  globalThis.document = { createElementNS: (_n, t) => makeEl(t), createElement: (t) => makeEl(t), body: makeEl('body') };
  globalThis.window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, URL: { createObjectURL: () => 'blob:s', revokeObjectURL() {} }, addEventListener() {} };
  globalThis.self = globalThis.window;
  globalThis.navigator ??= { userAgent: 'node' };
}
installDomShim();

const load = (p) => {
  const b = readFileSync(p);
  return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};

// Ground the character exactly like CharacterRig._normalise does, then play the
// clip and read Hips in world space.
function buildGrounded() {
  const char = load('public/models/character/mika.fbx');
  const rig = new THREE.Group();
  rig.add(char);
  char.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(char);
  const scale = TARGET_HEIGHT / (raw.max.y - raw.min.y);
  char.scale.setScalar(scale);
  char.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(char);
  const hips = char.getObjectByName('Hips');
  const hp = new THREE.Vector3();
  hips.getWorldPosition(hp);
  char.position.x -= hp.x;
  char.position.y -= box.min.y;
  char.position.z -= hp.z;
  char.updateMatrixWorld(true);
  return { rig, char, hips };
}

function measure(clipPath) {
  const clipFbx = load(clipPath);
  const clip = clipFbx.animations[0];
  const { rig, char, hips } = buildGrounded();

  const mixer = new THREE.AnimationMixer(rig);
  const action = mixer.clipAction(clip);
  action.play();

  const v = new THREE.Vector3();
  const ys = [];
  const zs = [];
  const steps = Math.max(60, Math.ceil(clip.duration * 30));
  for (let i = 0; i <= steps; i++) {
    action.paused = true;
    action.time = (i / steps) * clip.duration;
    mixer.update(0);
    char.updateMatrixWorld(true);
    hips.getWorldPosition(v);
    ys.push(v.y);
    zs.push(v.z);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    duration: clip.duration,
    hipsY: { avg: avg(ys), min: Math.min(...ys), max: Math.max(...ys) },
    hipsZ: { avg: avg(zs), min: Math.min(...zs), max: Math.max(...zs) },
  };
}

for (const [label, path] of [
  ['sitting-idle   ', 'public/models/animations/sitting-idle.fbx'],
  ['sitting-talking', 'public/models/animations/sitting-talking.fbx'],
]) {
  const m = measure(path);
  console.log(`${label}  ${m.duration.toFixed(2)}s`);
  console.log(`  hips Y  avg ${m.hipsY.avg.toFixed(4)}  range ${m.hipsY.min.toFixed(4)}..${m.hipsY.max.toFixed(4)}  (${((m.hipsY.max - m.hipsY.min) * 1000).toFixed(1)}mm of bob)`);
  console.log(`  hips Z  avg ${m.hipsZ.avg.toFixed(4)}  range ${m.hipsZ.min.toFixed(4)}..${m.hipsZ.max.toFixed(4)}`);
  console.log(`  as fraction of 1.62 standing height: ${(m.hipsY.avg / TARGET_HEIGHT).toFixed(3)}`);
}
