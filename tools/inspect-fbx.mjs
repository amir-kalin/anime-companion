/**
 * Offline FBX bone-name inspector.
 *
 * FBX binary files (>= v7500) embed a string table near the end of the file and
 * reference names in it by offset. Rather than depend on a browser to run
 * THREE.FBXLoader, we extract that string table directly so we can diff the
 * character rig against the Mixamo animation rigs before writing any binding
 * code.
 */
import { readFileSync } from 'node:fs';

const BONE_HINTS = [
  'hips', 'spine', 'chest', 'neck', 'head', 'shoulder', 'arm', 'forearm',
  'hand', 'finger', 'thumb', 'upleg', 'leg', 'foot', 'toe', 'thigh', 'calf',
  'mixamorig', 'index', 'middle', 'ring', 'pinky',
];

function readU32(buf, off) {
  return buf.readUInt32LE(off);
}

/** Parse the FBX binary string table, which holds every name FBX refers to. */
function extractStringTable(buf) {
  // Layout: "Kaydara FBX Binary  \0" (21 bytes) + 0x1A 0x00 (2 bytes)
  //         + u32 version + u32 (always 0) + u32 node-record count ...,
  // so the first node record begins at byte 35.
  const version = readU32(buf, 23);

  // Walking the node-record chain is brittle across FBX versions (7500 added
  // nested arrays, 7700 changed the counts), and the string table is a single
  // top-level "StringAt" record, so locate it by its literal name instead.
  // Its body starts right after the NUL-terminated name.
  const NEEDLE = 'StringAt';
  const at = buf.indexOf(NEEDLE, 23, 'ascii');
  if (at < 0) return { version, strings: [] };

  const body = at + NEEDLE.length + 1;
  const count = readU32(buf, body);
  const strings = [];
  let p = body + 4;
  for (let i = 0; i < count; i++) {
    if (p + 4 > buf.length) break;
    const len = readU32(buf, p);
    p += 4;
    if (len > 1 << 16 || p + len > buf.length) break;
    strings.push(buf.toString('utf8', p, p + len));
    p += len;
  }
  return { version, strings };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node inspect-fbx.mjs <file.fbx> [more.fbx ...]');
  process.exit(1);
}

const all = new Map();
for (const file of files) {
  let buf;
  try { buf = readFileSync(file); } catch (e) { console.error(`skip ${file}: ${e.message}`); continue; }
  const { version, strings } = extractStringTable(buf);
  const bones = strings.filter((s) => {
    const l = s.toLowerCase();
    return s.length < 60 && BONE_HINTS.some((h) => l.includes(h));
  });
  all.set(file, { version, bones });
  console.log(`\n=== ${file}`);
  console.log(`    fbx version : ${version}`);
  console.log(`    string count: ${strings.length}`);
  console.log(`    bone-ish (${bones.length}):`);
  for (const b of bones) console.log(`      ${b}`);
}

// Diff the bone name sets pairwise so mismatches are impossible to miss.
const entries = [...all.entries()].filter(([, v]) => v.bones.length);
if (entries.length > 1) {
  const [refName, ref] = entries[0];
  const refSet = new Set(ref.bones);
  console.log(`\n########## DIFF vs ${refName}`);
  for (const [name, v] of entries.slice(1)) {
    const own = new Set(v.bones);
    const missing = [...refSet].filter((b) => !own.has(b));
    const extra = [...own].filter((b) => !refSet.has(b));
    console.log(`\n  ${name}`);
    console.log(`    MISSING here (in ref, not in this): ${missing.length}`);
    if (missing.length) console.log(`      ${missing.join(', ')}`);
    console.log(`    EXTRA here (not in ref): ${extra.length}`);
    if (extra.length) console.log(`      ${extra.join(', ')}`);
  }
}
