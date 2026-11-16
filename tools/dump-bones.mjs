/**
 * Dump every bone / mesh / morph name in a model.
 *
 *   node tools/dump-bones.mjs path/to/model.glb
 *
 * This exists because check-model.mjs reports THAT a binding is missing but
 * not what the file actually calls things. When swapping in a downloaded
 * model, the bone scheme is usually a different convention entirely (Mixamo
 * `Hips` vs VRM `hips` vs a game-rig `pelvis`), and the fix is a candidate
 * alias in config.js - which needs the real names to write.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
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

const p = process.argv[2];
if (!p || !existsSync(p)) {
  console.error('usage: node tools/dump-bones.mjs <model.fbx|.glb|.gltf|.vrm>');
  process.exit(2);
}

const ext = extname(p).toLowerCase();
const buf = readFileSync(p);
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = ext === '.fbx' ? null : true;
const parsed = gltf
  ? await new GLTFLoader().parseAsync(bytes, '')
  : new FBXLoader().parse(bytes, '');
const root = parsed.scene ?? parsed;

const bones = [];
const meshes = [];
root.traverse((o) => {
  if (o.isBone) bones.push(o.name);
  if (o.isMesh) {
    const n = o.morphTargetDictionary ? Object.keys(o.morphTargetDictionary).length : 0;
    meshes.push(`${o.name}  [${n} morph shape(s)]`);
  }
});

console.log(`=== ${basename(p)} ===`);
console.log(`bones: ${bones.length}   meshes: ${meshes.length}`);
console.log(`\n--- BONES ---\n${bones.join('\n')}`);
console.log(`\n--- MESHES ---\n${meshes.join('\n')}`);
console.log(`\nanimations in file: ${(parsed.animations || []).length}`);
for (const c of parsed.animations || []) console.log(`  "${c.name}"  ${c.duration.toFixed(2)}s  ${c.tracks.length} tracks`);

// Which of the app's required names exist under ANY capitalisation?
const want = {
  root: ['Hips', 'hips', 'pelvis', 'root', 'Root', 'armature'],
  head: ['Head', 'head'],
  eyeL: ['Left_eye', 'LeftEye', 'eye.L', 'leftEye'],
  eyeR: ['Right_eye', 'RightEye', 'eye.R', 'rightEye'],
};
const lower = bones.map((b) => b.toLowerCase());
console.log('\n--- CASE-INSENSITIVE MATCHES FOR REQUIRED BONES ---');
for (const [label, cands] of Object.entries(want)) {
  const hits = cands.filter((c) => lower.includes(c.toLowerCase()));
  console.log(`  ${label.padEnd(6)}: ${hits.length ? hits.join(', ') : 'none'}`);
}