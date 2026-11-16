/**
 * Pre-flight check for swapping the character model.
 *
 *   node tools/check-model.mjs public/models/character/jinx.fbx
 *
 * The single most important thing to know before dropping in a downloaded
 * model is whether her EXISTING animation clips will still drive it.
 *
 * `new AnimationMixer(rig.model)` resolves every clip track by BONE NAME. If a
 * clip targets "LeftUpperArm" and the model has "upper_arm.L", the track is
 * silently dropped - the clip reports as playing, the console shows no error,
 * and she simply stands in her bind pose for the whole conversation. That is
 * the failure mode this tool exists to catch.
 *
 * So this parses the candidate model with the same loaders the browser uses,
 * then measures real track-by-name overlap against every clip in ANIMATIONS.
 *
 * It deliberately does NOT use tools/inspect-fbx.mjs: that tool reads the FBX
 * binary string table directly, and it reports 0 strings for both mika.fbx
 * (v7400) and idle.fbx (v7700), so its "bone-ish" list is empty and useless.
 * Parsing through FBXLoader/GLTFLoader is slower but it is the real code path,
 * so a pass here means a pass in the browser.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODEL, EYE_BONES, BLINK_SHAPES, VISEMES, ANIMATIONS } from '../src/utils/config.js';
import { RETARGET, lookupBone } from '../src/animation/retarget.js';

/**
 * Minimal DOM shim so FBXLoader/GLTFLoader run under Node.
 *
 * The subtle part is the fake <img>. three's ImageLoader sets `img.src` and
 * then waits for a 'load' event that will never come, so a stub with a no-op
 * addEventListener makes GLTFLoader's promise hang forever ("unsettled
 * top-level await"). Emitting the event with a 1x1 stand-in lets the parse
 * finish. The texture pixels are irrelevant here - this tool only reads
 * bones, morph targets and clip tracks.
 */
function installDomShim() {
  const makeEl = () => {
    const handlers = {};
    const el = {
      complete: false,
      width: 1,
      height: 1,
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      removeEventListener() {},
      setAttribute() {},
      getAttribute() { return null; },
      dispose() {},
      set src(v) {
        queueMicrotask(() => {
          for (const fn of handlers.load || []) {
            fn({ target: el, currentTarget: el });
          }
          if (typeof el.onload === 'function') el.onload({ target: el });
        });
      },
      get src() { return ''; },
      onload: null,
      onerror: null,
    };
    return el;
  };
  globalThis.document = {
    createElementNS: (_n, t) => makeEl(t), createElement: (t) => makeEl(t),
    body: makeEl('body'),
  };
  globalThis.window = {
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    URL: { createObjectURL: () => 'blob:s', revokeObjectURL() {} },
    addEventListener() {},
  };
  globalThis.navigator ??= { userAgent: 'node' };
  // GLTFLoader reaches for `self` (browsers alias window to self; Node has no
  // such alias), and fails with "self is not defined" without this.
  globalThis.self ??= globalThis;
}

/** Map a file extension onto the loader that can actually read it. */
function loaderFor(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.fbx') return { kind: 'fbx', make: () => new FBXLoader() };
  if (ext === '.glb' || ext === '.gltf') return { kind: 'gltf', make: () => new GLTFLoader() };
  if (ext === '.vrm') {
    // A VRM is a glTF with extra extension data. GLTFLoader reads the mesh and
    // skeleton; the expression shapes are picked up below via morph names.
    return { kind: 'vrm', make: () => new GLTFLoader() };
  }
  return null;
}

/**
 * Parse a model or clip.
 *
 * The two loaders do NOT have the same contract, which is a real trap:
 *   - FBXLoader.parse(buffer, path) is SYNCHRONOUS and returns the Object3D.
 *   - GLTFLoader.parse(data, path, onLoad, onError) is callback-based and
 *     returns undefined; only parseAsync() returns a promise.
 * Calling .parse() on a GLTFLoader and reading `.scene` off the result throws
 * "Cannot read properties of undefined (reading 'scene')".
 *
 * Note this is a Node-tool concern only. The app itself calls
 * `loader.load(url, onLoad, ...)`, which is the correct API for both.
 */
async function parseFile(path) {
  const spec = loaderFor(path);
  if (!spec) throw new Error(`unsupported extension "${extname(path)}" (want .fbx, .glb, .gltf or .vrm)`);
  const buf = readFileSync(path);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return spec.kind === 'fbx'
    ? spec.make().parse(bytes, '')
    : await spec.make().parseAsync(bytes, '');
}

async function loadObject(path) {
  const spec = loaderFor(path);
  if (!spec) throw new Error(`unsupported extension "${extname(path)}" (want .fbx, .glb, .gltf or .vrm)`);
  const parsed = await parseFile(path);
  // GLTFLoader nests the scene; FBXLoader returns it directly.
  return { root: parsed.scene ?? parsed, kind: spec.kind };
}

/**
 * The node a track drives, e.g. "LeftUpperArm.quaternion" -> "LeftUpperArm".
 * Morph tracks are "meshName.morphTargetInfluences" and are reported apart.
 */
function trackTarget(trackName) {
  const i = trackName.lastIndexOf('.');
  return i < 0 ? trackName : trackName.slice(0, i);
}

const isMorphTrack = (t) => t.endsWith('.morphTargetInfluences');

/** Lowercased name set, so lookups survive a case-only difference. */
const lower = (s) => s.toLowerCase();

/**
 * Mirrors CharacterRig._bone() exactly: direct candidates first, then the same
 * bone via the retarget map. If this drifts from the runtime behaviour the tool
 * stops being evidence, which is the whole point of it.
 */
function resolveAny(map, candidates) {
  for (const c of candidates) {
    const hit = map.bones.get(c) || map.bonesLower.get(lower(c));
    if (hit) return { name: hit.name, matched: c };
  }
  for (const c of candidates) {
    const mapped = lookupBone(c);
    if (!mapped) continue;
    const hit = map.bones.get(mapped) || map.bonesLower.get(lower(mapped));
    if (hit) return { name: hit.name, matched: `${c} -> ${mapped}` };
  }
  return null;
}

function resolveMorph(index, candidates) {
  for (const c of candidates) {
    const hit = index.get(lower(c));
    if (hit !== undefined) return { name: c, index: hit };
  }
  return null;
}

installDomShim();

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/check-model.mjs <model.fbx|.glb|.gltf|.vrm>');
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`no such file: ${target}`);
  process.exit(2);
}

let model;
try {
  model = await loadObject(target);
} catch (e) {
  console.error(`FAILED TO PARSE ${basename(target)}: ${e.message}`);
  console.error('If this is a .vrm or .pmx, see the notes at the bottom of this file.');
  process.exit(1);
}

const { root, kind } = model;

// ---------------------------------------------------------------- inventory
const bones = new Map();      // exact name -> bone
const bonesLower = new Map(); // lowercased -> bone
const meshNames = new Set();
const morphIndex = new Map(); // lowercased shape name -> {mesh,index}

root.updateMatrixWorld(true);
root.traverse((o) => {
  if (o.isBone) {
    bones.set(o.name, o);
    if (!bonesLower.has(lower(o.name))) bonesLower.set(lower(o.name), o);
  }
  if (o.isMesh) {
    meshNames.add(o.name);
    if (!o.morphTargetDictionary) return;
    for (const [shape, i] of Object.entries(o.morphTargetDictionary)) {
      const key = lower(shape);
      if (!morphIndex.has(key)) morphIndex.set(key, { mesh: o, index: i });
    }
  }
});

const box = new THREE.Box3().setFromObject(root);
const height = box.max.y - box.min.y;

console.log(`=== ${basename(target)}  (${kind}) ===`);
console.log(`  bones        : ${bones.size}`);
console.log(`  meshes       : ${meshNames.size}`);
console.log(`  morph shapes : ${morphIndex.size}`);
console.log(`  raw height   : ${height.toFixed(1)} units  -> scale factor ${(MODEL.targetHeight / (height || 1)).toExponential(2)}`);
console.log(`  faces +Z?    : ${(() => {
  // Cheapest useful signal: does the model face the camera by default?
  const m = [...meshNames][0];
  return m ? '(inconclusive without a render)' : 'no meshes';
})()}`);

// ------------------------------------------------------- required bindings
console.log('\n=== RIG BINDINGS (needed by blink / saccades / lip sync / framing) ===');
const required = {
  'centerOnBone': [MODEL.centerOnBone],
  'eye.left': EYE_BONES.left,
  'eye.right': EYE_BONES.right,
  'head': EYE_BONES.head,
};
let hardMiss = 0;
for (const [label, cands] of Object.entries(required)) {
  const hit = resolveAny({ bones, bonesLower }, cands);
  if (hit) {
    console.log(`  OK    ${label.padEnd(14)} -> "${hit.name}"`);
  } else {
    console.log(`  MISS  ${label.padEnd(14)} tried: ${cands.join(', ')}`);
    if (label === 'centerOnBone') { hardMiss++; console.log('        (falls back to bounding-box centring: wide hair/skirt will push her off-frame)'); }
    if (label === 'head') { hardMiss++; console.log('        (no head = no procedural look-at, no head tracking)'); }
  }
}

console.log('\n=== BLINK ===');
const blinkL = resolveMorph(morphIndex, BLINK_SHAPES.left);
const blinkR = resolveMorph(morphIndex, BLINK_SHAPES.right);
const blinkB = resolveMorph(morphIndex, BLINK_SHAPES.both);
if (blinkL && blinkR) console.log(`  OK    per-eye : "${blinkL.name}" / "${blinkR.name}"`);
else if (blinkB) console.log(`  OK    combined: "${blinkB.name}"`);
else { console.log('  MISS  none of the blink shapes resolved - she will never blink'); hardMiss++; }

console.log('\n=== VISEMES (lip sync) ===');
const visemeHits = [];
const visemeMisses = [];
for (const [key, cands] of Object.entries(VISEMES)) {
  const hit = resolveMorph(morphIndex, cands);
  if (hit) visemeHits.push(key); else visemeMisses.push(key);
}
console.log(`  resolved ${visemeHits.length}/${Object.keys(VISEMES).length}` +
  (visemeHits.length ? `: ${visemeHits.join(' ')}` : ''));
if (visemeMisses.length) {
  console.log(`  missing  : ${visemeMisses.join(' ')}`);
  console.log('  (mouth will move only for the shapes above; add aliases to VISEMES in src/utils/config.js)');
}

// ---------------------------------------------- the real question: the clips
console.log('\n=== ANIMATION BINDING (does her existing clip set still drive this rig?) ===');
const modelNames = new Set([...bones.keys()]);
const modelNamesLower = new Set([...bonesLower.keys()]);

let worstOverlap = 100;
const clipRows = [];
for (const [state, def] of Object.entries(ANIMATIONS)) {
  const path = `public/${def.url}`;
  if (!existsSync(path)) { clipRows.push({ state, note: 'clip file missing' }); continue; }
  let clips = [];
  try {
    const parsed = await parseFile(path);
    clips = parsed.animations ?? [];
  } catch (e) {
    clipRows.push({ state, note: `parse failed: ${e.message}` });
    continue;
  }
  if (!clips.length) { clipRows.push({ state, note: 'no clips inside' }); continue; }

  const clip = clips[0];
  const boneTracks = clip.tracks.filter((t) => !isMorphTrack(t.name));

  // Two numbers, because they answer different questions:
  //   raw       - does this model bind the clips AS AUTHORED?
  //   retargeted- will they bind once src/animation/retarget.js has rewritten
  //               the bone names? This is what actually happens at runtime.
  const bindsRaw = (n) => modelNames.has(n) || modelNamesLower.has(lower(n));
  const rawBound = boneTracks.filter((t) => bindsRaw(trackTarget(t.name)));

  const remapped = boneTracks.filter((t) => {
    const n = trackTarget(t.name);
    if (bindsRaw(n)) return true;
    const m = lookupBone(n);
    return Boolean(m && modelNames.has(m));
  });
  const noMapping = new Set(
    boneTracks
      .filter((t) => !bindsRaw(trackTarget(t.name)) && !remapped.includes(t))
      .map((t) => trackTarget(t.name))
  );

  const pct = boneTracks.length ? (remapped.length / boneTracks.length) * 100 : 0;
  const rawPct = boneTracks.length ? (rawBound.length / boneTracks.length) * 100 : 0;
  worstOverlap = Math.min(worstOverlap, pct);
  clipRows.push({ state, tracks: boneTracks.length, bound: remapped.length, pct, rawPct, noMapping, dur: clip.duration });
}

for (const r of clipRows) {
  if (r.note) { console.log(`  ??    ${r.state.padEnd(15)} ${r.note}`); continue; }
  const flag = r.pct >= 95 ? 'OK   ' : r.pct >= 80 ? 'WARN ' : 'FAIL ';
  const delta = r.rawPct < 95 ? `  (was ${r.rawPct.toFixed(0)}% raw, +${(r.pct - r.rawPct).toFixed(0)} from retargeting)` : '';
  console.log(`  ${flag} ${r.state.padEnd(15)} ${String(r.bound).padStart(3)}/${String(r.tracks).padEnd(3)} tracks bind (${r.pct.toFixed(1)}%)${delta}  ${r.dur.toFixed(2)}s`);
  if (r.noMapping.size) console.log(`        ${r.noMapping.size} bone(s) with no mapping: ${[...r.noMapping].slice(0, 8).join(', ')}`);
}

console.log('\n=== VERDICT ===');
const problems = [];
if (bones.size === 0) problems.push('no bones at all - not a rigged model');
if (hardMiss) problems.push(`${hardMiss} critical rig binding(s) missing (see above)`);
if (worstOverlap < 95) {
  problems.push(`worst clip only binds ${worstOverlap.toFixed(1)}% of its bone tracks -`);
  problems.push('  she will move in bind pose (stand still) for those states.');
  problems.push('  Fix by renaming bones, or replacing those clips for this rig.');
}
if (problems.length) {
  console.log('  NOT READY:');
  for (const p of problems) console.log(`   - ${p}`);
  process.exitCode = 1;
} else {
  console.log('  READY: rig bindings resolved and every clip binds by bone name.');
  console.log(`  Next: set MODEL.url in src/utils/config.js to '${target.replace(/\\/g, '/').replace(/^public\//, '')}'`);
}