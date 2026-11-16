/**
 * Prune unreferenced assets from the build output.
 *
 * Vite copies the whole of `public/` into `dist/`, and `public/models` holds
 * 99MB — of which only about half is used. The rest is the previous
 * character's files, the old Mixamo clips, and two `.bak` copies, all kept
 * on disk deliberately (see the README) but never loaded.
 *
 * That matters for the Android app, where every byte of `dist/` ends up in
 * the APK: an unreferenced 18MB `.bak` is 18MB of the download and 18MB of
 * the installed app, for nothing.
 *
 * The list of what IS used comes from the app's own config, so it cannot
 * drift: if a clip is added to ANIMATIONS, it is kept, and if one is
 * removed, it is pruned.
 *
 * Usage:
 *   node tools/prune-assets.mjs [distDir]
 */

import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MODEL, ANIMATIONS, CHAIR } from '../src/utils/config.js';

const distDir = process.argv[2] || 'dist';

/**
 * Every asset the app can load.
 *
 * ANIMATIONS carries extra keys that are not states (`variant`, `forState`),
 * but every entry in it is a URL the app will fetch, so all of them count.
 */
const used = new Set();
used.add(MODEL.url);
used.add(CHAIR.url);
for (const cfg of Object.values(ANIMATIONS)) {
  if (cfg?.url) used.add(cfg.url);
}

const modelsRoot = join(distDir, 'models');
if (!existsSync(modelsRoot)) {
  console.log(`no models directory in ${distDir} — nothing to prune`);
  process.exit(0);
}

/** Every file under the models tree, relative to dist, with forward slashes. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(relative(distDir, full).split(sep).join('/'));
  }
  return out;
}

const all = walk(modelsRoot);
const keep = [];
const drop = [];

for (const file of all) {
  // A model URL is 'models/...' relative to the app root, which is the same
  // path it has inside dist.
  if (used.has(file)) keep.push(file);
  else drop.push(file);
}

let freed = 0;
for (const file of drop) {
  const full = join(distDir, file);
  freed += statSync(full).size;
  unlinkSync(full);
}

// Remove directories that are now empty, so the APK does not carry a tree
// of empty folders.
function pruneEmptyDirs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    pruneEmptyDirs(full);
    if (readdirSync(full).length === 0) {
      try { unlinkSync(full); } catch { /* not a dir after all */ }
    }
  }
}
pruneEmptyDirs(modelsRoot);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`kept ${keep.length} asset(s):`);
for (const k of keep.sort()) console.log(`  ${k}`);
console.log(`pruned ${drop.length} unused file(s), ${mb(freed)} freed`);
