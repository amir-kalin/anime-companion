import * as THREE from 'three';

/**
 * BoneDamping
 *
 * Post-mixer amplitude limiter for specific bone groups.
 *
 * ## Why this exists
 *
 * The Mixamo clips were authored for a generic humanoid skeleton. On this rig
 * the hand and finger bones are proportionally larger and sit further from the
 * body axis, so the same angular displacement that reads as a natural gesture
 * on the source skeleton becomes an exaggerated, flailing motion here.
 *
 * Rather than editing the clips (which are shared assets and would need to be
 * re-downloaded for every variant), this layer runs AFTER the mixer and pulls
 * each damped bone's local rotation toward its bind pose by a configurable
 * factor. A factor of 0 leaves the clip untouched; 1 would pin the bone
 * entirely. Values around 0.3-0.5 take the edge off without killing the
 * gesture.
 *
 * ## How it works
 *
 * For each damped bone, every frame:
 *   1. Read the mixer-written local quaternion (the "animated" pose)
 *   2. Slerp it toward the cached bind quaternion by the damping factor
 *   3. Write the result back
 *
 * This is the same pattern as ProceduralLife and FacialRig: a post-mixer
 * correction that layers on top of the settled clip pose. It deliberately
 * does NOT use `setEffectiveWeight` on the action (which would scale the whole
 * clip) — only the bones that need it are touched.
 *
 * Bones are matched by name prefix, so a single entry covers the whole chain
 * (e.g. `hand_l` covers the wrist and all its finger children).
 */

const _q = new THREE.Quaternion();

export class BoneDamping {
  /**
   * @param {THREE.Object3D} root rig root
   * @param {object} opts
   * @param {Array<{prefix: string, factor: number}>} [opts.groups]
   *   Each group: `prefix` is matched case-insensitively against bone names,
   *   `factor` is 0..1 (0 = no damping, 1 = fully pinned to bind).
   */
  constructor(root, { groups = [] } = {}) {
    this.root = root;
    this.groups = groups.filter((g) => g.factor > 0);

    /** @type {Map<THREE.Bone, {bind: THREE.Quaternion, factor: number}>} */
    this.damped = new Map();
    /** @type {Set<string>} bone names that were matched, for logging */
    this.matched = new Set();

    if (this.groups.length > 0 && root) {
      root.traverse((o) => {
        if (!o.isBone) return;
        const name = o.name.toLowerCase();
        for (const g of this.groups) {
          if (name.startsWith(g.prefix.toLowerCase())) {
            this.damped.set(o, {
              bind: o.quaternion.clone(),
              factor: g.factor,
            });
            this.matched.add(o.name);
            break;
          }
        }
      });
    }

    this.ready = this.damped.size > 0;
  }

  /**
   * Apply damping. Call AFTER AnimationMixer.update() so the bones hold the
   * clip's pose for this frame, and BEFORE any procedural layer that reads
   * those bones as a base.
   */
  update() {
    if (!this.ready) return;

    for (const [bone, { bind, factor }] of this.damped) {
      // Skip bones the mixer did not touch this frame — they still hold
      // their bind pose (or a procedural write), and slerping toward bind
      // would compound the procedural offset.
      // The mixer sets needsUpdate on bones it animated, which shows up as
      // a non-identity matrixWorldAutoUpdate flag change. But the reliable
      // signal is: if the bone's local quaternion still equals the bind
      // pose, the mixer did not move it this frame.
      _q.copy(bone.quaternion);
      if (_q.equals(bind)) continue;

      // Pull the animated rotation toward bind by the damping factor.
      // result = animated*(1-factor) + bind*factor
      bone.quaternion.copy(_q).slerp(bind, factor);
    }
  }

  /** Restore every damped bone to its exact bind pose. */
  reset() {
    for (const [bone, { bind }] of this.damped) {
      bone.quaternion.copy(bind);
    }
  }

  stats() {
    return {
      groups: this.groups.length,
      bones: this.damped.size,
      matched: [...this.matched].sort(),
    };
  }
}
