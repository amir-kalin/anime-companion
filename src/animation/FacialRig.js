import * as THREE from 'three';

/**
 * Bone-driven facial animation.
 *
 * ## Why this exists
 *
 * This model has no blendshapes - `blink: none shapes, 0/15 visemes` - so the
 * existing MorphRegistry path is inert and she can neither blink nor lip-sync.
 * That reads as a doll.
 *
 * But the face is not shapeless either. It is a full facial BONE rig, and those
 * bones are genuinely skinned to the mesh. Measured influence:
 *
 *   R_eye_lid_upper_mid_116   263 verts   max weight 0.90
 *   L_eye_lid_upper_mid_119   269 verts   max weight 0.90
 *   C_jaw_113                 503 verts   max weight 1.00
 *   C_lip_upper_mid_100       157 verts   max weight 0.60
 *   C_brow_mid_96             132 verts   max weight 0.65
 *
 * Applying a rotation to the eyelid bones moves 532 vertices. So blinking is
 * possible without a blendshape, by rotating the lids the way the game rig does.
 *
 * ## How the axes were chosen
 *
 * At bind, the lid bones report (world space):
 *   localX = ~( 0.99, 0.11, -0.01)  across the face, left to right
 *   localY = ~(-0.11, 0.98, -0.14)  up the face
 *   localZ = ~( 0.00, 0.14,  0.99)  out of the face
 *
 * Sweeping a lid up/down on the face happens in the Y-Z plane, so the closing
 * rotation is about LOCAL X. The sign was measured by skinning 7,959 sampled
 * vertices either side of zero: a positive rotation moved the lids UP, so a
 * negative one closes them.
 *
 * ## Honest caveat
 *
 * The angles below were derived from geometry, not from watching her, because
 * this environment cannot screenshot the canvas. They are deliberately small and
 * every one of them is a single number in config so they can be corrected by
 * eye in seconds rather than by editing code.
 */

/** Bone names, best first, so a differently-named rig still resolves. */
const UPPER_LID = {
  left: ['L_eye_lid_upper_mid_119', 'L_eye_lid_upper', 'LeftEyeLidUpper'],
  right: ['R_eye_lid_upper_mid_116', 'R_eye_lid_upper', 'RightEyeLidUpper'],
};
const LOWER_LID = {
  left: ['L_eye_lid_lower_mid_118', 'L_eye_lid_lower', 'LeftEyeLidLower'],
  right: ['R_eye_lid_lower_mid_115', 'R_eye_lid_lower', 'RightEyeLidLower'],
};
const JAW = ['C_jaw_113', 'jaw', 'Jaw'];
const LIP_UPPER = ['C_lip_upper_mid_100', 'L_lip_upper_outer_101', 'R_lip_upper_outer_121'];
const LIP_LOWER = ['C_lip_lower_mid_109', 'L_lip_lower_outer_108', 'R_lip_lower_outer_110'];
const BROWS = ['C_brow_mid_96', 'L_brow_mid_97', 'R_brow_mid_104'];

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();

export class FacialRig {
  /**
   * @param {THREE.Object3D} root rig root
   * @param {object} opts see config.js FACIAL
   */
  constructor(root, {
    lidAxis = [1, 0, 0],
    lidAngle = 0.52,
    jawAxis = [1, 0, 0],
    jawAngle = 0.16,
    lipAxis = [1, 0, 0],
    lipAngle = 0.09,
    lowerLidFollow = 0.25,
  } = {}) {
    this.cfg = { lidAxis, lidAngle, jawAxis, jawAngle, lipAxis, lipAngle, lowerLidFollow };

    /** @type {Record<string, THREE.Bone[]>} role -> bones */
    this.bones = { upperLid: [], lowerLid: [], jaw: [], lipUpper: [], lipLower: [], brow: [] };
    /** @type {Map<THREE.Bone, THREE.Quaternion>} bind pose */
    this.bind = new Map();

    this.ready = false;
    this._collect(root);
    this.ready = this.bones.upperLid.length > 0 || this.bones.jaw.length > 0;
  }

  _pick(root, names) {
    const found = [];
    for (const n of names) {
      const b = this._bonesByName?.get(n);
      if (b) { found.push(b); break; }
    }
    return found;
  }

  _collect(root) {
    if (!root) return;
    const byName = new Map();
    root.traverse((o) => { if (o.isBone) byName.set(o.name, o); });
    this._bonesByName = byName;

    const resolve = (groups) => {
      const out = [];
      for (const names of groups) {
        for (const n of names) { const b = byName.get(n); if (b) { out.push(b); break; } }
      }
      return out;
    };

    this.bones.upperLid = resolve([UPPER_LID.left, UPPER_LID.right]);
    this.bones.lowerLid = resolve([LOWER_LID.left, LOWER_LID.right]);
    this.bones.jaw = resolve([JAW]);
    this.bones.lipUpper = resolve([LIP_UPPER]);
    this.bones.lipLower = resolve([LIP_LOWER]);
    this.bones.brow = resolve([BROWS]);

    for (const list of Object.values(this.bones)) {
      for (const b of list) this.bind.set(b, b.quaternion.clone());
    }
  }

  /**
   * Rotate every bone in `list` about a fixed LOCAL axis by `angle` radians.
   *
   * An angle of 0 must still WRITE the bind pose. Returning early instead was a
   * real bug: `setBlink(0)` and `setJaw(0)` are the "eyes open / mouth closed"
   * calls, and skipping them left her half-closed with her jaw stuck open once
   * she stopped talking.
   */
  _apply(list, axis, angle) {
    if (!list.length) return;
    _axis.set(axis[0], axis[1], axis[2]).normalize();
    if (angle) _q.setFromAxisAngle(_axis, angle);
    else _q.identity();
    for (const b of list) {
      const bind = this.bind.get(b);
      if (bind) b.quaternion.copy(bind).multiply(_q);
    }
  }

  /**
   * @param {number} v 0 = open, 1 = fully closed
   */
  setBlink(v) {
    const w = THREE.MathUtils.clamp(v, 0, 1);
    this._apply(this.bones.upperLid, this.cfg.lidAxis, -this.cfg.lidAngle * w);
    // The lower lid rises a little too, or the eye looks like it is shutting
    // one-sided. A fraction of the upper lid's travel.
    this._apply(this.bones.lowerLid, this.cfg.lidAxis, this.cfg.lidAngle * this.cfg.lowerLidFollow * w);
  }

  /**
   * Mouth opening, driven by speech level.
   *
   * The jaw bone is the PARENT of the lower lip, lower-lip corners, lower teeth
   * and tongue on this rig, so rotating it opens the whole mouth consistently -
   * which is why one bone covers most of it and the lip bones only add shape.
   * @param {number} v 0 = closed, 1 = wide open
   */
  setJaw(v) {
    const w = THREE.MathUtils.clamp(v, 0, 1);
    this._apply(this.bones.jaw, this.cfg.jawAxis, this.cfg.jawAngle * w);
    // Lips part a little on top of the jaw drop, which is what reads as speech
    // rather than a slack jaw.
    this._apply(this.bones.lipUpper, this.cfg.lipAxis, -this.cfg.lipAngle * w);
  }

  /** Put every driven bone back on its bind pose. */
  reset() {
    for (const [b, q] of this.bind) b.quaternion.copy(q);
  }

  stats() {
    const n = (l) => l.length;
    return {
      upperLid: n(this.bones.upperLid),
      lowerLid: n(this.bones.lowerLid),
      jaw: n(this.bones.jaw),
      lips: n(this.bones.lipUpper) + n(this.bones.lipLower),
      brows: n(this.bones.brow),
    };
  }
}