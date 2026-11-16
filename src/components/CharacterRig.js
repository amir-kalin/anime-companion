import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODEL, EYE_BONES, BLINK_SHAPES, VISEMES, materialPreset } from '../utils/config.js';
import { deriveNormalMap, deriveAoMap, whenImageReady } from '../utils/textures.js';
import { RETARGET } from '../animation/retarget.js';

/**
 * Pick a loader from the file extension.
 *
 * The rig used to be FBX-only, which meant any downloaded character had to be
 * an `.fbx` or it simply would not load. Most freely downloadable anime
 * characters ship as `.vrm` (a glTF variant) or `.glb`, so those are accepted
 * too. `.vrm` is read with GLTFLoader: that yields the mesh and the skeleton,
 * which is what the animation mixer binds against. The VRM-specific extras
 * (humanoid bone remapping) are a separate concern - see tools/check-model.mjs,
 * which measures the thing that actually matters: whether the existing clips
 * bind by bone name.
 */
function loaderFor(url) {
  const ext = url.split('?')[0].split('#')[0].toLowerCase();
  if (ext.endsWith('.glb') || ext.endsWith('.gltf') || ext.endsWith('.vrm')) {
    return new GLTFLoader();
  }
  return new FBXLoader();
}

/**
 * Case/format-insensitive lookup across every morph target on the model.
 *
 * Model authors are wildly inconsistent about blendshape names ("Blink L",
 * "Blink_L", "blink.l"), and VRM/FBX/GLTF each use a different convention, so
 * every semantic role is resolved by trying a list of candidate names.
 */
class MorphRegistry {
  constructor(meshes) {
    /** @type {Map<string, {mesh: THREE.Mesh, index: number}>} lowercased name -> target */
    this.index = new Map();
    this.meshes = meshes;
    for (const mesh of meshes) {
      const dict = mesh.morphTargetDictionary;
      if (!dict) continue;
      for (const [name, i] of Object.entries(dict)) {
        const key = name.toLowerCase();
        // First mesh wins, so overlapping names stay deterministic.
        if (!this.index.has(key)) this.index.set(key, { mesh, index: i });
      }
    }
  }

  /** @returns {{mesh: THREE.Mesh, index: number}|null} */
  resolve(candidates) {
    for (const cand of candidates) {
      const hit = this.index.get(cand.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  /** Apply a 0..1 weight if the target exists. @returns {boolean} whether it was found */
  set(candidates, value) {
    const hit = this.resolve(candidates);
    if (!hit) return false;
    const { mesh, index } = hit;
    if (!mesh.morphTargetInfluences) return false;
    mesh.morphTargetInfluences[index] = value;
    return true;
  }

  clearAll() {
    for (const mesh of this.meshes) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences.fill(0);
    }
  }
}

/**
 * CharacterRig
 *
 * Loads the character FBX, normalises its transform into a sensible world
 * space, and resolves every rig handle the animation + procedural layers need
 * (eyeballs, head, blink shapes, viseme shapes).
 *
 * The mesh ships in centimetres (~2331 units tall) facing +Z, so it is scaled
 * to MODEL.targetHeight and grounded with the root bone on the world origin.
 */
export class CharacterRig {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'CharacterRig';

    this.model = null;
    this.meshes = [];
    this.bones = new Map();
    /** Lowercased bone name -> bone, so lookups survive a case-only mismatch. */
    this.bonesLower = new Map();
    this.morphs = null;
    this.bindings = {};
    this.meta = {};
    /**
     * Extra Y offset applied to the model, in rig units, used when she sits.
     * The sitting clips bake in a hip height of 0.530, which is taller than a
     * real chair seat for a 1.62-unit character. Sinking the model lets the
     * chair keep its true proportions instead of being scaled up to meet her
     * (which made it a 1.10-unit armchair next to a 1.62-unit girl).
     */
    this.seatedOffsetY = 0;
    /** Seated Z offset; positive moves her toward the camera. */
    this.seatedOffsetZ = 0;
  }

  /**
   * Offset the model for a seated pose, so she sits ON the chair rather than in
   * it.
   *
   * `deltaY` and `deltaZ` are SIGNED rig-unit offsets: negative Y lowers her,
   * positive Z moves her toward the camera. Sign matters — the wrong sign on Y
   * leaves her hovering a full sink-distance above the seat, which reads as
   * levitating rather than slightly misaligned.
   *
   * The defaults describe a correct seated placement: the hip joint should sit
   * slightly ABOVE the seat surface, not on it, because a real seated body rests
   * on the cushion with its thigh and glute mass below the joint. Matching the
   * joint to the surface exactly buries her in the upholstery.
   *
   * Only the model's own position is touched, never `root`, so the world
   * position used for grounding, camera framing and hit-testing is unaffected
   * for standing poses and correctly reflects the offsets while seated.
   */
  setSeated(deltaY, deltaZ) {
    const y = deltaY || 0;
    const z = deltaZ || 0;
    if (Math.abs(y - this.seatedOffsetY) < 1e-6 && Math.abs(z - this.seatedOffsetZ) < 1e-6) return;
    this.seatedOffsetY = y;
    this.seatedOffsetZ = z;
    if (!this.model) return;
    // `root` is a fresh Group at identity, so model.position IS its world
    // translation and the offsets need no parent-transform conversion.
    this.model.position.y = this.model.userData.baseY + y;
    this.model.position.z = this.model.userData.baseZ + z;
  }

  /** Remember the grounded Y so seated/unseated do not have to re-derive it. */
  _captureBase() {
    if (!this.model) return;
    this.model.userData.baseX ??= this.model.position.x;
    this.model.userData.baseY ??= this.model.position.y;
    this.model.userData.baseZ ??= this.model.position.z;
  }

  async load({ url = MODEL.url, onProgress } = {}) {
    const model = await new Promise((resolve, reject) => {
      loaderFor(url).load(
        url,
        // GLTFLoader hands back a package; the FBX is the object itself.
        (result) => resolve(result.scene ?? result),
        (e) => onProgress?.(e.loaded / (e.total || 1)),
        (err) => reject(new Error(`Failed to load character "${url}": ${err?.message || err}`))
      );
    });

    this.model = model;
    this.root.add(model);

    model.traverse((o) => {
      if (o.isBone) {
        this.bones.set(o.name, o);
        // Bone naming is the least consistent thing across model sources:
        // Mixamo ships `Hips`/`LeftUpperArm`, VRM ships `hips`/`leftUpperArm`,
        // and Blender exports use `Hips` again. Matching case-insensitively
        // means a downloaded model resolves the same bindings as the original
        // instead of silently falling back to bounding-box centring.
        const key = o.name.toLowerCase();
        if (!this.bonesLower.has(key)) this.bonesLower.set(key, o);
      }
      if (o.isMesh) {
        this.meshes.push(o);
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        // The FBX bakes an ambient/emissive tint that washes out under PBR.
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          m.envMapIntensity = 0.9;
        }
      }
    });

    this._normalise(model);
    this._resolveBindings();
    this._buildMeta();
    await this._enhanceMaterials();

    return this;
  }

  /**
   * Convert the FBX's Blinn-Phong materials to PBR and synthesise the missing
   * normal/AO maps.
   *
   * This is the single biggest quality win in the project. The FBX was written
   * with `MeshPhongMaterial`, which has no roughness, no metalness and no
   * image-based lighting, so under any amount of light tuning it renders as
   * flat waxy plastic. MeshStandardMaterial plus an environment map and a
   * derived normal map gives it actual surface response.
   */
  async _enhanceMaterials() {
    const jobs = [];
    let derived = 0;
    let skipped = 0;

    for (const mesh of this.meshes) {
      const isArray = Array.isArray(mesh.material);
      const list = isArray ? mesh.material : [mesh.material];

      const converted = list.map((m) => {
        if (!m) return m;
        const std = this._toStandard(m);
        const preset = materialPreset(std.name);

        std.roughness = preset.roughness;
        std.metalness = preset.metalness;
        std.envMapIntensity = preset.envMapIntensity;
        std.emissive = new THREE.Color(preset.emissive);
        std.emissiveIntensity = preset.emissiveIntensity;

        if (std.map) {
          // Must wait: FBXLoader resolves before its textures finish loading,
          // and synthesis against an absent image silently yields nothing.
          jobs.push(
            whenImageReady(std.map)
              .then((image) => {
                if (!image) { skipped++; return null; }
                const nrm = deriveNormalMap(image, { strength: preset.normalStrength });
                const ao = deriveAoMap(image, preset.aoStrength);
                if (nrm) {
                  std.normalMap = nrm;
                  std.normalScale.set(preset.normalScale, preset.normalScale);
                }
                // The model has a single UV set, so the AO map must read uv0.
                // Without this, three looks for uv1 and the AO does nothing.
                if (ao) {
                  ao.channel = 0;
                  std.aoMap = ao;
                }
                std.needsUpdate = true;
                if (nrm && ao) derived++;
                return null;
              })
              .catch((err) => {
                skipped++;
                console.warn('[CharacterRig] map synthesis failed', err);
                return null;
              })
          );
        }
        return std;
      });

      mesh.material = isArray ? converted : converted[0];
    }

    await Promise.all(jobs);

    this.materials = this.meshes.flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material]));
    this.meta.enhanced = true;
    this.meta.pbr = this.materials.every((m) => m?.isMeshStandardMaterial);
    this.meta.mapsDerived = derived;
    this.meta.mapsSkipped = skipped;
  }

  /**
   * Blinn-Phong -> MeshStandardMaterial, preserving everything that carries
   * over, and stashing the Phong-specific values for reference.
   */
  _toStandard(src) {
    if (src.isMeshStandardMaterial || src.isMeshPhysicalMaterial) return src;

    const std = new THREE.MeshStandardMaterial({
      name: src.name,
      color: src.color?.clone(),
      map: src.map,
      normalMap: src.normalMap,
      emissive: src.emissive?.clone(),
      transparent: src.transparent,
      opacity: src.opacity,
      alphaTest: src.alphaTest,
      side: src.side,
      depthWrite: src.depthWrite,
      vertexColors: src.vertexColors,
      flatShading: src.flatShading,
      fog: src.fog,
    });

    // aoMap needs a second UV channel by default; this model only has one.
    if (src.aoMap) {
      src.aoMap.channel = 0;
      std.aoMap = src.aoMap;
    }
    if (src.normalScale) std.normalScale.copy(src.normalScale);

    // Phong's `shininess` is roughly 2^(shininess/4)-sized; the preset roughness
    // supersedes it, but keep the original for debugging.
    std.userData.fromPhong = {
      shininess: src.shininess,
      specular: src.specular ? src.specular.getHex() : null,
    };
    return std;
  }

  /**
   * Scale to target height, drop the feet onto y=0, and centre X/Z on the
   * root bone. Centring on the bone (not the bounding box) keeps the character
   * framed when hair or a skirt makes the box very wide.
   */
  _normalise(model) {
    model.updateMatrixWorld(true);

    const rawBox = new THREE.Box3().setFromObject(model);
    const rawHeight = rawBox.max.y - rawBox.min.y;
    const scale = rawHeight > 0 ? MODEL.targetHeight / rawHeight : 0.001;
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    const anchor = this._rootBone() || model;
    const anchorPos = new THREE.Vector3();
    anchor.getWorldPosition(anchorPos);

    // `rig.root` is a fresh Group at identity, so the model's own position IS
    // its world translation - no parent-transform conversion is needed, and the
    // offset must NOT be divided by the scale (that would push the character
    // thousands of units away).
    model.position.x -= anchorPos.x;
    model.position.y -= box.min.y;
    model.position.z -= anchorPos.z;
    model.updateMatrixWorld(true);
    this._captureBase();
  }

  _resolveBindings() {
    this.morphs = new MorphRegistry(this.meshes);

    // --- eyes + head
    this.bindings.eyeLeft = this._bone( EYE_BONES.left );
    this.bindings.eyeRight = this._bone(EYE_BONES.right);
    this.bindings.head = this._bone(EYE_BONES.head);
    this.bindings.root = this._rootBone();

    // --- blink. Prefer per-eye targets; fall back to a single combined shape.
    this.bindings.blink = {
      left: this.morphs.resolve(BLINK_SHAPES.left),
      right: this.morphs.resolve(BLINK_SHAPES.right),
      both: this.morphs.resolve(BLINK_SHAPES.both),
    };

    // --- visemes
    this.bindings.visemes = {};
    for (const [key, candidates] of Object.entries(VISEMES)) {
      this.bindings.visemes[key] = this.morphs.resolve(candidates);
    }
  }

  _bone(candidates) {
    // Pass 1: the candidate names as written, matched case-insensitively.
    for (const c of candidates) {
      const b = this.bones.get(c) || this.bonesLower.get(c.toLowerCase());
      if (b) return b;
    }
    // Pass 2: the same bone under a DIFFERENT rig convention, via the retarget
    // map. This is what lets a downloaded model resolve the bindings her clips
    // and procedural layer were authored against, without every model-specific
    // bone name having to be added to config.js. Jinx has `head_123`, not
    // `Head`, and `L_eye_117`, not `Left_eye`.
    for (const c of candidates) {
      const mapped = RETARGET[c];
      if (!mapped) continue;
      const b = this.bones.get(mapped) || this.bonesLower.get(mapped.toLowerCase());
      if (b) return b;
    }
    return null;
  }

  /**
   * The bone she is centred and grounded on. Resolved case-insensitively so a
   * VRM's `hips` works where the original `Hips` was expected.
   * @returns {THREE.Bone|null}
   */
  _rootBone() {
    return this._bone([MODEL.centerOnBone]);
  }

  _buildMeta() {
    const shapeNames = [...this.morphs.index.keys()];
    this.meta = {
      bones: this.bones.size,
      meshes: this.meshes.length,
      shapes: shapeNames.length,
      hasEyes: Boolean(this.bindings.eyeLeft && this.bindings.eyeRight),
      hasHead: Boolean(this.bindings.head),
      blinkMode: this.bindings.blink.left
        ? 'per-eye'
        : this.bindings.blink.both
          ? 'combined'
          : 'none',
      visemesResolved: Object.values(this.bindings.visemes).filter(Boolean).length,
      visemesTotal: Object.keys(this.bindings.visemes).length,
    };
  }

  // ------------------------------------------------------------------ controls

  setBlink(weight) {
    const w = THREE.MathUtils.clamp(weight, 0, 1);
    const { left, right, both } = this.bindings.blink;
    if (left) this.morphs.set(BLINK_SHAPES.left, w);
    if (right) this.morphs.set(BLINK_SHAPES.right, w);
    // Only drive the combined shape when per-eye ones are missing, otherwise
    // the same vertices get written twice.
    if (!left && !right && both) this.morphs.set(BLINK_SHAPES.both, w);
  }

  setViseme(key, weight) {
    this.morphs.set(VISEMES[key], THREE.MathUtils.clamp(weight, 0, 1));
  }

  /** Zero every viseme except `sil`, which is the resting "mouth closed" pose. */
  setVisemeWeights(weights) {
    for (const [key, candidates] of Object.entries(VISEMES)) {
      this.morphs.set(candidates, THREE.MathUtils.clamp(weights[key] ?? 0, 0, 1));
    }
  }

  clearMorphs() {
    this.morphs?.clearAll();
  }
}
