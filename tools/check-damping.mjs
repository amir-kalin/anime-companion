/**
 * Check which bones the BoneDamping layer will actually match.
 *
 * Verifies that the BONE_DAMPING prefixes in config.js match real bone names
 * in the model, and reports what fraction of hand/finger bones are covered.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODEL, BONE_DAMPING } from '../src/utils/config.js';

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

const modelPath = `public/${MODEL.url}`;
if (!existsSync(modelPath)) {
  console.error(`model missing: ${modelPath}`);
  process.exit(2);
}

const buf = readFileSync(modelPath);
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new GLTFLoader().parseAsync(bytes, '');
const root = gltf.scene ?? gltf;

const boneNames = [];
root.traverse((o) => { if (o.isBone) boneNames.push(o.name); });

console.log(`Model: ${MODEL.url}  (${boneNames.length} bones)\n`);

// Check which prefixes match which bones.
let totalMatched = 0;
let totalHandLike = 0;

for (const group of BONE_DAMPING) {
  const matches = boneNames.filter((n) => n.toLowerCase().startsWith(group.prefix.toLowerCase()));
  totalMatched += matches.length;
  if (matches.length) {
    console.log(`  "${group.prefix}" (${group.factor}) -> ${matches.length} bones: ${matches.slice(0, 4).join(', ')}${matches.length > 4 ? ', …' : ''}`);
  } else {
    console.log(`  "${group.prefix}" (${group.factor}) -> NO MATCHES`);
  }
}

// Count all hand-like bones for coverage.
const handLike = boneNames.filter((n) => {
  const l = n.toLowerCase();
  return l.includes('hand') || l.includes('index') || l.includes('middle') ||
         l.includes('ring') || l.includes('pinky') || l.includes('thumb');
});
totalHandLike = handLike.length;

console.log(`\nMatched ${totalMatched} of ${totalHandLike} hand-like bones`);
if (totalMatched === 0) {
  console.error('\nERROR: No bones matched. The BONE_DAMPING prefixes do not match this model\'s bone names.');
  console.error('Hand-like bone names in the model:');
  for (const n of handLike) console.error(`  ${n}`);
  process.exit(1);
} else if (totalMatched < totalHandLike * 0.5) {
  console.warn('\nWARNING: Less than half of hand-like bones are covered.');
  const unmatched = handLike.filter((n) => {
    const l = n.toLowerCase();
    return !BONE_DAMPING.some((g) => l.startsWith(g.prefix.toLowerCase()));
  });
  console.warn('Unmatched:');
  for (const n of unmatched) console.warn(`  ${n}`);
}
