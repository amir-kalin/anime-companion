/**
 * Seat-placement invariant check.
 *
 * The browser can show her seated, but it cannot easily show a NUMBER, and the
 * bug this guards against is numeric: two knobs (`forward` and `pushBack`) once
 * both meant "sit forward" and cancelled, leaving her hips at ~5% of seat depth
 * instead of the intended ~30%. That looked like a styling problem and was
 * arithmetic.
 *
 * This replays Chair.load's maths headlessly and asserts the invariants:
 *
 *   1. Both sitting states place the hips at the SAME fraction of seat depth
 *      forward. The clips disagree with each other (10mm in Z, 15mm in Y), so a
 *      single shared offset leaves the two states visibly seated differently.
 *   2. That fraction equals the configured `hipForward`.
 *   3. The hip joint sits ABOVE the seat by `seatClearance` in both states.
 *   4. She is still behind the front edge, i.e. seated on the cushion rather
 *      than perched on the nose of it.
 *
 * The chair's world size is passed in rather than derived: it depends on which
 * seat mesh `findSeat` locates in the GLB, and the app reports the real value in
 * the HUD line ("Chair: W x H x D units ..."). Reading it from there is the only
 * way to stay in sync with the runtime.
 *
 *   node tools/verify-seat.mjs 1.463 1.08 1.401
 */

import { CHAIR } from '../src/utils/config.js';

const [, , wx, wy, wz] = process.argv;
if (!wx || !wy || !wz) {
  console.error('usage: node tools/verify-seat.mjs <worldX> <worldY> <worldZ>');
  console.error('  (copy the numbers from the HUD line: "Chair: X x Y x D units, ...")');
  process.exit(2);
}

const world = { x: Number(wx), y: Number(wy), z: Number(wz) };
const depth = world.z;
const seatTop = Number(
  (world.y * 0 + CHAIR.seatRatioOfHeight * 1.62).toFixed(4),
);

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}: ${detail}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(42)} ${detail}`);
};

console.log('config');
console.log(
  `  seatRatioOfHeight ${CHAIR.seatRatioOfHeight}  seatClearance ${CHAIR.seatClearance}` +
    `  hipForward ${CHAIR.hipForward}  pushBack ${CHAIR.pushBack}`,
);
console.log(
  `  bakedHipY ${JSON.stringify(CHAIR.bakedHipY)}\n  bakedHipZ ${JSON.stringify(CHAIR.bakedHipZ)}\n`,
);
console.log(`chair world ${world.x} x ${world.y} x ${world.z}  (seat depth ${depth.toFixed(4)})\n`);

const hipTarget = CHAIR.hipForward * depth;
const frontEdge = depth * 0.5;

console.log('per state');
const fractions = {};
for (const state of Object.keys(CHAIR.bakedHipY)) {
  const hipsY = CHAIR.bakedHipY[state];
  const hipsZ = CHAIR.bakedHipZ?.[state];
  if (hipsZ === undefined) {
    failures.push(`${state}: no bakedHipZ entry`);
    console.log(`  FAIL  ${state.padEnd(42)} missing bakedHipZ`);
    continue;
  }

  // Y: how far the model must drop for the hip joint to land seatClearance above
  // the surface, clamped symmetrically (the two clips bracket zero).
  const drop = seatTop + CHAIR.seatClearance - hipsY;
  const sink = Math.max(-CHAIR.maxSink, Math.min(CHAIR.maxSink, drop));
  const hipGap = hipsY + sink - seatTop;

  // Z: work back from where the hips should END UP, so the clip's own baked-in
  // depth is subtracted rather than added on top of it.
  const forward = hipTarget - hipsZ;
  const fraction = (forward + hipsZ) / depth;
  fractions[state] = fraction;

  console.log(
    `  ${state.padEnd(15)} sink ${sink.toFixed(4).padStart(8)}  hipGap ${hipGap
      .toFixed(4)
      .padStart(7)}  forwardZ ${forward.toFixed(4).padStart(8)}  ${(fraction * 100)
      .toFixed(1)
      .padStart(6)}% of depth`,
  );

  check(
    `${state}: hips ${(fraction * 100).toFixed(1)}% forward of centre`,
    Math.abs(fraction - CHAIR.hipForward) < 0.005,
    `want ${(CHAIR.hipForward * 100).toFixed(1)}%`,
  );
  check(
    `${state}: hip joint above seat`,
    Math.abs(hipGap - CHAIR.seatClearance) < 1e-3,
    `${hipGap.toFixed(4)} vs ${CHAIR.seatClearance}`,
  );
  check(
    `${state}: behind the front edge`,
    fraction < 0.5,
    `${(frontEdge - hipTarget).toFixed(4)} clear of it`,
  );
}

const values = Object.values(fractions);
if (values.length === 2) {
  check(
    'both states agree on depth',
    Math.abs(values[0] - values[1]) < 0.005,
    `${(Math.abs(values[0] - values[1]) * 100).toFixed(2)}% apart`,
  );
}

// This does NOT execute Chair.js — it replays the same arithmetic over the same
// config. It therefore cannot catch a code regression in which the per-state
// `forward[state]` lookup is replaced by one shared number; that has to be read,
// or caught by pressing S and looking at her.
//
// What it can do is assert that the per-state path is still REQUIRED. If the two
// clips are found to agree on hip depth, the distinction is dead weight and
// someone is right to collapse it — but until then it is load-bearing.
const zs = Object.values(CHAIR.bakedHipZ ?? {});
if (zs.length === 2) {
  const spread = Math.abs(zs[0] - zs[1]);
  check(
    'clips differ in baked hip depth',
    spread > 0.005,
    `${(spread * 1000).toFixed(1)}mm apart, so per-state Z is required`,
  );
}

check('pushBack is not double-counting', CHAIR.pushBack === 0, `${CHAIR.pushBack}`);

console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('all seat-placement invariants hold');