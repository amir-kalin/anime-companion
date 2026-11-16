/**
 * Does a freshly downloaded Mixamo clip actually bind to this model?
 *
 *   node tools/test-mixamo-retarget.mjs
 *
 * The existing six clips were authored against a cleaned-up rig naming
 * (`Left_arm`, `Left_knee`, `Left_wrist`). A NEW download from Mixamo comes
 * out differently, in two ways that both silently bind 0%:
 *
 *   1. every bone is namespaced - `mixamorig:Hips`, not `Hips`
 *   2. the anatomical names differ - `LeftForeArm`, not `Left_elbow`
 *
 * Nothing about that failure is visible at runtime: the clip reports as
 * playing, no error is logged, and she stands in her bind pose. So rather
 * than assume the mapping covers it, this builds clips in BOTH conventions
 * from the model's real bone list and asserts every track gets rewritten.
 */
import * as THREE from 'three';
import { retargetClip } from '../src/animation/retarget.js';
import { MODEL } from '../src/utils/config.js';
import { readFileSync, existsSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

function installDomShim() {
  const makeEl = () => {
    const h = {};
    return {
      complete: false, width: 1, height: 1,
      addEventListener(t, f) { (h[t] ||= []).push(f); },
      removeEventListener() {}, setAttribute() {}, getAttribute() { return null; }, dispose() {},
      set src(v) {
        queueMicrotask(() => {
          for (const f of h.load || []) f({ target: this });
          if (typeof this.onload === 'function') this.onload({ target: this });
        });
      },
      get src() { return ''; }, onload: null,
    };
  };
  globalThis.document = { createElementNS: (_n, t) => makeEl(), createElement: (t) => makeEl(), body: makeEl() };
  globalThis.window = {
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    URL: { createObjectURL: () => 'blob:s', revokeObjectURL() {} }, addEventListener() {},
  };
  globalThis.navigator ??= { userAgent: 'node' };
  globalThis.self ??= globalThis;
}
installDomShim();

// ---------------------------------------------------------------- the model
const path = `public/${MODEL.url}`;
if (!existsSync(path)) {
  console.error(`model not found: ${path}`);
  process.exit(2);
}
const buf = readFileSync(path);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''
);
const modelBones = new Set();
gltf.scene.traverse((o) => { if (o.isBone) modelBones.add(o.name); });
console.log(`model: ${MODEL.url}  (${modelBones.size} bones)\n`);

// ------------------------------------------------------------- build clips
/** A 2-key rotation track, which is all the binding logic looks at. */
const rotTrack = (bone) =>
  new THREE.KeyframeTrack(`${bone}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1], THREE.InterpolateLinear);

const CONVENTIONS = {
  'existing clips (Left_arm / Left_knee)': [
    'Hips', 'Spine', 'Chest', 'Neck', 'Head',
    'Left_shoulder', 'Left_arm', 'Left_elbow', 'Left_wrist',
    'Right_shoulder', 'Right_arm', 'Right_elbow', 'Right_wrist',
    'Left_Leg', 'Left_knee', 'Left_ankle', 'Left_toe',
    'Right_Leg', 'Right_knee', 'Right_ankle', 'Right_toe',
    'Left_eye', 'Right_eye',
    'Index_finger_L', 'Index_finger_L001',
  ],
  'fresh Mixamo (mixamorig:LeftForeArm)': [
    'mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2',
    'mixamorig:Neck', 'mixamorig:Head',
    'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand',
    'mixamorig:RightShoulder', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand',
    'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase',
    'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot', 'mixamorig:RightToeBase',
  ],
};

let failures = 0;
for (const [label, bones] of Object.entries(CONVENTIONS)) {
  const clip = new THREE.AnimationClip('test', 1, bones.map(rotTrack));
  const { clip: out, rewritten, unmapped } = retargetClip(clip, modelBones);

  const pct = (rewritten / bones.length) * 100;
  const pass = rewritten === bones.length;
  if (!pass) failures++;

  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      ${rewritten}/${bones.length} tracks retargeted (${pct.toFixed(0)}%)`);
  if (unmapped.length) console.log(`      unmapped: ${unmapped.join(', ')}`);

  // Every rewritten track must now name a bone that exists on the model.
  const bad = out.tracks.map((t) => t.name.replace(/\.[^.]+$/, '')).filter((n) => !modelBones.has(n));
  if (bad.length) {
    failures++;
    console.log(`      ERROR: ${bad.length} rewritten track(s) still name a missing bone: ${bad.slice(0, 5).join(', ')}`);
  }
  console.log(`      sample: ${bones[0]}.quaternion -> ${out.tracks[0].name}`);
  console.log('');
}

// The mapping must not touch the ORIGINAL model, where names match directly.
const mikaPath = 'public/models/character/mika.fbx';
if (existsSync(mikaPath)) {
  console.log('--- regression: original model must be left alone ---');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const mb = readFileSync(mikaPath);
  const fbx = new FBXLoader().parse(mb.buffer.slice(mb.byteOffset, mb.byteOffset + mb.byteLength), '');
  const mikaBones = new Set();
  fbx.traverse((o) => { if (o.isBone) mikaBones.add(o.name); });

  const clip = new THREE.AnimationClip('mika', 1, ['Hips', 'Head', 'Left_arm', 'Left_knee'].map(rotTrack));
  const { clip: out, rewritten } = retargetClip(clip, mikaBones);
  const untouched = out === clip && rewritten === 0;
  if (!untouched) failures++;
  console.log(`${untouched ? 'PASS' : 'FAIL'}  mika.fbx clips are not rewritten (${rewritten} rewritten)`);
  console.log('');
}

console.log(failures === 0 ? 'VERDICT: both conventions bind to this model' : `VERDICT: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);