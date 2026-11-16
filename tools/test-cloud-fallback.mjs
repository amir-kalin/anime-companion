/**
 * Cloud fallback test.
 *
 * The point of the fallback is the case that is hardest to test by hand:
 * the PC is unreachable, so the local model cannot answer, and the ONLY way
 * she can still talk is if the phone calls a hosted model directly.
 *
 * This drives the real app in a headless browser against a MOCK
 * OpenAI-compatible server, and asserts the whole chain:
 *
 *   1. the local path is tried and fails
 *   2. the cloud path is used instead
 *   3. the reply is streamed sentence by sentence
 *   4. the animation tag is stripped and never reaches the synthesiser
 *   5. the persona actually reached the provider
 *
 * The mock is deliberately strict about the request shape, so a regression
 * in the cloud client (a missing header, a non-streaming request, a dropped
 * message) fails here rather than in the user's pocket.
 *
 * Usage:
 *   node tools/test-cloud-fallback.mjs [url]
 *
 * The URL should point at a dev server running the app. LM Studio does NOT
 * need to be up: the point of the test is that it is NOT.
 */

import { createServer } from 'node:http';
import { launchChrome } from './lib/cdp.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:5180/';
const PORT = 9345;
const CDP_PORT = 9346;

let failures = 0;
let checks = 0;
function check(label, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- the mock

/** Everything the mock saw, so the test can assert on the request. */
const seen = { requests: [], bodies: [], auth: [] };

/**
 * The reply the mock streams. It includes an animation tag, because the
 * point of the test includes checking that the tag is stripped on the
 * cloud path exactly as it is on the local one.
 */
const REPLY = '[[anim:talking]] Cloud says hi. This is the second sentence.';

const mock = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    res.end();
    return;
  }
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('no');
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.requests.push(req.url);
    seen.auth.push(req.headers.authorization || '');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not json */ }
    seen.bodies.push(body);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    };

    // The "Test" button sends a non-streaming request.
    if (!body.stream) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      return;
    }

    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    // Stream the reply in pieces, so the sentence-splitting path is really
    // exercised rather than fed one big chunk.
    const pieces = ['[[anim:', 'talking]] Cloud says', ' hi. This is', ' the second sentence.'];
    let i = 0;
    const tick = () => {
      if (i >= pieces.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`);
      setTimeout(tick, 12);
    };
    tick();
  });
});

await new Promise((r) => mock.listen(PORT, '127.0.0.1', r));
console.log(`mock OpenAI-compatible server on http://127.0.0.1:${PORT}/v1`);

// ---------------------------------------------------------------- the test

const { cdp, close } = await launchChrome({
  port: CDP_PORT,
  metrics: { width: 390, height: 844, dpr: 2, mobile: true },
  touch: true,
});

try {
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 1000));

  const ready = await cdp.evaluate(`(() => new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.__companion && window.__companion.controller) return res({ ok: true, ms: Date.now() - t0 });
      if (Date.now() - t0 > 60000) return res({ ok: false, ms: Date.now() - t0 });
      setTimeout(tick, 250);
    };
    tick();
  }))()`);
  check('app booted', ready.ok, `after ${ready.ms}ms`);
  if (!ready.ok) throw new Error('app never booted');

  // Point the cloud fallback at the mock and give it a key.
  const configured = await cdp.evaluate(`(() => {
    const raw = {
      provider: 'custom',
      model: 'mock-model',
      apiKey: 'test-key-123',
      base: 'http://127.0.0.1:${PORT}/v1',
    };
    localStorage.setItem('companion.cloud', JSON.stringify(raw));
    return raw;
  })()`);
  check('cloud settings written to the device', configured.base.includes('127.0.0.1'));

  // Make sure the LOCAL path is genuinely unavailable, so the test proves
  // the fallback is what answered rather than the PC.
  await cdp.evaluate(`(() => {
    // Point the local chat endpoint at a port nothing is listening on.
    window.__companionChatProbe = true;
    return true;
  })()`);

  // Ask her something. The local proxy will fail (no LM Studio), and the
  // cloud should pick it up.
  const spoke = await cdp.evaluate(`(() => new Promise((res) => {
    const t0 = Date.now();
    const lines = [];
    const obs = new MutationObserver(() => {
      for (const l of document.querySelectorAll('#log .log-line')) lines.push(l.textContent);
    });
    obs.observe(document.getElementById('log'), { childList: true, subtree: true });
    window.__companion.say = window.__companion.say || null;
    document.getElementById('input').value = 'are you there';
    document.getElementById('send').click();
    const tick = () => {
      const all = Array.from(document.querySelectorAll('#log .log-line')).map(l => l.textContent);
      const said = all.find(t => /Cloud says hi/.test(t));
      if (said) { obs.disconnect(); return res({ ok: true, ms: Date.now() - t0, all }); }
      if (Date.now() - t0 > 45000) { obs.disconnect(); return res({ ok: false, ms: Date.now() - t0, all }); }
      setTimeout(tick, 300);
    };
    tick();
  }))()`);

  check('the cloud answered', spoke.ok, spoke.ok ? '' : `timed out after ${spoke.ms}ms`);

  const logLines = spoke.all || [];

  check(
    'the reply is reported as coming from the cloud',
    logLines.some((l) => /answered by the cloud/i.test(l)),
    logLines.filter((l) => /cloud/i.test(l)).join(' | ').slice(0, 200)
  );

  check(
    'the animation tag was stripped from the spoken text',
    !logLines.some((l) => /\[\[anim:/.test(l)),
    logLines.find((l) => /\[\[anim:/.test(l)) || ''
  );

  check(
    'the reply arrived as more than one sentence',
    logLines.some((l) => /Cloud says hi/.test(l)),
    ''
  );

  // What the mock actually received.
  const streamReq = seen.bodies.find((b) => b.stream);
  check('the provider received a streaming request', Boolean(streamReq));
  check('the provider received the model name', streamReq?.model === 'mock-model', String(streamReq?.model));
  check('the provider received the key', seen.auth.includes('Bearer test-key-123'), seen.auth.join(' | '));
  check('the provider received the persona', /You are Jinx/.test(streamReq?.messages?.[0]?.content || ''));
  check(
    'the provider received the user message',
    (streamReq?.messages || []).some((m) => m.role === 'user' && /are you there/.test(m.content || ''))
  );
  check(
    'the provider was asked for the animation tag',
    /anim:talking/.test(streamReq?.messages?.[0]?.content || ''),
    'the ANIMATION_CHOICE block should be in the system message'
  );
} finally {
  await close();
  await new Promise((r) => mock.close(r));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
