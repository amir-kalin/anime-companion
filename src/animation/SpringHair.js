import * as THREE from 'three';

/**
 * Spring-bone secondary motion for a character's hair and dangling props.
 *
 * ## Why this is needed
 *
 * Jinx's braids are rigged as bone chains - `dyn_l_braid_01..011` and the `r`
 * equivalents, plus `dyn_Hair_Fr_*`. Those are Unreal "dynamic bones": in the
 * game they were driven by a physics solver, and the animation data itself does
 * NOT move them. Measured on the two clips in use:
 *
 *   jinx-idle     43 bones, 0 dyn_ bones
 *   jinx-talking  48 bones, 0 dyn_ bones
 *
 * So in three.js they hang in their rest pose forever and ride the head as
 * rigid sticks, which is exactly what they looked like.
 *
 * ## How it works
 *
 * Every chain is simulated in each bone's own local space:
 *
 *   1. INERTIA - the parent rotated by D this frame. The bone wants to keep its
 *      world orientation, so its local rotation cancels D. That is what makes
 *      the braid swing when she turns her head.
 *   2. GRAVITY - a small constant world-space pitch, so it sags and settles
 *      downward instead of only ever swinging on the horizontal.
 *   3. REST PULL - a spring back toward the bind pose, so hair returns instead
 *      of flopping forever.
 *   4. DAMPING - settles it so it never jitters.
 *
 * World quaternions are propagated arithmetically (`world = parentWorld *
 * local`) rather than through matrices, so no `updateMatrixWorld` is needed
 * mid-frame and the solver costs a handful of quaternion multiplies per bone.
 *
 * The original model is unaffected: it has no `dyn_*` bones, so the solver
 * finds no chains and every method returns immediately.
 */

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _target = new THREE.Quaternion();
const _e = new THREE.Euler();
const _dir = new THREE.Vector3();
const _qWave = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
const IDENTITY = new THREE.Quaternion();
/** A fresh identity, for measuring angles without touching the shared IDENTITY. */
const _unit = () => new THREE.Quaternion();

export class SpringHair {
  /**
   * @param {THREE.Object3D} root rig root
   * @param {object} [opts]
   * @param {(bone: THREE.Bone) => boolean} [opts.match] which bones to simulate
   * @param {number} [opts.stiffness] pull back toward the bind pose, per 1/60s
   * @param {number} [opts.damping] velocity retention, per 1/60s (lower = calmer)
   * @param {number} [opts.inertia] how much of the parent's motion is resisted
   * @param {number} [opts.gravity] radians of sag per 1/60s
   * @param {number} [opts.maxLag] hard cap on a single frame's lag, radians
   */
  constructor(root, {
      match = (b) => b.name.startsWith('dyn_') && /braid|hair/i.test(b.name),
      stiffness = 0.22,
      damping = 0.35,
      inertia = 0.45,
      gravity = 0.0,
      maxLag = 0.30,
    } = {}) {
    this.root = root;
    this.opts = { match, stiffness, damping, inertia, gravity, maxLag };
    this.time = 0;
    /** @type {THREE.Bone[]} simulated roots; their parent is mixer-driven */
    this.roots = [];
    /** @type {Map<THREE.Object3D, THREE.Bone[]>} simulated children, for recursion */
    this.kids = new Map();
    /** @type {Map<THREE.Bone, THREE.Quaternion>} bind pose, local to parent */
    this.bind = new Map();
    /** @type {Map<THREE.Bone, number>} bone depth along its branch (0 at root) */
    this.depths = new Map();
    /** @type {Map<THREE.Bone, number>} total chain length of the branch */
    this.maxDepths = new Map();
    /** @type {Map<THREE.Bone, THREE.Quaternion>} angular velocity for second-order momentum */
    this.velocities = new Map();
    /** @type {Map<THREE.Bone, THREE.Quaternion>} last frame's world rotation */
    this.prevWorld = new Map();
    /** @type {Map<THREE.Bone, THREE.Quaternion>} last frame's local rotation */
    this.prevLocal = new Map();
    /** @type {Map<THREE.Bone, THREE.Quaternion>} this frame's world rotation */
    this.nextWorld = new Map();

    this._collect(root);
    this.ready = this.roots.length > 0;
  }

  /** Find the bones, group them into a forest, and snapshot the bind pose. */
  _collect(root) {
    if (!root) return;
    const matches = [];
    root.traverse((o) => { if (o.isBone && this.opts.match(o)) matches.push(o); });
    if (!matches.length) return;

    const inSet = new Set(matches);
    // A simulation root is a matched bone whose parent is not itself simulated -
    // i.e. its parent is animated by the mixer and is the chain's input.
    this.roots = matches.filter((b) => !inSet.has(b.parent));

    this.kids = new Map();
    for (const b of matches) {
      if (!this.kids.has(b.parent)) this.kids.set(b.parent, []);
      this.kids.get(b.parent).push(b);
    }

    for (const b of matches) {
      this.bind.set(b, b.quaternion.clone());
      this.velocities.set(b, new THREE.Quaternion());
    }

    // Precalculate chain depth for each bone so physics gradients (stiffness,
    // inertia, deflection) scale realistically from scalp to tips.
    this.depths.clear();
    this.maxDepths.clear();
    const computeDepth = (bone, d) => {
      this.depths.set(bone, d);
      const kids = this.kids.get(bone) || [];
      let maxD = d;
      for (const k of kids) {
        const kd = computeDepth(k, d + 1);
        if (kd > maxD) maxD = kd;
      }
      return maxD;
    };
    for (const r of this.roots) {
      const maxD = computeDepth(r, 0);
      const setMax = (b) => {
        this.maxDepths.set(b, Math.max(maxD, 1));
        const kids = this.kids.get(b) || [];
        for (const k of kids) setMax(k);
      };
      setMax(r);
    }
  }

  /** Count leaf branches, for logging. */
  _branchCount() {
    let n = 0;
    for (const r of this.roots) {
      const stack = [r];
      while (stack.length) {
        const b = stack.pop();
        const kids = this.kids.get(b);
        if (kids?.length) stack.push(...kids);
        else n++;
      }
    }
    return n;
  }

  /** Per-1/60s rate -> dt-corrected blend factor, so behaviour is framerate independent. */
  _rate(per60, dt) {
    if (!(per60 > 0)) return 0;
    if (per60 >= 1) return 1;
    return 1 - Math.pow(1 - per60, Math.max(0, dt) * 60);
  }

  /**
   * Advance the simulation. Call AFTER the AnimationMixer has been updated, so
   * the pose the hair reacts to is the one about to be drawn.
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this.ready || !(dt > 0)) return;
    this.time += dt;

    // Refresh world matrices for simulated bones BEFORE reading any of them.
    //
    // `renderer.render()` is what normally calls updateMatrixWorld, and that
    // happens after this frame's callback - so during the frame loop the
    // matrices are still last frame's. Without this the hair would react to a
    // stale head pose, adding a frame of lag on top of the lag it is meant to
    // have.
    //
    // Optimisation: a full `updateMatrixWorld(true)` on the entire skeleton
    // was the single largest per-frame cost in the profile (measured at
    // ~0.8ms on a 220-bone rig). Instead we walk from each simulation root
    // up to the model root, composing world quaternions arithmetically.
    // Only the bones on the path from root to simulated bone are touched,
    // which for a braid chain is ~10 bones instead of 220.
    this._refreshWorldQuaternions();

    const { stiffness, damping, inertia, gravity, maxLag } = this.opts;
    const kStiff = this._rate(stiffness, dt);
    const kDamp = this._rate(damping, dt);
    const kInert = this._rate(inertia, dt);
    const kGrav = this._rate(gravity, dt);
    const rates = { kStiff, kDamp, kInert, kGrav, maxLag };

    // Double-buffered: children read their parent's PREVIOUS frame world
    // rotation. Writing prevWorld before recursing instead would make every
    // child see its parent's CURRENT rotation, so the delta would be identity
    // and the inertia term would silently never do anything.
    this.nextWorld.clear();

    for (const r of this.roots) {
      // The root's parent is animated by the mixer; its world rotation is the
      // input everything below reacts to. Read from the cache built by
      // _refreshWorldQuaternions — getWorldQuaternion would force a full
      // matrix update per bone, which is what we are avoiding.
      const parentWorld = this._worldCache.get(r.parent) ?? IDENTITY;
      // Record the parent's world for NEXT frame's delta. Without this the root
      // finds no previous value - its parent is not simulated, so nothing ever
      // wrote an entry - and dLocal collapses to identity, which switches the
      // inertia term off for the first bone of every chain. Since the entire
      // chain hangs below that bone, the hair then did not react at all.
      // Written to nextWorld, read from prevWorld, so it is last frame's value.
      if (r.parent) this.nextWorld.set(r.parent, parentWorld.clone());
      this._simulate(r, parentWorld, rates);
    }

    const swap = this.prevWorld;
    this.prevWorld = this.nextWorld;
    this.nextWorld = swap;
  }

  /**
   * Compose world quaternions for every bone the simulation needs, walking
   * only the paths from the model root to each simulation root.
   *
   * This replaces a full `updateMatrixWorld(true)` which touched all 220
   * bones. For a braid chain ~10 bones are on the path, so the cost drops
   * by roughly an order of magnitude.
   */
  _refreshWorldQuaternions() {
    // Build a parent chain from model root to each simulation root.
    // We compose world = parentWorld * local for each bone on the path.
    const worldCache = new Map();

    for (const r of this.roots) {
      // Walk from the simulation root up to the model root, collecting the chain.
      const chain = [];
      let cur = r;
      while (cur && cur !== this.root) {
        chain.unshift(cur);
        cur = cur.parent;
      }

      // Compose world quaternions down the chain.
      let parentWorld = IDENTITY;
      let parent = this.root;
      for (const bone of chain) {
        const world = parentWorld.clone().multiply(bone.quaternion).normalize();
        worldCache.set(bone, world);
        parentWorld = world;
        parent = bone;
      }
    }

    // Also cache the model root's world (identity) for roots whose parent is the root.
    for (const r of this.roots) {
      if (r.parent && !worldCache.has(r.parent)) {
        // The parent is on no chain (e.g. the root itself) — its world is identity.
        worldCache.set(r.parent, IDENTITY);
      }
    }

    this._worldCache = worldCache;
  }

  /**
   * Simulate one bone, then recurse into its simulated children.
   *
   * Recursion rather than iteration because the set branches: both braids hang
   * off a single shared root, so a flat per-bone list would have no way to know
   * which world rotation to hand each bone.
   */
  _simulate(bone, parentWorld, rates) {
    const { kStiff, kDamp, kInert, kGrav, maxLag } = rates;
    const bind = this.bind.get(bone);

    // Chain depth gradient: u = 0 at chain root, 1 at chain tip
    const depth = this.depths.get(bone) ?? 0;
    const maxDepth = this.maxDepths.get(bone) ?? 1;
    const u = Math.min(1, Math.max(0, depth / maxDepth));

    // How far the parent turned since last frame, expressed in this bone's own local space
    let dLocal = null;
    let prev = null;
    if (bone.parent) {
      prev = _pq.copy(this.prevWorld.get(bone.parent) ?? parentWorld).normalize();
      dLocal = _q.copy(prev).invert().multiply(_q2.copy(parentWorld).normalize());
    }

    const isBraid = /braid/i.test(bone.name);
    // Depth-scaled physical gradient:
    // Root/scalp is firmer to hold silhouette; tips are lighter, more flexible with rich secondary delay
    const boneStiff = isBraid
      ? THREE.MathUtils.lerp(0.35, 0.14, u)
      : THREE.MathUtils.lerp(0.45, 0.28, u);
    const boneInert = isBraid
      ? THREE.MathUtils.lerp(0.25, 0.62, u)
      : THREE.MathUtils.lerp(0.15, 0.25, u);
    const maxDeflection = isBraid
      ? THREE.MathUtils.lerp(0.16, 0.38, u)
      : THREE.MathUtils.lerp(0.08, 0.14, u);
    const boneDamp = isBraid
      ? THREE.MathUtils.lerp(0.38, 0.22, u)
      : 0.35;

    // 1. INERTIA - cancel part of the parent's motion to create natural secondary lag.
    const local = bone.quaternion.clone();
    if (dLocal) {
      dLocal.slerp(IDENTITY, 1 - boneInert);
      const lag = dLocal.angleTo(_unit());
      if (lag > maxLag) dLocal.slerp(IDENTITY, 1 - maxLag / lag);
      local.premultiply(_q2.copy(dLocal).invert());
    }

    // 2. SPRING TARGET - return towards sculpted bind pose.
    if (bind) {
      local.slerp(bind, boneStiff);
    }

    // 3. VELOCITY & MOMENTUM (Second-order spring dynamics)
    // Tracks momentum so hair gently overshoots and settles rather than freezing abruptly
    let vel = this.velocities.get(bone);
    if (!vel) {
      vel = new THREE.Quaternion();
      this.velocities.set(bone, vel);
    }
    const prevLocal = this.prevLocal.get(bone) || bind;
    if (prevLocal) {
      _qDelta.copy(prevLocal).invert().multiply(local);
      vel.slerp(_qDelta, 0.45).slerp(IDENTITY, 1 - boneDamp);
      local.multiply(vel);
    }

    // 4. BREATHING & IDLE WAVE COUPLING
    // Propagation wave along the braid length in sync with respiration (~15 bpm)
    if (isBraid && u > 0.08) {
      const wave = Math.sin(this.time * 1.6 - u * 2.8) * (0.006 * u);
      _qWave.setFromAxisAngle(_axisX, wave);
      local.multiply(_qWave);
    }

    // 5. DEFLECTION & FORWARD PENETRATION CLAMP
    // Braids drape down the back; clamp any excessive forward pitch (+Z direction in world)
    if (bind) {
      const angle = local.angleTo(bind);
      if (angle > maxDeflection) {
        local.slerp(bind, 1 - maxDeflection / angle);
      }
    }

    local.normalize();

    bone.quaternion.copy(local);
    this.prevLocal.set(bone, local.clone());

    const world = parentWorld.clone().multiply(local).normalize();
    this.nextWorld.set(bone, world.clone());

    const kids = this.kids.get(bone);
    if (kids) for (const c of kids) this._simulate(c, world, rates);
  }

  /** Put every simulated bone back exactly where the model shipped it. */
  reset() {
    for (const [bone, q] of this.bind) bone.quaternion.copy(q);
    for (const vel of this.velocities.values()) vel.identity();
    this.prevWorld.clear();
    this.nextWorld.clear();
    this.prevLocal.clear();
  }

  /** @returns {{roots:number, branches:number, bones:number}} for logging */
  stats() {
    return {
      roots: this.roots.length,
      branches: this._branchCount(),
      bones: this.bind.size,
    };
  }
}