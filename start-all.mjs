/**
 * start-all — one click for the whole stack.
 *
 * Starts, in order, and waits for each to be genuinely ready:
 *   1. LM Studio's local server (:1234) — checked, not started. It is a desktop
 *      app with a loaded model, so there is nothing to launch from here; if it
 *      is not up this says exactly what to do instead of failing obscurely.
 *   2. The voice service (:4123) — Piper TTS + faster-whisper STT.
 *   3. The dev server (:5180) — the app, and the proxy for both of the above.
 *
 * Then it keeps them alive: a supervisor that restarts anything that dies, and
 * re-probes the browser side so an idle hiccup heals itself.
 *
 * Why this exists: each service was previously started by hand, and the dev
 * server had nothing watching it. Combined with a client that latched
 * "unavailable" on the first failed health probe, a service that was briefly
 * down stayed down for the rest of the session.
 *
 *   node start-all.mjs            start everything, keep it running
 *   node start-all.mjs --status   report what is up, change nothing
 *   node start-all.mjs --stop     stop what this script started
 */

import { spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(ROOT, 'logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* fall back to no file logs */ }

const LOCK = join(LOG_DIR, 'launcher.lock');
let ownsLock = false;

const LLM_URL = 'http://127.0.0.1:1234';
const GEMINI_URL = 'http://127.0.0.1:5200';
const VOICE_URL = 'http://127.0.0.1:4123';
const APP_URL = 'http://127.0.0.1:5180';
const MODEL = 'prism-ml/bonsai-27b';

const args = process.argv.slice(2);
const WANT_STATUS = args.includes('--status');
const WANT_STOP = args.includes('--stop');
const WANT_GEMINI = args.includes('--gemini');

const COLOURS = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
const c = (k, s) => `${COLOURS[k] || ''}${s}${COLOURS.off}`;

const say = (tag, msg) => console.log(`${c('dim', new Date().toLocaleTimeString())} ${tag} ${msg}`);

// Claim the single-instance lock before starting anything. Placed here, after
// the argument parsing, because --status and --stop are read-only and must never
// be blocked by a lock.
if (!WANT_STATUS && !WANT_STOP) {
  /**
   * Is a pid still running? Signal 0 performs the permission/existence check
   * without delivering anything: it throws ESRCH if no such process exists.
   */
  const pidAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  };

  /**
   * Claim the lock, taking it over from a dead launcher.
   *
   * The lock is only released by `process.on('exit')`, which does NOT run when
   * the process is SIGKILLed, killed by a `taskkill /F`, or lost to a reboot.
   * That left a lock file holding a pid that no longer existed, and every later
   * start refused to boot with "already starting" until the file was deleted by
   * hand - which had already bitten twice.
   *
   * So a lock whose owner is provably gone is stale, not held.
   *
   * @returns {'claimed'|'held'}
   */
  const claimLock = () => {
    try {
      writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      ownsLock = true;
      return 'claimed';
    } catch {
      let heldBy = '?';
      try { heldBy = readFileSync(LOCK, 'utf8').trim(); } catch { /* unreadable */ }

      if (!pidAlive(Number(heldBy))) {
        // Owner is gone: clear it and take over.
        try { unlinkSync(LOCK); } catch { /* someone else got there first */ }
        try {
          writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
          ownsLock = true;
          say('lock', `cleared a stale lock from dead pid ${heldBy}`);
          return 'claimed';
        } catch {
          // A live launcher won the race. Fall through and report it as held.
        }
      }

      console.log('');
      console.log(`  ${c('warn', 'Mika is already starting.')}`);
      console.log(`  Another launcher owns this stack (pid ${heldBy}).`);
      console.log('');
      console.log(`  Just open ${c('dim', APP_URL)} - it is already coming up.`);
      console.log(`  Or run ${c('dim', 'npm run status')} to see what is running.`);
      console.log('');
      process.exit(0);
    }
  };

  claimLock();
  // A lock left behind by a killed launcher must not block the next start.
  process.on('exit', () => { if (ownsLock) { try { unlinkSync(LOCK); } catch { /* ignore */ } } });
}

/** Poll a URL until it answers, or give up. */
async function waitFor(url, { timeoutMs, label, check } = {}) {
  const deadline = Date.now() + (timeoutMs ?? 20_000);
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const body = await r.json().catch(() => null);
        // A service can be listening and still not ready: LM Studio answers
        // /v1/models before weights finish loading.
        if (!check || check(body)) return { ok: true, body };
        lastErr = 'listening but not ready';
      } else {
        lastErr = `HTTP ${r.status}`;
      }
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(700);
  }
  return { ok: false, error: lastErr || 'timed out', label };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Why a single instance, for the record.
 *
 * Two launchers on one machine fight over the ports, and the symptom is
 * misleading: the second vite exits with "Port 5180 is already in use" while the
 * FIRST launcher keeps serving happily, so it reads as a broken launcher rather
 * than a duplicated one. Worse, each supervisor then watches a port it does not
 * own and restarts it — which is how orphaned instances piled up before.
 *
 * The lock at the top of this file is claimed exclusively, so the second copy
 * declines instead of competing. See `ownsLock` for the claim itself.
 */
async function isUp(url) {
  try {
    // 8s, not 3s. /api/health probes two upstreams (voice + LM Studio) and
    // either can be briefly slow, so a 3s budget classified a healthy-but-busy
    // service as dead. The two-strike rule below is what actually prevents a
    // restart loop; this just stops it firing at all.
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Why a health check failed, in one short phrase.
 *
 * Without this, "stopped answering" is indistinguishable from "answered
 * slowly", "answered on the wrong port", and "the process is alive but wedged" —
 * and guessing between those is how a restart loop gets built.
 */
async function diagnose(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    return r.ok ? 'but answered now' : `HTTP ${r.status} in ${Date.now() - t0}ms`;
  } catch (e) {
    const cause = e.cause?.code ? `${e.cause.code} ` : '';
    return `${cause}${e.name} in ${Date.now() - t0}ms`;
  }
}

// ---------------------------------------------------------------- status

async function report() {
  console.log('');
  const gemini = await waitFor(`${GEMINI_URL}/health`, { timeoutMs: 2000, label: 'Gemini Listener' });
  const llm = gemini.ok ? { ok: true, isGemini: true } : await waitFor(`${LLM_URL}/v1/models`, { timeoutMs: 4000, label: 'LM Studio' });
  const voice = await waitFor(`${VOICE_URL}/health`, { timeoutMs: 4000, label: 'voice' });
  const app = await waitFor(`${APP_URL}/api/health`, { timeoutMs: 6000, label: 'app' });

  const mark = (v) => (v ? c('ok', 'UP  ') : c('err', 'DOWN'));
  if (gemini.ok) {
    console.log(`  ${mark(true)}  Gemini Agent ${GEMINI_URL}  (Tools & Realtime Listener Active)`);
  } else {
    console.log(`  ${mark(llm.ok)}  LM Studio    ${LLM_URL}`);
  }
  if (!gemini.ok && llm.ok && llm.body?.data) {
    const ids = llm.body.data.map((m) => m.id);
    console.log(`        ${c('dim', `${ids.length} model(s): ${ids.join(', ')}`)}`);
    const target = ids.find((id) => id === MODEL);
    if (target) console.log(`        ${c('dim', `using ${target}`)}`);
    else if (ids.length) {
      console.log(`        ${c('warn', `${MODEL} is not loaded; the chat will fall back to a canned line`)}`);
    }
  }
  console.log(`  ${mark(voice.ok)}  voice        ${VOICE_URL}  (Piper TTS + whisper STT)`);
  if (voice.ok && voice.body) {
    console.log(`        ${c('dim', `tts=${voice.body.tts} stt=${voice.body.stt} (${voice.body.stt_model}, ${voice.body.stt_device})`)}`);
  }
  console.log(`  ${mark(app.ok)}  app          ${APP_URL}`);
  console.log('');
  return { llm: llm.ok, gemini: gemini.ok, voice: voice.ok, app: app.ok };
}

if (WANT_STATUS) {
  await report();
  process.exit(0);
}

if (WANT_STOP) {
  say('stop', 'nothing to stop from here — close the windows you started, or Ctrl+C them.');
  process.exit(0);
}

// ---------------------------------------------------------------- start

console.log('');
console.log(c('ok', '  Anime Companion — starting everything'));
console.log('');

const children = [];
let shuttingDown = false;

/**
 * Launch a child and keep a handle on everything it spawns.
 *
 * Two Windows details make this necessary, and both caused a runaway restart
 * loop in the first version of this file:
 *
 *  1. `npm.cmd run dev` is a shim that starts vite as a GRANDCHILD. Killing the
 *     npm process leaves vite running and still holding the port.
 *  2. Vite does not fail when its port is taken — it prints "Port 5180 is in
 *     use, trying another one" and moves to 5181. So a restart that raced the
 *     old instance did not error; it quietly listened somewhere else, and the
 *     supervisor, still polling 5180, never saw it come up and started another.
 *
 * So: no shell layer (spawn vite directly, not through npm), `detached: true`
 * so the child gets its own process group, and kill the whole group rather than
 * one process. `strictPort` additionally makes a port clash a hard error
 * instead of a silent move, so this can never be invisible again.
 */
function start(name, cmd, cmdArgs, logName, { ours = true } = {}) {
  const out = join(LOG_DIR, logName);
  const proc = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so one kill reaches the whole tree
  });
  const write = (data) => {
    if (!logName) return;
    try {
      appendFileSync(out, data);
    } catch { /* logging must never take the app down */ }
  };
  proc.stdout?.on('data', write);
  proc.stderr?.on('data', write);
  proc.on('exit', (code, signal) => {
    write(`\n[${name}] exited code=${code} signal=${signal}\n`);
    if (shuttingDown) return;
    say(c('err', name), `${c('err', 'died')} (${signal || `code ${code}`}) — see logs/${logName}`);
  });
  children.push({ name, proc, cmd, args: cmdArgs, logName, ours });
  return proc;
}

/** Kill a child AND everything it started, on Windows and elsewhere. */
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      // Negative pid targets the process group created by `detached: true`.
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}

// 1. Brain check: Gemini Listener or LM Studio
let brainUp = false;
say('brain', 'checking for Gemini Agent Listener on port 5200...');
if (await isUp(`${GEMINI_URL}/health`)) {
  say('gemini', `${c('ok', 'Gemini Agent Listener is active!')}`);
  brainUp = true;
} else if (WANT_GEMINI) {
  say('gemini', 'starting Gemini Agent Listener on port 5200...');
  start('gemini', 'node', [join(ROOT, 'tools', 'agent-listener.mjs'), '--port', '5200'], 'gemini.log');
  const g = await waitFor(`${GEMINI_URL}/health`, { timeoutMs: 8000, label: 'Gemini Listener' });
  if (g.ok) {
    say('gemini', `${c('ok', 'Gemini Agent Listener ready with live tools')}`);
    brainUp = true;
  }
}

if (!brainUp) {
  say('llm ', 'checking LM Studio...');
  const llm = await waitFor(`${LLM_URL}/v1/models`, { timeoutMs: 5000, label: 'LM Studio' });
  if (llm.ok) {
    const ids = (llm.body?.data || []).map((m) => m.id);
    say('llm ', `${c('ok', 'up')}${ids.length ? `, ${ids.length} model(s) loaded` : ''}`);
    if (ids.length && !ids.includes(MODEL)) {
      say('llm ', c('warn', `${MODEL} not loaded; load it in LM Studio for real replies`));
    }
    brainUp = true;
  }
}

if (!brainUp) {
  console.log('');
  console.log(`  ${c('err', 'Neither Gemini Agent Listener nor LM Studio is running.')}`);
  console.log('');
  console.log('  To use Gemini:   run `npm run listener` or `node start-all.mjs --gemini`');
  console.log('  To use LM Studio: open LM Studio and press "Start Server" (port 1234)');
  console.log('');
  process.exit(1);
}

// 2. Voice service.
if (await isUp(`${VOICE_URL}/health`)) {
  say('voice', `${c('ok', 'already running')}`);
} else {
  const script = join(ROOT, 'voice', 'local_voice.py');
  if (!existsSync(script)) {
    say('voice', c('err', `voice/local_voice.py is missing`));
    process.exit(1);
  }
  say('voice', 'starting (first boot takes ~90-140s: Piper loads, then Whisper)...');
  start('voice', 'python', [join(ROOT, 'voice', 'local_voice.py'), '--port', '4123'], 'voice.log');
  // Generous: the first run downloads the Whisper model as well.
  const ready = await waitFor(`${VOICE_URL}/health`, { timeoutMs: 240_000, label: 'voice' });
  if (ready.ok) {
    say('voice', `${c('ok', 'ready')} (tts=${ready.body?.tts} stt=${ready.body?.stt})`);
  } else {
    say('voice', `${c('warn', 'not ready yet')}: ${ready.error}. It will keep loading; the app works without it.`);
  }
}

// 3. Dev server / app.
const adoptApp = (await isUp(`${APP_URL}/api/health`)) && !args.includes('--force');
if (adoptApp) {
  say('app  ', `${c('ok', 'already running')}`);
} else {
  say('app  ', 'starting...');
  // vite directly, not `npm run dev`, and with --strictPort so a port clash is a
  // hard error instead of a silent move to 5181.
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  start('app', process.execPath, [viteBin, '--port', '5180', '--strictPort'], 'app.log');
  const ready = await waitFor(`${APP_URL}/api/health`, { timeoutMs: 90_000, label: 'app' });
  if (ready.ok) say('app  ', `${c('ok', 'ready')} at ${APP_URL}`);
  else say('app  ', `${c('warn', 'not ready yet')}: ${ready.error} (see logs/app.log)`);
}

console.log('');
console.log(`  ${c('ok', 'She is awake.')}  ${c('dim', APP_URL)}`);
console.log(`  ${c('dim', 'Press F for fullscreen, S to sit, and Ctrl+C here to stop everything.')}`);
console.log('');

// ---------------------------------------------------------------- supervise

/**
 * Keep her alive.
 *
 * The reported symptom was that things stop working when left alone. Whatever
 * the individual cause, a dead service should be restarted rather than waited
 * on, so every few seconds each one is checked and restarted if it is gone.
 */
say('watch', 'supervising. Ctrl+C stops everything.');

/**
 * A process this script spawned is "ours". A process that was already running
 * when it started is NOT — restarting a service the user launched themselves
 * from another window would fight them for the port.
 */
const supervised = children.filter((ch) => ch.ours);
if (children.length !== supervised.length) {
  const adopted = children.filter((ch) => !ch.ours).map((ch) => ch.name);
  say('watch', `${adopted.join(' and ')} already running; leaving ${adopted.length > 1 ? 'them' : 'it'} alone.`);
}

/**
 * Adopt a service that was already running, so it gets watched too.
 *
 * Otherwise `npm run dev` by hand, then this script, means the app is
 * unsupervised - and the complaint being fixed is precisely that things stop
 * working when left alone. The only thing not done to an adopted service is
 * being killed on exit: it is not ours to stop.
 */
for (const child of children) {
  if (child.ours) continue;
  const url = child.name === 'voice' ? `${VOICE_URL}/health`
    : child.name === 'app' ? `${APP_URL}/api/health`
    : null;
  if (!url) continue;
  const handle = {
    ...child,
    url,
    get proc() { return { exitCode: 0 }; }, // never "died" as far as we know
    restart: () => {
      say(child.name, `${c('warn', 'stopped answering')} — starting it myself`);
      const started = start(child.name, child.cmd, child.args, child.logName);
      child.proc = started; // now ours to kill
      child.ours = true;
      return started;
    },
  };
  supervised.push(handle);
  say('watch', `now watching ${child.name} too (it was already running)`);
}

const tick = async () => {
  if (shuttingDown) return;
  for (const child of supervised) {
    const url = child.url || (child.name === 'voice' ? `${VOICE_URL}/health`
      : child.name === 'app' ? `${APP_URL}/api/health`
      : null);
    if (!url) continue;
    // A process we started that has already exited is the exit hook's business.
    if (child.ours && child.proc?.exitCode != null) continue;
    if (await isUp(url)) continue;

    // Give it a moment before respawning. Killing and restarting instantly
    // races the port release, and vite with --strictPort would then fail its
    // own bind and the loop would never settle.
    say(child.name, `${c('warn', 'stopped answering')} (${await diagnose(url)}) — rechecking in 3s`);
    await sleep(3000);
    if (shuttingDown) return;
    // Three strikes, not one. A single slow response is not a dead service, and
    // restarting a working one is what produces the "Port 5180 is already in
    // use" death: the old process is still alive and holding the port when its
    // replacement starts.
    child.strikes = 1;
    for (let i = 0; i < 2; i++) {
      if (await isUp(url)) {
        say(child.name, c('dim', 'answered on recheck — nothing was wrong'));
        child.strikes = 0;
        break;
      }
      child.strikes++;
      await sleep(3000);
      if (shuttingDown) return;
    }
    // Still nothing after three attempts: genuinely down.
    if (child.strikes === 0) continue;
    child.strikes = 0;
    if (child.restart) {
      child.restart();
    } else {
      // Before spawning, make sure nothing else has taken the port. A previous
      // instance can still be alive when its own restart raced it, and vite
      // with --strictPort then exits with "Port 5180 is already in use" — which
      // looks like a broken launcher but is really two owners of one port. If
      // something IS serving, adopt it rather than competing with it.
      if (await isUp(url)) {
        say(child.name, c('dim', 'something else is already serving it - leaving it alone'));
        child.ours = false;
        continue;
      }
      child.proc = start(child.name, child.cmd, child.args, child.logName);
    }
    const back = await waitFor(url, { timeoutMs: 45_000, label: child.name });
    say(child.name, back.ok ? `${c('ok', 'back up')}` : `${c('err', 'still not answering')}: ${back.error}`);
  }
  timer = setTimeout(tick, 5000);
};
let timer = setTimeout(tick, 5000);

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  say('stop ', 'shutting down...');
  // Only what this script started. A service the user launched themselves from
  // another window is left alone, because it is not ours to stop.
  for (const { proc, ours } of children) {
    if (ours) killTree(proc);
  }
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
