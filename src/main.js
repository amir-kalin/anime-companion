import * as THREE from 'three';
import { Stage } from './components/Stage.js';
import { CharacterRig } from './components/CharacterRig.js';
import { Hud } from './components/Hud.js';
import { AnimationController } from './animation/AnimationController.js';
import { InactivityManager } from './animation/InactivityManager.js';
import { ProceduralLife } from './animation/ProceduralLife.js';
import { SpringHair } from './animation/SpringHair.js';
import { FacialRig } from './animation/FacialRig.js';
import { BoneDamping } from './animation/BoneDamping.js';
import { LipSync } from './audio/LipSync.js';
import { SpeechSource } from './audio/SpeechSource.js';
import { SentenceQueue } from './audio/SentenceQueue.js';
import { ChatClient } from './ai/chat.js';
import { MemoryClient } from './ai/memory.js';
import { SttClient } from './ai/stt.js';
import { Petting } from './interaction/Petting.js';
import { Chair } from './components/Chair.js';
import { ANIMATIONS, STATES, GAZE, TTS, RENDER, CHAIR, MODEL, SEATED_STATES, HAIR, FACIAL, BONE_DAMPING, sanitizeForSpeech, PET_PROMPTS, pickQuality, MOBILE, CLOUD } from './utils/config.js';
import { loadCloudSettings, saveCloudSettings, clearCloudSettings, cloudConfigured, describeCloud } from './ai/cloudChat.js';
import { apiUrl, getApiBase, setApiBase, describeConnection } from './utils/connection.js';

const ZOOM_STEP = RENDER.zoom.step;

/**
 * Device profile, resolved once.
 *
 * A phone gets a lighter renderer (see QUALITY in config.js) and a collapsed
 * HUD, because the debug telemetry is the largest block in the panel and the
 * least useful thing on a screen that is 360px wide.
 */
const quality = pickQuality();

const canvas = document.getElementById('stage');
const hudRoot = document.getElementById('hud');
const statusEl = document.getElementById('status');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const micBtn = document.getElementById('mic');
const micFs = document.getElementById('mic-fs');
const overlayInputEl = document.getElementById('overlay-input');
const overlaySendBtn = document.getElementById('overlay-send');
const overlayMicBtn = document.getElementById('overlay-mic');
const logEl = document.getElementById('log');
const sitBtn = document.getElementById('sit-toggle');
const resetOrbitBtn = document.getElementById('reset-orbit');
const hudToggleBtn = document.getElementById('hud-toggle');
const gateEl = document.getElementById('audio-gate');
const gateBtn = document.getElementById('audio-gate-btn');
const cloudToggleBtn = document.getElementById('cloud-toggle');
const cloudSheet = document.getElementById('cloud-sheet');
const cloudProviderSel = document.getElementById('cloud-provider');
const cloudBaseField = document.getElementById('cloud-base-field');
const cloudBaseInput = document.getElementById('cloud-base');
const cloudModelInput = document.getElementById('cloud-model');
const cloudModelList = document.getElementById('cloud-models');
const cloudKeyInput = document.getElementById('cloud-key');
const cloudHint = document.getElementById('cloud-hint');
const cloudStatus = document.getElementById('cloud-status');
const cloudSaveBtn = document.getElementById('cloud-save');
const cloudTestBtn = document.getElementById('cloud-test');
const cloudClearBtn = document.getElementById('cloud-clear');
const cloudCloseBtn = document.getElementById('cloud-close');
const apiBaseInput = document.getElementById('api-base');
const apiBaseHint = document.getElementById('api-base-hint');

const overlayStatusBadgeEl = document.getElementById('overlay-status-badge');
const overlayStatusTextEl = document.getElementById('overlay-status-text');
const cyberStatusChipEl = document.getElementById('cyber-status-chip');
const cyberStatusTextEl = document.getElementById('cyber-status-text');
const affectionTitleEl = document.getElementById('affection-title');

// Same-origin; the Vite plugin forwards these to LM Studio and the local voice
// service. Kept as one place so the endpoints are easy to see.
const TTS_ENDPOINT = '/api/tts';
const STT_ENDPOINT = '/api/stt';

const setStatus = (msg, kind = '') => {
  let inferred = kind;
  const m = String(msg || '').toLowerCase();
  if (!inferred) {
    if (m.includes('thinking')) inferred = 'thinking';
    else if (m.includes('execut') || m.includes('inspect') || m.includes('working') || m.includes('load')) inferred = 'working';
    else if (m.includes('speaking')) inferred = 'speaking';
    else if (m.includes('listening')) inferred = 'listening';
    else if (m.includes('ready')) inferred = 'ready';
    else if (m.includes('error') || m.includes('fail')) inferred = 'error';
    else inferred = 'ready';
  }

  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.className = `status ${inferred}`;
  }
  if (overlayStatusTextEl) {
    overlayStatusTextEl.textContent = msg;
  }
  if (overlayStatusBadgeEl) {
    overlayStatusBadgeEl.className = `overlay-status-badge ${inferred}`;
  }
  if (cyberStatusTextEl) {
    cyberStatusTextEl.textContent = msg;
  }
  if (cyberStatusChipEl) {
    cyberStatusChipEl.className = `cyber-status-chip ${inferred}`;
  }
};

function log(who, text) {
  const card = document.createElement('div');
  card.className = `chat-card ${who}`;

  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  meta.textContent = who === 'you' ? 'YOU' : who === 'orb' ? 'JINX' : 'SYSTEM';

  const body = document.createElement('div');
  body.className = 'chat-body';

  // Format any animation tags as sleek glowing pills
  const formatted = String(text || '').replace(/\[\[anim:(\w+)\]\]/gi, (match, anim) => {
    return `<span class="anim-pill anim-${anim.toLowerCase()}">${anim.toUpperCase()}</span>`;
  });
  body.innerHTML = formatted;

  card.appendChild(meta);
  card.appendChild(body);

  logEl.prepend(card);
  while (logEl.childElementCount > 40) logEl.lastElementChild.remove();
}

/**
 * Clip length, or an ellipsis for a clip that has not finished downloading.
 *
 * With progressive loading the one-shot and seated clips are not resident
 * when this is first called, and `durationOf` returns 0 for them. Printing
 * "0.00s" would look like a broken clip rather than a pending one.
 */
function clipDuration(state) {
  const d = controller?.durationOf(state) ?? 0;
  return d > 0 ? `${d.toFixed(2)}s` : '…';
}

// ---------------------------------------------------------------- bootstrap
const stage = new Stage(canvas, quality);
const rig = new CharacterRig();
const hud = new Hud(hudRoot);

const isOverlay = typeof window !== 'undefined' && window.location.search.includes('overlay=1');
if (isOverlay) {
  document.body.classList.add('overlay-mode');
  stage.setOverlay(true);
  stage.distance = 2.4;
  stage.cameraTarget.set(0, 1.25, 0);
  stage.camera.lookAt(stage.cameraTarget);
}

/** @type {SpeechSource} */
let speech = null;
/** @type {LipSync} */
let lipSync = null;
/** @type {ChatClient} */
let chat = null;
/** @type {SentenceQueue} */
let queue = null;
/** @type {SttClient} */
let stt = null;
/** @type {MemoryClient} */
let memory = null;
let inactivity = null;
let life = null;
let controller = null;
/** Spring-bone hair/prop physics. Null-safe on models with no dyn_ chains. */
let hair = null;
/** Bone-driven blink and jaw. Null-safe on rigs with no face bones. */
let face = null;
/** Post-mixer amplitude limiter for hand/finger bones. */
let damping = null;
let thinking = false;
let lastEmotion = 'neutral';
let lastChosenAnimation = null;
/**
 * True once the app is interactive.
 *
 * Used to stop the status line being overwritten by "Loading <clip>…"
 * messages from the background clips that are still streaming in after she
 * is already on screen and talking.
 */
let booted = false;
/**
 * Cooldown per one-shot animation, NOT one shared timer.
 *
 * A single `chosenCooldownUntil` covering both one-shots meant they excluded
 * each other: asking for a kiss set it 45s out, and an "are you bored" 7s later
 * was dropped on the same check, so she just sat there talking. The model had
 * already chosen correctly — the choice was discarded on arrival. Per-animation
 * cooldowns only stop the model repeating the SAME one-shot, which is all they
 * were ever meant to do.
 */
const chosenCooldowns = new Map();
let pendingChosen = null;   // one-shot she picked, played after she finishes

// A world-space point the eyes are attracted to. Priority in the frame loop is
// the petting touch point, then the pointer while it is over her, then the
// camera.
const lookTarget = new THREE.Vector3();
let petHover = false;

async function boot() {
  setStatus('Loading character…');
  try {
    await rig.load();
  } catch (err) {
    setStatus(`Character failed to load: ${err.message}`, 'error');
    console.error(err);
    return;
  }
  stage.add(rig.root);

  setStatus('Loading animations…');
  controller = new AnimationController(rig.model, { onStateChange });
  try {
    /**
     * IDLE and TALKING first, everything else behind her.
     *
     * The seven clips are 25MB of FBX. Waiting for all of them before the
     * app became interactive meant she did not appear until every file had
     * downloaded AND parsed — over a phone's connection that is the whole
     * cold start. These two are the ones she cannot be without; BORED (the
     * largest clip at 8.9MB) arrives only if she is idle long enough to
     * need it.
     */
    await controller.loadAll(ANIMATIONS, (state, ratio) => {
      if (!booted) setStatus(`Loading ${state}…`);
    }, { priority: ['idle', 'talking'] });
  } catch (err) {
    setStatus(`Animations failed to load: ${err.message}`, 'error');
    console.error(err);
    return;
  }

  life = new ProceduralLife(
    rig,
    (boneName) => controller.animatesBone(boneName),
    (b, out) => controller.getCleanQuaternion(b, out)
  );
  hair = new SpringHair(rig.model, HAIR);
  face = new FacialRig(rig.model, FACIAL);
  damping = new BoneDamping(rig.model, { groups: BONE_DAMPING });
  if (face.ready) {
    const s = face.stats();
    console.info(`[FacialRig] bone-driven face: lids ${s.upperLid}+${s.lowerLid}, jaw ${s.jaw}, lips ${s.lips}`);
  }
  if (hair.ready) {
    const s = hair.stats();
    console.info(`[SpringHair] simulating ${s.bones} bones: ${s.branches} branches from ${s.roots} roots`);
  }
  if (damping?.ready) {
    const s = damping.stats();
    console.info(`[BoneDamping] damping ${s.bones} bones across ${s.groups} groups: ${s.matched.slice(0, 8).join(', ')}${s.matched.length > 8 ? ', …' : ''}`);
  }
  inactivity = new InactivityManager({ onBored: enterBored });

  petting = new Petting({
    rig,
    camera: stage.camera,
    sceneTarget: rig.root,
    onReact: reactToPet,
    onActivity: () => inactivity.notifyActivity(),
  });

  // Head lock reads the Head bone each frame. The yaw is read too so the
  // camera can stay in front of her face as she turns, not just follow her
  // position.
  const _headPos = new THREE.Vector3();
  const _headQ = new THREE.Quaternion();
  const _fwd = new THREE.Vector3();
  const _euler = new THREE.Euler();
  stage.setHeadProvider((out) => {
    const head = rig.bindings.head;
    if (!head) return;
    head.getWorldPosition(out);
    head.getWorldQuaternion(_headQ);
    _fwd.set(0, 0, 1).applyQuaternion(_headQ);
    _euler.setFromQuaternion(_headQ, 'YXZ');
    // Feed the head's own yaw into the orbit so the view rotates with her.
    stage.azimuth = -_euler.y;
  });

  // BORED is a one-shot clip: hand back to IDLE the moment it finishes.
  controller.watchOnce(STATES.BORED, () => {
    controller.transitionTo(STATES.IDLE, 0.7);
    inactivity.notifyBoredComplete();
  });

  // KISS is also one-shot, and returns to IDLE the same way.
  controller.watchOnce(STATES.KISS, () => {
    controller.transitionTo(STATES.IDLE, 0.6);
    inactivity.notifyActivity();
  });

  hud.setVisemes(
    Object.entries(rig.bindings.visemes)
      .filter(([, hit]) => hit)
      .map(([key]) => key)
  );
  const m = rig.meta;
  const hs = hair?.stats();
  const hairNote = hs ? ` · hair ${hs.branches}br/${hs.bones}b` : '';
  // Report what actually animates her face. With no blendshapes the morph path
  // is inert, so `blinkMode: none` was true and misleading at the same time -
  // the eyelids are bone-driven instead.
  const fs = face?.stats();
  const blinkNote = fs?.upperLid ? `bone:${fs.upperLid}` : m.blinkMode;
  const jawNote = fs?.jaw ? ` · jaw:bone` : '';
  hud.setRigSummary(
    `${m.bones} bones · ${m.shapes} shapes · blink:${blinkNote} · visemes:${m.visemesResolved}/${m.visemesTotal} · PBR:${m.pbr ? 'yes' : 'no'} · maps:${m.mapsDerived}/${m.mapsDerived + m.mapsSkipped}${hairNote}${jawNote}`
  );

  const mapNote = m.mapsSkipped
    ? ` (${m.mapsSkipped} texture(s) never loaded — maps skipped)`
    : '';
  setStatus(
    `Ready — ${m.bones} bones, blink via ${fs?.upperLid ? `${fs.upperLid} eyelid bones` : `${m.blinkMode} shapes`}, mouth via ${fs?.jaw ? 'jaw bone' : 'viseme shapes'}, hair ${hs ? `${hs.branches} chains` : 'none'}, ${m.mapsDerived} derived map set(s)${mapNote}`,
    m.mapsSkipped ? '' : 'ok'
  );

  // The chair is optional: a missing or failed prop must not stop her working,
  // it just means there is nothing to sit on.
  loadChair();
  log('sys', `Rig ready: ${m.bones} bones, ${m.shapes} blendshapes.`);
  log('sys', `Idle clip ${clipDuration(STATES.IDLE)} · Talking ${clipDuration(STATES.TALKING)}`);

  // The remaining clips are still downloading behind her. Report them when
  // they land rather than printing "0.00s" for states that are not here yet.
  void controller.allReady?.then(() => {
    log(
      'sys',
      `Bored ${clipDuration(STATES.BORED)} (played once) · ` +
        `Sitting ${clipDuration(STATES.SITTING_IDLE)} · ` +
        `Sitting talking ${clipDuration(STATES.SITTING_TALKING)} — press S to sit`
    );
  });

  wireInput();
  wireZoom();
  stage.onFrame(frame);
  stage.start();

  // Report which local services are up. The voice service needs ~60s to load
  // Piper and Whisper, so probe with retries rather than declaring it dead on
  // the first miss - otherwise the log permanently claims "STT: off" on a
  // perfectly healthy machine that was simply started at the same time.
  chat = new ChatClient();
  refreshServices({ retries: 8, delayMs: 5000 });

  // Load affection status from server
  fetch(apiUrl('/api/affection'))
    .then((r) => r.json())
    .then((d) => {
      if (d?.title && affectionTitleEl) {
        affectionTitleEl.textContent = d.title;
      }
    })
    .catch(() => {});

  // Load what she remembers. First meeting is a one-time milestone worth
  // keeping, and it is written straight into the file so it survives the reboot
  // that follows.
  //
  // The guard checks for the EVENT, not for `turns === 0`: turns stays zero
  // until a real conversation happens, so that condition was true on every page
  // load and "First time we talked" got written three times.
  memory = new MemoryClient();
  memory.load().then((m) => {
    if (memory.available === false) {
      log('err', 'Memory file unavailable — she will forget between restarts.');
      return;
    }
    // The local path gets her memory injected server-side, but the cloud
    // path cannot reach the PC's file, so the notes are handed to the chat
    // client directly. Without this she forgets everything the moment the
    // PC sleeps.
    chat?.setMemoryNotes(memory.notes);
    const met = (m.events || []).some((e) => /first time/i.test(e.what || ''));
    if (met) {
      log('sys', `Memory: ${memory.summary} over ${m.turns} turn(s)`);
      if (memory.notes.length) log('sys', `She remembers: ${memory.notes.slice(0, 2).join(' · ')}`);
    } else {
      void memory.event('First time we talked');
      log('sys', 'Memory: this is the first time she has met you');
    }
    hud.setMemorySummary(memory.summary);
  });

  // Debug handle: lets the dev tools (and automated checks) inspect and drive
  // the state machine without going through the UI.
  window.__companion = {
    stage, rig, controller, life, inactivity,
    get hair() { return hair; },
    get face() { return face; },
    get petting() { return petting; },
    get lipSync() { return lipSync; },
    get speech() { return speech; },
    say, dictate, reactToPet, enterTalking, enterBored, enterKiss,
    enterSitting, standUp,
    get chair() { return chair; },
    states: STATES,
    /** Force a state, bypassing the inactivity timer. */
    force: (s) => controller.transitionTo(s, 0.4),
    /** Simulate a pet at a world point, for automated checks. */
    testPet: (y = 1.35, z = 0.15) => {
      const p = new THREE.Vector3(0.05, y, z);
      petting.begin(p);
      petting.move(p);
      return { active: petting.active, strength: petting.strength };
    },
  };

  booted = true;
}

// ------------------------------------------------------------- state machine
let previousState = null;
function onStateChange(next, prev) {
  previousState = prev;
  if (prev) log('state', `${prev} -> ${next}`);
  // The chair only exists while she is sitting down, and the petting region
  // moves with her (you cannot pat the head of someone sitting at that height
  // from the same camera framing).
  const seated = SEATED_STATES.has(next);
  chair?.setVisible(seated);
  // The sit button reflects the real state, so it cannot disagree with her.
  sitBtn?.setAttribute('aria-pressed', String(seated));
  // Per-state placement: the two sitting clips park the hips at different
  // heights AND different depths, so each state needs its own Y and Z offset.
  // She is also seated forward of the chair's geometric centre, onto the seat
  // rather than into the backrest.
  rig.setSeated(
    seated ? chair?.sink?.[next] ?? chair?.defaultSink ?? 0 : 0,
    seated ? chair?.forward?.[next] ?? chair?.defaultForward ?? 0 : 0
  );
  if (petting) {
    // Re-derive the pettable band from her actual height, so a seated pet still
    // works: seated she is much lower in the frame.
    petting.setHeightBand(seated ? [0.62, 0.99] : [0.72, 0.98]);
  }
  if (seated) log('sys', 'she sat down');
}

/** TALKING: cross-fade in, and return to IDLE when the audio finishes. */
function enterTalking() {
  if (controller.state === STATES.BORED) controller.transitionTo(STATES.IDLE, 0.3);
  // Talking while seated is fine, but a kiss needs her up, and a one-shot
  // seated clip would fight the seated idle.
  if (SEATED_STATES.has(controller.state)) {
    // Sitting + talking is a real state; stay in it rather than standing up on
    // every line.
    controller.transitionTo(STATES.SITTING_TALKING, 0.5);
    return;
  }
  controller.transitionTo(STATES.TALKING, 0.35);
}

let lastProactiveCheckin = Date.now();
const PROACTIVE_CHECKIN_MS = 240_000;

/** BORED: play once, then the `finished` handler returns to IDLE. */
function enterBored() {
  if (controller.state === STATES.TALKING) return; // never interrupt speech
  // Replaying from the start makes repeated BORED entries feel intentional.
  controller.transitionTo(STATES.BORED, 0.6, { restart: true });

  const now = Date.now();
  if (now - lastProactiveCheckin >= PROACTIVE_CHECKIN_MS && !thinking) {
    lastProactiveCheckin = now;
    setTimeout(() => {
      if (controller.state !== STATES.TALKING && !thinking) {
        say('idle_checkin');
      }
    }, 1200);
  }
}

/**
 * KISS: the reward for a sustained pet.
 *
 * Deliberately does NOT stop the audio. Both callers defer the clip until she
 * has finished her line, because cancelling mid-sentence truncates it and the
 * arrival of a hard-cut word is far more jarring than a short wait.
 */
function enterKiss() {
  if (controller.state === STATES.KISS) return;
  // She has to stand for this; a kiss while seated reads as a head tilt.
  if (SEATED_STATES.has(controller.state)) {
    standUp();
    log('sys', 'she gets up to kiss you');
  }
  log('sys', 'she kisses you');
  controller.transitionTo(STATES.KISS, 0.4, { restart: true });
  // A shared moment worth keeping, in case the machine reboots.
  void memory?.event('She kissed you');
  // The stroke that triggered this also counts as activity, or the inactivity
  // timer would fire BORED the instant the kiss ends.
  inactivity.notifyActivity();
}

// ---------------------------------------------------------------- fullscreen
const appEl = document.getElementById('app');
const fsBtn = document.getElementById('fs-toggle');
const framingBtn = document.getElementById('framing-toggle');
const lockBtn = document.getElementById('lock-toggle');
let isFullscreen = false;

/**
 * Toggle a clean, HUD-free fullscreen view.
 *
 * The Fullscreen API is attempted for a true OS-level fullscreen, but it is
 * best-effort and deliberately NOT awaited before the UI updates: requestFullscreen
 * can reject, and in some environments its promise never settles at all, which
 * would otherwise leave the layout permanently half-applied. The class-based
 * view is the source of truth, so it is applied and resized first and
 * synchronously.
 */
function setFullscreen(on) {
  isFullscreen = on;
  appEl.classList.toggle('fs', on);
  // The floating control bar is a sibling of #app, not a child, so it cannot
  // be reached by a descendant selector from `.app.fs`. It is mirrored onto
  // <body> so it can move out of the way of the collapsed panel.
  document.body.classList.toggle('fs', on);
  fsBtn.setAttribute('aria-pressed', String(on));

  // Reading the layout forces a reflow, so the canvas picks up the new box on
  // this frame rather than waiting for a ResizeObserver callback that a
  // throttled tab may delay indefinitely.
  stage.resize();
  setTimeout(() => stage.resize(), 260);

  try {
    if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else if (!on && document.fullscreenElement) {
      const p = document.exitFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch {
    // Fullscreen API refused or blocked; the class-based view still applies.
  }
}

  // Dragging *her* is petting; dragging past her orbits the camera. The
  // pointerdown handler below already decided whether this was a pet, so this
  // branch only runs when the press missed.
  //
  // Every active pointer is tracked, because a phone has no scroll wheel:
  // ONE finger orbits, TWO fingers pinch to zoom. The second finger has to
  // cancel the orbit rather than fight it, or the camera spins while it is
  // being zoomed.
  const pointers = new Map();
  let orbitFrom = null;
  let pinch = null;

  const pointerList = () => [...pointers.values()];

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      // A second finger means pinch, not orbit.
      orbitFrom = null;
      // If the first finger had already started a pet, that gesture is over:
      // a two-finger zoom must not also be stroking her head.
      petting?.end();
      const [a, b] = pointerList();
      pinch = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        // The zoom at the START of the pinch. It is held fixed rather than
        // updated in place, because `applied` below is measured from the
        // start of the gesture: recomputing from a moving base would make
        // the zoom compound, one extra step for every pointermove.
        baseZoom: stage.zoom,
      };
      return;
    }
    if (pointers.size > 2) return;
    if (petting?.active) return; // petting owns this gesture
    orbitFrom = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (pinch && pointers.size >= 2) {
      const [a, b] = pointerList();
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const delta = dist / pinch.dist - 1;
      // Dead zone: a thumb resting on the glass moves a pixel or two, and
      // without this the camera creeps while you are trying to talk to her.
      // The zone is SUBTRACTED rather than used as a threshold, so the zoom
      // starts moving exactly at the edge of the zone instead of jumping.
      const dz = MOBILE.pinchThreshold - 1;
      const applied = Math.abs(delta) > dz ? delta - Math.sign(delta) * dz : 0;
      // Spreading the fingers zooms IN, and `stage.zoom` is normalised the
      // other way round: 0 is the closest camera. So it is subtracted.
      stage.setZoom(pinch.baseZoom - applied * 0.9);
      return;
    }

    if (!orbitFrom) return;
    stage.orbitBy(e.clientX - orbitFrom.x, e.clientY - orbitFrom.y);
    orbitFrom = { x: e.clientX, y: e.clientY };
  });

  const endOrbit = (e) => {
    if (e?.pointerId !== undefined) pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!orbitFrom) return;
    orbitFrom = null;
    canvas.style.cursor = 'default';
    if (e && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endOrbit);
  canvas.addEventListener('pointercancel', endOrbit);

  framingBtn?.addEventListener('click', toggleFraming);
  lockBtn?.addEventListener('click', toggleLock);
  fsBtn.addEventListener('click', () => setFullscreen(!isFullscreen));
  // S and R were keyboard-only until now, which on a phone means they did
  // not exist. The on-screen controls are the same code path as the keys.
  sitBtn?.addEventListener('click', toggleSit);
  resetOrbitBtn?.addEventListener('click', () => {
    stage.resetOrbit();
    log('sys', 'Camera reset');
  });
  hudToggleBtn?.addEventListener('click', toggleHud);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (e.target === inputEl) return; // don't hijack typing
    setFullscreen(!isFullscreen);
  }
  if (e.key === 'c' || e.key === 'C') {
    if (e.target === inputEl) return;
    toggleFraming();
  }
  if (e.key === '+' || e.key === '=') { stage.zoomBy(-ZOOM_STEP); e.preventDefault(); }
  if (e.key === '-' || e.key === '_') { stage.zoomBy(ZOOM_STEP); e.preventDefault(); }
  if (e.key === '0') { stage.resetZoom(); }
  if (e.key === 'l' || e.key === 'L') { if (e.target !== inputEl) toggleLock(); }
  if (e.key === 'r' || e.key === 'R') { if (e.target !== inputEl) stage.resetOrbit(); }
  if (e.key === 's' || e.key === 'S') {
    if (e.target === inputEl) return;
    toggleSit();
  }
  if (e.key === 'Escape' && isFullscreen) setFullscreen(false);
});

// Full-body <-> face close-up.
function toggleFraming() {
  const next = stage.toggleFraming();
  framingBtn?.setAttribute('aria-pressed', String(next === 'face'));
  if (framingBtn) framingBtn.textContent = next === 'face' ? 'Face' : 'Full';
  log('sys', `Framing: ${next}`);
}

// Camera lock: follow her head so she cannot drift out of shot.
function toggleLock() {
  const on = stage.toggleLock();
  lockBtn?.setAttribute('aria-pressed', String(on));
  log('sys', on ? 'Camera locked to her head' : 'Camera unlocked');
  return on;
}

/**
 * Sit down / stand up.
 *
 * One entry point for the key, the on-screen button and the model, so the
 * button's pressed state can never drift from the state she is actually in.
 */
function toggleSit() {
  if (!controller) return;
  if (SEATED_STATES.has(controller.state)) standUp();
  else enterSitting();
}

/**
 * Show or hide the debug telemetry.
 *
 * Collapsed by default on a phone: the meters, cross-fade weights and gaze
 * angles are the largest block in the panel and the least useful thing on a
 * 360px-wide screen, where they push the chat input off the bottom.
 */
function toggleHud() {
  const hidden = appEl.classList.toggle('no-hud');
  hudToggleBtn?.setAttribute('aria-pressed', String(!hidden));
  hudToggleBtn?.setAttribute('aria-expanded', String(!hidden));
  log('sys', hidden ? 'Stats hidden' : 'Stats shown');
  return !hidden;
}

// ------------------------------------------------------------------ zoom bar
const zoombar = document.getElementById('zoombar');
const zoomThumb = document.querySelector('[data-f="zoomThumb"]');
const zoomLabel = document.querySelector('[data-f="zoomLabel"]');

/** Mirror the stage's zoom onto the scrollbar. */
function paintZoom() {
  const t = stage.zoom;
  if (zoomThumb) zoomThumb.style.top = `${t * 100}%`;
  if (zoombar) zoombar.setAttribute('aria-valuenow', String(Math.round(t * 100)));
  if (zoomLabel) zoomLabel.textContent = zoomWord(t);
}

/**
 * Short human label for a zoom position.
 *
 * The bands are derived from the framing presets rather than hardcoded
 * fractions of the slider. The old fixed cut-offs (0.12 / 0.34 / 0.72) put the
 * `full` preset inside the "waist" band - it sits at t = 0.347 - so selecting
 * full-body framing still displayed "waist", which reads as the character being
 * cropped when the camera was actually at the right distance.
 */
function zoomWord(t) {
  const { min, max } = RENDER.zoom;
  const dist = min + t * (max - min);
  const face = RENDER.framing.face.distance;
  const full = RENDER.framing.full.distance;
  if (dist <= face) return 'face';
  if (dist >= full - 1e-6) return 'full';
  return dist <= (face + full) / 2 ? 'bust' : 'waist';
}

function wireZoom() {
  // Wheel over the canvas dollies. preventDefault so the page never scrolls.
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // deltaMode 1 is lines, 2 is pages; normalise so a trackpad and a mouse
      // wheel feel comparable.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const delta = (e.deltaY * unit) / 400;
      stage.zoomBy(delta * ZOOM_STEP);
    },
    { passive: false }
  );

  // Dragging the thumb. Pointer capture so the drag survives leaving the track.
  let dragging = false;
  const applyFromEvent = (e) => {
    const track = zoombar.querySelector('.zoombar-track');
    const r = track.getBoundingClientRect();
    stage.setZoom((e.clientY - r.top) / r.height);
  };
  zoombar.addEventListener('pointerdown', (e) => {
    dragging = true;
    zoombar.classList.add('dragging');
    zoombar.setPointerCapture?.(e.pointerId);
    applyFromEvent(e);
    e.preventDefault();
  });
  zoombar.addEventListener('pointermove', (e) => {
    if (dragging) applyFromEvent(e);
  });
  const stopDrag = (e) => {
    dragging = false;
    zoombar.classList.remove('dragging');
    if (e && zoombar.hasPointerCapture?.(e.pointerId)) zoombar.releasePointerCapture(e.pointerId);
  };
  zoombar.addEventListener('pointerup', stopDrag);
  zoombar.addEventListener('pointercancel', stopDrag);

  // Clicking a +/- end zooms that way; double-click resets to the preset.
  zoombar.addEventListener('dblclick', () => {
    stage.resetZoom();
    log('sys', `Framing reset: ${zoomWord(stage.zoom)}`);
  });
  zoombar.querySelector('.zoombar-zoom:not(.out)')?.addEventListener('click', () => stage.zoomBy(-0.2));
  zoombar.querySelector('.zoombar-zoom.out')?.addEventListener('click', () => stage.zoomBy(0.2));

  // Keyboard accessibility for the slider role.
  zoombar.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.2 : 0.08;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { stage.zoomBy(-step); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { stage.zoomBy(step); e.preventDefault(); }
    else if (e.key === 'Home') { stage.setZoom(0); e.preventDefault(); }
    else if (e.key === 'End') { stage.setZoom(1); e.preventDefault(); }
  });

  stage.onZoom = paintZoom;
  paintZoom();
}
document.addEventListener('fullscreenchange', () => {
  // Keep the class in sync if the user leaves fullscreen with Esc at the OS level.
  if (!document.fullscreenElement && isFullscreen) {
    isFullscreen = false;
    appEl.classList.remove('fs');
    fsBtn.setAttribute('aria-pressed', 'false');
  }
});

// -------------------------------------------------------------------- input
function wireInput() {
  const markActive = () => inactivity.notifyActivity();

  window.addEventListener('pointermove', markActive, { passive: true });
  window.addEventListener('pointerdown', markActive, { passive: true });
  window.addEventListener('keydown', markActive, { passive: true });

  // Map the pointer onto a plane through the head so the eyes can follow it.
  // This is only USED while the pointer is over her; otherwise she looks at the
  // camera. A previous version latched `pointerActive = true` on the first
  // mouse move and never cleared it, so the gaze stayed pinned to the last
  // pointer position forever.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const planePoint = new THREE.Vector3();
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, stage.camera);
    const head = rig.bindings.head || rig.root;
    planeNormal.set(0, 0, 1).applyQuaternion(stage.camera.quaternion);
    planePoint.setFromMatrixPosition(head.matrixWorld);
    plane.setFromNormalAndCoplanarPoint(planeNormal, planePoint);
    ray.ray.intersectPlane(plane, lookTarget);
  });

  // Petting: pointer contact with her head/shoulders. Bound on the canvas so a
  // drag stays a drag instead of selecting page text.
  const petHit = (e) => petting?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());

  canvas.addEventListener('pointerdown', (e) => {
    // A second finger is a pinch, not a stroke.
    if (pointers.size > 1) return;
    const hit = petHit(e);
    if (hit) {
      petting.begin(hit);
      canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const hit = pointers.size > 1 ? null : petHit(e);
    petHover = Boolean(hit);
    if (hit) petting?.move(hit);
    canvas.style.cursor = hit ? 'grab' : 'default';
  });
  const endPet = (e) => {
    // The hover flag has to be cleared here, not only on pointerleave.
    // `pointerleave` does not fire for touch, so on a phone the last touch
    // point stayed the gaze target and her eyes stayed pinned to it after
    // the finger had lifted.
    petHover = false;
    petting?.end();
    if (e && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endPet);
  canvas.addEventListener('pointercancel', endPet);
  canvas.addEventListener('pointerleave', () => {
    petHover = false;
    petting?.end();
  });

  sendBtn.addEventListener('click', () => say());
  micBtn?.addEventListener('click', dictate);
  // Same handler on the fullscreen copy; it is the only dictation control
  // visible once the panel is hidden.
  micFs?.addEventListener('click', dictate);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') say();
  });

  // Overlay bar controls
  overlaySendBtn?.addEventListener('click', () => say());
  overlayMicBtn?.addEventListener('click', dictate);
  overlayInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') say();
  });

  // Quick Action Buttons
  document.querySelectorAll('.quick-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      if (cmd) say(cmd);
    });
  });
}

/**
 * One conversational turn, fully streamed.
 *
 *   mic/type -> LM Studio streams tokens -> each finished sentence is sent to
 *   TTS as soon as it exists -> the queue synthesises sentence N+1 while
 *   sentence N is still playing.
 *
 * Two things fall out of that ordering. First audio arrives after roughly one
 * sentence's synthesis rather than after the whole reply, which on this machine
 * is the difference between well under a second and several seconds. And
 * TALKING begins on real audio (the queue's onFirstAudio) rather than on the
 * request, so she starts gesturing only once she is actually speaking.
 */
async function say(explicitText) {
  const text = typeof explicitText === 'string'
    ? explicitText.trim()
    : (overlayInputEl?.value?.trim() || inputEl.value.trim());
  if (!text || thinking) return;
  if (overlayInputEl) overlayInputEl.value = '';
  inputEl.value = '';

  if (text === 'idle_checkin') {
    log('sys', 'Jinx checks in on you...');
  } else {
    log('you', text);
    lastProactiveCheckin = Date.now();
  }
  inactivity.notifyActivity();

  // AudioContext needs a user gesture; this click/keypress is it.
  ensureSpeech();

  thinking = true;
  const lower = text.toLowerCase();
  if (lower.match(/^(?:look|see|what is on|screen|capture|check|git|status|diff|branch|system|hardware|cpu|ram|memory|run|exec|cmd|powershell|terminal|read|write|file)/)) {
    setStatus('Working on it…', 'working');
  } else {
    setStatus('Thinking…', 'thinking');
  }
  queue.reset();

  const spoken = [];
  const t0 = performance.now();

  const result = await chat.sendStreaming(
    text,
    (sentence) => {
      spoken.push(sentence);
      queue.push(sentence);
    },
    {
      allowAnimation: true,
      // The model picks her animation from the mood of its own reply. It is
      // advisory: TALKING still owns the state once audio starts, and a
      // one-shot (kiss/bored) gets a cooldown so the model cannot spam it.
      onAnimation: applyChosenAnimation,
      onStatus: (statusText, kind) => setStatus(statusText, kind),
    }
  );

  thinking = false;
  if (result.source === 'fallback') {
    log('err', `chat unavailable: ${chat.lastError || 'not configured'}`);
  } else {
    if (result.unknownTag) {
      // She said a tag, but not one we can play. It has been stripped from the
      // speech already; say so, because otherwise a turn silently loses its
      // animation and looks exactly like the model not caring.
      log('err', `unplayable anim tag "[[anim:${result.unknownTag}]]" — ignored`);
    }
    if (result.via === 'cloud') {
      // Say so plainly. A reply from a different model is a different
      // quality, and the user should be able to tell which one spoke.
      log('sys', 'answered by the cloud — your PC is unreachable');
    }
    log('orb', result.text);
  }

  await queue.waitForDrain();
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  log('sys', `${spoken.length} sentence(s) spoken in ${secs}s`);
  settleAfterSpeech();
  // Any one-shot she chose now plays in full, instead of being cut off by the
  // first word of her own audio.
  playPendingChosen();
  // Persist the exchange. Not awaited: the reply is already on screen and
  // recording it must never delay anything.
  void memory?.record(text, result.text);
  setStatus(`Ready — ${secs}s turn`, 'ok');
}

/** Lazily build the audio stack, on the first user gesture. */
function ensureSpeech() {
  if (speech) return;
  speech = new SpeechSource({
    onstart: () => {
      enterTalking();
      inactivity.notifyActivity();
    },
    onend: () => {
      if (controller.state === STATES.TALKING) controller.transitionTo(STATES.IDLE, 0.4);
      lipSync?.reset();
      inactivity.notifyActivity();
    },
    onerror: (err) => log('err', `Speech error: ${err.message}`),
    onmode: (mode) => log('sys', `Voice: ${mode}`),
  });
  lipSync = new LipSync(speech.ensureContext());

  // Synthesise ahead of playback so the mouth is never starved of audio.
  queue = new SentenceQueue({
    synthesise: async (sentence) => {
      const ctx = speech.ctx;
      // Sanitising also recovers the emotional cue from the stage direction and
      // turns it into a speaking rate, so delivery varies instead of every line
      // being identically paced. The cue itself is never read aloud.
      const { spoken, speed, emotion } = sanitizeForSpeech(sentence);
      if (!spoken) return null;
      lastEmotion = emotion;
      const r = await fetch(apiUrl(TTS_ENDPOINT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: spoken, speed }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}`);
      return ctx.decodeAudioData(await r.arrayBuffer());
    },
    play: (buffer) => speech.playBuffer(buffer),
    // TALKING starts on the first real audio, not on the first request.
    onFirstAudio: () => {
      setStatus('Speaking…', 'speaking');
      enterTalking();
      inactivity.notifyActivity();
    },
  });
}

/** @type {Petting} */
let petting = null;
/** @type {Chair} */
let chair = null;

/**
 * She reacts to being petted, out loud.
 *
 * Routed through the same streaming chat + sentence queue as a normal turn, so
 * it inherits the low-latency speech and never queues behind an existing
 * conversation. Petting never changes the animation state: the reaction is a
 * procedural layer that composes with whatever clip is already playing.
 */
/**
 * Load the chair and align it to where the sitting clips actually put her.
 *
 * Failure is non-fatal on purpose: a missing prop should degrade to "she sits
 * on nothing" rather than breaking the whole app.
 */
async function loadChair() {
  const hips = new THREE.Vector3();
  const hipsBone = rig.bones.get('Hips');
  if (hipsBone) hipsBone.getWorldPosition(hips);

  try {
    chair = new Chair();
    const info = await chair.load(CHAIR.url, {
      hips,
      standingHeight: MODEL.targetHeight,
      // Hip height the sitting clips bake in, measured across the clip. Used to
      // compute how far she has to sink onto a realistically-sized seat.
      bakedHipY: CHAIR.bakedHipY,
      bakedHipZ: CHAIR.bakedHipZ,
    });
    chair.setVisible(false); // shown only in a seated state
    stage.add(chair.group);

    // The 14.5MB GLB can still be loading when she decides to sit, in which case
    // `enterSitting` had no sink to apply. Re-apply it now that one exists,
    // otherwise she stays at the standing offset and hovers over the seat.
    if (SEATED_STATES.has(controller.state)) {
      rig.setSeated(
        chair.sink?.[controller.state] ?? chair.defaultSink ?? 0,
        chair.forward?.[controller.state] ?? chair.defaultForward ?? 0
      );
      chair.setVisible(true);
      log('sys', 'Chair finished loading; she was already sitting, so she settles onto it');
    }
    const gaps = Object.entries(info.hipGapByState)
      .map(([s, g]) => `${s.replace('sitting', '')} ${g >= 0 ? '+' : ''}${g}`)
      .join(', ');
    // The forward figure is the one that reads as a bug when it is wrong: it is
    // her hips as a fraction of seat depth, where ~0.5 is the front edge.
    const fwd = Object.entries(info.hipForwardOfSeatByState)
      .map(([s, f]) => `${s.replace('sitting', '')} ${(f * 100).toFixed(0)}%`)
      .join(', ');
    log(
      'sys',
      `Chair: ${info.worldSize.join(' x ')} units, seat at ${info.seatTop} - hip gap ${gaps} - seated ${fwd} of seat depth forward`
    );
  } catch (e) {
    chair = null;
    log('err', `Chair not loaded: ${e.message}`);
  }
}

/** Sustained pet -> the KISS clip, plus a spoken line. */
function onPetReward() {
  // If she is mid-sentence, let her finish and kiss afterwards. Firing now
  // would stop the audio and truncate the line mid-word.
  if (controller.state === STATES.TALKING) {
    pendingChosen = STATES.KISS;
    log('sys', 'she will kiss you when she finishes');
  } else {
    enterKiss();
  }
  reactToPet('kiss');
}

async function reactToPet(kind) {
  if (!chat) chat = new ChatClient();
  ensureSpeech();

  const p = PET_PROMPTS[kind] || PET_PROMPTS.start;
  log('sys', kind === 'kiss' ? 'you petted her (she kissed you)' : kind === 'start' ? 'you petted her' : 'you petted her again');

  queue.reset();
  const sentences = [];
  // The narration is sent as the user turn; the stance rides in the system
  // message. See PET_PROMPTS for why a user message is mandatory here.
  await chat.sendStreaming(
    p.narration,
    (s) => {
      sentences.push(s);
      queue.push(s);
    },
    { system: `${TTS.system} ${p.stance}` }
  );
  await queue.waitForDrain();
  if (sentences.length) log('orb', sentences.join(' '));
  // A pet reaction also speaks through the queue, so it also starts TALKING via
  // onFirstAudio and also has to end it. settleAfterSpeech only touches
  // TALKING, so a KISS that is playing alongside is left to its own 'finished'
  // handler rather than being cut off here.
  settleAfterSpeech();
  // A pet that turned into a deferred kiss is played now, for the same reason
  // say() does it: never interrupt her own line.
  playPendingChosen();
}

/** Poll the local services and log a single summary once they settle. */
async function refreshServices({ retries = 1, delayMs = 3000 } = {}) {
  let h = null;
  for (let i = 0; i < retries; i++) {
    h = await chat.probe();
    // Only stop once everything is genuinely up. Bailing out as soon as the
    // voice service answered would log "STT: off" while Whisper was still
    // loading, and that stale line would then never be corrected.
    if (h.llm && h.voice && h.stt) break;
    if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!h) return null;
  if (!h.llm) log('err', 'No AI backend found — run `npm run listener` for Gemini or start LM Studio');
  if (!h.voice) log('err', 'Voice service down — run: python voice/local_voice.py');
  else if (!h.stt) log('err', 'Voice service up but STT disabled (--no-stt) — no dictation.');
  if (h.isGemini) {
    log('sys', `Brain: 🌸 Gemini Agent (Active Listener + Tools) · Voice: ${h.voice ? 'Piper' : 'off'} · STT: ${h.stt ? `whisper ${h.sttDevice || 'local'}` : 'off'}`);
  } else if (h.llm) {
    log('sys', `Model: ${h.llmModel} · voice: ${h.voice} · STT: ${h.stt ? `whisper ${h.sttDevice}` : 'off'}`);
  }
  return h;
}

/**
 * Return to IDLE once she has finished speaking.
 *
 * The sentence queue starts TALKING via onFirstAudio, so something has to end
 * it again. The SpeechSource `onend` handler cannot do this: it only fires for
 * speech.speak(), and the streaming path plays audio through the queue instead.
 * Without this she stayed in TALKING until the inactivity timer rescued her
 * 15 seconds later.
 */
function settleAfterSpeech() {
  lipSync?.reset();
  stage.mouthLight.intensity = 0;
  // If a reaction one-shot is pending, let playPendingChosen transition directly
  // to avoid a double-transition pop through IDLE.
  if (pendingChosen) return;
  if (controller.state === STATES.TALKING) {
    controller.transitionTo(STATES.IDLE, 0.4);
  }
  // Seated, settle back into the seated idle rather than standing her up.
  if (controller.state === STATES.SITTING_TALKING) {
    controller.transitionTo(STATES.SITTING_IDLE, 0.5);
  }
  inactivity.notifyActivity();
  setStatus('Ready', 'ready');
}

/**
 * Act on the animation the model chose for itself.
 *
 * One-shots are NOT fired here. The tag is parsed from the first streamed
 * chunk, so firing immediately would start the 7s kiss clip and then have the
 * first word of audio cut it off two seconds later. Instead the choice is
 * recorded and played after she has finished speaking, which reads as a
 * reaction rather than an interruption. `talking` is a no-op because TALKING is
 * already started by the first audio.
 */
function applyChosenAnimation(choice) {
  // Recorded BEFORE the null guard, and reset on null. Leaving the previous
  // value in place made the HUD show a stale choice for a turn that never chose
  // anything, which reads as "she picked bored and nothing happened" — the same
  // misleading picture as a suppressed choice, from a different cause.
  lastChosenAnimation = choice || null;
  if (!choice) {
    log('sys', 'no anim tag this turn (model answered untagged)');
    return;
  }
  if (choice === STATES.TALKING || choice === STATES.IDLE) return;

  // Sitting is a resting state, not a one-shot, so it does not go through the
  // deferred queue - it applies immediately and stays until something else
  // takes her off the chair.
  if (choice === 'sit' || choice === 'sittalk') {
    enterSitting(choice === 'sittalk' ? STATES.SITTING_TALKING : STATES.SITTING_IDLE);
    return;
  }

  if (choice === STATES.BORED) {
    if (!claimCooldown(STATES.BORED, 30_000)) return;
    pendingChosen = STATES.BORED;
    return;
  }
  if (choice === STATES.KISS) {
    if (!claimCooldown(STATES.KISS, 45_000)) return;
    pendingChosen = STATES.KISS;
  }
}

/**
 * Take the cooldown for one one-shot animation.
 *
 * Returns false if that SAME animation is still cooling down. The suppression
 * is logged rather than silent: a choice that is discarded on arrival is
 * indistinguishable from the model never having chosen it, which is exactly how
 * this bug looked from the outside.
 */
function claimCooldown(anim, ms) {
  const now = performance.now();
  const until = chosenCooldowns.get(anim) ?? 0;
  if (now < until) {
    log(
      'sys',
      `${anim} suppressed: still cooling down, ${Math.ceil((until - now) / 1000)}s left`
    );
    return false;
  }
  chosenCooldowns.set(anim, now + ms);
  return true;
}

/** Play the one-shot she picked, once she has stopped talking. */
function playPendingChosen() {
  const choice = pendingChosen;
  pendingChosen = null;
  if (!choice) return;
  if (choice === STATES.BORED) {
    if (controller.state !== STATES.BORED) enterBored();
  } else if (choice === STATES.KISS) {
    enterKiss();
  }
}

/**
 * Sit down / stand up.
 *
 * Sitting is a resting state rather than a one-shot, so the controller's
 * `finished` handler does not return her to idle - standing up is explicit, or
 * happens when she next speaks.
 */
function enterSitting(state = STATES.SITTING_IDLE) {
  if (SEATED_STATES.has(controller.state)) return;
  const target = state === STATES.SITTING_TALKING ? state : STATES.SITTING_IDLE;
  controller.transitionTo(target, 0.7);
  // She is much lower in frame, so the camera has to come down with her.
  stage.setSeated(true);
  // Drop her onto the seat: the clips bake in a hip height taller than a real
  // chair, so the model sinks to compensate, and she moves forward off the
  // chair's geometric centre.
  rig.setSeated(
    chair?.sink?.[target] ?? chair?.defaultSink ?? 0,
    chair?.forward?.[target] ?? chair?.defaultForward ?? 0
  );
  inactivity.notifyActivity();
}

function standUp() {
  if (!SEATED_STATES.has(controller.state)) return;
  controller.transitionTo(STATES.IDLE, 0.6);
  stage.setSeated(false);
  // Back to the grounded standing position, with no forward nudge.
  rig.setSeated(0, 0);
  log('sys', 'she stands up');
}

/** Dictation: record until silence, transcribe locally, then run the turn. */
async function dictate() {
  if (!stt) stt = new SttClient();
  if (stt.recording) {
    stt.stop();
    return;
  }
  ensureSpeech();
  // Both copies highlight, so the button reacts wherever it is on screen.
  micBtn?.classList.add('rec');
  micFs?.classList.add('rec');
  setStatus('Listening…', 'listening');
  try {
    const { text } = await stt.record((lvl) => {
      const scale = String(0.4 + lvl);
      micBtn?.style.setProperty('--level', scale);
      micFs?.style.setProperty('--level', scale);
    });
    micBtn?.classList.remove('rec');
    micFs?.classList.remove('rec');
    if (text) {
      inputEl.value = text;
      log('you', `${text}  (heard)`);
      await say();
    } else {
      setStatus('Heard nothing');
    }
  } catch (e) {
    micBtn?.classList.remove('rec');
    micFs?.classList.remove('rec');
    log('err', `Mic error: ${e.message}`);
    setStatus(`Mic error: ${e.message}`, 'error');
  }
}

// --------------------------------------------------------------------- frame
let frameErrors = 0;

/**
 * Per-frame update.
 *
 * Order matters and is load-bearing:
 *   1. baked animation settles the pose,
 *   2. the state machine may change state,
 *   3. procedural layers are applied ON TOP of that settled pose,
 *   4. lip-sync writes morph targets last,
 *   5. the HUD reads the result.
 *
 * Everything is wrapped so a single bad frame reports once and keeps the
 * renderer alive, rather than silently freezing the canvas.
 */
function frame(dt, elapsed) {
  try {
    // 1. Advance baked animation first, so procedural layers build on a settled
    //    pose rather than fighting a half-written one.
    controller.update(dt);

    // 1b. Damp exaggerated hand/finger bone amplitudes from the clips, so the
    //     procedural layers below read a settled base that is not over-swinging.
    damping?.update();

    // 1c. Hair / dangling props, AFTER the mixer so the hair reacts to the pose
    //     that is actually about to be drawn rather than last frame's.
    hair?.update(dt);

    // 2. Inactivity -> BORED. Never while talking.
    if (inactivity.update(dt, controller.state)) {
      enterBored();
    }

    // 3. Petting reaction, and procedural life layered on top of the clip.
    petting?.update(dt, petHover, onPetReward);
    const gaze = GAZE[controller.state] || GAZE.idle;
    // Touch point wins while petting, then the pointer, then the camera.
    const gazeTarget = petting?.lookTarget || (petHover ? lookTarget : stage.camera.position);
    life.update(dt, {
      blinkWeight: gaze.blinkWeight,
      squint: petting?.squint || 0,
      gaze: { yawBias: gaze.yawBias, pitchBias: gaze.pitchBias },
      lookTarget: gazeTarget,
    });
    // Bone-driven blink. The blink timer above already produces the right curve,
    // it just drives `rig.setBlink`, which is a no-op on a rig with no
    // blendshapes - so her face has been completely static. Forward the same
    // value to the eyelid bones.
    face?.setBlink(life.blink.value);

    // 4. Lip sync from the live audio signal.
    //
    // Preferred path is a real analyser fed by the voice audio (local TTS or
    // the procedural formant voice). The Web Speech API exposes no audio node,
    // so when speechSynthesis is the active voice the mouth is driven by a
    // synthetic syllabic envelope instead - still lip-synced to the speech
    // rhythm, but approximated rather than measured.
    let lipMode = 'none';
    if (lipSync && (controller.state === STATES.TALKING || controller.state === STATES.SITTING_TALKING)) {
      let weights;
      if (speech?.mode === 'speechSynthesis') {
        const env = speech.envelope();
        weights = env
          ? lipSync.updateSynthetic(dt, env.level, env.shape)
          : lipSync.updateSynthetic(dt, 0, 0.5);
        lipMode = 'envelope';
      } else {
        weights = lipSync.update(dt);
        lipMode = 'spectrum';
      }
      rig.setVisemeWeights(weights);
      // Bone-driven mouth, because this model has no viseme blendshapes at all.
      // Same signal, second output: the morph path drives nothing, so without
      // this she speaks with a completely static face.
      face?.setJaw(Math.min(1, lipSync.level * 2.2));
      // A faint light bloom on the mouth scaled by loudness.
      stage.mouthLight.intensity = Math.min(1, lipSync.level * 3) * 0.55;
    } else {
      // Fall back to a closed mouth.
      rig.setViseme('sil', 1);
      face?.setJaw(0);
      stage.mouthLight.intensity = 0;
    }

    // 5. HUD.
    hud.update({
      state: controller.state,
      previous: previousState,
      timeInState: controller.timeInState,
      chosen: lastChosenAnimation,
      framing: zoomWord(stage.zoom),
      memoryNotes: memory?.notes.length ?? 0,
      memoryTurns: memory?.turns ?? 0,
      weights: controller.getWeightSnapshot(),
      inactivityRemaining: inactivity.remainingMs,
      inactivityProgress: inactivity.progress,
      boredCount: inactivity.boredCount,
      blinkPhase: life.blink.phase,
      blinkValue: life.blink.value,
      blinkCount: life.blink.blinkCount,
      squint: petting?.squint || 0,
      petting: petting?.active || false,
      gazeYaw: life.saccade.current.x,
      gazePitch: life.saccade.current.y,
      eyeTrack: life.saccade.enabled ? 'bone offsets' : 'unavailable',
      voiceMode: speech?.speaking ? `${speech.mode || '...'}${lipMode === 'envelope' ? ' (envelope)' : lipMode === 'spectrum' ? ' (spectrum)' : ''} · ${lastEmotion}` : 'idle',
      rms: lipSync?.rms ?? 0,
      visemes: lipSync?.weights ?? { sil: 1 },
      frameErrors,
    });
  } catch (err) {
    frameErrors++;
    if (frameErrors <= 3) console.error('[frame] update failed', err);
  }
}

// ------------------------------------------------------------------- cloud
/**
 * Cloud fallback settings.
 *
 * She normally runs on the model on your PC, reached over Tailscale. When
 * that is unreachable — the PC is asleep, or off the tailnet — this
 * configures a hosted model to use INSTEAD, called directly from this
 * device rather than through the PC.
 *
 * The key lives in this browser's localStorage. It never goes to the PC,
 * never enters the repository, and never leaves the device except as an
 * Authorization header to the provider that was chosen.
 */

function setCloudStatus(msg, kind = '') {
  cloudStatus.textContent = msg;
  cloudStatus.className = `sheet-status ${kind}`;
}

function currentProvider() {
  const id = cloudProviderSel.value;
  return CLOUD.providers[id] || CLOUD.providers[Object.keys(CLOUD.providers)[0]];
}

/** Fill the model list and the hint for the selected provider. */
function refreshCloudModels() {
  const p = currentProvider();
  cloudModelList.innerHTML = '';
  for (const m of p.models) {
    const opt = document.createElement('option');
    opt.value = m;
    cloudModelList.appendChild(opt);
  }
  cloudHint.textContent = p.note || '';
  cloudKeyInput.placeholder = p.keyHint || 'API key';
  // Only the custom provider has an editable endpoint.
  cloudBaseField.hidden = !p.editableBase;
}

/** The settings currently in the form. */
function cloudFormValues() {
  const p = currentProvider();
  return {
    provider: cloudProviderSel.value,
    model: cloudModelInput.value.trim() || p.defaultModel,
    apiKey: cloudKeyInput.value.trim(),
    base: p.editableBase ? cloudBaseInput.value.trim() : p.base,
  };
}

/** Reflect the configured state on the button that opens the sheet. */
function markCloudActive(on) {
  if (!cloudToggleBtn) return;
  cloudToggleBtn.setAttribute('aria-pressed', String(on));
  cloudToggleBtn.classList.toggle('active', on);
  cloudToggleBtn.textContent = on ? 'cloud ●' : 'cloud';
}

function openCloudSheet() {
  if (!cloudProviderSel.options.length) {
    for (const [id, p] of Object.entries(CLOUD.providers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.label;
      cloudProviderSel.appendChild(opt);
    }
    cloudProviderSel.addEventListener('change', () => {
      cloudModelInput.value = currentProvider().defaultModel;
      refreshCloudModels();
    });
  }
  const s = loadCloudSettings();
  cloudProviderSel.value = s?.provider || Object.keys(CLOUD.providers)[0];
  refreshCloudModels();
  cloudModelInput.value = s?.model || currentProvider().defaultModel;
  cloudBaseInput.value = s?.base || '';
  cloudKeyInput.value = s?.apiKey || '';
  apiBaseInput.value = getApiBase();
  apiBaseHint.textContent = `Currently: ${describeConnection()}`;
  setCloudStatus(s ? `Active — ${describeCloud()}` : 'Not configured', s ? 'ok' : '');
  cloudSheet.hidden = false;
}

function closeCloudSheet() {
  cloudSheet.hidden = true;
}

function saveCloud() {
  // The PC address is saved independently of the cloud settings: it is
  // about WHERE the stack is, not about which model answers.
  setApiBase(apiBaseInput.value);
  apiBaseHint.textContent = `Currently: ${describeConnection()}`;

  const v = cloudFormValues();
  if (!v.apiKey && !v.base) {
    setCloudStatus('An API key is required.', 'error');
    return;
  }
  saveCloudSettings(v);
  setCloudStatus(`Saved — ${describeCloud()}`, 'ok');
  markCloudActive(true);
  log('sys', `Cloud fallback: ${describeCloud()}`);
}

/**
 * Check the key actually works.
 *
 * A saved key that does not work is worse than no key at all, because she
 * would silently fail every time the PC is asleep. This sends the smallest
 * possible request and reports exactly what came back.
 */
async function testCloud() {
  setCloudStatus('Testing…');
  const saved = saveCloudSettings(cloudFormValues());
  const base = (saved.base || '').replace(/\/+$/, '');
  if (!base) {
    setCloudStatus('No endpoint configured.', 'error');
    return;
  }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(saved.apiKey ? { Authorization: `Bearer ${saved.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: saved.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 10,
      }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        detail = j?.error?.message || j?.error || detail;
      } catch { /* not json */ }
      setCloudStatus(`Failed: ${detail}`, 'error');
      return;
    }
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content?.trim() || '(no text)';
    setCloudStatus(`Works — "${text}"`, 'ok');
    markCloudActive(true);
  } catch (e) {
    setCloudStatus(`Failed: ${e.message}`, 'error');
  }
}

function removeCloud() {
  clearCloudSettings();
  cloudKeyInput.value = '';
  setCloudStatus('Removed. She will use the model on your PC only.', '');
  markCloudActive(false);
  log('sys', 'Cloud fallback removed');
}

cloudToggleBtn?.addEventListener('click', openCloudSheet);
cloudCloseBtn?.addEventListener('click', closeCloudSheet);
cloudSaveBtn?.addEventListener('click', saveCloud);
cloudTestBtn?.addEventListener('click', testCloud);
cloudClearBtn?.addEventListener('click', removeCloud);
// Tapping the backdrop closes it, the way a sheet is expected to behave.
cloudSheet?.addEventListener('click', (e) => { if (e.target === cloudSheet) closeCloudSheet(); });
markCloudActive(cloudConfigured());

// ------------------------------------------------------------------- mobile
/**
 * Phone integration.
 *
 * Four things a phone needs that a desktop does not:
 *
 *  1. A gate. Mobile browsers refuse to start an AudioContext without a
 *     user gesture, and the whole lip-sync path is an AudioContext graph —
 *     the analyser the visemes are computed from is a node in it. Without
 *     this, the first reply comes out silent with no indication why.
 *  2. A screen wake lock, or the display sleeps halfway through a sentence.
 *  3. A layout that follows the on-screen keyboard, which `dvh` does not
 *     cover.
 *  4. A collapsed HUD, because the telemetry is the biggest block in a panel
 *     that is 360px wide.
 */

const isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;

// --- 1. the audio gate -------------------------------------------------------

let gateOpen = true;

/**
 * Create and resume the audio graph.
 *
 * The AudioContext is created SYNCHRONOUSLY inside this function, before the
 * first await. That matters: a user gesture is only valid for the task it
 * happened in, so deferring the `new AudioContext()` past an await would
 * have it created with no activation and the browser would leave it
 * suspended forever.
 */
async function primeAudio() {
  ensureSpeech();
  const ctx = speech?.ctx;
  if (ctx && ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* the browser refused; the gate stays up */ }
  }
}

async function dismissGate() {
  if (!gateOpen) return;
  gateOpen = false;
  // Hidden first, then primed: the gate must not linger over the canvas
  // while the resume promise settles.
  if (gateEl) gateEl.hidden = true;
  await primeAudio();
  wantsWakeLock = true;
  await acquireWakeLock();
  log('sys', 'Audio enabled.');
}

// --- 2. the screen wake lock ------------------------------------------------

let wakeLock = null;
let wantsWakeLock = false;

async function acquireWakeLock() {
  if (!wantsWakeLock) return;
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Denied, or the device is in a state where it will not grant one. Not
    // fatal: the screen simply dims.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Android drops the lock when the screen turns off and does NOT hand it
    // back on its own, so it has to be re-requested on every return to the
    // foreground. Without this the screen sleeps again the moment the phone
    // is pocketed and unlocked again.
    void acquireWakeLock();
  } else {
    wakeLock?.release?.().catch(() => {});
    wakeLock = null;
  }
});

// --- 3. the on-screen keyboard ----------------------------------------------

/**
 * Keep the app sized to the VISUAL viewport.
 *
 * `dvh` follows the browser's own chrome but NOT the on-screen keyboard, so
 * when the keyboard opens the app has to shrink with it or the input being
 * typed into sits underneath the keyboard.
 */
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  // Floor of 200px: a collapsed visual viewport during a rotation animation
  // would otherwise squash the app to nothing for a frame.
  const h = Math.max(200, Math.round(vv.height));
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
  syncViewport();
}

// --- 4. the collapsed HUD ----------------------------------------------------

if (quality.mobile) {
  appEl.classList.add('no-hud');
  hudToggleBtn?.setAttribute('aria-pressed', 'false');
  hudToggleBtn?.setAttribute('aria-expanded', 'false');
}

// --- wire the gate -----------------------------------------------------------

if (isCoarsePointer && gateEl) {
  // Shown, not merely wired up. The element ships with the `hidden`
  // attribute so that a desktop load never flashes it, which means the
  // touch path has to take it off again explicitly.
  gateEl.hidden = false;
  // Dismissed by the first touch ANYWHERE, not only by the button: someone
  // who taps her straight away should not be blocked by a dialog, and their
  // tap is just as good a user gesture.
  document.addEventListener('pointerdown', dismissGate, { capture: true, once: true });
  gateBtn?.addEventListener('click', dismissGate);
} else {
  gateOpen = false;
  if (gateEl) gateEl.hidden = true;
}

boot();
