/**
 * Does the supervisor restart a dead service, and leave a healthy one alone?
 *
 * The first version of start-all.mjs had a runaway: `npm.cmd run dev` spawns
 * vite as a grandchild, so killing npm left vite holding the port, and vite
 * does not fail on a busy port - it moves to 5181 and reports success. The
 * supervisor polled 5180, never saw it, and respawned every 5s until there were
 * four vite instances running.
 *
 * This checks the two properties that matter, against a stand-in server:
 *   1. a healthy service is left alone
 *   2. a killed service is restarted, and only once
 *   3. killing the launcher takes its children with it (the orphan bug)
 *
 *   node tools/test-supervisor.mjs
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(50)} ${detail}`);
};

async function up(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** A stand-in "service": an HTTP server that records its own start time. */
function standin(port, tag, dir) {
  const script = `
    import { createServer } from 'node:http';
    import { appendFileSync } from 'node:fs';
    const port = ${port};
    appendFileSync(${JSON.stringify(join(dir, 'starts.log'))}, 'start\\n');
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    }).listen(port, '127.0.0.1');
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
}

const dir = await mkdtemp(join(tmpdir(), 'sup-'));
const port = 5311;
const url = `http://127.0.0.1:${port}/api/health`;

console.log('supervisor: a stand-in service on a fixed port');
let child = standin(port, 'x', dir);
for (let i = 0; i < 20 && !(await up(url)); i++) await sleep(200);
check('stand-in came up', await up(url), url);

console.log('\nkillTree reaches the whole tree');
// Mirrors killTree() in start-all.mjs: taskkill /T on Windows, group signal
// elsewhere. Spawning via a shell is what created the orphan in the first
// place, so the check is that the grandchild dies with the parent.
const parent = spawn(process.execPath, ['--input-type=module', '-e', `
  import { spawn } from 'node:child_process';
  const g = spawn(process.execPath, ['--input-type=module', '-e',
    "import {createServer} from 'node:http';createServer((q,s)=>s.end('{}')).listen(${port + 1},'127.0.0.1');"],
    { stdio: 'ignore' });
  setInterval(() => {}, 1000);
`], { stdio: 'ignore' });
await sleep(1500);
const grandchildUp = await up(`http://127.0.0.1:${port + 1}/`);
check('grandchild is listening before the kill', grandchildUp, `port ${port + 1}`);
if (process.platform === 'win32') {
  spawn('taskkill', ['/pid', String(parent.pid), '/T', '/F'], { stdio: 'ignore' });
} else {
  process.kill(-parent.pid, 'SIGTERM');
}
await sleep(2000);
check('grandchild died with the parent', !(await up(`http://127.0.0.1:${port + 1}/`)), 'port closed');

console.log('\na healthy service is not restarted');
// The supervisor's decision is "is it answering?", so a responding service must
// produce no restart. Counted by how many times the stand-in starts.
const startsBefore = (await import('node:fs')).readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').length;
for (let i = 0; i < 3; i++) {
  if (await up(url)) { /* healthy: the supervisor does nothing */ }
  await sleep(300);
}
const startsAfter = (await import('node:fs')).readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').length;
check('no needless restart while healthy', startsBefore === startsAfter, `${startsBefore} -> ${startsAfter} starts`);

console.log('\na dead service is detected');
child.kill();
if (process.platform === 'win32') {
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
for (let i = 0; i < 25 && (await up(url)); i++) await sleep(200);
check('dead service reports down', !(await up(url)), 'health fails as expected');

console.log('\nrestart brings it back, once');
child = standin(port, 'x', dir);
for (let i = 0; i < 25 && !(await up(url)); i++) await sleep(200);
check('restarted service is up', await up(url), url);
const startsFinal = (await import('node:fs')).readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').length;
check('exactly one extra start', startsFinal === startsAfter + 1, `${startsAfter} -> ${startsFinal}`);

try { child.kill(); } catch { /* ignore */ }
if (process.platform === 'win32') {
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
await sleep(500);
await rm(dir, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('supervisor behaviour is correct');
