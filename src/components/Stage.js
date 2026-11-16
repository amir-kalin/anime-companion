import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RENDER } from '../utils/config.js';

/**
 * Stage
 *
 * White studio: solid white background, a black square grid on the floor that
 * fades to nothing at the horizon, and the character lit by a prefiltered
 * environment probe plus three shaped lights.
 *
 * Two camera framings (`full` and `face`) since the procedural
 * micro-expressions are unreadable at full-body distance but the Mixamo clips
 * are full-body gestures that a close-up crops away.
 */
export class Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [quality] from `pickQuality()` — pixelRatio, shadowMap,
   *   antialias, targetFps. Falls back to the desktop profile so a caller that
   *   does not care still gets today's behaviour.
   */
  constructor(canvas, quality = null) {
    this.canvas = canvas;
    // Resolved once here so the render loop and the light rig read the same
    // numbers instead of each deciding for itself.
    this.quality = quality || { pixelRatio: 2, shadowMap: 2048, antialias: true, targetFps: 0 };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = RENDER.exposure;
    if (RENDER.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    const isOverlay = typeof window !== 'undefined' && (
      window.location.search.includes('overlay=1') ||
      document.body.classList.contains('overlay-mode')
    );
    this.isOverlay = isOverlay;

    this.scene = new THREE.Scene();
    if (!isOverlay) {
      this.scene.background = new THREE.Color(RENDER.background);
    } else {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    }
    // No fog: on a white background fog reads as a grey haze and dirties the
    // clean backdrop. The grid's own distance fade handles the horizon.
    this.scene.fog = null;

    this.camera = new THREE.PerspectiveCamera(RENDER.fov, 1, 0.1, 100);
    this.framing = 'full';
    // Normalised zoom: 0 = closest, 1 = furthest. Each framing preset is just a
    // default for this, so scrolling away from a preset is not a mode change.
    this.zoom = 1;
    this.zoomPreset = true;
    // Orbit, in spherical coordinates around the target.
    this.azimuth = 0;
    this.elevation = 0;
    this.distance = 3.45;
    this.cameraTarget = new THREE.Vector3();
    this.seated = false;
    this.lock = false;
    this.headProvider = null;
    this._headPos = new THREE.Vector3();
    this._headYaw = 0;
    this.onZoom = null;
    this._applyFraming(this.framing);

    this._buildEnvironment();
    this._buildLights();
    this._buildGrid();

    this.clock = new THREE.Clock();
    this._onFrame = null;
    this._running = false;
    this._tick = this._tick.bind(this);

    // ResizeObserver covers normal layout changes; the window listener is kept
    // because observers are delivered on the rendering step, which can be
    // starved when the tab is throttled.
    this._observer = new ResizeObserver(() => this.resize());
    this._observer.observe(canvas.parentElement || canvas);
    window.addEventListener('resize', (this._resizeBound = () => this.resize()));
    this.resize();
  }

  /**
   * Place the camera for the current zoom + orbit + lock.
   *
   * Distance and look-at height both derive from the single normalised `zoom`
   * value, so the look-at slides from her head down to her body centre as you
   * pull back. A fixed look-at height would put a fully zoomed-in view on her
   * midriff, which is the obvious-but-wrong way to do this.
   *
   * The camera itself sits on a sphere around the target:
   *   azimuth  - where around her you are, 0 = dead ahead (+Z)
   *   elevation- angle above the target's horizontal
   */
  _updateCamera() {
    const { min, max, headFocus, bodyFocus, seatedHeadFocus, seatedBodyFocus } = RENDER.zoom;
    const t = THREE.MathUtils.clamp(this.zoom, 0, 1);
    this.distance = THREE.MathUtils.lerp(min, max, t);

    // Target: her head when locked, otherwise a height that follows the zoom.
    if (this.lock && this.headProvider) {
      this.headProvider(this._headPos, this._headYaw);
      this.cameraTarget.copy(this._headPos);
    } else {
      // Seated she is much lower in frame, so the look-at drops with her.
      const hi = this.seated ? seatedHeadFocus : headFocus;
      const lo = this.seated ? seatedBodyFocus : bodyFocus;
      this.cameraTarget.set(0, THREE.MathUtils.lerp(hi, lo, t), 0);
    }

    const horiz = this.distance * Math.cos(this.elevation);
    this.camera.position.set(
      this.cameraTarget.x + horiz * Math.sin(this.azimuth),
      this.cameraTarget.y + this.distance * Math.sin(this.elevation),
      this.cameraTarget.z + horiz * Math.cos(this.azimuth)
    );
    // Never dip below the floor, or the grid would be seen edge-on from beneath.
    if (this.camera.position.y < 0.05) this.camera.position.y = 0.05;
    this.camera.lookAt(this.cameraTarget);
  }

  /**
   * @param {THREE.Vector3} out world head position
   * @param {number} outYaw receives her head's world yaw, for head lock
   */
  setHeadProvider(fn) {
    this.headProvider = fn;
  }

  setLock(on) {
    this.lock = Boolean(on);
    this._updateCamera();
    this.onZoom?.(this.zoom);
    return this.lock;
  }

  toggleLock() {
    return this.setLock(!this.lock);
  }

  /** Drop the look-at height while she is seated. */
  setSeated(on) {
    if (this.seated === Boolean(on)) return;
    this.seated = Boolean(on);
    this._updateCamera();
  }

  /**
   * Orbit by a pixel delta. Horizontal drags spin around her, vertical drags
   * raise and lower the camera.
   */
  orbitBy(dx, dy) {
    this.azimuth -= dx * RENDER.orbit.sensitivity;
    this.elevation = THREE.MathUtils.clamp(
      this.elevation - dy * RENDER.orbit.sensitivity,
      RENDER.orbit.minElevation,
      RENDER.orbit.maxElevation
    );
    this._updateCamera();
    this.onZoom?.(this.zoom);
  }

  /** Snap back to a straight-on view at the current zoom. */
  resetOrbit() {
    this.azimuth = 0;
    this.elevation = 0;
    this._updateCamera();
    this.onZoom?.(this.zoom);
  }

  /** Map a framing preset onto the normalised zoom axis. */
  _zoomForFraming(name) {
    const f = RENDER.framing[name] || RENDER.framing.full;
    const { min, max } = RENDER.zoom;
    return THREE.MathUtils.clamp((f.distance - min) / (max - min), 0, 1);
  }

  _applyFraming(name) {
    this.framing = name;
    this.zoom = this._zoomForFraming(name);
    this.azimuth = 0;
    this.elevation = 0;
    this._updateCamera();
  }

  /**
   * @param {number} t 0..1
   * @param {boolean} [fromUser=true] scrolling away from a preset
   */
  setZoom(t, fromUser = true) {
    const next = THREE.MathUtils.clamp(t, 0, 1);
    if (next === this.zoom) return this.zoom;
    this.zoom = next;
    if (fromUser) this.zoomPreset = false;
    this._updateCamera();
    this.onZoom?.(this.zoom);
    return this.zoom;
  }

  /** @param {number} delta negative zooms in */
  zoomBy(delta) {
    return this.setZoom(this.zoom + delta);
  }

  /** Return to whatever the current framing preset implies. */
  resetZoom() {
    // Must go through _applyFraming, not just _updateCamera: otherwise the
    // zoom value is left wherever the user last scrolled to and "reset" does
    // nothing. Presets are defined as a distance, so it has to be converted
    // back onto the normalised axis.
    this._applyFraming(this.framing);
    this.zoomPreset = true;
    this.onZoom?.(this.zoom);
    return this.zoom;
  }

  /** Switch framing, which also resets the zoom to that preset. */
  setFraming(name) {
    if (!RENDER.framing[name] || name === this.framing) return this.framing;
    this._applyFraming(name);
    this.zoomPreset = true;
    this.onZoom?.(this.zoom);
    this.resize();
    return name;
  }

  toggleFraming() {
    return this.setFraming(this.framing === 'full' ? 'face' : 'full');
  }

  setOverlay(active) {
    this.isOverlay = Boolean(active);
    if (this.isOverlay) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      if (this.grid) this.grid.visible = false;
      if (this.contactShadow) this.contactShadow.visible = false;
    } else {
      this.scene.background = new THREE.Color(RENDER.background);
      this.renderer.setClearColor(RENDER.background, 1);
      if (this.grid) this.grid.visible = true;
      if (this.contactShadow) this.contactShadow.visible = true;
    }
  }

  add(object) {
    this.scene.add(object);
  }

  /**
   * Image-based lighting.
   *
   * Without an environment map, MeshStandardMaterial has nothing to reflect
   * and surfaces collapse to whatever the direct lights hit, which is most of
   * the "plastic" look. The probe also keeps her from washing out against a
   * white background, since it supplies lit-from-above variation.
   */
  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = envRT.texture;
    this.scene.environmentIntensity = RENDER.envIntensity ?? 1.0;
    this._envRT = envRT;
    pmrem.dispose();
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8de, 0.75));

    const key = new THREE.DirectionalLight(0xfff4e8, 1.7);
    key.position.set(-1.6, 2.6, 2.2);
    if (RENDER.shadows) {
      key.castShadow = true;
      // From the device profile: 1024 on a phone over the same ~3.2 unit box,
      // 2048 on desktop. See QUALITY in config.js for the reasoning.
      key.shadow.mapSize.set(this.quality.shadowMap, this.quality.shadowMap);
      key.shadow.camera.near = 0.5;
      key.shadow.camera.far = 9;
      key.shadow.camera.left = -1.6;
      key.shadow.camera.right = 1.6;
      key.shadow.camera.top = 2.2;
      key.shadow.camera.bottom = -0.4;
      key.shadow.bias = -0.0009;
      key.shadow.radius = 3;
    }
    this.scene.add(key);

    // Rim light, still the one that should stay punchy: it is what separates
    // her hair and shoulders from a white background.
    const rim = new THREE.DirectionalLight(0x9fd8ff, 1.15);
    rim.position.set(1.9, 1.6, -2.2);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0xfff0e2, 0.35);
    fill.position.set(0.8, -0.8, 1.6);
    this.scene.add(fill);

    // Faint mouth light so the lips catch a highlight while she speaks.
    this.mouthLight = new THREE.PointLight(0xffe6d0, 0, 1.2, 2);
    this.mouthLight.position.set(0, RENDER.mouthLightHeight, 0.42);
    this.scene.add(this.mouthLight);
  }

  /**
   * Floor grid: plain black squares on white, fading out with distance.
   *
   * Built as LineSegments with per-vertex alpha rather than THREE.GridHelper,
   * because GridHelper draws a hard rectangle of lines and leaves a visible
   * edge in an otherwise empty white frame. Fading to nothing reads as an
   * infinite floor, which is the "simple and modern" look that was asked for.
   */
  _buildGrid() {
    const { color, divisions, extent, fadeStart, fadeEnd } = RENDER.grid;
    const step = (extent * 2) / divisions;
    const positions = [];
    const colors = [];
    const base = new THREE.Color(color);
    const c = new THREE.Color();

    const push = (x1, z1, x2, z2) => {
      for (const [x, z] of [[x1, z1], [x2, z2]]) {
        // Alpha is carried in the vertex colour; the material is transparent.
        const d = Math.hypot(x, z);
        const t = THREE.MathUtils.clamp((d - fadeStart) / (fadeEnd - fadeStart), 0, 1);
        const a = 1 - t;
        c.copy(base).multiplyScalar(a);
        positions.push(x, 0, z);
        colors.push(c.r, c.g, c.b);
      }
    };

    for (let i = -divisions / 2; i <= divisions / 2; i++) {
      const o = i * step;
      push(o, -extent, o, extent); // lines along Z
      push(-extent, o, extent, o); // lines along X
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const grid = new THREE.LineSegments(geo, mat);
    grid.name = 'floor-grid';
    // Slightly above y=0 so it cannot z-fight with the shadow catcher.
    grid.position.y = 0.001;
    if (this.isOverlay) grid.visible = false;
    this.scene.add(grid);
    this.grid = grid;

    this._buildContactShadow();
  }

  /**
   * Soft blob under her feet.
   *
   * The floor is drawn as lines, so there is no surface for the directional
   * light to cast onto and she appears to hover. A radial-gradient sprite gives
   * the grounding back cheaply, and reads as a studio floor rather than a hard
   * shadow.
   */
  _buildContactShadow() {
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(20,20,24,0.42)');
    g.addColorStop(0.55, 'rgba(20,20,24,0.20)');
    g.addColorStop(1, 'rgba(20,20,24,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.002;
    mesh.renderOrder = -1;
    this.scene.add(mesh);
    this.contactShadow = mesh;
  }

  setOverlay(active) {
    this.isOverlay = Boolean(active);
    if (this.isOverlay) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      if (this.grid) this.grid.visible = false;
      if (this.contactShadow) this.contactShadow.visible = false;
    } else {
      this.scene.background = new THREE.Color(RENDER.background);
      this.renderer.setClearColor(RENDER.background, 1);
      if (this.grid) this.grid.visible = true;
      if (this.contactShadow) this.contactShadow.visible = true;
    }
  }

  add(object) {
    this.scene.add(object);
  }

  /** @param {(dt: number, elapsed: number) => void} fn */
  onFrame(fn) {
    this._onFrame = fn;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.clock.start();
    this._lastRenderAt = 0;
    requestAnimationFrame(this._tick);
  }

  stop() {
    this._running = false;
  }

  _tick() {
    if (!this._running) return;
    requestAnimationFrame(this._tick);

    /**
     * Optional frame cap (mobile: 45fps).
     *
     * The skipped ticks do NOT call getDelta(), which is the whole point:
     * Clock.getDelta() returns the time since the previous CALL, so consuming
     * it on a skipped tick would hand the render tick only the leftover
     * ~5ms and her animation would advance in slow motion while the frame
     * rate looked correct. Skipping without consuming lets the clock
     * accumulate, so the next rendered frame gets the true elapsed time and
     * everything stays real-time.
     */
    const target = this.quality.targetFps;
    if (target > 0) {
      const now = performance.now();
      // -1ms of slack: rAF fires on vsync boundaries, so a strict `< 22.22ms`
      // test at 45fps on a 60Hz display would never pass and she would freeze.
      if (now - this._lastRenderAt < 1000 / target - 1) return;
      this._lastRenderAt = now;
    }

    // Clamp dt so a backgrounded tab does not fast-forward the whole
    // animation and blink system on return.
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    // The update callback is user code and may throw. Keep rendering anyway:
    // a thrown update must never leave a frozen canvas.
    try {
      this._onFrame?.(dt, elapsed);
      // Recompute the camera AFTER the frame so head lock tracks the pose that
      // was just applied, not last frame's.
      if (this.lock) this._updateCamera();
    } catch (err) {
      this.updateErrors = (this.updateErrors || 0) + 1;
      if (this.updateErrors <= 3) console.error('[Stage] frame update threw', err);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Sync the drawing buffer to the canvas' CSS size.
   *
   * Public and safe to call directly: reading clientWidth forces a synchronous
   * reflow, so calling this straight after toggling a layout class gets the new
   * size immediately instead of waiting for a ResizeObserver callback that may
   * be delayed on a throttled tab.
   */
  resize() {
    const parent = this.canvas.parentElement || document.body;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.stop();
    this._observer.disconnect();
    window.removeEventListener('resize', this._resizeBound);
    this.renderer.dispose();
  }
}
