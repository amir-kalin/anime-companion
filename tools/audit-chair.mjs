/**
 * Audit a GLB prop against the character rig.
 *
 * The chair has to line up with where the sitting clip actually puts her hips.
 * Getting this wrong is very visible, so both are measured: the chair's own
 * bounds and seat height in its file's units, and the hips height the sitting
 * clip produces in the rig's normalised space.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
  // GLTFLoader reaches for `self.URL` when it resolves embedded images.
  globalThis.self = globalThis.window;
  globalThis.navigator ??= { userAgent: 'node' };
  globalThis.fetch = async () => { throw new Error('no network'); };
}
installDomShim();

const chairPath = process.argv[2];
if (!chairPath) { console.error('usage: node tools/audit-chair.mjs <chair.glb>'); process.exit(1); }

// ------------------------------------------------------------- character scale
const fbxBuf = readFileSync('public/models/character/mika.fbx');
const char = new FBXLoader().parse(
  fbxBuf.buffer.slice(fbxBuf.byteOffset, fbxBuf.byteOffset + fbxBuf.byteLength), ''
);
char.updateMatrixWorld(true);
const charBox = new THREE.Box3().setFromObject(char);
const charHeight = charBox.max.y - charBox.min.y;
const RIG = 1.62 / charHeight;                 // rig unit per FBX unit
console.log(`character: height ${charHeight.toFixed(0)} FBX units -> rig scale ${RIG.toExponential(3)}`);
console.log(`           Hips bind position: ${(() => { const h = char.getObjectByName('Hips'); const v = new THREE.Vector3(); h.getWorldPosition(v); return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`; })()}\n`);

// ------------------------------------------------------------- hips in the sit clip
const sitBuf = readFileSync('public/models/animations/sitting-talking.fbx');
const sit = new FBXLoader().parse(
  sitBuf.buffer.slice(sitBuf.byteOffset, sitBuf.byteOffset + sitBuf.byteLength), ''
);
const sitClip = sit.animations[0];

// Bind the character into a normalised rig, then sample the clip and read Hips.
const rig = new THREE.Group();
const model = sit.getObjectByName('Armature') ? char.clone() : char.clone();
rig.add(model);
model.scale.setScalar(RIG);
// ground the model exactly like CharacterRig does
model.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(model);
const hips = model.getObjectByName('Hips');
const hv = new THREE.Vector3();
hips.getWorldPosition(hv);
model.position.x -= hv.x;
model.position.y -= box.min.y;
model.position.z -= hv.z;
model.updateMatrixWorld(true);

const mixer = new THREE.AnimationMixer(rig);
const action = mixer.clipAction(sitClip);
action.play();
const samples = [];
for (let t = 0; t <= 20; t += 0.25) {
  action.paused = true;
  action.time = Math.min(t, sitClip.duration);
  mixer.update(0);
  model.updateMatrixWorld(true);
  const h = new THREE.Vector3();
  hips.getWorldPosition(h);
  const root = new THREE.Vector3();
  rig.getObjectByName('Armature')?.getWorldPosition(root);
  samples.push({ t, hipsY: h.y, hipsZ: h.z, hipsX: h.x, rootZ: root.z });
}
const ys = samples.map((s) => s.hipsY);
const zs = samples.map((s) => s.hipsZ);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log('while sitting (rig units, feet at y=0):');
console.log(`  hips height : avg ${avg(ys).toFixed(3)}  range ${Math.min(...ys).toFixed(3)}..${Math.max(...ys).toFixed(3)}`);
console.log(`  hips depth  : avg ${avg(zs).toFixed(3)}  range ${Math.min(...zs).toFixed(3)}..${Math.max(...zs).toFixed(3)}`);
console.log('  (a standing pose puts the hips near 0.95-1.0, so this is the drop)\n');

// ------------------------------------------------------------- the chair
const glbBuf = readFileSync(chairPath);
const ab = glbBuf.buffer.slice(glbBuf.byteOffset, glbBuf.byteOffset + glbBuf.byteLength);
const gltf = await new Promise((resolve, reject) => {
  new GLTFLoader().parse(ab, '', resolve, reject);
});

const chair = gltf.scene;
chair.updateMatrixWorld(true);
const cbox = new THREE.Box3().setFromObject(chair);
const csize = new THREE.Vector3();
cbox.getSize(csize);
console.log(`chair: ${chairPath}`);
console.log(`  raw bounds size : ${csize.x.toFixed(1)} x ${csize.y.toFixed(1)} x ${csize.z.toFixed(1)}`);
console.log(`  raw min         : ${cbox.min.x.toFixed(1)}, ${cbox.min.y.toFixed(1)}, ${cbox.min.z.toFixed(1)}`);
console.log(`  meshes          : ${chair.children.filter((c) => c.isMesh).length} (root children: ${chair.children.length})`);

// Seat height ~= the top surface of the seat. For a dining chair the seat is
// roughly at 45-50% of the total height; report that and the implied scale.
const rawHeight = csize.y;
const targetSeat = avg(ys);
console.log(`\n  to seat her at ${targetSeat.toFixed(3)} rig units with a ~48% seat ratio:`);
console.log(`    chair seat fraction : ${(targetSeat / (rawHeight * 0.48)).toFixed(4)}  <- scale to apply`);
console.log(`    i.e. chair scaled to ${(rawHeight * (targetSeat / (rawHeight * 0.48))).toFixed(1)} raw units tall`);

// Also try to find an actual seat by looking for a horizontal slab.
const candidates = [];
chair.traverse((o) => {
  if (!o.isMesh) return;
  o.geometry.computeBoundingBox();
  const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
  const s = new THREE.Vector3();
  b.getSize(s);
  // A seat is a wide, flat, upward-facing slab in the lower-middle.
  if (s.x > csize.x * 0.35 && s.z > csize.z * 0.3 && s.y < csize.y * 0.5 && s.y < csize.x * 0.4) {
    candidates.push({ name: o.name || '(unnamed)', top: b.max.y, size: [s.x, s.y, s.z] });
  }
});
if (candidates.length) {
  console.log('\n  possible seat slabs (top surface):');
  for (const c of candidates.slice(0, 5)) {
    console.log(`    ${c.name.padEnd(18)} top=${c.top.toFixed(1)}  size=${c.size.map((v) => v.toFixed(1)).join(' x ')}`);
    console.log(`      -> scale to seat her: ${(targetSeat / c.top).toFixed(4)}`);
  }
} else {
  console.log('\n  no obvious seat slab found; fall back to the 48% ratio');
}
