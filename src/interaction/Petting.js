import * as THREE from 'three';
import { KISS } from '../utils/config.js';

/**
 * Petting
 *
 * Pointer contact with the character's upper body starts a pet. While it is
 * active she reacts without any baked animation, all procedurally layered on
 * top of whatever clip is playing:
 *
 *  - eyes squint to a soft happy curve (the eyelid blendshapes, held at a
 *    partial value rather than fully closed)
 *  - head tilts and leans into the touch
 *  - gaze snaps to the touch point instead of wandering
 *
 * and she comments on it, via the LLM with the interaction as context.
 *
 * The reaction is deliberately *not* a fourth animation state. The spec defines
 * IDLE / TALKING / BORED, and a pet during BORED or TALKING should not hijack
 * the body — the procedural layer composes with whichever clip is live.
 */
export class Petting {
  /**
   * @param {object} opts
   * @param {import('../components/CharacterRig.js').CharacterRig} opts.rig
   * @param {THREE.Camera} opts.camera
   * @param {THREE.Object3D} opts.sceneTarget the object to raycast
   * @param {(event: string) => void} [opts.onReact] fired when she should speak
   * @param {() => void} [opts.onActivity] user-activity hook (resets inactivity)
   */
  constructor({ rig, camera, sceneTarget, onReact, onActivity }) {
    this.rig = rig;
    this.camera = camera;
    this.target = sceneTarget;
    this.onReact = onReact || (() => {});
    this.onActivity = onActivity || (() => {});

    this.active = false;
    this.strength = 0;        // 0..1 eased reaction amount
    this.point = new THREE.Vector3();      // world-space touch point
    this.pointSmooth = new THREE.Vector3(); // smoothed, so the head does not jitter
    this.lastSpokeAt = 0;
    this.spokeThisStroke = false;
    this.grabbed = false;     // pointer is down over her

    // Only the upper body is pettable; a hip click should not trigger this.
    // These are fractions of the rig's own height, so they hold regardless of
    // how the character is normalised or which camera framing is active.
    this.minY = 0.72;
    this.maxY = 0.98;

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._hit = new THREE.Vector3();

    this.holdMs = 0;              // how long the current stroke has lasted
    this.holdFired = false;        // this stroke already triggered the reward
    this.rewardCooldownUntil = 0; // prevents re-triggering while held down
  }

  /**
   * Convert a pointer event to NDC and raycast.
   * @returns {THREE.Vector3|null} world hit point
   */
  pick(clientX, clientY, rect) {
    if (!this.rig.model) return null;
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._ray.setFromCamera(this._ndc, this.camera);

    const hits = this._ray.intersectObject(this.rig.model, true);
    if (!hits.length) return null;

    const h = hits[0].point;
    // Normalised height within the character, for a body-region test.
    const box = new THREE.Box3().setFromObject(this.rig.model);
    const hgt = Math.max(1e-6, box.max.y - box.min.y);
    const t = (h.y - box.min.y) / hgt;
    if (t < this.minY || t > this.maxY) return null;

    return h;
  }

  /** Pointer down on her upper body. */
  begin(hit) {
    if (this.active) return;
    this.active = true;
    this.grabbed = true;
    this.spokeThisStroke = false;
    this.holdMs = 0;
    this.holdFired = false;
    this.point.copy(hit);
    this.pointSmooth.copy(hit);
    this.onActivity?.();
    // Speak on the first stroke only, so holding the mouse down is not a loop.
    this.speak('start');
  }

  /** Pointer moved while down. */
  move(hit) {
    if (!this.active || !hit) return;
    this.point.copy(hit);
  }

  end() {
    this.active = false;
    this.grabbed = false;
    this.holdMs = 0;
    this.holdFired = false;
  }

  /**
   * Fire a reaction line, rate-limited so a long pet does not queue speech.
   * @param {'start'|'again'} kind
   */
  speak(kind) {
    if (kind === 'again' && this.spokeThisStroke) return;
    const now = performance.now();
    if (now - this.lastSpokeAt < 9000) return;
    this.lastSpokeAt = now;
    this.spokeThisStroke = true;
    this.onReact(kind);
  }

  /** Re-derive the pettable band, e.g. when she sits down and is lower. */
  setHeightBand([minY, maxY]) {
    this.minY = minY;
    this.maxY = maxY;
  }
  /** Let the caller block the reward briefly after a kiss, if it wants to. */
  startCooldown(ms = KISS.cooldownMs) {
    this.rewardCooldownUntil = performance.now() + ms;
  }

  get rewardReady() {
    return performance.now() >= this.rewardCooldownUntil;
  }

  /**
   * @param {number} dt
   * @param {boolean} hovering pointer is over her pettable region
   * @param {(kind: 'kiss') => void} [onReward] fired when a stroke is sustained
   *   long enough to earn the KISS clip
   */
  update(dt, hovering, onReward) {
    // Ease in fast, out slow - a reaction should feel instant to start and
    // relax gently rather than snapping off.
    const target = this.active ? 1 : hovering ? 0.28 : 0;
    const rate = this.active ? 12 : 4;
    this.strength += (target - this.strength) * Math.min(1, rate * dt);

    // Smooth the touch point so the head lean is calm.
    if (this.active) this.pointSmooth.lerp(this.point, Math.min(1, 14 * dt));

    // Sustained stroke -> the KISS clip. A tap is not a kiss.
    if (this.active) {
      this.holdMs += dt * 1000;
      if (!this.holdFired && this.holdMs >= KISS.holdMs) {
        this.holdFired = true;
        if (this.rewardReady) {
          this.startCooldown();
          onReward?.('kiss');
        }
      }
    }
  }

  /** 0..1 eyelid squint: the "happy" curve without a dedicated blendshape. */
  get squint() {
    return this.strength * 0.42;
  }

  /**
   * World-space point the head should lean toward while petted.
   * @returns {THREE.Vector3|null}
   */
  get lookTarget() {
    if (this.strength < 0.02) return null;
    return this.pointSmooth;
  }
}
