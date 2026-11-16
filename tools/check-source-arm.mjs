/**
 * Read a Mixamo clip AS SHIPPED and report how much each bone actually moves.
 *
 * This is the control for retargeting: if the source's `mixamorigLeftArm`
 * swings 20 degrees and the retargeted `upperarm_l_26` swings 0.7, the
 * retargeter is eating the motion. If the source also swings 0.7, the
 * downloaded clip is simply a stiff one and no amount of retargeting fixes it.
 *
 * Also reports the arm's angle from straight down in the source's rest pose,
 * because an idle that holds the arms in a T-pose looks like a T-pose.
 *
 * Usage: node tools/check-source-arm.mjs [clip.fbx ...]
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/check-source-arm.mjs <clip.fbx ...>');
  process.exit(2);
}

const ARM = /^(mixamorig)?(LeftArm|RightArm|LeftForeArm|RightForeArm|LeftShoulder|RightShoulder|Head|Neck|Spine|Hips)$/i;

for (const file of files) {
  const loader = new FBXLoader();
  const group = loader.parse(readFileSync(resolve(file)), '');

  const bones = new Map();
  group.traverse((o) => { if (o.isBone) bones.set(o.name, o); });

  const clip = group.animations?.[0];
  if (!clip) { console.log(`${file}: NO CLIP`); continue; }

  // Rest-pose arm angle, measured from straight down in world space.
  group.updateMatrixWorld(true);
  const angleFromDown = (bone) => {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    bone.getWorldPosition(a);
    bone.parent.getWorldPosition(b);
    const dir = a.sub(b).normalize();
    return +(Math.acos(THREE.MathUtils.clamp(dir.dot(new THREE.Vector3(0, -1, 0)), -1, 1)) * 180 / Math.PI).toFixed(1);
  };

  // Largest rotation BETWEEN CONSECUTIVE keyframes - the real motion, as
  // opposed to the offset from the bind pose.
  const swings = new Map();
  const q = new THREE.Quaternion();
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    if (dot <= 0 || track.name.slice(dot) !== '.quaternion') continue;
    const node = track.name.slice(0, dot);
    let prev = null, max = 0;
    for (let i = 0; i < track.values.length; i += 4) {
      q.set(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3]);
      if (prev) max = Math.max(max, prev.angleTo(q));
      prev = (prev ? prev.clone() : new THREE.Quaternion()).copy(q);
    }
    const deg = max * 180 / Math.PI;
    if (swings.get(node) === undefined || deg > swings.get(node)) swings.set(node, deg);
  }

  const rows = [];
  for (const [name, bone] of bones) {
    if (!ARM.test(name.replace(/^mixamorig/, '')) && !/head|neck|spine/i.test(name)) continue;
    rows.push({
      bone: name,
      swingDeg: +(swings.get(name) ?? 0).toFixed(1),
      restAngleFromDown: angleFromDown(bone),
    });
  }

  console.log(`\n${file}`);
  console.log(`  duration ${clip.duration.toFixed(2)}s   ${clip.tracks.length} tracks   ${bones.size} bones`);
  console.log('  bone                         swing   rest-angle-from-down');
  for (const r of rows.sort((a, b) => a.bone.localeCompare(b.bone))) {
    console.log(`  ${r.bone.padEnd(28)} ${String(r.swingDeg).padStart(6)}   ${String(r.restAngleFromDown).padStart(6)}`);
  }
  const armSwings = rows.filter((r) => /arm/i.test(r.bone)).map((r) => r.swingDeg);
  console.log(`  ARM MOTION TOTAL: max ${Math.max(0, ...armSwings).toFixed(1)} deg`);
}