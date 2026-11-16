import * as THREE from 'three';

/**
 * Bone retargeting for a downloaded character model.
 *
 * ## Why this exists
 *
 * `THREE.AnimationMixer` resolves every clip track by bone NAME against the
 * skeleton it was given. Her six clips were authored against Mika's 71-bone
 * Mixamo-style rig (`Hips`, `Left_arm`, `Index_finger_L001`). A model
 * downloaded from elsewhere almost never uses those names, and the failure is
 * silent: the clip reports as playing, no error is logged, and she simply
 * stands in her bind pose for the whole conversation.
 *
 * Measured on `jinx_-_arcane_fortnite.glb` before this existed:
 *   0 of 57 tracks bound, on all six clips.
 *
 * So this rewrites track node names from the source rig's convention to the
 * target rig's before the mixer ever sees the clip.
 *
 * ## Why it is safe for Mika
 *
 * A track is only rewritten when BOTH are true:
 *   1. the source bone is absent from the target skeleton, and
 *   2. the map has a replacement AND that replacement exists in the skeleton.
 *
 * Mika matches her own clip names on condition 1, so every one of her tracks
 * is left untouched and nothing changes for her. Retargeting only engages for
 * a model that genuinely needs it.
 */

/**
 * Source bone name -> target bone name.
 *
 * Built from `node tools/dump-bones.mjs` on both files, not guessed:
 *
 *   Mika (71 bones, Mixamo-ish)        Jinx (220 bones, Unreal/Arcane)
 *   ----------------------------       ---------------------------------
 *   Hips                               pelvis_217
 *   Spine                              spine_01_133
 *   Chest                              spine_03_131
 *   Neck                               neck_01_125
 *   Head                               head_123
 *   Left_shoulder                      clavicle_l_27
 *   Left_arm                           upperarm_l_26
 *   Left_elbow                         lowerarm_l_23
 *   Left_wrist                         hand_l_20
 *   Left_Leg / _knee / _ankle / _toe   thigh_l_154 / calf_l_150 / foot_l_149 / ball_l_148
 *   Index_finger_L                     index_metacarpal_l_3
 *   Index_finger_L001 / _002           index_01_l_2 / index_02_l_1
 *
 * Only the 56 bones the clips actually drive need an entry; the rest of the
 * 220 are face/detail/physics bones no clip touches.
 */
export const RETARGET = {
  // --- spine / head
  Armature: 'root_218',
  Hips: 'pelvis_217',
  Spine: 'spine_01_133',
  Chest: 'spine_03_131',
  Neck: 'neck_01_125',
  Head: 'head_123',

  // --- left arm
  Left_shoulder: 'clavicle_l_27',
  Left_arm: 'upperarm_l_26',
  Left_elbow: 'lowerarm_l_23',
  Left_wrist: 'hand_l_20',

  // --- right arm
  Right_shoulder: 'clavicle_r_57',
  Right_arm: 'upperarm_r_55',
  Right_elbow: 'lowerarm_r_52',
  Right_wrist: 'hand_r_48',

  // --- left leg
  Left_Leg: 'thigh_l_154',
  Left_knee: 'calf_l_150',
  Left_ankle: 'foot_l_149',
  Left_toe: 'ball_l_148',

  // --- right leg
  Right_Leg: 'thigh_r_178',
  Right_knee: 'calf_r_174',
  Right_ankle: 'foot_r_173',
  Right_toe: 'ball_r_172',

  // --- eyes. The source rig carries two naming variants for the same pair and
  // both resolve onto the model's single pair, so saccades and blinks agree.
  Left_eye: 'L_eye_117',
  LeftEye: 'L_eye_117',
  Right_eye: 'R_eye_114',
  RightEye: 'R_eye_114',

  // --- left hand
  Index_finger_L: 'index_metacarpal_l_3',
  Index_finger_L001: 'index_01_l_2',
  Index_finger_L002: 'index_02_l_1',
  Middle_Finger_L: 'middle_metacarpal_l_7',
  Middle_Finger_L001: 'middle_01_l_6',
  Middle_Finger_L002: 'middle_02_l_5',
  Ring_finger_L: 'ring_metacarpal_l_15',
  Ring_finger_L001: 'ring_01_l_14',
  Ring_finger_L002: 'ring_02_l_13',
  Little_finger_L: 'pinky_metacarpal_l_11',
  Little_finger_L001: 'pinky_01_l_10',
  Little_finger_L002: 'pinky_02_l_9',
  Thumb_L: 'thumb_01_l_18',
  Thumb_L001: 'thumb_02_l_17',
  Thumb_L002: 'thumb_03_l_16',

  // --- right hand
  Index_finger_R: 'index_metacarpal_r_31',
  Index_finger_R001: 'index_01_r_30',
  Index_finger_R002: 'index_02_r_29',
  Middle_Finger_R: 'middle_metacarpal_r_35',
  Middle_Finger_R001: 'middle_01_r_34',
  Middle_Finger_R002: 'middle_02_r_33',
  Ring_finger_R: 'ring_metacarpal_r_43',
  Ring_finger_R001: 'ring_01_r_42',
  Ring_finger_R002: 'ring_02_r_41',
  Little_finger_R: 'pinky_metacarpal_r_39',
  Little_finger_R001: 'pinky_01_r_38',
  Little_finger_R002: 'pinky_02_r_37',
  Thumb_R: 'thumb_01_r_46',
  Thumb_R001: 'thumb_02_r_45',
  Thumb_R002: 'thumb_03_r_44',
};

/**
 * Standard Mixamo humanoid names -> this model's bones.
 *
 * Separate from RETARGET above because the two source conventions are
 * genuinely different, and the existing clips use the one above:
 *
 *   existing clips        Mixamo "Without Skin"
 *   ------------------    -------------------
 *   Left_arm              mixamorig:LeftArm
 *   Left_elbow            mixamorig:LeftForeArm
 *   Left_wrist            mixamorig:LeftHand
 *   Left_Leg              mixamorig:LeftUpLeg
 *   Left_knee             mixamorig:LeftLeg
 *   Left_ankle            mixamorig:LeftFoot
 *   Left_toe              mixamorig:LeftToeBase
 *
 * So a fresh download from Mixamo will NOT match the existing clips' names and
 * would bind 0% without this. Both sets are keyed here, and
 * `stripRigPrefix` removes the `mixamorig:` namespace Mixamo prepends.
 */
export const MIXAMO_RETARGET = {
  Hips: 'pelvis_217',
  Spine: 'spine_01_133',
  Spine1: 'spine_02_132',
  Spine2: 'spine_03_131',
  // This rig's spine is 5 long; Mixamo's is 3. The extra two are not in
  // Mixamo's set, so they carry no animation, but mapping them keeps the
  // middle of her back from being stiff if a clip ever does drive them.
  Spine3: 'spine_04_130',
  Spine4: 'spine_05_129',
  Neck: 'neck_01_125',
  Head: 'head_123',
  HeadTop_End: 'head_123',
  LeftEye: 'L_eye_117',
  RightEye: 'R_eye_114',

  LeftShoulder: 'clavicle_l_27',
  LeftArm: 'upperarm_l_26',
  LeftForeArm: 'lowerarm_l_23',
  LeftHand: 'hand_l_20',

  RightShoulder: 'clavicle_r_57',
  RightArm: 'upperarm_r_55',
  RightForeArm: 'lowerarm_r_52',
  RightHand: 'hand_r_48',

  LeftUpLeg: 'thigh_l_154',
  LeftLeg: 'calf_l_150',
  LeftFoot: 'foot_l_149',
  LeftToeBase: 'ball_l_148',
  LeftToe_End: 'ball_l_148',

  RightUpLeg: 'thigh_r_178',
  RightLeg: 'calf_r_174',
  RightFoot: 'foot_r_173',
  RightToeBase: 'ball_r_172',
  RightToe_End: 'ball_r_172',

  // Mixamo's 3-joint fingers, versus this rig's 4 (metacarpal + 3 phalanges),
  // so the terminal joint maps onto Mixamo's last one.
  LeftHandIndex1: 'index_metacarpal_l_3',
  LeftHandIndex2: 'index_01_l_2',
  LeftHandIndex3: 'index_02_l_1',
  LeftHandIndex4: 'index_03_l_0',
  LeftHandMiddle1: 'middle_metacarpal_l_7',
  LeftHandMiddle2: 'middle_01_l_6',
  LeftHandMiddle3: 'middle_02_l_5',
  LeftHandMiddle4: 'middle_03_l_4',
  LeftHandRing1: 'ring_metacarpal_l_15',
  LeftHandRing2: 'ring_01_l_14',
  LeftHandRing3: 'ring_02_l_13',
  LeftHandRing4: 'ring_03_l_12',
  LeftHandPinky1: 'pinky_metacarpal_l_11',
  LeftHandPinky2: 'pinky_01_l_10',
  LeftHandPinky3: 'pinky_02_l_9',
  LeftHandPinky4: 'pinky_03_l_8',
  LeftHandThumb1: 'thumb_01_l_18',
  LeftHandThumb2: 'thumb_02_l_17',
  LeftHandThumb3: 'thumb_03_l_16',

  RightHandIndex1: 'index_metacarpal_r_31',
  RightHandIndex2: 'index_01_r_30',
  RightHandIndex3: 'index_02_r_29',
  RightHandIndex4: 'index_03_r_28',
  RightHandMiddle1: 'middle_metacarpal_r_35',
  RightHandMiddle2: 'middle_01_r_34',
  RightHandMiddle3: 'middle_02_r_33',
  RightHandMiddle4: 'middle_03_r_32',
  RightHandRing1: 'ring_metacarpal_r_43',
  RightHandRing2: 'ring_01_r_42',
  RightHandRing3: 'ring_02_r_41',
  RightHandRing4: 'ring_03_r_40',
  RightHandPinky1: 'pinky_metacarpal_r_39',
  RightHandPinky2: 'pinky_01_r_38',
  RightHandPinky3: 'pinky_02_r_37',
  RightHandPinky4: 'pinky_03_r_36',
  RightHandThumb1: 'thumb_01_r_46',
  RightHandThumb2: 'thumb_02_r_45',
  RightHandThumb3: 'thumb_03_r_44',
};

/**
 * Drop a rig namespace prefix.
 *
 * Mixamo writes every bone as `mixamorig:Hips`. But FBX has no first-class
 * namespaces, so the export FLATTENS it, and three.js hands the bone to us as
 * `mixamorigHips` - no colon at all. Stripping only on `:` therefore did
 * nothing, and a real download of her own retargeted clips bound only 63.8%
 * with every Mixamo bone falling through as unmapped.
 *
 * Both shapes are handled: the colon form and the flattened prefix form.
 */
export function stripRigPrefix(name) {
  const i = name.indexOf(':');
  if (i >= 0) return name.slice(i + 1);
  const m = /^(mixamorig|mixamrig|armature)[._-]?/i.exec(name);
  if (m && name.length > m[0].length) return name.slice(m[0].length);
  return name;
}

/**
 * Look a source bone up in either map, trying the raw name and then the
 * namespace-stripped one.
 */
export function lookupBone(node) {
  for (const n of [node, stripRigPrefix(node)]) {
    const a = RETARGET[n];
    if (a) return a;
    const b = MIXAMO_RETARGET[n];
    if (b) return b;
  }
  return null;
}

/** Every bone name in a subtree, used to decide whether retargeting applies. */
export function collectBoneNames(root) {
  const names = new Set();
  root?.traverse?.((o) => { if (o.isBone) names.add(o.name); });
  return names;
}

/**
 * Properties that must NOT be carried across rigs.
 *
 * Rotation is a unit quaternion and means the same thing on any skeleton.
 * Translation and scale are lengths in whatever units the SOURCE rig was
 * authored in, so replaying them on a different skeleton moves the character
 * by an arbitrary amount.
 *
 * Measured on this model: every clip carried foreign-unit position tracks, and
 * replaying them threw her clean off the floor -
 *
 *   clip         offending track              source max | displacement
 *   -----------  ---------------------------  ----------- | ------------
 *   bored        Armature.position                 491.9 |  -0.54 units
 *   kiss         Armature.position                 431.8 |  -0.43 units
 *   sitting-idle Armature.position                 504.0 |  -5.25 units
 *   jinx-idle    mixamorigHips.position            98.1 |  -80.5 units
 *
 * Mixamo in particular normalises the retargeted rig to its own standard height,
 * so its rest positions are ~185x larger than hers.
 */
const DROP_ON_RETARGET = new Set(['.position', '.scale']);

/** No rotation. Used to skip bones whose two rest poses already agree. */
const IDENTITY = new THREE.Quaternion();

/**
 * Rewrite a clip's track names onto `modelBones`.
 *
 * Returns a NEW clip when anything changed, and the original when nothing did,
 * so the common case (Mika) costs nothing and the source clip is never mutated
 * in case it is cached and reused.
 *
 * @param {THREE.AnimationClip} clip
 * @param {Set<string>} modelBones
 * @returns {{clip: THREE.AnimationClip, rewritten: number, dropped: number, unmapped: string[]}}
 */
/**
 * Bind-pose correction.
 *
 * A clip's quaternion tracks hold ABSOLUTE local rotations, not deltas. That
 * only works if the source and target skeletons have the same rest orientation
 * for that bone - and two different rigs never do.
 *
 * Measured on this model at frame 0, before any correction:
 *
 *   GLTF_created_0_rootJoint   179.7 deg   <- the armature ROOT, so she was
 *                                                 rotated flat onto the floor
 *   pinky_metacarpal_l_11      57.4 deg
 *   ring_metacarpal_r_43       50.2 deg
 *   upperarm_l_26              36.3 deg
 *
 * The fix is to apply the clip's ANIMATION DELTA rather than its absolute pose:
 *
 *   delta    = inverse(sourceRest) * clipRotation
 *   newLocal = targetRest * delta
 *
 * so each keyframe becomes `targetRest * inverse(sourceRest) * keyframe`. The
 * per-bone offset is constant, so it is computed once and multiplied into every
 * keyframe at load time.
 *
 * This applies to EVERY animated bone, including ones whose names already match
 * and therefore need no name remapping - a shared name does not imply a shared
 * rest orientation.
 *
 * @param {THREE.KeyframeTrack} track
 * @param {THREE.Quaternion} offset targetRest * inverse(sourceRest)
 */
function applyBindOffset(track, offset) {
  const v = track.values;
  const q = new THREE.Quaternion();
  for (let i = 0; i < v.length; i += 4) {
    q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(offset);
    v[i] = q.x; v[i + 1] = q.y; v[i + 2] = q.z; v[i + 3] = q.w;
  }
  track.needsUpdate = true;
  return track;
}

export function retargetClip(clip, modelBones, { sourceBind = null, targetBind = null } = {}) {
  if (!clip || !modelBones || modelBones.size === 0) {
    return { clip, rewritten: 0, dropped: 0, corrected: 0, unmapped: [] };
  }

  let rewritten = 0;
  let dropped = 0;
  let corrected = 0;
  const unmapped = new Set();
  const tracks = [];
  const offset = new THREE.Quaternion();
  const inv = new THREE.Quaternion();

  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    if (dot <= 0) { tracks.push(track); continue; }

    const node = track.name.slice(0, dot);
    const prop = track.name.slice(dot);

    // Anything whose node is not one of THIS model's bones is discarded, and
    // this is the single most important rule in the file.
    //
    // Passing an unresolved track through looked harmless and was not. Mixamo
    // ships `GLTF_created_0.scale` = 100, because it normalises its rig to 100
    // units. `GLTF_created_0` is the armature Group on the source, not a bone,
    // so `modelBones` does not contain it and it used to fall out of this
    // function untouched. three.js then resolved that track BY NAME against the
    // model's own identically-named Group and applied the scale, multiplying
    // the entire skeleton by 100:
    //
    //   pelvis world position   (0, 0.946, 0)  ->  (0, -0.511, -94.594)
    //   character apparent size 1.62 units     ->  ~162 units
    //
    // which is what threw her across the floor and out of frame. The name
    // collision is the trap: "no mapping exists" is exactly the case where
    // three.js's name-based fallback is most likely to hit something real.
    const mapped = modelBones.has(node) ? node : lookupBone(node);
    if (!mapped || !modelBones.has(mapped)) {
      unmapped.add(node);
      dropped++;
      continue;
    }
    if (mapped !== node) rewritten++;

    // Foreign-unit translation has no meaning on this skeleton. This is
    // clip-wide on purpose: Mixamo normalises the retargeted rig to its own
    // height, so even bones that keep their name carry lengths ~185x too big.
    if (DROP_ON_RETARGET.has(prop)) { dropped++; continue; }

    const out = track.clone();
    if (mapped !== node) out.name = mapped + prop;

    if (prop === '.quaternion' && sourceBind && targetBind) {
      const src = sourceBind.get(node);
      const tgt = targetBind.get(mapped);
      if (src && tgt) {
        inv.copy(src).invert();
        offset.copy(tgt).multiply(inv);
        if (offset.angleTo(IDENTITY) > 1e-4) { applyBindOffset(out, offset); corrected++; }
      }
    }

    tracks.push(out);
  }

  if (rewritten === 0 && dropped === 0 && corrected === 0) {
    return { clip, rewritten, dropped, corrected, unmapped: [...unmapped] };
  }

  // If the source clip keys start at t > 0 (common in Mixamo exports where frame 0
  // is omitted and keys start at frame 1 = 1/30s = 0.0333s), shift all track times
  // so the first key is at t = 0.0. This removes the 2-frame dead zone at the loop seam.
  let minT0 = Infinity;
  for (const track of tracks) {
    if (track.times.length > 0 && track.times[0] < minT0) {
      minT0 = track.times[0];
    }
  }
  let duration = clip.duration;
  if (minT0 > 0 && minT0 < 0.1 && minT0 !== Infinity) {
    for (const track of tracks) {
      for (let i = 0; i < track.times.length; i++) {
        track.times[i] = Math.max(0, track.times[i] - minT0);
      }
    }
    duration = Math.max(0, duration - minT0);
  }

  const out = new THREE.AnimationClip(clip.name, duration, tracks);
  return { clip: out, rewritten, dropped, corrected, unmapped: [...unmapped] };
}