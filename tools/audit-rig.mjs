/**
 * Headless rig audit.
 *
 * Answers the questions that decide whether the animation state machine can
 * work at all, before a single line of runtime code exists:
 *   1. What are the character's actual bone names?
 *   2. What blendshape / morph-target names does it expose?
 *      (needed for blink + viseme lip-sync)
 *   3. Do the animation FBX files' bones line up with the character?
 *   4. What are the AnimationClips' names, durations and track counts?
 *
 * three's FBXLoader only touches the DOM to build <img> elements for texture
 * loading, so a small shim lets us parse real assets under bare Node.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const modelPath = 'public/models/character/mika.fbx';
const animPaths = [
  'public/models/animations/idle.fbx',
  'public/models/animations/talking.fbx',
  'public/models/animations/bored.fbx',
];

// ---------------------------------------------------------------- DOM shim
function installDomShim() {
  const imgProto = {};
  const makeEl = () => {
    const el = {
      ...imgProto,
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      width: 0,
      height: 0,
      _src: '',
      listeners: {},
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      removeEventListener() {},
      setAttribute() {},
      getAttribute() { return null; },
      dispose() {},
    };
    // Never resolve: we only care about the parse tree, not pixel data.
    Object.defineProperty(el, 'src', {
      get() { return this._src; },
      set(v) { this._src = v; },
    });
    return el;
  };
  globalThis.document = {
    createElementNS: (_ns, tag) => makeEl(tag),
    createElement: (tag) => makeEl(tag),
    body: makeEl('body'),
  };
  globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    addEventListener() {},
  };
  globalThis.self = globalThis.window;
  globalThis.navigator ??= { userAgent: 'node' };
  globalThis.Blob ??= class { constructor(p) { this.parts = p; } };
  globalThis.ImageData ??= class {};
}
installDomShim();

// ---------------------------------------------------------------- helpers
function parseFbx(path) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new FBXLoader();
  // In three r170 parse() resolves to the root Group itself and hangs the
  // AnimationClips off its `animations` property.
  const group = loader.parse(ab, '');
  return { group, animations: group.animations || [] };
}

function collect(root) {
  const bones = [];
  const morphs = new Map(); // mesh.uuid -> { name: [targets] }
  root.traverse((o) => {
    if (o.isBone || o.isSkeleton) {
      if (o.isBone) bones.push(o.name);
    }
    if (o.isMesh) {
      const md = o.morphTargetDictionary;
      const names = md ? Object.keys(md) : [];
      if (names.length) morphs.set(o.name, names);
    }
  });
  return { bones, morphs };
}

// ---------------------------------------------------------------- run
const fbx = parseFbx(modelPath);
const char = collect(fbx.group);

console.log('='.repeat(72));
console.log('CHARACTER:', modelPath);
console.log('='.repeat(72));
console.log(`bones: ${char.bones.length}`);
console.log(char.bones.join(', '));

console.log('\nblendshape meshes:');
if (!char.morphs.size) console.log('  (none)');
for (const [mesh, names] of char.morphs) {
  console.log(`  ${mesh}  [${names.length}]`);
  for (const n of names) console.log(`      ${n}`);
}

// Textures reference check
console.log('\ntextures referenced by materials:');
const texSet = new Set();
fbx.group.traverse((o) => {
  const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
  for (const m of mats) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
      if (m[k]?.source?.data?.src) texSet.add(m[k].source.data.src.split('/').pop());
    }
  }
});
console.log('  ' + (texSet.size ? [...texSet].join('\n  ') : '(none embedded)'));

console.log('\n' + '='.repeat(72));
console.log('ANIMATIONS');
console.log('='.repeat(72));

const animBones = [];
for (const p of animPaths) {
  const a = parseFbx(p);
  const c = collect(a.group);
  animBones.push({ p, bones: c.bones });

  console.log(`\n--- ${p}`);
  console.log(`  scene bones: ${c.bones.length}`);
  console.log(`  clips: ${a.animations.length}`);
  for (const clip of a.animations) {
    const dur = clip.duration.toFixed(2);
    console.log(`    "${clip.name}"  duration=${dur}s  tracks=${clip.tracks.length}`);
  }
}

// ---------------------------------------------------------------- binding diff
const charSet = new Set(char.bones);
console.log('\n' + '='.repeat(72));
console.log('BINDING DIFF  (animation bone -> character bone)');
console.log('='.repeat(72));
for (const { p, bones } of animBones) {
  const missing = bones.filter((b) => !charSet.has(b));
  console.log(`\n${p}`);
  console.log(`  animation bones: ${bones.length}   unmatched: ${missing.length}`);
  if (missing.length) console.log(`    MISSING: ${missing.join(', ')}`);
  else console.log('    all animation bones resolve against the character');
}

// ---------------------------------------------------------------- viseme/blink map
console.log('\n' + '='.repeat(72));
console.log('BLINK / VISEME CANDIDATES');
console.log('='.repeat(72));
const all = new Set();
for (const names of char.morphs.values()) names.forEach((n) => all.add(n));
const lower = [...all].map((n) => [n, n.toLowerCase()]);
const find = (re) => lower.filter(([, l]) => re.test(l)).map(([n]) => n);
console.log('  blink-ish :', find(/blink|eye_?close|eyeclose|eyelid|close.*eye/) .join(', ') || '(none)');
console.log('  aa-ish    :', find(/^a$|^aa$|viseme.*a|open|mouth.*open|jaw/) .join(', ') || '(none)');
console.log('  ih-ish    :', find(/^i$|^ih$|ee|smile/) .join(', ') || '(none)');
console.log('  ou-ish    :', find(/^o$|^ou$|oo$|uw$|round/) .join(', ') || '(none)');
console.log('  ee-ish    :', find(/^e$|^eh$/) .join(', ') || '(none)');
