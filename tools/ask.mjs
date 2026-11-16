/**
 * Live persona check through the SAME request shape the browser client sends
 * (src/ai/chat.js always posts `system` from TTS.system).
 *
 * A bare curl to /api/chat without `system` hits the generic fallback in
 * server/api-plugin.js instead, which says nothing about whether the persona
 * is actually live - it only tests the fallback.
 *
 *   node tools/ask.mjs "i miss you"
 */
import { TTS } from '../src/utils/config.js';

const q = process.argv.slice(2).join(' ') || 'hello';
// TTS.system is already a joined string (the array literal ends .join('\n')).
const system = TTS.system;

const res = await fetch('http://127.0.0.1:5180/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: q, system, stream: false, useMemory: false }),
});
const j = await res.json();
if (j.error) {
  console.error(`HTTP ${res.status}: ${j.error}`);
  process.exit(1);
}
console.log(`> ${q}`);
console.log(`  ${j.text}`);
if (j.raw) console.log(`  [raw] ${j.raw}`);