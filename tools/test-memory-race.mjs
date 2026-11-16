/**
 * Concurrent memory writes must not lose the file or reject.
 *
 * This reproduces the crash that took the dev server down:
 *
 *   ENOENT: rename 'data\memory.json.tmp' -> 'data\memory.json'
 *
 * `distill()` is deliberately fire-and-forget, so it overlaps the next turn's
 * save. Both used the SAME temp filename, so whichever renamed first removed the
 * file the other was about to rename. The resulting rejection came out of
 * `recordTurn`, was discarded by `void`, and Node exited on the unhandled
 * rejection - taking the app with it.
 *
 *   node tools/test-memory-race.mjs
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore } from '../server/memory.js';

const root = await mkdtemp(join(tmpdir(), 'memrace-'));
const file = join(root, 'data', 'memory.json');
const lines = [];
const store = memoryStore({
  root,
  lmBase: 'http://127.0.0.1:1',   // never reached: distillation is not needed
  lmKey: 'x',
  lmModel: 'x',
  log: (m) => lines.push(m),
});

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
};

console.log('concurrent recordTurn + recordEvent + save');
// The real trigger is a turn's save overlapping the fire-and-forget distiller's
// save. Both go through the public writers, so hammering them together
// exercises the same path.
await Promise.all([
  ...Array.from({ length: 25 }, (_, i) => store.recordTurn(`user ${i}`, `mika ${i}`)),
  ...Array.from({ length: 25 }, (_, i) => store.recordEvent(`event ${i}`)),
  ...Array.from({ length: 25 }, () => store.save()),
]);

const doc = JSON.parse(await readFile(file, 'utf8'));
check('memory.json still parses', true, `${doc.turns} turns, ${doc.events.length} events`);
check('no turn was lost', doc.turns === 25, `${doc.turns} of 25 recorded`);
check('no event was lost', doc.events.length >= 25, `${doc.events.length} events`);
check('no save errors logged', !lines.some((l) => /save failed/.test(l)),
  lines.filter((l) => /save failed/.test(l)).length + ' error(s)');
check('nothing rejected', true, 'Promise.all resolved');

// No orphaned temp files left behind.
const tmpLeft = (await import('node:fs')).readdirSync(join(root, 'data'))
  .filter((f) => f.endsWith('.tmp'));
check('no orphan .tmp files', tmpLeft.length === 0, tmpLeft.join(', ') || 'none');

// And it must still be readable/reloadable.
const reopened = memoryStore({ root, lmBase: '', lmKey: '', lmModel: '', log: () => {} });
const d2 = await reopened.load();
check('reopens from disk', d2.turns === doc.turns, `${d2.turns} turns`);

await rm(root, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('memory writes are safe under concurrency');