// Render the operator console at a desktop width and capture it.
//
// The review browser window is often narrow enough to hit the single-column breakpoint, which hides
// whether the three-column layout actually works. This drives the harness's own browser instead,
// where the viewport is set explicitly.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HarnessServer, SCENARIOS } from '../src/harness/server.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';
import { sleep } from '../src/cdp/client.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'shots');
mkdirSync(OUT, { recursive: true });

const scenarioKey = process.argv[2] ?? 'channels';
const width = Number(process.argv[3] ?? 1600);
const height = Number(process.argv[4] ?? 1000);

const server = new HarnessServer({ headless: true, width, height });
const { origin } = await server.listen(0);

const viewer = await createRuntime({ headless: true, width, height, allowHosts: ['127.0.0.1', 'localhost'] });

try {
  await viewer.page.goto(`${origin}/`);
  // Give the SSE connection and the accessibility-tree poll time to land.
  await sleep(2500);

  const layout = await viewer.page.evaluate(`JSON.stringify({
    innerWidth: window.innerWidth,
    display: getComputedStyle(document.querySelector('main')).display,
    cols: getComputedStyle(document.querySelector('main')).gridTemplateColumns,
    widths: [...document.querySelectorAll('main > section')].map(s => Math.round(s.getBoundingClientRect().width)),
    tops: [...document.querySelectorAll('main > section')].map(s => Math.round(s.getBoundingClientRect().top))
  })`);
  console.log('layout:', layout);

  await viewer.page.evaluate(`fetch('/api/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: ${JSON.stringify(scenarioKey)} })
  })`);

  // Wait for the run to settle by polling the server's own state endpoint.
  for (let i = 0; i < 120; i++) {
    const state = await fetch(`${origin}/api/state`).then((r) => r.json()).catch(() => null);
    if (state && !state.running && state.lastResult) break;
    await sleep(250);
  }
  await sleep(1000);

  const state = await viewer.page.evaluate(`JSON.stringify({
    steps: document.querySelectorAll('#steps .step').length,
    images: document.querySelectorAll('#shots figure img').length,
    axLines: (document.getElementById('ax').textContent || '').split('\\n').filter(Boolean).length
  })`);
  console.log('console state:', state);

  const frame = await viewer.page.screenshot();
  const file = join(OUT, `console-${scenarioKey}-${width}.png`);
  writeFileSync(file, Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
  console.log('wrote', file);

  // Also capture the demo target itself, as the agent sees it.
  const target = await createRuntime({ headless: true, width, height, allowHosts: ['127.0.0.1', 'localhost'] });
  await target.page.goto(`${origin}/target.html`);
  await sleep(600);
  const targetFrame = await target.page.screenshot();
  const targetFile = join(OUT, `target-${width}.png`);
  writeFileSync(targetFile, Buffer.from(targetFrame.dataUrl.split(',')[1], 'base64'));
  console.log('wrote', targetFile);
  await target.close();
} finally {
  await viewer.close();
  await server.close();
}