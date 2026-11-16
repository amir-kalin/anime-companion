/** Report the model's materials so MATERIALS presets in config.js match reality. */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const makeEl = () => ({
  complete: false, width: 0, height: 0,
  addEventListener() {}, removeEventListener() {},
  setAttribute() {}, getAttribute() { return null; }, dispose() {},
  set src(v) {}, get src() { return ''; },
});
globalThis.document = { createElementNS: (_n, t) => makeEl(), createElement: (t) => makeEl(), body: makeEl() };
globalThis.window = { innerWidth: 1, innerHeight: 1, devicePixelRatio: 1, URL: { createObjectURL: () => 'b', revokeObjectURL() {} }, addEventListener() {} };
globalThis.navigator ??= { userAgent: 'node' };

const b = readFileSync('public/models/character/mika.fbx');
const g = new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');

g.traverse((o) => {
  if (!o.isMesh) return;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  console.log(`MESH "${o.name}" verts=${o.geometry.attributes.position.count} groups=${o.geometry.groups.length}`);
  for (const m of mats) {
    if (!m) continue;
    console.log(`   material="${m.name}" type=${m.type} roughness=${m.roughness} metalness=${m.metalness} hasMap=${!!m.map} normalMap=${!!m.normalMap}`);
  }
  // which material each geometry group uses
  o.geometry.groups.forEach((gr, i) => {
    const mi = gr.materialIndex ?? 0;
    console.log(`   group ${i}: materialIndex=${mi} -> "${mats[mi]?.name ?? 'n/a'}" count=${gr.count}`);
  });
});
