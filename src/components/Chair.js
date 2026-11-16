import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHAIR } from '../utils/config.js';

/**
 * Chair
 *
 * A self-aligning prop.
 *
 * The subtlety is that the sitting clip bakes her hip height in at 0.530 rig
 * units (measured, stable to +/-0.003, by tools/audit-chair.mjs), which is 0.33
 * of her standing height - far too tall for any real chair. Scaling a chair so
 * its seat reaches that height inflates it into a 1.10-unit armchair next to a
 * 1.62-unit girl, which looks wrong.
 *
 * So the chair is scaled to a real seat height for her size and she is sunk
 * onto it instead, capped so a badly proportioned chair cannot drop her through
 * the floor. The per-state hip gaps are reported in `info.hipGapByState` so any
 * remaining mismatch is visible rather than silently absorbed.
 */
export class Chair {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'chair';
    this.model = null;
    this.info = null;
    /** How far her model must drop to rest on the seat, in rig units. */
    this.sink = 0;
    this.seatTop = 0;
  }

  /**
   * @param {string} url
   * @param {{hips:THREE.Vector3, standingHeight:number, bakedHipY:object, bakedHipZ?:object}} opts
   */
  async load(url, { hips, standingHeight, bakedHipY, bakedHipZ }) {
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().load(url, resolve, undefined, (e) =>
        reject(new Error(`chair failed: ${e?.message || e}`))
      );
    });

    this.model = gltf.scene;
    this.group.add(this.model);
    this.model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(this.model);
    const size = new THREE.Vector3();
    box.getSize(size);

    const seat = findSeat(this.model, box, size);
    const seatAboveBase = seat ? seat.top - box.min.y : size.y * CHAIR.seatRatio;

    // Scale to a REAL seat height for her size, not to the hip height baked
    // into the clip. The clip's 0.530 is ~0.33 of her standing height, which is
    // far too tall for a chair; matching it would inflate the chair ~30%.
    const targetSeat = standingHeight * CHAIR.seatRatioOfHeight;
    const scale = targetSeat / Math.max(1e-4, seatAboveBase);
    this.model.scale.setScalar(scale);
    this.model.updateMatrixWorld(true);

    const scaled = new THREE.Box3().setFromObject(this.model);
    const scaledSize = new THREE.Vector3();
    scaled.getSize(scaledSize);
    const seatTop = seatAboveBase * scale + scaled.min.y;

    // Centre the chair under her hips. `pushBack` slides the whole prop backward
    // along the floor and is normally 0 — where she SITS on the seat is decided
    // by `hipForward` below, and having both non-zero was the bug that left her
    // buried in the upholstery.
    const centre = new THREE.Vector3();
    scaled.getCenter(centre);
    this.model.position.x += hips.x - centre.x;
    this.model.position.z += hips.z - centre.z + CHAIR.pushBack * scaledSize.z;
    this.model.position.y += -scaled.min.y;
    this.model.updateMatrixWorld(true);

    // She now has to come DOWN to the seat. NEGATIVE, since it is a Y offset.
    // Capped, so a badly proportioned chair cannot sink her through the floor.
    //
    // The offset is computed per clip rather than once: the two sitting clips
    // do not park the hips at the same height (idle 0.5145, talking 0.5293), so
    // a single value leaves one of the two states visibly floating.
    this.sink = {};
    for (const [state, hipsY] of Object.entries(bakedHipY)) {
      // Target: the hip joint `seatClearance` ABOVE the seat surface. Working
      // backwards, the offset is (seat + clearance) - hips.
      //
      // This is clamped SYMMETRICALLY, not to <= 0. The two clips bake in
      // different hip heights, so with a real clearance the lower one (idle)
      // needs a small POSITIVE offset to be lifted onto the seat while the
      // higher one (talking) still comes down. Clamping at zero left idle
      // floating 28.5mm short of the 35mm clearance it should have had.
      const drop = seatTop + CHAIR.seatClearance - hipsY;
      this.sink[state] = Math.max(-CHAIR.maxSink, Math.min(CHAIR.maxSink, drop));
    }
    /**
     * Seated Z offset, per state. The clips bake in hip depths near Z=0.03 and
     * they disagree with each other, so a single shared offset leaves the two
     * states visibly seated at different depths on the same chair.
     *
     * Working backwards from where the hips should END UP: the chair's
     * geometric centre is the reference, `hipForward` says how far forward of
     * it the hips belong, and the clip's own baked-in depth is subtracted so it
     * lands there rather than on top of it.
     */
    const depth = scaledSize.z;
    const hipTarget = CHAIR.hipForward * depth;
    this.forward = {};
    for (const state of Object.keys(bakedHipY)) {
      this.forward[state] = hipTarget - (bakedHipZ?.[state] ?? 0);
    }
    // Default is the shallowest, so a state missing from the table errs toward
    // being seated further back rather than perched off the front edge.
    this.defaultForward = Math.min(...Object.values(this.forward));
    /**
     * Default is the deepest sink, so a state not in the table errs toward
     * pressing into the cushion rather than hovering above the seat.
     */
    this.defaultSink = Math.min(...Object.values(this.sink));
    this.seatTop = seatTop;
    this.seatDepth = depth;
    this.hipTarget = hipTarget;

    this.info = {
      rawSize: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
      scale: +scale.toFixed(5),
      worldSize: [scaledSize.x, scaledSize.y, scaledSize.z].map((v) => +v.toFixed(3)),
      seatTop: +seatTop.toFixed(4),
      targetSeat: +targetSeat.toFixed(4),
      sinkByState: Object.fromEntries(
        Object.entries(this.sink).map(([k, v]) => [k, +v.toFixed(4)])
      ),
      // For each clip, where the hip joint ends up relative to the seat surface
      // after the sink. This should equal `seatClearance`, not 0: a joint
      // resting exactly on the surface looks like she has sunk into the
      // upholstery.
      hipGapByState: Object.fromEntries(
        Object.entries(this.sink).map(([k, v]) => [
          k,
          +(bakedHipY[k] + v - seatTop).toFixed(4),
        ])
      ),
      seatClearance: CHAIR.seatClearance,
      /**
       * Seated Z offset per state, and the resulting position of her hips
       * forward of the chair's geometric centre. The latter should equal
       * `hipForward * depth`: it is the single number that says whether she is
       * perched on the front edge or buried in the backrest, and it is what
       * used to silently land at 0.05 instead of the intended value.
       */
      forwardByState: Object.fromEntries(
        Object.entries(this.forward).map(([k, v]) => [k, +v.toFixed(4)])
      ),
      hipForwardOfSeatByState: Object.fromEntries(
        Object.entries(this.forward).map(([k, v]) => [
          k,
          +(((v + (bakedHipZ?.[k] ?? 0)) / Math.max(1e-6, depth))).toFixed(4),
        ])
      ),
      hipForward: CHAIR.hipForward,
      pushBack: CHAIR.pushBack,
      seatDepth: +depth.toFixed(4),
      hipTarget: +hipTarget.toFixed(4),
      seatFound: Boolean(seat),
      seatName: seat?.name || `(fallback ratio ${CHAIR.seatRatio})`,
    };

    this._toneMaterials();
    return this.info;
  }

  /**
   * Tone the prop so it reads as part of the scene instead of a white blob.
   *
   * The GLB ships near-white upholstery at full env intensity, which under the
   * scene's IBL blows out to pure white and visually outshouts the character.
   * This is a set of deliberate downgrades, not a faithful material: the prop is
   * background dressing, and a slightly darker, rougher fabric sits behind her
   * better than a brighter one.
   */
  _toneMaterials() {
    let touched = 0;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;

      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        touched++;
        if (m.isMeshStandardMaterial) {
          m.envMapIntensity = CHAIR.tone.envMapIntensity;
          m.roughness = Math.max(m.roughness ?? 1, CHAIR.tone.minRoughness);
          m.metalness = 0;
        }
        // A near-white albedo clips to flat white as soon as it catches the key
        // light. Pulling it down keeps the upholstery's own shading visible.
        if (m.color) m.color.multiplyScalar(CHAIR.tone.albedoScale);
      }
    });
    this.info.materialsToned = touched;
  }

  setVisible(v) {
    this.group.visible = v;
  }

  get visible() {
    return this.group.visible;
  }
}

/**
 * Find the seat surface.
 *
 * Ideally this is a distinct wide, thin slab in the lower half of the chair.
 * Many GLBs, though, ship the chair as ONE merged mesh, in which case there is
 * no separate seat object to find and the height ratio is the only available
 * estimate. Returning null in that case is deliberate: the caller falls back to
 * `CHAIR.seatRatio`, which is a far better guess than a bounding box, since a
 * bounding box includes the backrest and would place the seat far too high.
 */
function findSeat(model, box, size) {
  let best = null;
  let meshCount = 0;
  model.traverse((o) => {
    if (!o.isMesh) return;
    meshCount++;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const s = new THREE.Vector3();
    b.getSize(s);
    const relY = (b.max.y - box.min.y) / Math.max(1e-6, size.y);
    const relX = s.x / Math.max(1e-6, size.x);
    const relZ = s.z / Math.max(1e-6, size.z);
    const thin = s.y / Math.max(1e-6, Math.max(s.x, s.z));

    // Seat: broad footprint, thin in Y, in the lower-middle of the chair.
    if (relX > 0.4 && relZ > 0.35 && thin < 0.25 && relY > 0.25 && relY < 0.65) {
      if (!best || b.max.y > best.top) {
        best = { name: o.name || '(unnamed)', top: b.max.y, size: [s.x, s.y, s.z] };
      }
    }
  });
  // A single merged mesh has no separable seat; the ratio fallback is correct
  // for it and safer than returning the whole-mesh bounding box.
  if (meshCount <= 1) return null;
  return best;
}
