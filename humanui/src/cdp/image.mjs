// Observation: screenshots, zoom, and the coordinate frame.
//
// The single most common bug in this class of harness is a coordinate-frame mismatch.
// Vendor docs state the rule twice, once per vendor:
//
//   "If you downscale a screenshot, map the model's coordinates back to the environment's
//    coordinate space before executing actions."                       — OpenAI
//   "Coordinates are in screenshot pixels. Every `coordinate`, `start_coordinate`, and `region`
//    value ... is in the pixel space of the full-display screenshots you return."
//                                                                       — Anthropic
//
// This module makes that impossible to get wrong by refusing to hand out a bare image. Every
// capture returns a `Frame` that carries the viewport size, the scale that was applied, and
// helpers to convert in both directions. Downstream code calls `frame.toViewport(x, y)` and
// never multiplies by hand.
//
// Chromium does the resampling for us: Page.captureScreenshot accepts a `clip` with its own
// `scale`, so a downscale is a browser-side resize and the agent needs no image library.

import { sleep } from './client.mjs';

/** Anthropic documents ~1024x768 as the practical optimum for screenshot performance. */
export const DEFAULT_MAX_DIMENSION = 1024;

/**
 * A captured observation plus the coordinate mapping that goes with it.
 *
 * Two things are being tracked, and conflating them is a real bug:
 *
 *  - `scale` — image pixels per *frame* pixel, where the frame is the viewport for a full
 *    screenshot and the crop rect for a zoom. Dividing by the viewport width unconditionally is
 *    wrong for zooms: a 300x120 crop of a 1440x900 viewport is at native resolution even though
 *    the viewport is much larger.
 *  - `space` — which frame the coordinates the model emits are in. For a full screenshot the model
 *    has only the downscaled image, so it emits image pixels and a mapping is required. After a
 *    zoom the vendor rule is that the model keeps emitting *full-viewport* coordinates, so no
 *    mapping may be applied. `space` records which, so the action layer never has to guess.
 */
export class Frame {
  constructor({ dataUrl, viewport, imageWidth, imageHeight, region = null, space = 'image' }) {
    this.dataUrl = dataUrl;
    this.viewport = viewport;          // { width, height } in CSS px
    this.imageWidth = imageWidth;
    this.imageHeight = imageHeight;
    this.region = region;              // [x0, y0, x1, y1] viewport-space, or null for a full frame
    this.space = space;                // 'image' | 'viewport'

    const boxWidth = region ? region[2] - region[0] : viewport.width;
    const boxHeight = region ? region[3] - region[1] : viewport.height;
    this.originX = region ? region[0] : 0;
    this.originY = region ? region[1] : 0;
    this.scale = boxWidth > 0 ? imageWidth / boxWidth : 1;
  }

  /** This frame's image pixels -> viewport CSS pixels. Always correct for this frame. */
  toViewport(x, y) {
    return { x: this.originX + x / this.scale, y: this.originY + y / this.scale };
  }

  /** Viewport CSS pixel -> this frame's image pixels (for drawing overlays back onto the image). */
  toImage(x, y) {
    return { x: (x - this.originX) * this.scale, y: (y - this.originY) * this.scale };
  }

  /**
   * Map a coordinate the model just produced into viewport CSS pixels.
   *
   * `space === 'viewport'` is identity by contract; that is the post-zoom rule. `space === 'image'`
   * applies the scale, which is what makes a downscaled full screenshot clickable at all.
   */
  fromModel(x, y) {
    return this.space === 'viewport' ? { x, y } : this.toViewport(x, y);
  }

  get downscaled() {
    return this.scale < 1;
  }

  /** Compact, log-friendly description. The full data URL is deliberately omitted. */
  describe() {
    const bits = [`${this.viewport.width}x${this.viewport.height} viewport`];
    bits.push(`image ${this.imageWidth}x${this.imageHeight}`);
    bits.push(`space=${this.space}`);
    if (this.downscaled) bits.push(`scale ${this.scale.toFixed(3)}`);
    if (this.region) bits.push(`zoom of ${JSON.stringify(this.region)}`);
    return bits.join(', ');
  }
}

/** Capture the viewport, downscaling in the browser if it exceeds the model's image limits. */
export async function captureViewport(session, { maxDimension = DEFAULT_MAX_DIMENSION } = {}) {
  const viewport = await viewportSize(session);
  const longest = Math.max(viewport.width, viewport.height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;

  const { data } = await session.send('Page.captureScreenshot', {
    format: 'png',
    // captureBeyondViewport keeps the full page addressable even when the window is smaller.
    captureBeyondViewport: false,
    fromSurface: true,
  });

  const buf = Buffer.from(data, 'base64');
  const dims = await pngSize(buf);
  return new Frame({
    dataUrl: `data:image/png;base64,${data}`,
    viewport,
    imageWidth: dims.width,
    imageHeight: dims.height,
  });
}

/**
 * Capture a sub-region at native resolution — the `zoom` member from Anthropic's computer
 * toolset, which exists because "small text or dense UI isn't legible in a downscaled full
 * screenshot" (filenames in a sidebar, tab titles, line numbers, button labels).
 *
 * A zoom does NOT move the coordinate frame. The returned Frame records the region so callers
 * can report it, but toViewport() still maps into full-viewport space, because the docs are
 * explicit that the model keeps emitting full-frame coordinates after a zoom.
 */
export async function captureRegion(session, region, { maxDimension = DEFAULT_MAX_DIMENSION } = {}) {
  const viewport = await viewportSize(session);
  const [x0, y0, x1, y1] = normalizeRegion(region, viewport);
  const width = Math.max(1, Math.round(x1 - x0));
  const height = Math.max(1, Math.round(y1 - y0));

  const longest = Math.max(width, height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;

  const { data } = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: x0, y: y0, width, height, scale },
    captureBeyondViewport: true,
    fromSurface: true,
  });

  const buf = Buffer.from(data, 'base64');
  const dims = await pngSize(buf);
  // A zoom reports space 'viewport': after inspecting a crop the model still reasons in
  // full-viewport coordinates, so the action layer must not re-map them.
  return new Frame({
    dataUrl: `data:image/png;base64,${data}`,
    viewport,
    imageWidth: dims.width,
    imageHeight: dims.height,
    region: [x0, y0, x1, y1],
    space: 'viewport',
  });
}

/** Read the live viewport size. Cheap, and the honest answer beats a cached constant. */
export async function viewportSize(session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})',
    returnByValue: true,
  });
  const parsed = JSON.parse(result.value);
  return { width: parsed.w, height: parsed.h, dpr: parsed.dpr ?? 1 };
}

function normalizeRegion(region, viewport) {
  let [x0, y0, x1, y1] = region.map(Number);
  if ([x0, y0, x1, y1].some((n) => !Number.isFinite(n))) {
    throw new Error(`zoom needs [x0, y0, x1, y1] viewport pixels, got ${JSON.stringify(region)}`);
  }
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  return [
    clamp(x0, 0, viewport.width),
    clamp(y0, 0, viewport.height),
    clamp(x1, 0, viewport.width),
    clamp(y1, 0, viewport.height),
  ];
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Read dimensions straight out of the PNG IHDR chunk.
 *
 * PNGs from Chromium are never interlaced, so the first chunk after the signature is always
 * IHDR and width/height are big-endian uint32 at fixed offsets. Parsing them avoids pulling in
 * an image library purely to learn the size of a buffer we already have.
 */
export function pngSize(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error('Expected a PNG buffer; signature did not match.');
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') throw new Error(`Expected IHDR as the first PNG chunk, got ${chunkType}.`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Wait until the renderer reports a stable layout, to avoid capturing mid-reflow. */
export async function settle(session, quietMs = 120, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const probe = await session.send('Runtime.evaluate', {
      expression:
        'JSON.stringify({ready: document.readyState, h: document.body ? document.body.scrollHeight : 0, t: document.title})',
      returnByValue: true,
    });
    const now = JSON.parse(probe.result.value);
    const key = JSON.stringify(now);
    if (key !== last) {
      last = key;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return now;
    }
    await sleep(40);
  }
  return JSON.parse(last ?? '{}');
}