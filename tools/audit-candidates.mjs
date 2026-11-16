/**
 * Audit candidate animation files against the character rig.
 *
 * Usage: node tools/audit-candidates.mjs <file.fbx> [more.fbx ...]
 *
 * The question that matters for every new download is whether its bones resolve
 * against this specific character. A clip that names bones the rig does not
 * have will load without error and then animate nothing - or animate the wrong
 * parts - so the diff is checked before anything is copied into the project.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
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
  globalThis.navigator ??= { userAgent: 'node' };
}
installDomShim();

const load = (p) => {
  const b = readFileSync(p);
  return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};

const char = load('public/models/character/mika.fbx');
const charBones = new Set();
char.traverse((o) => { if (o.isBone) charBones.add(o.name); });

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/audit-candidates.mjs <file.fbx> [...]\nuse - to read paths from stdin');
  process.exit(1);
}

for (const file of files) {
  console.log(`\n${'='.repeat(70)}\n${file}\n${'='.repeat(70)}`);
  let g;
  try {
    g = load(file);
  } catch (e) {
    console.log(`  LOAD FAILED: ${e.message}`);
    continue;
  }

  const bones = new Set();
  g.traverse((o) => { if (o.isBone) bones.add(o.name); });

  const missing = [...bones].filter((b) => !charBones.has(b));
  const extra = [...charBones].filter((b) => !bones.has(b));

  console.log(`  scene bones : ${bones.size}   (character has ${charBones.size})`);
  console.log(`  unresolved  : ${missing.length}${missing.length ? ' -> ' + missing.join(', ') : '  (all bones bind)'}`);
  console.log(`  unused      : ${extra.length}${extra.length ? ' -> ' + extra.slice(0, 12).join(', ') + (extra.length > 12 ? ' …' : '') : ''}`);

  const clips = g.animations || [];
  console.log(`  clips       : ${clips.length}`);
  for (const c of clips) {
    const animated = new Set();
    for (const t of c.tracks) {
      const d = t.name.lastIndexOf('.');
      if (d > 0) animated.add(t.name.slice(0, d));
    }
    const unresolvedTracks = [...animated].filter((b) => !charBones.has(b)).length;
    // Which of the interesting bones does it actually drive?
    const drives = (n) => (animated.has(n) ? n : null);
    const eyeKeys = ['Left_eye', 'Right_eye', 'LeftEye', 'RightEye'].filter((n) => animated.has(n));
    console.log(
      `    "${c.name}"  ${c.duration.toFixed(2)}s  tracks=${c.tracks.length}  ` +
      `bonesDriven=${animated.size}  unresolvedBones=${unresolvedTracks}` +
      (eyeKeys.length ? `  eyeBones=[${eyeKeys.join(',')}]` : '  eyeBones=none')
    );
    // Root motion: a Hips position track would slide the character.
    const hipsPos = c.tracks.find((t) => t.name === 'Hips.position' || t.name.endsWith('.bones.Hips.position'));
    if (hipsPos) {
      const n = hipsPos.values.length / hipsPos.times.length;
      let maxDev = 0;
      for (let i = 0; i < n; i++) {
        const y = hipsPos.values[i * 3 + 1];
        maxDev = Math.max(maxDev, Math.abs(y - hipsPos.values[1]));
      }
      console.log(`      Hips position track present, max Y deviation ${maxDev.toFixed(3)} units`);
    }
    // Loop seam
    let worst = 0, worstName = '';
    for (const t of c.tracks) {
      const n = t.times.length;
      if (n < 2) continue;
      const first = t.values.slice(0, t.values.length / n);
      const last = t.values.slice(t.values.length - t.values.length / n);
      let d;
      if (t.isQuaternionKeyframedTrack) {
        d = new THREE.Quaternion(...first).angleTo(new THREE.Quaternion(...last));
      } else {
        d = 0;
        for (let i = 0; i < first.length; i++) d = Math.max(d, Math.abs(first[i] - last[i]));
      }
      if (d > worst) { worst = d; worstName = t.name; }
    }
    const seamOk = worst < 0.02;
    console.log(`      loop seam: ${seamOk ? 'SEAMLESS' : `pop ${(worst * 57.2958).toFixed(1)}deg at ${worstName}`} -> loop${seamOk ? 'able' : ' (use LoopOnce)'}`);
  }
}
