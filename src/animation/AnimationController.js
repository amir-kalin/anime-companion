import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { CROSSFADE_EPSILON, STATES } from '../utils/config.js';
import { retargetClip, collectBoneNames } from './retarget.js';

/**
 * AnimationController
 *
 * Wraps a single THREE.AnimationMixer and exposes a small, explicit state
 * machine over it: exactly one logical state is "current" at any moment, and
 * every change between states is a symmetric cross-fade.
 *
 * Why symmetric fades
 * -------------------
 * A one-sided `incoming.fadeIn(d)` leaves the outgoing action sitting at full
 * weight. If it is then simply stopped, the pose pops for a frame. Fading the
 * outgoing action to zero over the same window (and only stopping it once its
 * weight has actually reached ~0) removes the pop entirely, so the
 * IDLE -> TALKING -> IDLE round trip is seamless.
 *
 * Why clips are keyed by file
 * ---------------------------
 * All three Mixamo FBX files contain exactly one clip, and every one of them is
 * internally named "mixamo.com". Keying off `clip.name` would collapse the
 * three states into one, so states are keyed by their source URL instead and
 * the clip is renamed to match. See tools/audit-rig.mjs.
 */
export class AnimationController {
  /**
   * @param {THREE.Object3D} root Skeleton root; all clip bindings resolve here.
   */
  constructor(root, { onStateChange } = {}) {
    if (!root) throw new Error('AnimationController requires a root Object3D');

    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.timeScale = 1;

    /**
     * Bone names present on this skeleton, and a per-state record of how many
     * clip tracks had to be retargeted onto them. Both exist for one reason:
     * a downloaded model uses different bone names, and the resulting track
     * mismatch is silent, so it needs to be measurable rather than assumed.
     */
    this.modelBones = collectBoneNames(root);
    /**
     * Rest local rotation of every bone on THIS skeleton, by name.
     *
     * Clip tracks carry absolute local quaternions, so transferring them needs
     * both rest poses: the clip's own (source) and this model's (target). Without
     * the pair, any difference in rest orientation becomes a pose error - and on
     * this model that was 179.7 degrees on the armature root, which laid her
     * flat on the floor.
     * @type {Map<string, THREE.Quaternion>}
     */
    this.modelBind = new Map();
    root.traverse((o) => { if (o.isBone) this.modelBind.set(o.name, o.quaternion.clone()); });
    /** @type {Record<string, {rewritten: number, dropped: number, corrected: number}>} */
    this.retargetReport = {};

    /** @type {Map<string, THREE.AnimationAction>} state name -> action */
    this.actions = new Map();
    /** @type {Map<string, {clip: THREE.AnimationClip, loop: boolean}>} */
    this.clips = new Map();
    /** @type {Set<string>} bone names driven by at least one registered clip */
    this.animatedBones = new Set();
    /**
     * Extra clips for a state that already has a primary, so `talking` can
     * gesture differently each time instead of replaying one loop identically.
     * @type {Map<string, THREE.AnimationAction[]>}
     */
    this.variants = new Map();
    /** @type {Map<string, THREE.AnimationAction>} state -> the clip actually playing */
    this._active = new Map();

    /**
     * States whose clip is still downloading.
     * @type {Set<string>}
     */
    this._loading = new Set();
    /**
     * States that were asked for before their clip landed.
     *
     * This is what makes progressive loading safe. A one-shot like BORED can
     * fire the moment the app becomes interactive, and BORED's clip may still
     * be in flight. Dropping the request would make the model look like it
     * ignored the user; remembering it means the clip plays as soon as it
     * arrives, a second or two late.
     * @type {Set<string>}
     */
    this._pending = new Set();
    /**
     * Resolves when every clip has finished loading.
     * @type {Promise<this>|null}
     */
    this.allReady = null;

    this.state = null;
    this.timeInState = 0;
    this.busy = false;

    this._onStateChange = onStateChange || (() => {});
    this._loader = new FBXLoader();
    this._finishedListeners = [];
  }

  // ------------------------------------------------------------------ loading

  /**
   * Load one FBX per logical state.
   *
   * `priority` names the states to load FIRST, and the rest are loaded in the
   * background while the app is already interactive. This exists because of
   * the cold start on a phone: the seven clips are 25MB of FBX, and waiting
   * for all of them meant she did not appear until every one had downloaded
   * AND parsed. Loading IDLE and TALKING first and letting the rest stream
   * in means she is on screen and answering in a fraction of the time, and
   * BORED (8.9MB, the largest clip) arrives only if she is ever idle long
   * enough to need it.
   *
   * @param {Record<string, {url: string, loop: boolean}>} spec
   * @param {(state: string, ratio: number) => void} [onProgress]
   * @param {{priority?: string[]}} [opts]
   */
  loadAll(spec, onProgress, { priority = [] } = {}) {
    const entries = Object.entries(spec);
    this._loading = new Set(entries.map(([k]) => k));

    const loadSet = (list) =>
      Promise.all(
        list.map(([state, cfg]) =>
          this._loadOne(state, cfg).then(() => {
            onProgress?.(cfg.variant ? `${state} (variant)` : state, 1);
          })
        )
      );

    const first = entries.filter(([k]) => priority.includes(k));
    const rest = entries.filter(([k]) => !priority.includes(k));

    // The priority set gates the app becoming interactive.
    const ready = loadSet(first).then(() => {
      // Idle is the base state, so it has to be resident before the first
      // frame is drawn.
      this.transitionTo(STATES.IDLE, 0);
      return this;
    });

    // The rest run in the background. A failure here is not fatal: the state
    // is simply unavailable, and `transitionTo` reports it rather than
    // throwing.
    this.allReady = loadSet(rest)
      .then(() => {
        this._loading.clear();
        this._applyPending();
        return this;
      })
      .catch((err) => {
        this._loading.clear();
        console.warn(`[AnimationController] background clips failed: ${err?.message || err}`);
        return this;
      });

    return ready;
  }

  /**
   * Play any state that was requested before its clip finished downloading.
   *
   * Called when a clip registers, and again when the last background clip
   * lands, so a request that arrived early is honoured either way.
   */
  _applyPending() {
    for (const state of [...this._pending]) {
      if (!this._pickAction(state)) continue;   // still not here
      this._pending.delete(state);
      this.transitionTo(state, 0.4);
    }
  }

  _loadOne(state, cfg) {
    return new Promise((resolve, reject) => {
      this._loader.load(
        cfg.url,
        (group) => {
          // Mixamo ships a single clip; take it and rename to the state name.
          const source = group.animations?.[0];
          if (!source) {
            reject(new Error(`"${cfg.url}" contains no AnimationClip`));
            return;
          }
          source.name = state;

          // The clip file carries its OWN rig, with its own rest orientations. That is
          // the source bind pose the correction needs; without it there is
          // nothing to correct against.
          const sourceBind = new Map();
          group.traverse?.((o) => { if (o.isBone) sourceBind.set(o.name, o.quaternion.clone()); });

          // A downloaded model rarely uses the same bone names the clips were
          // authored against, and a name mismatch drops the track silently.
          // Rewriting here - before the mixer sees it - is what stops her
          // standing in her bind pose. A no-op for the original model.
          const { clip, rewritten, dropped, corrected, unmapped } = retargetClip(source, this.modelBones, {
            sourceBind,
            targetBind: this.modelBind,
          });
          this.retargetReport[state] = { rewritten, dropped, corrected };
          if (rewritten || dropped || corrected) {
            console.info(
              `[AnimationController] "${state}": ${rewritten} renamed, ${corrected} bind-corrected, `
              + `${dropped} foreign-unit translation tracks dropped`
              + (unmapped.length ? `; ${unmapped.length} bone(s) had no mapping: ${unmapped.slice(0, 6).join(', ')}` : '')
            );
          }

          // A variant is filed under the state it is an alternative FOR, not under its
    // own config key. `forState` names that state; without it a clip keyed
    // 'talkingAlt' lands in variants['talkingAlt'] while _candidates asks for
    // variants['talking'], and the alternation quietly does nothing.
    const slot = cfg.variant ? (cfg.forState ?? state) : state;
    this.register(slot, clip, { loop: cfg.loop, variant: Boolean(cfg.variant) });
            this._loading.delete(state);
            // If this state was asked for while it was still downloading, it
            // is playable now.
            if (this._pending.has(slot)) {
              this._pending.delete(slot);
              this.transitionTo(slot, 0.4);
            }
          resolve();
        },
        undefined,
        (err) => {
          // A clip that never arrives must not leave the controller
          // believing it is still loading, or every request for that state
          // would be queued forever.
          this._loading.delete(state);
          reject(new Error(`Failed to load animation "${state}" from ${cfg.url}: ${err?.message || err}`));
        }
      );
    });
  }

  /**
   * Bind a clip to a state and create its action.
   * @param {boolean} loop false => LoopOnce + ClampWhenFinished, so the pose
   *   holds on the last frame until we hand back to IDLE (used by BORED).
   *
   * Weight model (three r170):
   *   effectiveWeight = action.weight * weightInterpolant(t)
   * The interpolant is what a fade animates, so the BASE `weight` must stay 1
   * for any action that is allowed to play. Zeroing it here (the obvious
   * "start silent" instinct) makes every later fadeIn compute 0 * ramp = 0 and
   * the clip silently never contributes to the pose.
   */
  register(state, clip, { loop = true, variant = false } = {}) {
    const action = this.mixer.clipAction(clip);

    // Record which bones this clip drives. The procedural layer needs this: an
    // eye bone that a clip animates gets rewritten by the mixer every frame, so
    // the procedural offset must be applied on top of the fresh value. An eye
    // bone that NO clip touches would instead accumulate our own offset, so it
    // needs a cached bind-pose base. (Verified via tools/check-eye-tracks.mjs:
    // all three clips do drive Left_eye/Right_eye/LeftEye/RightEye and Head.)
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      if (dot <= 0) continue;
      this.animatedBones.add(track.name.slice(0, dot));
    }

    if (loop) {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }

    // Park it: not contributing, not advancing, base weight primed at 1 so the
    // first fadeIn works.
    action.enabled = false;
    action.paused = true;
    action.weight = 1;
    action._effectiveWeight = 0;

    // A variant is an extra clip for a state that already has a primary. It is
    // stored in a side map and NEVER in `actions`, because `actions` is keyed by
    // state and the fade-out sweep iterates it: a second entry under the same
    // key would overwrite the primary, and one under a different key would be
    // faded out on the very transition that just started it.
    if (variant) {
      if (!this.variants.has(state)) this.variants.set(state, []);
      this.variants.get(state).push(action);
    } else {
      this.actions.set(state, action);
      // Only the primary is recorded here. A variant writing to the same key
      // would replace the primary's entry, and `durationOf` (used for the boot
      // log) would then report whichever clip happened to load last.
      this.clips.set(state, { clip, loop });
    }
    this._quatBindings = null;
    return action;
  }

  /**
   * Every clip registered for a state: the primary first, then any variants.
   * @returns {THREE.AnimationAction[]}
   */
  _candidates(state) {
    const primary = this.actions.get(state);
    const extra = this.variants.get(state) ?? [];
    return primary ? [primary, ...extra] : [...extra];
  }

  /**
   * Choose which clip plays a state, avoiding an immediate repeat when there is
   * a choice. With one clip this returns it unchanged, so a state that has no
   * variants behaves exactly as it did before this existed.
   */
  _pickAction(state) {
    const options = this._candidates(state);
    if (options.length <= 1) return options[0] ?? null;
    const current = this._active.get(state);
    const others = options.filter((a) => a !== current);
    return others[Math.floor(Math.random() * others.length)] ?? options[0];
  }

  // ------------------------------------------------------------- state machine

  /**
   * Cross-fade to a new state.
   *
   * @param {string} next        target state name
   * @param {number} [duration]  fade time in seconds (spec default 0.5s)
   * @param {object} [opts]
   * @param {boolean} [opts.restart=false] rewind the target before fading in.
   *   Needed for one-shot states that should replay on re-entry.
   * @returns {boolean} whether the state actually changed
   */
  transitionTo(next, duration = 0.5, { restart = false } = {}) {
    const action = this._pickAction(next);
    if (!action) {
      // The clip may simply not have arrived yet. With progressive loading,
      // BORED can be requested seconds before its 8.9MB file lands, and
      // dropping the request would make the model look like it ignored the
      // user. Queue it instead: it plays the moment the clip is here.
      if (this._loading.has(next)) {
        this._pending.add(next);
        return false;
      }
      console.warn(`[AnimationController] unknown state "${next}"`);
      return false;
    }
    // Same state and nothing asked for a replay: still nothing to do. Note this
    // is checked against the STATE, not the chosen clip, so alternating between
    // two variants cannot spam re-entries.
    if (this.state === next && !restart) return false;

    const previous = this.state;
    this.state = next;
    this.timeInState = 0;
    this._active.set(next, action);

    const fade = duration > 0 ? duration : CROSSFADE_EPSILON;

    // --- incoming
    if (action.paused || restart) action.reset();
    action.paused = false;
    action.enabled = true;
    action.play();
    // Base weight 1; the fade interpolant supplies the 0 -> 1 ramp.
    action.weight = 1;
    action.fadeIn(fade);

    // --- outgoing: ramp the interpolant 1 -> 0 over the same window, so the
    // blend is symmetric and the pose does not pop when the old action stops.
    //
    // Every action is considered, INCLUDING the other variants of the state
    // being entered - otherwise the clip that played last time would keep
    // contributing on top of the new one and she'd blend two gestures. The one
    // action skipped is the exact instance just started.
    for (const other of this._allActions()) {
      if (other === action) continue;
      if (!other.enabled && other.getEffectiveWeight() <= CROSSFADE_EPSILON) continue;
      other.weight = 1;
      other.fadeOut(fade);
    }

    this._onStateChange(next, previous);
    return true;
  }

  /** Every registered action: primaries and variants alike. */
  _allActions() {
    const out = [...this.actions.values()];
    for (const list of this.variants.values()) out.push(...list);
    return out;
  }

  /** Jump to a state with no fade (used once, on first load). */
  playImmediately(next) {
    const action = this._pickAction(next);
    if (!action) return false;
    // All actions, variants included: a variant left enabled here would keep
    // contributing to the pose on top of the one being started.
    for (const other of this._allActions()) {
      other.enabled = false;
      other.setEffectiveWeight(0);
    }
    action.reset();
    action.paused = false;
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.play();
    this.state = next;
    this.timeInState = 0;
    this._onStateChange(next, null);
    return true;
  }

  has(name) {
    return this.actions.has(name);
  }

  /**
   * Weight snapshot for the HUD, reused array to avoid per-frame allocation.
   * @returns {[string, number][]}
   */
  getWeightSnapshot() {
    if (!this._weightSnapshot) this._weightSnapshot = [];
    const snap = this._weightSnapshot;
    snap.length = 0;
    for (const [name, action] of this.actions) {
      snap.push([name, action.getEffectiveWeight()]);
    }
    return snap;
  }

  /** Whether any registered clip drives this bone (see register()). */
  animatesBone(boneName) {
    return this.animatedBones.has(boneName);
  }

  /**
   * Return the clean, uncorrupted local rotation computed by the mixer for this frame.
   * Three.js PropertyMixer stores this in buffer[stride ... 2*stride].
   * If Three.js skips calling binding.setValue() because consecutive frames had
   * identical values, reading node.quaternion directly would yield an old procedural
   * offset. Reading the PropertyMixer buffer gives the true raw animation value.
   * @param {THREE.Bone} bone
   * @param {THREE.Quaternion} out
   * @returns {THREE.Quaternion|null}
   */
  getCleanQuaternion(bone, out) {
    if (!bone || !this.mixer || !this.mixer._bindings) return null;
    if (!this._quatBindings) {
      this._quatBindings = new Map();
      for (const b of this.mixer._bindings) {
        if (b.binding?.parsedPath?.propertyName === 'quaternion' && b.binding?.node) {
          this._quatBindings.set(b.binding.node, b);
        }
      }
    }
    const pm = this._quatBindings.get(bone);
    if (!pm || !pm.buffer) return null;
    const s = pm.valueSize;
    // In Three.js PropertyMixer, buffer layout is [incoming | accu0 | accu1 | orig].
    // accu0 is buffer[s..2s-1] and accu1 is buffer[2s..3s-1], interleaved by pm._accuIndex.
    const idx = (pm._accuIndex === 0) ? s : (2 * s);
    return out.set(pm.buffer[idx], pm.buffer[idx + 1], pm.buffer[idx + 2], pm.buffer[idx + 3]);
  }

  get durationOf() {
    return (name) => this.clips.get(name)?.clip.duration ?? 0;
  }

  // -------------------------------------------------------------------- ticking

  /**
   * Advance the mixer. Call once per frame BEFORE the procedural layer, so
   * blink/saccade offsets are applied on top of a settled pose.
   */
  update(dt) {
    this.mixer.update(dt);
    this.timeInState += dt;

    // Retire fully faded-out actions. three already sets `enabled = false`
    // when a fade-out interpolant reaches 0; stopping here just removes them
    // from the active set so they stop costing mixing time. The base `weight`
    // is deliberately left at 1 so a later fadeIn still works.
    for (const [name, action] of this.actions) {
      if (name === this.state) continue;
      if (!action.enabled && action.getEffectiveWeight() <= CROSSFADE_EPSILON) {
        action.stop();
      }
    }
  }

  /**
   * Watch a one-shot state and fire once it reaches its last frame.
   * ClampWhenFinished keeps the pose held, so the hold looks intentional
   * during the fade back to idle.
   *
   * three dispatches 'finished' on the AnimationMixer (not the action), with
   * the originating action on the event, so the listener is registered once on
   * the mixer and filtered by identity.
   */
  watchOnce(state, onFinished) {
    const action = this.actions.get(state);
    if (!action) return;

    const handler = (event) => {
      if (event.action !== action) return;
      if (this.state !== state) return;
      onFinished();
    };
    this.mixer.addEventListener('finished', handler);
    this._finishedListeners.push({ action, handler });
  }

  dispose() {
    for (const { action, handler } of this._finishedListeners) {
      this.mixer?.removeEventListener('finished', handler);
    }
    this._finishedListeners.length = 0;
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.root);
    this.mixer = null;
    this._quatBindings = null;
    this.actions.clear();
    this.clips.clear();
  }
}
