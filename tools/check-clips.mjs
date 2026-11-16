/**
 * Will these downloaded clips drive the model in the app?
 *
 *   node tools/check-clips.mjs "path/one.fbx" "path/two.fbx"
 *
 * Separate from check-model.mjs, which only measures the clips already wired
 * into ANIMATIONS. This one takes arbitrary files, so a fresh download can be
 * vetted before it is installed.
 *
 * Reports BOTH numbers, because they answer different questions:
 *   raw        - do the names match as-is?
 *   retargeted - do they bind once src/animation/retarget.js has rewritten
 *                them? That is what actually happens at runtime.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODEL } from '../src/utils/config.js';
import { retargetClip, collectBoneNames, stripRigPrefix } from '../src/animation/retarget.js';

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
  return extname(p).toLowerCase() === '.fbx'
    ? new FBXLoader().parse(bytes, '')
    : await new GLTFLoader().parseAsync(bytes, '');
}

// ---------------------------------------------------------------- the model
const modelPath = `public/${MODEL.url}`;
if (!existsSync(modelPath)) { console.error(`model missing: ${modelPath}`); process.exit(2); }
const modelRoot = (await parseFile(modelPath)).scene ?? (await Promise.resolve(null));
const m = await parseFile(modelPath);
const modelBones = collectBoneNames(m.scene ?? m);
console.log(`model: ${MODEL.url}  (${modelBones.size} bones)`);
console.log(`       e.g. ${[...modelBones].slice(0, 4).join(', ')}\n`);

// ------------------------------------------------------------------- clips
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/check-clips.mjs <clip.fbx> [more.fbx ...]');
  process.exit(2);
}

let worst = 100;
for (const f of files) {
  if (!existsSync(f)) { console.log(`SKIP  ${basename(f)}  (not found)`); continue; }
  let parsed;
  try { parsed = await parseFile(f); }
  catch (e) { console.log(`FAIL  ${basename(f)}  parse error: ${e.message}`); worst = 0; continue; }

  const clips = parsed.animations ?? [];
  if (!clips.length) { console.log(`FAIL  ${basename(f)}  no AnimationClip inside`); worst = 0; continue; }

  const clip = clips[0];
  const hasMesh = (() => {
    let n = 0;
    (parsed.scene ?? parsed).traverse?.((o) => { if (o.isMesh) n++; });
    return n;
  })();

  const boneTracks = clip.tracks.filter((t) => !t.name.endsWith('.morphTargetInfluences'));
  const rawBound = boneTracks.filter((t) => {
    const n = t.name.slice(0, t.name.lastIndexOf('.'));
    return modelBones.has(n) || modelBones.has(stripRigPrefix(n));
  });
  const { clip: out, rewritten, unmapped } = retargetClip(clip, modelBones);

  const rawPct = (rawBound.length / boneTracks.length) * 100;
  const pct = ((rawBound.length + rewritten) / boneTracks.length) * 100;
  worst = Math.min(worst, pct);
  const flag = pct >= 95 ? 'OK  ' : pct >= 80 ? 'WARN' : 'FAIL';

  console.log(`${flag}  ${basename(f)}`);
  console.log(`      clip "${clip.name}"  ${clip.duration.toFixed(2)}s  ${boneTracks.length} bone tracks`);
  console.log(`      raw ${rawPct.toFixed(1)}%  + retargeting ${rewritten}  =  ${pct.toFixed(1)}% bound`);
  if (unmapped.length) console.log(`      ${unmapped.length} unmapped bone(s): ${unmapped.slice(0, 6).join(', ')}`);
  if (hasMesh) console.log(`      NOTE: contains ${hasMesh} mesh(es) - a "with skin" download. Ignored at runtime,`);
  if (hasMesh) console.log(`            but worth stripping: it is most of the file size.`);
  console.log('');
}

console.log(worst >= 95
  ? 'VERDICT: every clip will drive this model'
  : `VERDICT: worst clip only binds ${worst.toFixed(1)}%`);
process.exit(worst >= 95 ? 0 : 1);