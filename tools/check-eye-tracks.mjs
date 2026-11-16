/**
 * Which bones do the Mixamo clips actually animate?
 *
 * Procedural eye offsets are applied additively on top of the mixer output.
 * That is only safe if we know the base pose to add to:
 *   - bone IS animated by the clip -> the mixer rewrites it every frame, so the
 *     post-update value is a valid base and reading it is correct;
 *   - bone is NOT animated        -> the mixer never touches it, so reading it
 *     would compound our own previous offset. A cached bind-pose quaternion
 *     must be used as the base instead.
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

// three's FBXLoader names animation tracks "<boneName>.<property>" with no
// ".bones." prefix, e.g. "Left_eye.quaternion".
const TRACK_RE = /^(.+)\.(\w+)$/;

for (const name of ['idle', 'talking', 'bored']) {
  const a = load(`public/models/animations/${name}.fbx`);
  const clip = a.animations[0];
  const byBone = new Map();
  for (const t of clip.tracks) {
    const m = TRACK_RE.exec(t.name);
    if (!m) continue;
    if (!byBone.has(m[1])) byBone.set(m[1], new Set());
    byBone.get(m[1]).add(m[2]);
  }
  const eyeBones = [...byBone.keys()].filter((b) => /eye/i.test(b));
  const props = eyeBones.map((b) => `${b}{${[...byBone.get(b)].join(',')}}`);

  console.log(`${name.padEnd(8)} tracks=${clip.tracks.length}  animatedBones=${byBone.size}`);
  console.log(`         eye bones animated: ${props.length ? props.join('  ') : '(NONE - mixer will not touch them)'}`);
  console.log(`         head animated: ${byBone.has('Head') ? [...byBone.get('Head')].join(',') : 'no'}`);
}
