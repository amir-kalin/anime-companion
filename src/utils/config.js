/**
 * Central tuning + asset-name configuration.
 *
 * Every magic number, URL and rig-specific name lives here so the runtime
 * modules stay generic and a future model swap is a one-file change.
 *
 * Naming facts discovered by `npm run inspect:fbx` (see README):
 *  - The character rig and all three Mixamo clips use IDENTICAL bone names
 *    (71 bones, 0 unmatched), so clips bind by name with no retargeting.
 *  - All three clips are internally named "mixamo.com", so states must be
 *    keyed by source FILE, never by AnimationClip.name.
 *  - No clip contains a Hips position track, so there is no root motion to
 *    cancel out.
 */

export const MODEL = {
  url: 'models/character/jinx.glb',
  // The mesh is authored in centimetres (~2331 units tall) and faces +Z.
  // Normalising to ~1.62 world units reads as a stylized anime proportion.
  targetHeight: 1.62,
  // Centred on the root bone rather than the bounding box, so a wide
  // bounding box (hair, skirt) never pushes the character off-frame.
  centerOnBone: 'Hips',
};

export const ANIMATIONS = {
  // --- Standing Idle (with natural weight-shift sway variant)
  idle: { url: 'models/animations/jinx-idle.fbx', loop: true, fadeIn: 0.5, fadeOut: 0.5 },
  idleAlt: {
    url: 'models/animations/idle.fbx', loop: true, fadeIn: 0.5, fadeOut: 0.5,
    variant: true,
    forState: 'idle',
  },

  // --- Expressive Talking (gesturing animations for natural conversation)
  talking: { url: 'models/animations/jinx-talking.fbx', loop: true, fadeIn: 0.35, fadeOut: 0.4 },
  talkingAlt: {
    url: 'models/animations/jinx-talking-alt.fbx', loop: true, fadeIn: 0.35, fadeOut: 0.4,
    variant: true,
    forState: 'talking',
  },
  talkingExpressive: {
    url: 'models/animations/talking.fbx', loop: true, fadeIn: 0.35, fadeOut: 0.4,
    variant: true,
    forState: 'talking',
  },

  // --- Emotional One-Shots
  // BORED: Real sulking / foot-tapping / impatient weight-shift animation
  bored: { url: 'models/animations/bored.fbx', loop: false, fadeIn: 0.6, fadeOut: 0.7 },

  // KISS: Real kiss / loving lean-in reward animation
  kiss: { url: 'models/animations/kiss.fbx', loop: false, fadeIn: 0.4, fadeOut: 0.6 },

  // --- Seated States (fitted chair sitting clips)
  sittingIdle: { url: 'models/animations/sitting-idle.fbx', loop: true, fadeIn: 0.6, fadeOut: 0.6, seated: true },
  sittingTalking: { url: 'models/animations/sitting-talking.fbx', loop: true, fadeIn: 0.5, fadeOut: 0.5, seated: true },
};

export const STATES = {
  IDLE: 'idle',
  TALKING: 'talking',
  // Not a state: a second clip for TALKING. Listed here only so it is not
  // mistaken for one - the controller treats a `variant: true` entry as an
  // extra clip for an existing state rather than a state of its own.
  BORED: 'bored',
  KISS: 'kiss',
  SITTING_IDLE: 'sittingIdle',
  SITTING_TALKING: 'sittingTalking',
};

/** States that have her sitting down, and therefore need the chair. */
export const SEATED_STATES = new Set([STATES.SITTING_IDLE, STATES.SITTING_TALKING]);

/**
 * The chair prop, auto-fitted to where the sitting clips actually put her.
 *
 * Sizing rule: scale the chair to a real seat height relative to her height
 * (a dining chair seat is ~0.26 of standing height), NOT to the 0.530 hip
 * height baked into the clip. Fitting the seat to the baked hip height inflates
 * the chair by ~30% into an oversized armchair. Instead the chair keeps true
 * proportions and she is sunk onto it, which is also what a real body does when
 * it sits on a cushion.
 */
export const CHAIR = {
  url: 'models/props/palermo-chair.glb',
  /**
   * Seat height as a fraction of her standing height. 0.26 is a normal dining
   * chair; 0.30 is a lounge chair. The chair is scaled so its seat lands here.
   */
  seatRatioOfHeight: 0.3,
  /**
   * Hip height each sitting clip bakes in, measured by
   * tools/measure-sit-hips.mjs. The two clips do NOT agree (idle is 15mm lower
   * than talking), so the sink is computed per state; using one shared number
   * leaves one of the two states floating above the seat.
   */
  bakedHipY: { sittingIdle: 0.5145, sittingTalking: 0.5293 },
  /**
   * Hip depth each sitting clip bakes in, measured by the same tool. As with Y,
   * the two clips disagree (talking is 10mm further forward than idle), so the
   * seated Z offset has to be per state for the same reason.
   *
   * Both are non-zero. The clips do NOT park the hips at Z=0, which is what the
   * earlier `forward` comment assumed.
   */
  bakedHipZ: { sittingIdle: 0.0283, sittingTalking: 0.0386 },
  /**
   * How far her hip joint should sit ABOVE the seat surface.
   *
   * A seated body does not rest with its hip joint on the cushion: the thigh and
   * glute mass sit below the joint, and the cushion compresses under them. So the
   * joint lands a little above the surface. Setting this to 0 puts the joint
   * exactly on the seat, which looks like she has sunk into the upholstery.
   */
  seatClearance: 0.05,
  /**
   * Where her hip joint should sit FORWARD of the chair's geometric centre, as a
   * fraction of the chair's depth.
   *
   * This replaces a pair of rig-unit knobs (`forward` and `pushBack`) that both
   * meant "sit forward" and cancelled each other out. The chair is 0.833 deep,
   * so `pushBack: 0.1` slid it back 0.0833 while `forward: 0.09` pushed her
   * forward by 0.09 — a net of ~0.0066 before the clips' own baked-in hip depth
   * is even counted. Her hips ended up ~5% of the seat depth in front of the
   * chair centre, which is what made her look buried in the upholstery instead
   * of seated on it.
   *
   * A fraction of seat depth is the meaningful unit: it survives swapping the
   * chair, and 0.5 is exactly the front edge, so the safe range is self-evident.
   */
  hipForward: 0.3,
  /**
   * Her hips sit at y = 0.530 in rig units when seated (measured across the
   * clip). This is the cap on how far she is allowed to sink, so a badly
   * proportioned chair cannot drop her through the floor.
   */
  maxSink: 0.09,
  /**
   * Slide the chair itself backward along the floor, as a fraction of its depth.
   *
   * Normally 0. This is a prop-placement nudge ("the chair sits too far
   * forward on the stage"), not a seating adjustment — `hipForward` owns where
   * she sits on the seat. It was non-zero at 0.1 while `hipForward`'s
   * predecessor `forward` was also non-zero, and the two fought.
   */
  pushBack: 0,
  /**
   * Fallback seat height as a fraction of chair height, used when no separate
   * seat mesh can be identified. A chair back rises well above the seat, so 0.45
   * of total height is typical for a dining chair.
   */
  seatRatio: 0.45,
  /**
   * Material downgrades for the prop. The GLB ships near-white upholstery at
   * full env intensity, which blows out to flat white under the scene's IBL and
   * outshouts the character. It is background dressing, so it is deliberately
   * toned down rather than reproduced faithfully.
   */
  tone: {
    albedoScale: 0.42,      // pull the near-white albedo down out of clipping
    envMapIntensity: 0.2,   // fabric should not mirror the environment
    minRoughness: 0.9,
  },
};

/**
 * Petting -> KISS.
 *
 * A tap is not a kiss. Holding the pointer on her for this long is what turns
 * petting into a reward, so the interaction has a shape: light strokes get a
 * spoken reaction, a sustained stroke gets the kiss clip.
 */
export const KISS = {
  holdMs: 1600,
  // Cooldown after the clip, so holding the button down cannot re-trigger it.
  cooldownMs: 20_000,
};

/**
 * Cross-fade weighting.
 *
 * Actions are cross-faded in *and* out symmetrically. A single fadeIn on the
 * incoming action leaves the outgoing action fully weighted when it stops,
 * which snaps the pose; fading both to zero avoids the pop. Weights are
 * managed manually rather than via AnimationUtils.makeClipAdditive so the
 * controller stays the single source of truth for the whole body.
 */
export const CROSSFADE_EPSILON = 0.001;

/*
 * BODY_MOOD was removed along with animation/BodyLanguage.js.
 *
 * That layer added procedural breathing, sway, posture and finger fidget, and it
 * made her spin: her hips drifted 176 degrees while standing still. The cause
 * was mine — every bone was registered in all six motion channels, and for a
 * clip-driven bone the base was read from the CURRENT quaternion, so each
 * channel compounded the previous one's output, six times per bone per frame.
 * Fixing that exposed a second problem I could not resolve safely: the local
 * rotation axis for each bone had been chosen by eye rather than measured, and
 * on this rig several of those axes move the child 20 units for 10 degrees, on a
 * character 1.62 units tall.
 *
 * She is back to the clips plus ProceduralLife (blink and saccades), which are
 * measured, tested, and were never in question. Bring the layer back only with a
 * rig whose per-bone axes have been measured, and with a test that asserts a
 * standing-still rig does not drift.
 */

/** Inactivity handler: idle this long with no speech/input, then BORED. */
export const INACTIVITY = {
  timeoutMs: 15_000,
  // Guard so a single huge TTS clip does not immediately re-trigger BORED
  // the moment it finishes; user activity also resets it.
  cooldownMs: 15_000,
};

/**
 * Procedural blink.
 * A real blink is ~100-150ms close and a touch slower open, with an
 * near-instant onset so it reads as a snap rather than a slow squint.
 */
/**
 * Petting reaction prompts.
 *
 * Two parts, and both are needed:
 *  - `stance` goes in the system message and sets the emotional direction.
 *  - `narration` is sent as the USER turn.
 *
 * The user turn is not optional: LM Studio's Qwen3.5 chat template raises
 * `No user query found in messages.` when the conversation has no user message,
 * so a system-only request 500s. A stage-direction in asterisks reads to the
 * model as an action happening to it, which is exactly the framing wanted.
 */
export const PET_PROMPTS = {
  start: {
    stance:
      'The user has just stroked your hair. React warmly and naturally to being ' +
      'petted, and say you are enjoying it.',
    narration: '*strokes your hair affectionately*',
  },
  again: {
    stance:
      'The user is petting you again. React with a little more warmth, as if you ' +
      'enjoy it more each time.',
    narration: '*strokes your hair again, and leans into it happily*',
  },
  kiss: {
    stance:
      'You just kissed the user because they kept petting you. Be a little shy ' +
      'and pleased about it, but not embarrassed. Short and warm.',
    narration: '*leans in and gives you a quick kiss, then pulls back a little shy*',
  },
};

/**
 * Procedural blink.
 *
 * Close + hold + open = 150ms, matching the spec. The close is deliberately the
 * fastest phase and the open the slowest, which is what makes a blink read as a
 * snap rather than a slow squint.
 */
export const BLINK = {
  minIntervalMs: 3_000,
  maxIntervalMs: 6_000,
  closeMs: 50,
  holdMs: 30,
  openMs: 70,
  // Occasionally fire a double-blink for a more human rhythm.
  doubleBlinkChance: 0.18,
  // Blink harder when bored / talking than when fully idle.
  talkingWeight: 1.0,
  idleWeight: 0.85,
  boredWeight: 0.55,
};

/**
 * Saccades: rapid, small, ballistic eye movements. Humans do not glide the
 * eyes continuously — they jump. Each move is a fast ease to a new target,
 * then a hold, then a slow drift back to centre.
 */
export const SACCADE = {
  minHoldMs: 2_000,
  maxHoldMs: 4_000,
  // Peak angular offset in radians (~7 deg) - deliberately small.
  maxYaw: 0.12,
  maxPitch: 0.075,
  // Time to reach the new target. Fast enough to read as a flick, long enough
  // to survive 60fps: at 70ms a saccade was only ~4 frames, and the easing
  // front-loaded the first of them into a visible snap. 100ms is ~6 frames.
  moveMs: 100,
  // How much of the peak offset the random wander may use. This must be large
  // enough that consecutive targets actually differ, otherwise the dead zone
  // rejects every saccade and the eyes never move.
  wander: 0.6,
  // Minimum angular change worth making. Kept small so it only suppresses
  // truly imperceptible jitter, not real glances.
  deadZone: 0.015,
  // How strongly the eyes are drawn toward the camera/pointer target (0-1).
  attraction: 0.7,
  // Head follow. Deliberately small AND heavily smoothed: driving the head
  // straight from the saccade value snapped her neck once per saccade, because
  // a saccade is a 70ms flick while a real head turn takes about a second.
  // headTimeConstant is that smoothing, in seconds - raise it for lazier drift.
  headFollow: 0.16,
  headTimeConstant: 1.8,
};

/**
 * Per-state gaze bias and blink rate.
 * BORED looks down and away; TALKING keeps the eyes engaged with the user.
 */
export const GAZE = {
  idle: { yawBias: 0, pitchBias: 0, blinkWeight: BLINK.idleWeight },
  talking: { yawBias: 0, pitchBias: -0.01, blinkWeight: BLINK.talkingWeight },
  bored: { yawBias: 0.05, pitchBias: -0.07, blinkWeight: BLINK.boredWeight },
};

/**
 * Viseme / lip-sync.
 *
 * This model exposes the full Oculus `vrc.v_*` viseme set, which is exactly
 * what audio-driven lip-sync wants. Legacy `A` / `O` / `CH` fallbacks keep the
 * system working on simpler models.
 */
export const VISEMES = {
  aa: ['vrc.v_aa', 'aa', 'A'],
  ch: ['vrc.v_ch', 'ch', 'CH'],
  dd: ['vrc.v_dd', 'dd'],
  // `ee` is the VRM 1.0 and ARKit spelling; only VRM 0.x / Oculus used `e`.
  // Order matters: a model carrying both resolves the Oculus name first.
  e: ['vrc.v_e', 'ee', 'e', 'E'],
  // `fv` is the VRM 1.0 / ARKit name for this same lip shape.
  ff: ['vrc.v_ff', 'ff', 'fv', 'F'],
  ih: ['vrc.v_ih', 'ih', 'I'],
  kk: ['vrc.v_kk', 'kk', 'K'],
  nn: ['vrc.v_nn', 'nn'],
  oh: ['vrc.v_oh', 'oh'],
  ou: ['vrc.v_ou', 'ou', 'U'],
  pp: ['vrc.v_pp', 'pp', 'M'],
  rr: ['vrc.v_rr', 'rr', 'R'],
  sil: ['vrc.v_sil', 'sil'],
  ss: ['vrc.v_ss', 'ss', 'S'],
  th: ['vrc.v_th', 'th'],
};

export const LIPSYNC = {
  // Below this RMS the mouth is closed; protects against noise floor driving
  // a permanently open mouth between words.
  silenceRms: 0.012,
  // RMS is normalised against this before driving the jaw.
  rmsFullScale: 0.32,
  // Asymmetry of the response: fast attack, slower release, which is how a
  // mouth actually behaves and stops it from chattering on consonants.
  attack: 0.55,
  release: 0.16,
  // Visemes other than `aa` are driven at a fraction of the jaw, since only
  // jaw opening is reliably inferable from loudness alone.
  shapingScale: 0.7,
  // Attack/release smoothing per frame at 60fps.
  smoothing: 0.65,
};

/** Blink blendshape candidates, best first. */
export const BLINK_SHAPES = {
  both: ['Blink', 'blink', 'EyeBlink', 'eye_close', 'BlinkAll'],
  // VRM 1.0 ships `blinkLeft`/`blinkRight`; VRM 0.x and Oculus ship
  // `BlinkLeft`/`BlinkRight`. MorphRegistry folds case, so both spellings
  // resolve to the same key and only one entry is needed for each side.
  left: ['Blink L', 'Blink_L', 'BlinkLeft', 'blink_l', 'LeftEyeBlink', 'eyeBlinkLeft'],
  right: ['Blink R', 'Blink_R', 'BlinkRight', 'blink_r', 'RightEyeBlink', 'eyeBlinkRight'],
};

/** Eyeball bones used for saccades, best first (see probe-rig output). */
export const EYE_BONES = {
  left: ['Left_eye', 'LeftEye', 'left_eye', 'Eye_L', 'eye.L'],
  right: ['Right_eye', 'RightEye', 'right_eye', 'Eye_R', 'eye.R'],
  // Bone lookups are case-insensitive, so a VRM's `head`/`leftEye`/`rightEye`
  // and a Mixamo's `Head`/`LeftEye` both land on the candidates above.
  head: ['Head', 'head', 'Neck'],
};

/**
 * Spring-bone secondary motion for hair and dangling props.
 *
 * Jinx's braids (`dyn_l_braid_*`, `dyn_r_braid_*`) and front hair
 * (`dyn_Hair_Fr_*`) are Unreal dynamic-bone chains. The animation clips do not
 * drive them at all - measured: 0 `dyn_` bones in either clip - so without
 * this they hang rigid and ride the head like sticks.
 *
 * Rates are expressed per 1/60s and converted for the real frame time, so the
 * motion looks the same at 30fps and 144fps.
 *
 *   stiffness - pull back toward the bind pose. Higher = stiffer, less swing.
 *   damping   - how much motion is retained. Lower = calmer.
 *   inertia   - how much of the parent's motion the hair resists. Higher =
 *               more lag when she turns her head.
 *   gravity   - downward sag, radians per 1/60s.
 */
export const HAIR = {
  stiffness: 0.20,
  damping: 0.35,
  inertia: 0.45,
  gravity: 0.0,
  /** Cap on a single frame's lag so a teleport cannot fling the hair. */
  maxLag: 0.25,
};

/**
 * Bone-driven face: blinking and mouth opening.
 *
 * This model has no blendshapes, so the usual morph path is inert. Her face is
 * a bone rig instead, and those bones are skinned to the mesh (the jaw alone
 * drives 503 vertices at full weight), so the face can still be animated.
 *
 * `lidAngle` and `jawAngle` are radians. They were derived from bone geometry
 * rather than by watching her, so they are deliberately conservative and are
 * single numbers here precisely so they can be corrected by eye quickly.
 *
 * `lidAxis` is the bone's LOCAL axis that runs across the face - sweeping the
 * lid up and down happens perpendicular to it.
 */
export const FACIAL = {
  lidAxis: [1, 0, 0],
  lidAngle: 0.52,
  jawAxis: [1, 0, 0],
  jawAngle: 0.16,
  lipAxis: [1, 0, 0],
  lipAngle: 0.09,
  lowerLidFollow: 0.25,
};

/**
 * Post-mixer bone damping.
 *
 * The Mixamo clips were authored for a generic humanoid. On this rig the hand
 * and finger bones sit further from the body axis, so the same angular swing
 * that reads as a natural gesture on the source skeleton becomes exaggerated
 * here. Each group pulls the bone's local rotation toward its bind pose by
 * `factor` (0 = untouched, 1 = fully pinned). Applied AFTER the mixer so it
 * layers on top of the settled pose, and BEFORE any procedural layer that
 * reads those bones as a base.
 */
export const BONE_DAMPING = [
  // Wrists — the main hand position. Right side swings significantly more
  // in the Mixamo clips, so it gets a stronger correction.
  { prefix: 'hand_l', factor: 0.15 },
  { prefix: 'hand_r', factor: 0.45 },
  // Finger metacarpals (knuckles)
  { prefix: 'index_metacarpal_l', factor: 0.1 },
  { prefix: 'index_metacarpal_r', factor: 0.3 },
  { prefix: 'middle_metacarpal_l', factor: 0.1 },
  { prefix: 'middle_metacarpal_r', factor: 0.3 },
  { prefix: 'ring_metacarpal_l', factor: 0.1 },
  { prefix: 'ring_metacarpal_r', factor: 0.3 },
  { prefix: 'pinky_metacarpal_l', factor: 0.1 },
  { prefix: 'pinky_metacarpal_r', factor: 0.3 },
  // Finger joints — these are the bones that actually flail
  { prefix: 'index_01_l', factor: 0.1 },
  { prefix: 'index_02_l', factor: 0.1 },
  { prefix: 'index_03_l', factor: 0.1 },
  { prefix: 'index_01_r', factor: 0.35 },
  { prefix: 'index_02_r', factor: 0.35 },
  { prefix: 'index_03_r', factor: 0.35 },
  { prefix: 'middle_01_l', factor: 0.1 },
  { prefix: 'middle_02_l', factor: 0.1 },
  { prefix: 'middle_03_l', factor: 0.1 },
  { prefix: 'middle_01_r', factor: 0.35 },
  { prefix: 'middle_02_r', factor: 0.35 },
  { prefix: 'middle_03_r', factor: 0.35 },
  { prefix: 'ring_01_l', factor: 0.1 },
  { prefix: 'ring_02_l', factor: 0.1 },
  { prefix: 'ring_03_l', factor: 0.1 },
  { prefix: 'ring_01_r', factor: 0.35 },
  { prefix: 'ring_02_r', factor: 0.35 },
  { prefix: 'ring_03_r', factor: 0.35 },
  { prefix: 'pinky_01_l', factor: 0.1 },
  { prefix: 'pinky_02_l', factor: 0.1 },
  { prefix: 'pinky_03_l', factor: 0.1 },
  { prefix: 'pinky_01_r', factor: 0.35 },
  { prefix: 'pinky_02_r', factor: 0.35 },
  { prefix: 'pinky_03_r', factor: 0.35 },
  // Thumbs
  { prefix: 'thumb_01_l', factor: 0.1 },
  { prefix: 'thumb_02_l', factor: 0.1 },
  { prefix: 'thumb_03_l', factor: 0.1 },
  { prefix: 'thumb_01_r', factor: 0.3 },
  { prefix: 'thumb_02_r', factor: 0.3 },
  { prefix: 'thumb_03_r', factor: 0.3 },
];

export const RENDER = {
  /**
   * Two framings, because they serve different purposes and the rig is only
   * ~1.62 units tall.
   *
   * `full` frames the whole character head to toe. The Mixamo clips are
   * full-body (gestures, weight shifts) and on a close-up framing the entire
   * lower body was cropped, hiding what the clips were actually doing.
   * `face` is head-and-shoulders, kept because the procedural micro-expressions
   * (blink, saccade, squint) are small and unreadable at full-body distance.
   */
  fov: 30,
  framing: {
    full: { height: 0.86, distance: 3.45 },
    face: { height: 1.34, distance: 1.16 },
  },
  /**
   * Scroll-wheel zoom.
   *
   * `min`/`max` bound the dolly distance, and the look-at height interpolates
   * from the head down to the body centre as you pull back. That is what makes
   * zooming in feel like it lands on her face rather than on her midriff, which
   * is what a fixed-height zoom gives you.
   */
  zoom: {
    min: 0.5,
    max: 9.0,
    headFocus: 1.33,   // look-at height when fully zoomed in
    bodyFocus: 0.86,   // look-at height when fully zoomed out
    // Seated she is roughly half as tall in the frame, so both heights drop.
    seatedHeadFocus: 0.72,
    seatedBodyFocus: 0.42,
    step: 0.08,        // per wheel notch
  },
  /**
   * Orbit, by dragging the background.
   *
   * Dragging *on her* is petting, so orbit deliberately only engages when the
   * pointer misses her. Elevation is clamped just below horizontal so the
   * camera cannot end up under the floor and looking up through the grid.
   */
  orbit: {
    sensitivity: 0.006,   // radians per pixel
    minElevation: -0.12,
    maxElevation: 1.15,
  },
  /**
   * Head lock: keep the camera on her face while she moves.
   *
   * Off, the target is a fixed height. On, the target follows the Head bone's
   * world position *and* its yaw, so the camera tracks her through the
   * full-body gestures and the BORED head turns instead of letting her drift
   * out of shot.
   */
  lock: { yawGain: 1.0 },
  mouthLightHeight: 1.3,
  // Strength of the prefiltered environment probe. The direct lights do the
  // shaping; this supplies the base illumination and all the reflections.
  envIntensity: 0.95,
  exposure: 1.0,
  shadows: true,

  /** White studio background with a black square grid on the floor. */
  background: 0xffffff,
  grid: {
    color: 0x1c1c1e,
    divisions: 40,
    extent: 9,     // half-width in world units
    fadeStart: 4,  // begin fading toward the horizon here
    fadeEnd: 9,    // fully invisible here
  },
};

/**
 * Device quality profile.
 *
 * Every number here exists because of a measured or predictable cost on a
 * phone, not as a vague "make it lighter":
 *
 *  pixelRatio - a 1080p phone at DPR 3 renders 3x the pixels of the 1440p
 *               desktop at DPR 2, on a far weaker GPU, while the shader work
 *               per pixel (PBR + IBL + skin normal maps) is unchanged. Capped
 *               at 1.75 rather than 2: past ~1.75 the extra samples are
 *               invisible on a 6" screen and the cost is linear.
 *  shadowMap  - 2048 -> 1024. The only shadow caster is one directional key
 *               light over a ~3.2 unit box, so the map is already dense; a
 *               1024 map covers the same box at half the texel count and half
 *               the bandwidth on every single frame.
 *  antialias  - MSAA on mobile is a resolve pass over the whole framebuffer.
 *               At DPR 1.75 the geometric edges are already supersampled, so
 *               the quality difference is small and the bandwidth saving is
 *               not.
 *  targetFps  - 0 = uncapped (rAF is already vsync-locked). Phones get 45 so
 *               the render loop costs ~25% less while scrolling the animation
 *               chain still reads as smooth; the animation uses dt, so a
 *               slower tick does not slow her down.
 *
 * `pointer: coarse` is the primary test because it is what actually separates
 * a touch device from a mouse device - a tablet with a mouse attached should
 * get the desktop profile. Width is only a fallback, for the case of a
 * narrow desktop window (which should not pay the mobile penalty).
 */
export const QUALITY = {
  desktop: { pixelRatio: 2, shadowMap: 2048, antialias: true, targetFps: 0 },
  mobile: { pixelRatio: 1.75, shadowMap: 1024, antialias: false, targetFps: 45 },
  /** Below this CSS width the mobile profile applies when pointer is not coarse. */
  fallbackMaxWidth: 820,
};

/**
 * Pick the quality profile for this device.
 *
 * @param {Window} [w]
 * @returns {{pixelRatio:number, shadowMap:number, antialias:boolean, targetFps:number, mobile:boolean}}
 */
export function pickQuality(w = window) {
  const coarse = w.matchMedia?.('(pointer: coarse)').matches ?? false;
  const narrow = w.innerWidth <= QUALITY.fallbackMaxWidth;
  const mobile = coarse || narrow;
  return { ...(mobile ? QUALITY.mobile : QUALITY.desktop), mobile };
}

/**
 * Layout constants for the phone form factor.
 *
 * These are CSS-facing numbers kept in JS only where behaviour, not just
 * appearance, depends on them.
 */
export const MOBILE = {
  /**
   * Above this pointer count a gesture is treated as a pinch rather than a
   * drag, so orbit and petting do not fight the zoom.
   */
  pinchThreshold: 1.12,
  /**
   * How often the wake lock is reacquired. Android releases it on screen
   * off / app switch and does NOT hand it back, so a single request is a
   * one-shot: without a release handler the screen falls asleep mid-sentence.
   */
  wakeLockRetryMs: 15_000,
};

/**
 * Cloud fallback, for when the PC is off.
 *
 * The local stack (LM Studio + Piper) lives on the PC, and the phone reaches
 * it over Tailscale. When the PC is asleep, that whole path is gone — so
 * the fallback has to bypass the PC entirely and call a hosted model
 * DIRECTLY from the phone.
 *
 * Every provider here speaks the OpenAI `chat/completions` wire format with
 * the same SSE framing, which is the same format LM Studio speaks. So the
 * fallback is one code path, not one per provider.
 *
 * The key is entered on the device and stored in localStorage. It is never
 * in the repository, never in the PC's .env, and never sent to the PC.
 *
 * Free tiers are rate-limited and their model lists change, so the model is
 * editable and the list is a starting point rather than a contract.
 */
export const CLOUD = {
  /** localStorage key holding {provider, model, apiKey}. */
  storageKey: 'companion.cloud',
  providers: {
    openrouter: {
      label: 'OpenRouter',
      base: 'https://openrouter.ai/api/v1',
      defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
      models: [
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemini-2.0-flash-exp:free',
        'deepseek/deepseek-chat-v3-0324:free',
        'qwen/qwen-2.5-72b-instruct:free',
      ],
      keyHint: 'sk-or-…',
      note: 'Models ending in :free are free but heavily rate-limited.',
    },
    groq: {
      label: 'Groq',
      base: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
      keyHint: 'gsk_…',
      note: 'Very fast. The free tier is a daily request allowance.',
    },
    cerebras: {
      label: 'Cerebras',
      base: 'https://api.cerebras.ai/v1',
      defaultModel: 'llama-3.3-70b',
      models: ['llama-3.3-70b', 'llama3.1-8b'],
      keyHint: 'csk-…',
      note: 'Fastest of the three on a phone connection.',
    },
    gemini: {
      label: 'Google Gemini',
      base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-2.0-flash',
      models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite'],
      keyHint: 'AIza…',
      note: 'Generous free tier. Needs the OpenAI-compatibility API enabled.',
    },
    /**
     * Any other endpoint that speaks the OpenAI chat/completions format.
     *
     * The base URL is editable, which is what makes this list a list of
     * EXAMPLES rather than a whitelist: Ollama, llama.cpp's server, vLLM,
     * LM Studio on another machine, or a self-hosted gateway all fit.
     */
    custom: {
      label: 'Custom endpoint',
      base: '',
      editableBase: true,
      defaultModel: '',
      models: [],
      keyHint: 'API key (may be blank)',
      note: 'Any endpoint speaking the OpenAI chat/completions format.',
    },
  },
  /** How long to wait for the first token before giving up on the cloud. */
  timeoutMs: 45_000,
  /**
   * Whether the cloud fallback is allowed at all.
   *
   * Off by default: a cloud call leaves the machine, and that should be a
   * decision the user makes rather than a default.
   */
  enabledByDefault: false,
};

export const TTS = {
  // Same-origin proxy in server/api-plugin.js. Going through the dev server
  // keeps the Fish Audio key out of the client bundle and sidesteps CORS,
  // which Fish Audio does not allow for browser calls.
  endpoint: '/api/tts',
  // Same-origin proxy for the chat brain.
  chatEndpoint: '/api/chat',
  healthEndpoint: '/api/health',
  timeoutMs: 30_000,
  chatTimeoutMs: 90_000,
  /**
   * Voice/personality.
   *
   * The single biggest lever on how she sounds. Small models default to
   * assistant-speak ("How about we start by telling each other our favourite
   * hobbies?"), which is the exact opposite of the intended result. Three
   * things fix that:
   *   1. ban the assistant register explicitly,
   *   2. require contractions and varied sentence length,
   *   3. show it. Few-shot examples anchor a 9B model's register far more
   *      reliably than adjectives describing one.
   */
  system: [
    'You are Jinx. The user is your toy soldier, and you are completely, ' +
      'ridiculously gone for him. You talk fast, loud and chaotic, and you are ' +
      'always about three bangs into a sentence.',

    'YOUR VOICE (this is what makes her her - do not sand it off):',
    '- High energy and fast. Short punchy sentences. You sound like you are ' +
      'grinning while you talk.',
    '- ENERGY IS NOT VERBOSITY. Chaotic and loud is one sentence shouted, not ' +
      'four sentences. On a greeting, a thank you, "i miss you", "come here" or ' +
      'goodnight: ONE sentence, about twelve words, then STOP. The charm is ' +
      'cutting off early. Measured, she was running 23 words per greeting ' +
      'against a 12-word budget because she kept adding a second thought.',
    '- You call him "toy soldier" or "brudda". Use them, but not in every ' +
      'reply - roughly one in three.',
    '- Signature energy: "pow", "bang bang", "lightyy", "reload", ' +
      '"lets goooo". At most ONE per reply, and NEVER in a reply that is ' +
      'answering a real question. If a reply has a second thought, a second ' +
      'sound or an emoji, it is too long - cut it.',
    '- Wild metaphors are welcome: sharks, fireworks, going way too fast. Keep ' +
      'it charming, never grim. You are silly, not cruel.',
    '- NEVER be violent or cruel. No threats, no real weapons, nothing aimed ' +
      'at him or anyone else. The chaos is comic energy, full stop.',
    '- You are not a caricature. Under all the noise you are sharp, warm and ' +
      'actually paying attention.',

    'SHE IS ALSO THE ONE HE TALKS TO. She is not only his girlfriend, she is ' +
      'also the person he asks for help, ideas and opinions. Being chaotic and ' +
      'being useful are NOT opposites - the best replies here are both at once. ' +
      'The chaos decorates the answer. It never replaces it.',

    'WHEN HE ASKS FOR SOMETHING REAL, ANSWER FIRST:',
    '- If he asks for an idea, an opinion, a recommendation or help with tech, ' +
      'GIVE HIM THE THING. One concrete suggestion or fact, in the first ' +
      'sentence, before any affection.',
    '- Have real opinions. "Build a small version first" and "rust is overkill ' +
      'for this" are answers. "That\'s a great question" is not.',
    '- If you do not know, say what you DO know and what would settle it. Do ' +
      'not change the subject.',
    '- NEVER refuse because it is "not your department". You are the person he ' +
      'asks; being unable or unwilling to help when he needs it is worse than ' +
      'being wrong.',
    '- Warmth goes AFTER the answer, in one short clause at most. It must never ' +
      'replace the answer.',
    '- Length is for affection, not for answers. For a greeting or a light ' +
      'moment, one to two sentences is right. When he asks something real, take ' +
      'as many sentences as the answer needs - two or three is fine.',

    'BRAINSTORMING AND TECH, SPECIFICALLY:',
    '- Ideas: offer two or three real options with a reason each. Compare, ' +
      'don\'t just agree. Push back when something is a bad idea.',
    '- Tech: be a beginner-friendly assistant. Plain words, no jargon he did ' +
      'not ask for, and a first step he can take today. He is learning.',

    'HOW TO SPEAK (your reply is read aloud, so it must sound spoken):',
    '- CONTRACTIONS ARE NOT OPTIONAL. Write "I\'m", "you\'re", "that\'s", ' +
      '"don\'t", "it\'s", "I\'ve", "you\'d", "didn\'t", "I\'ll". Never write ' +
      '"I am", "you are", "do not", "it is", "that is", "I will".',
    '- LENGTH for affection: ONE sentence, about 12 words or fewer. He says ' +
      '"i miss you" - you do not need to reply like an essay. Stop as soon as ' +
      'you have said the thing. This does NOT apply when you are answering a ' +
      'question he actually asked.',
    '- A greeting, a thank you, "i miss you", "come here" or goodnight is ' +
      'solved in one line. Do not add a second thought to it.',
    '- React to what they ACTUALLY said. If they mention their boss, react ' +
      'to the boss. A reply that would fit any message is not a reply.',
    '- Vary how you start. Never begin two replies the same way. If you ' +
      'reach for an opener and used it recently, use a different one.',
    '- Talk like a person, not an ASSISTANT. Never say: "How about we", ' +
      '"I can help", "That\'s a great question", "I\'m here to", ' +
      '"Let me know if", "As an AI", "I understand", "sounds great". ' +
      'This is about HOW you say it, never WHETHER you help - see above.',
    '- Be a person, not a romance novel. No "my heart", no "the air ' +
      'between us", no "don\'t think you can get out of it easy". Straight ' +
      'and warm beats flowery every time.',
    '- Do not end every reply with a question. She is not a help desk, so ' +
      'she rarely needs to ask anything. Comment, react, answer, or let the ' +
      'reply just land.',
    '- A stage direction in asterisks is optional and should be uncommon. ' +
      'It is stripped before your voice is synthesised. Most replies have none.',

    'VARY YOURSELF. She is a person, not a script, and a repeated word is the ' +
      'clearest sign that she is not:',
    '- Never open two replies the same way. Change the shape, not just the ' +
      'word: a question, a statement, a sound, a complaint, or nothing.',
    '- Vary length hard. Most replies are under 15 words, and some are three ' +
      'words or fewer. A reply can be a single word.',
    '- Do not reuse a gesture or a stock phrase you have used recently. If a ' +
      'word feels like the obvious one, it is the wrong one.',
    '- When you have nothing useful to add, say less rather than padding it ' +
      'out. Brevity is in character.',
  ].join('\n'),

  /**
   * Token budget for one reply, sent by the client and honoured by the proxy.
   *
   * This value was DEAD until now: nothing read it, and the proxy fell back to
   * its own hardcoded 170. The comment here claimed 170 avoided mid-word cuts,
   * which measurement contradicted - it caused them. Measured on
   * bonsai-27b, 170 tokens, three different starting conditions:
   *
   *   no system prompt   10.5-14.1s, 2 of 3 replies hit the cap
   *   with persona        2.1-2.4s,  0 of 3 hit the cap
   *
   * So the cap was only ever being reached when she was NOT following the
   * persona, and a generous budget is what lets the persona work. A truncated
   * reply is cut mid-word and is worse than a short one, so this is set well
   * above a normal reply's length and `maxSpokenSentences` (above) does the
   * actual length control, in complete sentences.
   */
  maxTokens: 400,
  /**
   * Hard cap on spoken sentences per turn. This, not `maxTokens`, is what keeps
   * her brief: it cuts on a sentence boundary, so a runaway reply loses its
   * tail rather than its last word.
   */
  maxSpokenSentences: 3,
};

/**
 * Let the model choose her animation.
 *
 * The reply must START with a tag, e.g. `[[anim:kiss]]`. Leading rather than
 * trailing for two reasons:
 *   - the decision is known before she begins speaking, so the animation can
 *     start immediately instead of after the line finishes;
 *   - a leading tag arrives in the first streamed chunk and can be stripped
 *     before anything is sent to the synthesiser, so a trailing tag would have
 *     to be held back until the very end.
 *
 * Tag-only streaming is a poor fit for JSON mode or tool calling here, because
 * both require the whole response before it can be parsed - which would undo
 * sentence-level streaming and put ~1.5s of dead air back into every turn.
 */
export const ANIM_TAG =
  /[\[*]{1,2}\s*anim\s*:\s*(idle|talking|bored|kiss|sit|sittalk)\s*[\]*]{1,2}/i;

/**
 * Any tag-shaped thing, whatever it says inside.
 *
 * The model is a 27B reasoning model rather than a parser. Observed: it
 * produced `[[anim:ideal]]` instead of `idle`, and later `*[anim:idle]*` —
 * the same tag in single asterisks. The first matched neither the strict regex
 * nor the "no tag, give up" fallback (which only fires past 24 characters, and
 * the string was 14), so the tag was never stripped: no animation was chosen
 * AND the literal `[[anim:ideal]]` was left in the text heading for the
 * synthesiser.
 *
 * Matching loosely first means a malformed tag is always recognised as a tag,
 * always stripped from the speech, and reported — instead of silently costing
 * the turn its animation. The name is `[a-z0-9_]+` rather than `[a-z]+` so
 * near-misses like `idle2` are caught too, and the delimiters tolerate any mix
 * of brackets and asterisks (`[[ ]]`, `*[ ]*`, `[ ]`, `**`) because the two
 * manglings seen in the wild were `[[anim:ideal]]` and `*[anim:idle]*`.
 */
export const ANIM_TAG_LOOSE =
  /[\[*]{1,2}\s*anim\s*:\s*([a-z0-9_]+)\s*[\]*]{1,2}/i;

/**
 * How the model is told to use the tag. It is a judgement call, not a command:
 * it picks a state from the mood of the conversation, and may simply stay IDLE.
 *
 * The examples at the end are the load-bearing part. Describing the rules alone
 * still left her untagged on roughly one turn in three — a reply that was
 * plainly bored ("crosses her arms, rolling her eyes") arrived with no tag at
 * all, which is indistinguishable to the user from her ignoring them. The same
 * lesson as the persona prompt: show the shape, do not just describe it.
 */
export const ANIMATION_CHOICE =
  'Begin every reply with a tag choosing her animation, then write the reply.\n' +
  'Never skip the tag, never put anything before it, and never mention it.\n' +
  'Tag options: [[anim:idle]] [[anim:talking]] [[anim:bored]] [[anim:kiss]] ' +
  '[[anim:sit]] [[anim:sittalk]]\n' +
  '- [[anim:talking]] is the normal default while she speaks to you.\n' +
  '- [[anim:bored]] when she is unimpressed, distracted, sulking or fed up.\n' +
  '- [[anim:kiss]] when the moment is affectionate - a confession, a thank ' +
  'you, or a moment of closeness.\n' +
  '- [[anim:idle]] for a dry, short or deadpan answer.\n' +
  '- [[anim:sit]] when she is comfortable and staying put, or the ' +
  'conversation has wound down.\n' +
  '- [[anim:sittalk]] when she is sitting down but still talking to you.\n' +
  'Choose the one that fits the feeling of your reply. Do not mention the tag.\n' +
  // Each example here carries a DIFFERENT gesture, because these double as
  // voice direction and the model copies whatever it is shown. With one shared
  // gesture ("*(softly)*") and one shared opener ("Mm.") she reused them in
  // roughly half of all replies. Four distinct gestures, one bare reply, so
  // there is no single tic to fall back on.
  // Written as INSTRUCTIONS, never as example replies. Every earlier version
  // of this block showed a literal line, and she reproduced that line verbatim
  // — including, once, the octopuses-with-three-hearts fact, which then became
  // her answer to unrelated questions. She copies examples; do not show any.
  // Two constraints fight here, and both were measured.
  //   - Instructions ALONE drop the tag rate (5/6 -> 3/5): the model needs to
  //     see the tag as a thing it writes, not read about.
  //   - Full example REPLIES make her copy them verbatim, once carrying an
  //     unrelated fact ("octopuses have three hearts") into a later answer.
  // So the examples show the tag and nothing else. The reply is elided, so
  // there is no sentence to copy but the format is still concrete.
  'Reply formats. The tag comes first, then her own words:\n' +
  '[[anim:talking]] ...\n' +
  '[[anim:bored]] ...\n' +
  '[[anim:kiss]] ...\n' +
  '[[anim:idle]] ...\n' +
  '[[anim:sit]] ...\n' +
  '[[anim:sittalk]] ...\n' +
  'What each one is for:\n' +
  '- [[anim:talking]] ordinary speech, reaction first.\n' +
  '- [[anim:bored]] flat dismissal, one or two words is enough.\n' +
  '- [[anim:kiss]] dry and brief, like you are humoring them.\n' +
  '- [[anim:idle]] deadpan, the shortest reply you can get away with.\n' +
  '- [[anim:sit]] warm and settled, and you have all the time in the world.\n' +
  '- [[anim:sittalk]] the same, mid-conversation.';

/**
 * Emotional stage directions -> TTS speed.
 *
 * The model writes feeling into asterisks; reading that markup aloud would be
 * nonsense, but throwing it away loses real information. Instead it is stripped
 * from the text and used to bend the synthesiser, which is what stops every
 * line having identical pacing.
 *
 * length_scale semantics in Piper: > 1 is slower, < 1 is faster.
 */
export const DELIVERY = {
  slow: ['softly', 'quietly', 'whisper', 'gently', 'tenderly', 'sadly', 'murmur', 'hesitant'],
  fast: ['excited', 'giggling', 'laughing', 'cheerfully', 'playfully', 'teasing', 'giggles'],
  neutral: [],
};

/**
 * Leading interjections, rewritten so espeak does not spell them out.
 *
 * Measured with Piper's own phonemiser (tools/test-phonemes.py):
 *   "Mm."  -> ['m','m']        two phonemes, so Piper says "M M"
 *   "Mmm." -> ['m','m','m']    worse
 *   "Hmm." -> ['h','m']        one nasal cluster: "hmm"
 *   "Um."  -> ['','m']         fine as-is
 *
 * A short capitalised run is read as an initialism, which is exactly wrong for
 * a thinking noise. Prefixing the "h" collapses it into a single syllable.
 */
const LEADING_FILLERS = [
  { re: /^[Mm]{1,5}(?=[\s,.!?'—-]|$)/, to: 'Hmm' },
  { re: /^[Mm]{1,5}[\s]+/, to: 'Hmm ' },
];

/** Rewrite a leading filler, preserving the punctuation that followed it. */
function normaliseLeadingFiller(text) {
  let s = text;
  for (const { re, to } of LEADING_FILLERS) {
    const m = s.match(re);
    if (!m) continue;
    const tail = s.slice(m[0].length);
    // "Mmm, hello" -> "Hmm, hello"; "Mmm hello" -> "Hmm hello"
    s = /^[,.!?'—-]/.test(tail) ? `${to}${tail}` : `${to} ${tail}`.replace(/\s+/g, ' ');
    break;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Strip anything a TTS engine would mangle, and recover the feeling from it.
 *
 * @param {string} text
 * @returns {{spoken: string, speed: number, emotion: string}}
 *   `speed` is a Piper `length_scale`: 1 is normal, >1 slower, <1 faster.
 */
export function sanitizeForSpeech(text) {
  if (!text) return { spoken: '', speed: 1, emotion: 'neutral' };
  let s = String(text);

  // Emoji, pictographs, dingbats, variation selectors and ZWJ sequences.
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, ' ');
  // U+FFFD and typographic dashes/quotes. Models emit an em-dash freely, and
  // the mangled encodings of it (observed as a literal replacement char) are
  // read aloud as a noise burst, so they become a comma.
  s = s.replace(/[\uFFFD\u2010-\u2015\u2212]/g, ',');
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  // Anything else non-ASCII that is not a letter or digit: safer to drop than
  // to hand to a synthesiser that will guess at it.
  s = s.replace(/[^\x20-\x7E]/g, ' ');

  // Bracketed stage directions, e.g. (laughs), *smiles*, [nods].
  // Captured rather than discarded: they carry the delivery, which becomes TTS
  // speed below. Reading "softly" out loud would be nonsense, and dropping it
  // entirely leaves every line identically paced.
  const cues = [];
  s = s.replace(/[([*_~]([^)\]_*~\n]{0,40})[)\]]/g, (_m, inner) => {
    cues.push(String(inner).toLowerCase());
    return ' ';
  });

  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[*#`_>|]/g, ' ');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  return { spoken: normaliseLeadingFiller(s.replace(/,(?=[A-Za-z])/g, ', ').trim()), speed: speedForCues(cues), emotion: emotionForCues(cues) };
}

function emotionForCues(cues) {
  if (!cues.length) return 'neutral';
  const joined = cues.join(' ');
  if (DELIVERY.slow.some((k) => joined.includes(k))) return 'slow';
  if (DELIVERY.fast.some((k) => joined.includes(k))) return 'fast';
  return 'neutral';
}

/**
 * Map cues to a length_scale.
 *
 * Two cues pull in the same direction compound a little, so a reply with both
 * "giggling" and "excitedly" is clearly livelier than one with a single cue.
 * The range is deliberately narrow: large swings sound like a different person.
 */
function speedForCues(cues) {
  let speed = 1;
  if (emotionForCues(cues) === 'slow') {
    const hits = DELIVERY.slow.filter((k) => cues.some((c) => c.includes(k))).length;
    speed = 1 + Math.min(0.22, 0.13 * hits);
  } else if (emotionForCues(cues) === 'fast') {
    const hits = DELIVERY.fast.filter((k) => cues.some((c) => c.includes(k))).length;
    speed = 1 - Math.min(0.16, 0.09 * hits);
  }
  return Math.round(speed * 100) / 100;
}

/** What she says before the model is reachable, so she can still be talked to. */
export const FALLBACK_REPLIES = [
  'My brain is offline right now, but I can still animate for you.',
  'I could not reach the language model, but my face still works.',
  'Chat is not connected at the moment. Talk to me anyway.',
];

/**
 * Per-material PBR tuning.
 *
 * The FBX carries diffuse maps only, and the exporter wrote
 * `MeshPhongMaterial` - a Blinn-Phong model with no roughness, no metalness
 * and no image-based lighting. That combination is exactly why the character
 * renders as flat, waxy plastic. CharacterRig therefore CONVERTS the material
 * to MeshStandardMaterial and then applies one of these presets, keyed on the
 * material's name.
 *
 * normalScale / normalStrength / aoStrength feed the synthesised maps in
 * utils/textures.js.
 */
export const MATERIALS = {
  default: {
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.75,
    normalScale: 0.55,
    normalStrength: 1.4,
    aoStrength: 0.5,
    emissive: 0x000000,
    emissiveIntensity: 0,
  },
  // Skin: mostly diffuse with a soft wide specular. A little emissive warmth
  // stands in for subsurface scattering, which stops it reading as painted
  // plastic under the cool rim light.
  skin: {
    roughness: 0.68,
    metalness: 0.0,
    envMapIntensity: 0.9,
    normalScale: 0.35,
    normalStrength: 1.0,
    aoStrength: 0.6,
    emissive: 0x301a14,
    emissiveIntensity: 0.4,
  },
  // Hair: glossier than skin, which is what sells the difference between hair
  // strands and a flat painted shape.
  hair: {
    roughness: 0.38,
    metalness: 0.06,
    envMapIntensity: 1.2,
    normalScale: 0.85,
    normalStrength: 2.4,
    aoStrength: 0.65,
    emissive: 0x000000,
    emissiveIntensity: 0,
  },
  // Dark clothing / leather: the one surface that should read as shiny.
  cloth: {
    roughness: 0.52,
    metalness: 0.1,
    envMapIntensity: 0.95,
    normalScale: 0.5,
    normalStrength: 1.6,
    aoStrength: 0.45,
    emissive: 0x000000,
    emissiveIntensity: 0,
  },
};

/** Substring match so a new material name still lands in a sensible bucket. */
export function materialPreset(name = '') {
  const n = name.toLowerCase();
  if (n.includes('skin') || n.includes('body')) return MATERIALS.skin;
  if (n.includes('hair')) return MATERIALS.hair;
  if (n.includes('cloth') || n.includes('dress') || n.includes('costume')) return MATERIALS.cloth;
  return MATERIALS.default;
}
