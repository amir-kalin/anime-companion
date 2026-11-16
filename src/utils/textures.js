import * as THREE from 'three';

/**
 * Wait for a texture's image data to actually arrive.
 *
 * FBXLoader kicks off texture downloads with TextureLoader and resolves its
 * promise WITHOUT waiting for them, so at load time `texture.image` is still
 * undefined. Any map synthesis attempted at that point silently produces
 * nothing. This waits for the 'update' event (with a poll as a fallback, and a
 * timeout so it can never hang the boot).
 *
 * @param {THREE.Texture} tex
 * @param {number} [timeoutMs]
 * @returns {Promise<any|null>} the image, or null on timeout
 */
export function whenImageReady(tex, timeoutMs = 10_000) {
  if (!tex) return Promise.resolve(null);
  if (tex.image) return Promise.resolve(tex.image);

  return new Promise((resolve) => {
    let done = false;
    let poll = 0;
    const finish = (img) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      tex.removeEventListener?.('update', onUpdate);
      resolve(img || null);
    };
    const onUpdate = () => { if (tex.image) finish(tex.image); };
    const timer = setTimeout(() => finish(tex.image || null), timeoutMs);
    poll = setInterval(() => { if (tex.image) finish(tex.image); }, 40);
    tex.addEventListener?.('update', onUpdate);
  });
}

/** Accepts a Texture or a raw image. */
const imageOf = (src) => (src && src.image ? src.image : src) || null;

/**
 * Runtime texture utilities.
 *
 * The character FBX ships diffuse maps only - no normal, roughness or AO maps.
 * That is the main reason the model reads as flat, waxy plastic under PBR
 * lighting: there is no per-pixel surface detail for light to catch, so the
 * only shading information is the low-frequency diffuse itself.
 *
 * These helpers synthesise the missing maps from the diffuse, which costs
 * nothing at runtime and recovers most of the perceived quality.
 */

/**
 * Derive a tangent-space normal map from a diffuse texture's luminance using a
 * Sobel gradient.
 *
 * Flat regions produce a neutral (128,128,255) normal; edges in the artwork
 * become bumps. This is a classic stylisation trick and it is why toon and
 * anime models often look far better once a bump is derived this way.
 *
 * @param {THREE.Texture|HTMLImageElement} src
 * @param {object} [opts]
 * @param {number} [opts.strength=1.6] gradient multiplier
 * @returns {THREE.CanvasTexture|null}
 */
export function deriveNormalMap(src, { strength = 1.6 } = {}) {
  const image = imageOf(src);
  if (!image) return null;

  const w = image.width;
  const h = image.height;
  if (!w || !h) return null;

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const sctx = cv.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(image, 0, 0);
  const data = sctx.getImageData(0, 0, w, h).data;

  // Luminance plane, wrapping at the edges so the seams do not show.
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  const at = (x, y) => lum[((y + h) % h) * w + ((x + w) % w)];

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const px = img.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len;
      const nzn = nz / len;

      const i = (y * w + x) * 4;
      px[i] = (nx * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * 0.5 + 0.5) * 255;
      px[i + 2] = (nzn * 0.5 + 0.5) * 255;
      px[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.NoColorSpace; // normal maps are data, not colour
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Derive a cheap ambient-occlusion map: darken areas whose luminance is much
 * lower than the local average, which in cel-shaded artwork correlates well
 * with painted shadow and contact areas.
 *
 * @param {THREE.Texture|HTMLImageElement} src
 * @param {number} strength
 * @returns {THREE.CanvasTexture|null}
 */
export function deriveAoMap(src, strength = 0.55) {
  const image = imageOf(src);
  if (!image) return null;
  const w = image.width, h = image.height;
  if (!w || !h) return null;

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const sctx = cv.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(image, 0, 0);
  const data = sctx.getImageData(0, 0, w, h).data;

  // Box-blurred luminance = local average.
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  }
  const blurred = new Float32Array(w * h);
  const R = 6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -R; dy <= R; dy += 2) {
        for (let dx = -R; dx <= R; dx += 2) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          sum += lum[yy * w + xx]; n++;
        }
      }
      blurred[y * w + x] = sum / n;
    }
  }

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const px = img.data;
  for (let i = 0; i < w * h; i++) {
    const diff = blurred[i] - lum[i];              // >0 where darker than average
    const ao = Math.max(0, Math.min(1, 1 - diff * strength * 2.2));
    const v = ao * 255;
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
