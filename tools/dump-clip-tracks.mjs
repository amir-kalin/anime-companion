/**
 * Dump all bone track names from an animation clip.
 * Usage: node tools/dump-clip-tracks.mjs [path-to-fbx]
 */
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

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

const path = process.argv[2] || 'public/models/animations/jinx-idle.fbx';
if (!existsSync(path)) {
  console.error(`not found: ${path}`);
  process.exit(2);
}

const buf = readFileSync(path);
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const parsed = new FBXLoader().parse(bytes, '');
const clip = parsed.animations?.[0];

if (!clip) {
  console.error('no clip found');
  process.exit(2);
}

console.log(`Clip: ${clip.name}  ${clip.duration.toFixed(2)}s  ${clip.tracks.length} tracks\n`);

const boneTracks = clip.tracks.filter((t) => !t.name.endsWith('.morphTargetInfluences'));
const names = boneTracks.map((t) => t.name.slice(0, t.name.lastIndexOf('.')));
const unique = [...new Set(names)].sort();

console.log(`Unique bone names (${unique.length}):`);
for (const n of unique) console.log(`  ${n}`);
