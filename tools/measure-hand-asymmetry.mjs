/**
 * Measure left/right hand bone rotation ranges in the animation clips.
 *
 * The clips use Mixamo bone names which get retargeted to Unreal names
 * at load time. This measures the source tracks to quantify asymmetry.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MODEL, ANIMATIONS } from '../src/utils/config.js';

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

async function parseFile(p) {
  const buf = readFileSync(p);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new FBXLoader().parse(bytes, '');
}

// Load model for bind pose (Unreal names)
const modelPath = `public/${MODEL.url}`;
const modelGltf = await (async () => {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const buf = readFileSync(modelPath);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new GLTFLoader().parseAsync(bytes, '');
})();
const modelRoot = modelGltf.scene ?? modelGltf;

// Build a map: Mixamo name -> bind quaternion (via retarget)
import { RETARGET } from '../src/animation/retarget.js';
const mixamoToUnreal = {};
for (const [src, tgt] of Object.entries(RETARGET)) {
  mixamoToUnreal[src] = tgt;
}
const mixamoToUnrealPrefix = {};
for (const [src, tgt] of Object.entries(RETARGET)) {
  if (!mixamoToUnrealPrefix[tgt]) mixamoToUnrealPrefix[tgt] = src;
}

const bindQuat = new Map();
modelRoot.traverse((o) => { if (o.isBone) bindQuat.set(o.name, o.quaternion.clone()); });

// Hand bones to measure — Mixamo source names
const HAND_BONES = [
  { mixamo: 'mixamorigLeftHand', label: 'L wrist/hand' },
  { mixamo: 'mixamorigRightHand', label: 'R wrist/hand' },
  { mixamo: 'mixamorigLeftForeArm', label: 'L forearm' },
  { mixamo: 'mixamorigRightForeArm', label: 'R forearm' },
  { mixamo: 'mixamorigLeftArm', label: 'L upper arm' },
  { mixamo: 'mixamorigRightArm', label: 'R upper arm' },
  { mixamo: 'mixamorigLeftHandIndex1', label: 'L index base' },
  { mixamo: 'mixamorigRightHandIndex1', label: 'R index base' },
  { mixamo: 'mixamorigLeftHandMiddle1', label: 'L middle base' },
  { mixamo: 'mixamorigRightHandMiddle1', label: 'R middle base' },
  { mixamo: 'mixamorigLeftHandThumb1', label: 'L thumb base' },
  { mixamo: 'mixamorigRightHandThumb1', label: 'R thumb base' },
];

console.log('Measuring hand bone ranges in animation clips...\n');

for (const [state, cfg] of Object.entries(ANIMATIONS)) {
  if (cfg.variant) continue;
  const clipPath = `public/${cfg.url}`;
  if (!existsSync(clipPath)) continue;

  const parsed = await parseFile(clipPath);
  const clip = parsed.animations?.[0];
  if (!clip) continue;

  console.log(`--- ${state} (${cfg.url}) ---`);

  for (const { mixamo, label } of HAND_BONES) {
    const track = clip.tracks.find((t) => {
      return t.name === `${mixamo}.quaternion`;
    });
    if (!track) {
      console.log(`  ${label.padEnd(20)} NO TRACK`);
      continue;
    }

    // Find bind quaternion via retarget map
    const unrealName = mixamoToUnreal[mixamo] || mixamo;
    const bind = bindQuat.get(unrealName);
    if (!bind) {
      console.log(`  ${label.padEnd(20)} NO BIND`);
      continue;
    }

    const q = new THREE.Quaternion();
    const inv = bind.clone().invert();
    let maxDeg = 0;

    for (let i = 0; i < track.values.length; i += 4) {
      q.set(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3]);
      const delta = inv.clone().multiply(q);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w))) * (180 / Math.PI);
      if (angle > maxDeg) maxDeg = angle;
    }

    console.log(`  ${label.padEnd(20)} max deviation from bind: ${maxDeg.toFixed(1)}°`);
  }
  console.log('');
}
