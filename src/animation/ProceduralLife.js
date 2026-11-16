import * as THREE from 'three';
import { BLINK, SACCADE } from '../utils/config.js';

const smoothstep = (t) => t * t * (3 - 2 * t);
const rand = (a, b) => a + Math.random() * (b - a);

// Scratch objects reused every frame; the update runs at 60fps so per-frame
// allocation here would be pure GC pressure.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q1b = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

/**
 * BlinkController
 *
 * Fully code-driven blinking - no baked keyframes. A blink fires every 3-6s,
 * snapping shut over 70ms, holding 30ms, and reopening over 110ms, which
 * approximates a real ~210ms blink far better than a symmetric lerp.
 *
 * The eyelid is driven through blendshapes when the model has them, so it
 * composes correctly with any facial animation.
 */
export class BlinkController {
  constructor(rig) {
    this.rig = rig;

    this.PHASE = { WAIT: 'wait', CLOSE: 'close', HOLD: 'hold', OPEN: 'open', GAP: 'gap' };
    this.phase = this.PHASE.WAIT;
    this.phaseTime = 0;
    this.timer = rand(BLINK.minIntervalMs, BLINK.maxIntervalMs);

    this.value = 0;
    this.blinkCount = 0;
    this._doublePending = false;
  }

  reset({ immediate = false } = {}) {
    this.phase = this.PHASE.WAIT;
    this.phaseTime = 0;
    this.timer = immediate ? 0 : rand(BLINK.minIntervalMs, BLINK.maxIntervalMs);
    this.value = 0;
    this.rig.setBlink(0);
  }

  /** Trigger a blink now (e.g. on a user gesture, for a "reaction" blink). */
  trigger() {
    if (this.phase === this.PHASE.WAIT) {
      this.phase = this.PHASE.CLOSE;
      this.phaseTime = 0;
    }
  }

  /**
   * @param {number} dt
   * @param {number} weightScale per-state multiplier (blinking slows when bored)
   * @param {number} squint extra eyelid closure 0..1 from another layer (e.g.
   *   petting). Applied as a FLOOR rather than an addition, so a squint and a
   *   blink combine without the sum overshooting into a permanently shut eye.
   */
  update(dt, weightScale = 1, squint = 0) {
    this.phaseTime += dt * 1000;

    switch (this.phase) {
      case this.PHASE.WAIT: {
        this.timer -= dt * 1000 * weightScale;
        // Longer intervals between blinks, but still blinks occasionally.
        if (this.timer <= 0) this._startBlink();
        break;
      }
      case this.PHASE.CLOSE: {
        const t = THREE.MathUtils.clamp(this.phaseTime / BLINK.closeMs, 0, 1);
        this.value = smoothstep(t);
        if (t >= 1) { this.phase = this.PHASE.HOLD; this.phaseTime = 0; }
        break;
      }
      case this.PHASE.HOLD: {
        this.value = 1;
        if (this.phaseTime >= BLINK.holdMs) { this.phase = this.PHASE.OPEN; this.phaseTime = 0; }
        break;
      }
      case this.PHASE.OPEN: {
        const t = THREE.MathUtils.clamp(this.phaseTime / BLINK.openMs, 0, 1);
        this.value = 1 - smoothstep(t);
        if (t >= 1) this._endBlink();
        break;
      }
      case this.PHASE.GAP: {
        this.value = 0;
        if (this.phaseTime >= 60) {
          this.phase = this.PHASE.CLOSE;
          this.phaseTime = 0;
        }
        break;
      }
    }

    this._apply(Math.max(this.value, squint), weightScale);
    return this.value;
  }

  _apply(amount, weightScale) {
    // Floor semantics: squint shows through when not mid-blink, and a real
    // blink still reaches full closure.
    this.rig.setBlink(amount * weightScale);
  }

  _startBlink() {
    this.phase = this.PHASE.CLOSE;
    this.phaseTime = 0;
    this.blinkCount++;
  }

  _endBlink() {
    this.value = 0;
    this.rig.setBlink(0);
    // A second blink shortly after reads as a natural double-blink.
    if (this._doublePending) {
      this._doublePending = false;
      this.phase = this.PHASE.GAP;
      this.phaseTime = 0;
      return;
    }
    this.phase = this.PHASE.WAIT;
    this.phaseTime = 0;
    this.timer = rand(BLINK.minIntervalMs, BLINK.maxIntervalMs);
    if (Math.random() < BLINK.doubleBlinkChance) this._doublePending = true;
  }
}

/**
 * SaccadeController
 *
 * Eyes do not glide continuously - they jump between discrete fixations every
 * 2-4s. Each saccade reaches its new target in ~70ms with an ease-out, then
 * holds, then drifts back toward whatever the character is "interested" in
 * (the camera, or the pointer).
 *
 * The offsets are applied ADDITIVELY on top of whatever the AnimationMixer
 * produced this frame, so eye motion layers on top of the idle/talking/bored
 * clip instead of fighting it.
 */
export class SaccadeController {
  /**
   * @param {CharacterRig} rig
   * @param {(boneName: string) => boolean} isAnimatedBone supplied by the
   *   AnimationController. Decides whether the post-mixer value is a valid
   *   base for our additive offset (clip drives the bone) or whether we must
   *   fall back to the cached bind pose (no clip drives it, so reading the
   *   bone back would compound our own last frame's offset).
   * @param {(bone: THREE.Bone, out: THREE.Quaternion) => THREE.Quaternion|null} [getCleanQuaternion]
   *   Supplies the raw animation value computed by the mixer buffer, preventing
   *   compounding when Three.js skips updating stationary bone transforms.
   */
  constructor(rig, isAnimatedBone = () => false, getCleanQuaternion = null) {
    this.rig = rig;
    this.isAnimatedBone = isAnimatedBone;
    this.getCleanQuaternion = getCleanQuaternion;
    this._cleanQ = new THREE.Quaternion();
    this.enabled = Boolean(rig.bindings.eyeLeft && rig.bindings.eyeRight);

    this.current = new THREE.Vector2(0, 0); // yaw, pitch in radians
    this.from = new THREE.Vector2(0, 0);
    this.target = new THREE.Vector2(0, 0);
    this.interest = new THREE.Vector2(0, 0); // where it wants to look
    // Heavily smoothed copy of `current`, used for the head. Kept separate so
    // the head can never inherit a saccade's 70ms snap.
    this.headCurrent = new THREE.Vector2(0, 0);

    this.moveTime = 0;
    this.moveDuration = SACCADE.moveMs / 1000;
    this.holdTimer = rand(SACCADE.minHoldMs, SACCADE.maxHoldMs) / 1000;

    // Bind-pose quaternions, used only for bones no clip drives.
    this._restL = rig.bindings.eyeLeft?.quaternion.clone() ?? null;
    this._restR = rig.bindings.eyeRight?.quaternion.clone() ?? null;
    this._restHead = rig.bindings.head?.quaternion.clone() ?? null;
  }

  reset() {
    this.current.set(0, 0);
    this.from.set(0, 0);
    this.target.set(0, 0);
    this.headCurrent.set(0, 0);
    this.holdTimer = rand(SACCADE.minHoldMs, SACCADE.maxHoldMs) / 1000;
    this._aimEyes(0, 0);
    this._aimHead(0, 0);
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3|null} lookTarget world point the eyes are drawn to
   * @param {{yawBias?:number, pitchBias?:number}} [mood] per-state gaze bias
   */
  update(dt, lookTarget = null, mood = {}) {
    if (!this.enabled) return;

    this._updateInterest(lookTarget, mood);

    // Eyes: hold on the current fixation, then fire a saccade.
    if (this.moveTime >= this.moveDuration) {
      this.holdTimer -= dt;
      if (this.holdTimer <= 0) this._pickTarget();
    } else {
      this.moveTime += dt;
      const t = THREE.MathUtils.clamp(this.moveTime / this.moveDuration, 0, 1);
      // smoothstep, NOT easeOutCubic. A saccade is ballistic - slow to leave,
      // fast in the middle, slow to arrive - and easeOutCubic does the opposite:
      // its derivative is highest at t=0, so the first frame of the move jumped
      // 56% of the whole saccade. On a 6-11 degree eye movement that is a 3-6
      // degree snap in a single frame, which read as her head glitching every
      // time a new fixation fired (every 2-4s). smoothstep starts flat, so the
      // first frame is a few percent of the move and the eye travels instead of
      // jumping.
      this.current.lerpVectors(this.from, this.target, smoothstep(t));
      this._aimEyes(this.current.x, this.current.y);
    }

    // Head: updated EVERY frame, and driven by the smoothed *interest* direction
    // rather than the saccade. Two things matter here:
    //   - a saccade is a 70ms flick, so letting the head chase it snapped her
    //     neck ~10 degrees at the start and end of every saccade;
    //   - `interest` (where she is generally looking) is the stable quantity a
    //     head would actually turn toward, while the eyes dart around it.
    this._updateHead(dt);
  }

  _updateHead(dt) {
    const head = this.rig.bindings.head;
    if (!head || SACCADE.headFollow <= 0) return;

    // Frame-rate independent exponential approach.
    const k = 1 - Math.exp(-dt / SACCADE.headTimeConstant);
    this.headCurrent.x += (this.interest.x - this.headCurrent.x) * k;
    this.headCurrent.y += (this.interest.y - this.headCurrent.y) * k;
    this._aimHead(this.headCurrent.x, this.headCurrent.y);
  }

  /**
   * Aim both eyeballs at a gaze direction.
   *
   * The direction is built in the character's ROOT frame, where +Z is the
   * model's true facing, then rotated into world space. It is deliberately not
   * built in the head bone's local frame: that bone's local +Y is its bone
   * axis, not its gaze direction, so using it as a reference reports a bogus
   * pitch.
   */
  _aimEyes(yaw, pitch) {
    const { eyeLeft, eyeRight } = this.rig.bindings;
    if (!eyeLeft || !eyeRight) return;

    this.rig.root.updateWorldMatrix(true, false);
    _q1.setFromRotationMatrix(this.rig.root.matrixWorld);

    _v3.set(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    ).applyQuaternion(_q1).normalize();

    this._aimBone(eyeLeft, _v3, 1);
    this._aimBone(eyeRight, _v3, 1);
  }

  /** Aim the head, softened by SACCADE.headFollow. */
  _aimHead(yaw, pitch) {
    const head = this.rig.bindings.head;
    if (!head) return;

    this.rig.root.updateWorldMatrix(true, false);
    _q1.setFromRotationMatrix(this.rig.root.matrixWorld);

    _v2.set(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    ).applyQuaternion(_q1).normalize();

    this._aimBone(head, _v2, SACCADE.headFollow);
  }

  /**
   * Blend "where the character wants to look" from the interest point plus a
   * small random wander, so the eyes are never perfectly still and never
   * mechanically pinned to the cursor.
   */
  _updateInterest(lookTarget, mood) {
    this.interest.set(mood.yawBias || 0, mood.pitchBias || 0);
    if (!lookTarget) return;

    const head = this.rig.bindings.head || this.rig.root;
    _v1.setFromMatrixPosition(head.matrixWorld);
    _v2.subVectors(lookTarget, _v1);
    if (_v2.lengthSq() < 1e-8) return;
    _v2.normalize();

    // Convert into the CHARACTER's frame, NOT the head bone's local frame.
    // This rig's head bone points along its own local +Y (standard bone-axis
    // convention), so assuming its local +Z is "forward" reports a bogus ~22
    // degree pitch and pins the eyes at the clamp. The root frame is the
    // character's true facing (+Z) and is what the gaze offsets are relative to.
    this.rig.root.updateWorldMatrix(true, false);
    _q1.setFromRotationMatrix(this.rig.root.matrixWorld).invert();
    _v2.applyQuaternion(_q1);

    const yaw = Math.atan2(-_v2.x, _v2.z);
    const pitch = Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z));
    this.interest.x += THREE.MathUtils.clamp(yaw, -0.6, 0.6) * SACCADE.attraction;
    this.interest.y += THREE.MathUtils.clamp(pitch, -0.4, 0.4) * SACCADE.attraction;
  }

  _pickTarget() {
    this.from.copy(this.current);

    // The interest point (camera / pointer / mood bias) sets where she tends to
    // look; a random wander on top keeps each fixation distinct so the eyes
    // keep making real saccades instead of locking onto one spot.
    this.target.set(
      THREE.MathUtils.clamp(
        this.interest.x + rand(-1, 1) * SACCADE.maxYaw * SACCADE.wander,
        -SACCADE.maxYaw * 1.6,
        SACCADE.maxYaw * 1.6
      ),
      THREE.MathUtils.clamp(
        this.interest.y + rand(-1, 1) * SACCADE.maxPitch * SACCADE.wander,
        -SACCADE.maxPitch * 1.6,
        SACCADE.maxPitch * 1.6
      )
    );

    this.holdTimer = rand(SACCADE.minHoldMs, SACCADE.maxHoldMs) / 1000;
    // Long glances are rarer than short ones.
    if (Math.random() < 0.25) this.holdTimer *= 1.8;

    // Below the dead zone the move is imperceptible, so skip straight to the
    // next hold without burning a movement.
    if (this.from.distanceTo(this.target) < SACCADE.deadZone) {
      this.target.copy(this.from);
      return;
    }
    this.moveTime = 0;
  }

  /**
   * Rotate a bone so its gaze axis points along `worldDir`, as an offset on top
   * of the pose the mixer already produced.
   *
   * Why this is done with quaternions instead of Euler angles: in this rig the
   * eyeball bones look along their own local +Y (verified - the +Y axis points
   * within 0.0006 of the camera; +Z is perpendicular to it). Hand-written
   * Euler guesses about which local axis is "yaw" are therefore wrong, and the
   * eyes end up rolled or crossed. Building the rotation from the measured
   * current axis to the desired direction is correct for any bone-axis
   * convention, and it also makes the two eyes independently aim at the same
   * world direction, so no L/R mirroring hack is needed.
   *
   * @param {THREE.Bone} bone
   * @param {THREE.Vector3} worldDir desired gaze direction, world space
   * @param {number} weight 0..1 fraction of the full aim (head follow)
   */
  _aimBone(bone, worldDir, weight = 1) {
    // If the bone is animated by the mixer, restore its clean mixer quaternion
    // before measuring world quaternion or applying procedural aim. This prevents
    // compounding if Three.js skips updating the bone when clip values are held.
    const clean = this.getCleanQuaternion?.(bone, this._cleanQ);
    const base = clean || (this.isAnimatedBone(bone.name) ? bone.quaternion : this._restOf(bone));
    if (!base) return;

    if (clean) bone.quaternion.copy(clean);

    // getWorldQuaternion refreshes this bone's world matrix, so the base
    // orientation is whatever the mixer last wrote for this frame.
    bone.getWorldQuaternion(_q3);
    // On this rig, the eye bones look along local +Y, but the head bone faces
    // along local -Y (where (0, -1, 0) transforms to forward +Z in world space).
    const localFwd = (bone === this.rig.bindings.head) ? _v1.set(0, -1, 0) : _v1.set(0, 1, 0);
    _v4.copy(localFwd).applyQuaternion(_q3);       // current gaze axis, world

    // Rotation that swings the current gaze axis onto the desired direction.
    _q2.setFromUnitVectors(_v4, worldDir);
    if (weight < 1) {
      _q1b.identity().slerp(_q2, weight);
      _q2.copy(_q1b);
    }

    // Convert the world-space aim into the bone's own local space.
    _q1b.copy(_q3).invert().multiply(_q2).multiply(_q3);

    bone.quaternion.copy(base).multiply(_q1b);
    // Keep quaternion in canonical hemisphere relative to base to prevent 360-deg sign flips
    if (bone.quaternion.dot(base) < 0) {
      bone.quaternion.x = -bone.quaternion.x;
      bone.quaternion.y = -bone.quaternion.y;
      bone.quaternion.z = -bone.quaternion.z;
      bone.quaternion.w = -bone.quaternion.w;
    }
  }

  _restOf(bone) {
    if (bone === this.rig.bindings.eyeLeft) return this._restL;
    if (bone === this.rig.bindings.eyeRight) return this._restR;
    if (bone === this.rig.bindings.head) return this._restHead;
    return null;
  }
}

/**
 * BreathingController
 *
 * Procedural respiration and subtle weight micro-sway.
 * Human breathing expands the chest and subtly lifts the shoulders (~15 bpm).
 * This eliminates the "frozen statue" / uncanny mannequin appearance when idle.
 */
export class BreathingController {
  constructor(rig, getCleanQuaternion = null) {
    this.rig = rig;
    this.getCleanQuaternion = getCleanQuaternion;
    this._cleanQ = new THREE.Quaternion();
    this.time = 0;
    this._q = new THREE.Quaternion();
    this._axisX = new THREE.Vector3(1, 0, 0);

    const m = rig?.model;
    this.chest = m?.getObjectByName('spine_03_131') || m?.getObjectByName('spine_02_132') || m?.getObjectByName('Chest');
    this.clavL = m?.getObjectByName('clavicle_l_27') || m?.getObjectByName('Left_shoulder');
    this.clavR = m?.getObjectByName('clavicle_r_57') || m?.getObjectByName('Right_shoulder');
  }

  reset() {
    this.time = 0;
  }

  update(dt, rate = 1) {
    this.time += dt * rate;
    // Respiration ~15 breaths/min (0.25 Hz)
    const breath = Math.sin(this.time * 1.6);

    // Subtle chest expansion / rise
    if (this.chest) {
      const clean = this.getCleanQuaternion?.(this.chest, this._cleanQ);
      if (clean) this.chest.quaternion.copy(clean);
      this._q.setFromAxisAngle(this._axisX, breath * 0.015);
      this.chest.quaternion.multiply(this._q);
    }

    // Subtle shoulder rise on inhale
    const inhale = Math.max(0, breath);
    if (this.clavL && this.clavR) {
      const cleanL = this.getCleanQuaternion?.(this.clavL, this._cleanQ);
      if (cleanL) this.clavL.quaternion.copy(cleanL);
      this._q.setFromAxisAngle(this._axisX, inhale * 0.010);
      this.clavL.quaternion.multiply(this._q);

      const cleanR = this.getCleanQuaternion?.(this.clavR, this._cleanQ);
      if (cleanR) this.clavR.quaternion.copy(cleanR);
      this.clavR.quaternion.multiply(this._q);
    }
  }
}

/**
 * ProceduralLife
 *
 * Bundles the code-driven behaviours that make the character read as alive
 * between keyframed animations: breathing, blinking, and eye darts.
 */
export class ProceduralLife {
  /**
   * @param {CharacterRig} rig
   * @param {(boneName: string) => boolean} isAnimatedBone
   * @param {(bone: THREE.Bone, out: THREE.Quaternion) => THREE.Quaternion|null} [getCleanQuaternion]
   */
  constructor(rig, isAnimatedBone, getCleanQuaternion = null) {
    this.rig = rig;
    this.breathing = new BreathingController(rig, getCleanQuaternion);
    this.blink = new BlinkController(rig);
    this.saccade = new SaccadeController(rig, isAnimatedBone, getCleanQuaternion);
  }

  reset() {
    this.breathing.reset();
    this.blink.reset();
    this.saccade.reset();
  }

  /**
   * @param {number} dt
   * @param {{blinkWeight:number, squint:number, gaze:{yawBias:number,pitchBias:number}, lookTarget:THREE.Vector3|null}} p
   */
  update(dt, { blinkWeight = 1, squint = 0, gaze = {}, lookTarget = null } = {}) {
    this.breathing.update(dt);
    this.blink.update(dt, blinkWeight, squint);
    this.saccade.update(dt, lookTarget, gaze);
  }
}
