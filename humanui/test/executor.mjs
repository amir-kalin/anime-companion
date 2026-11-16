// Executor behavior against a real browser.
//
// These are the properties the vendor docs state about computer use, asserted rather than assumed:
// coordinate mapping, handle stability across reflow, zoom not moving the coordinate frame, real
// trusted input events, and the pixel fallback where the accessibility tree has nothing to say.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { check, section, summary } from './assert.mjs';
import { createStaticServer } from '../src/harness/static.mjs';
import { createRuntime } from '../src/harness/runtime.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const statics = createStaticServer(PUBLIC);
const { origin } = await statics.listen(0);

const runtime = await createRuntime({
  headless: true,
  allowHosts: ['127.0.0.1', 'localhost'],
  approvalMode: 'allow-all',
});
const { page } = runtime;

/** Reload the demo target, so each section starts from known state. */
const fresh = async () => {
  await page.goto(`${origin}/target.html`);
};

try {
  await page.goto(`${origin}/target.html`);

  // -------------------------------------------------------------- semantic channel
  section('executor: the semantic channel');

  const snap = await page.snapshot({ filter: 'interactive' });
  check('labelled controls are exposed', /textbox "Search title"/.test(snap.text));
  check('handles are assigned', /\[ref_\d+\]/.test(snap.text));
  check('each line carries a viewport box', /\(\d+,\d+ \d+x\d+\)/.test(snap.text), snap.text.split('\n')[0]);

  const applyRef = /button "Apply filters" \[(ref_\d+)\]/.exec(snap.text)[1];
  const repeat = await page.snapshot({ filter: 'interactive' });
  check('handles are not renumbered between reads', repeat.text.includes(`[${applyRef}]`));

  const resolved = await page.resolveTarget({ ref: applyRef });
  check('a handle resolves through the semantic channel', resolved.channel === 'semantic', resolved.channel);
  check('the resolved node reports its accessible name', resolved.name === 'Apply filters', resolved.name);

  // -------------------------------------------------------------- trusted input
  section('executor: input is real, not synthetic DOM mutation');

  await page.fill({ role: 'textbox', name: 'Search title' }, 'penguin');
  const count = await page.evaluate("document.getElementById('count').textContent");
  check('fill() replaces rather than appends', count.includes('1 of 7'), count);
  check('the focused element is the real one',
    (await page.evaluate('document.activeElement.id')) === 'q');

  // -------------------------------------------------------------- chords
  section('executor: modifier chords use real key events');

  await page.evaluate("document.getElementById('q').focus(); document.getElementById('q').value='xy'");
  await page.press('ctrl+a');
  const selection = await page.evaluate(
    'String(document.getElementById("q").selectionStart) + "," + String(document.getElementById("q").selectionEnd)',
  );
  check('ctrl+a selects all', selection === '0,2', `selection=${selection}`);
  await page.press('Delete');
  check('Delete clears the selection',
    (await page.evaluate("document.getElementById('q').value")) === '');
  await page.type('ab');
  check('plain typing still works after a chord',
    (await page.evaluate("document.getElementById('q').value")) === 'ab');

  await page.press('ctrl+a');
  await page.type('c');
  check('typing replaces a selection',
    (await page.evaluate("document.getElementById('q').value")) === 'c');

  // -------------------------------------------------------------- coordinate frame
  section('executor: the coordinate frame');

  const frame = await page.screenshot();
  check('a full screenshot declares image space', frame.space === 'image', frame.describe());
  check('image pixels map into viewport space',
    Math.abs(frame.toViewport(frame.imageWidth, frame.imageHeight).x - frame.viewport.width) < 2,
    JSON.stringify(frame.toViewport(frame.imageWidth, frame.imageHeight)));

  const zoom = await page.zoom([200, 100, 500, 220]);
  check('a zoom declares viewport space', zoom.space === 'viewport', zoom.describe());
  check('zoom scales against the crop, not the viewport',
    Math.abs(zoom.scale - 1) < 0.02 || zoom.imageWidth <= 1024, `scale=${zoom.scale}`);
  const mapped = zoom.toViewport(zoom.imageWidth / 2, zoom.imageHeight / 2);
  check('zoom image pixels land inside the crop',
    Math.abs(mapped.x - 350) < 8 && Math.abs(mapped.y - 160) < 8, JSON.stringify(mapped));
  const passthrough = zoom.fromModel(350, 160);
  check('post-zoom coordinates pass through unmapped',
    passthrough.x === 350 && passthrough.y === 160, JSON.stringify(passthrough));

  // -------------------------------------------------------------- perceptual channel
  section('executor: the perceptual channel reports what it hit');

  const btnBox = await page.evaluate(
    '(() => { const r = document.getElementById("apply").getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()',
  );
  const coordRec = await page.click({ x: btnBox[0], y: btnBox[1] });
  check('a coordinate click uses the perceptual channel', coordRec.channel === 'perceptual', coordRec.channel);
  check('the click was verified against the DOM',
    String(coordRec.node).includes('apply'), String(coordRec.node));
  check('the button actually fired',
    /Filters applied/.test(await page.evaluate("document.getElementById('banner').textContent")));

  // -------------------------------------------------------------- pixel-only surfaces
  section('executor: pixel-only surfaces fall back to coordinates');

  const all = await page.snapshot({ filter: 'all' });
  const hasCanvas = all.text.split('\n').some((l) => /^canvas\b/.test(l));
  check('a canvas has no accessible node to target', !hasCanvas);

  const chart = await page.evaluate(
    '(() => { const r = document.getElementById("chart").getBoundingClientRect(); return [r.x, r.y, r.x + r.width, r.y + r.height]; })()',
  );
  const canvasZoom = await page.zoom(chart);
  check('the canvas can still be observed by pixels',
    canvasZoom.dataUrl.startsWith('data:image/png;base64,'), canvasZoom.describe());

  const iframeBox = await page.evaluate(
    '(() => { const r = document.getElementById("player").getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()',
  );
  const iframeRec = await page.click({ x: iframeBox[0], y: iframeBox[1] });
  check('a click into an iframe resolves perceptually', iframeRec.channel === 'perceptual', iframeRec.channel);

  // -------------------------------------------------------------- targeting forms
  section('executor: every documented targeting form works');

  for (const [label, target] of [
    ['handle', { ref: applyRef }],
    ['selector', '#apply'],
    ['role+name', { role: 'button', name: 'Apply filters' }],
  ]) {
    const r = await page.resolveTarget(target);
    check(`${label} resolves semantically`, r.channel === 'semantic', `${r.via}/${r.channel}`);
  }

  let stale = '';
  try { await page.click('ref_99999'); } catch (err) { stale = err.message; }
  check('an unknown handle is refused with actionable text', /Could not resolve target/.test(stale),
    stale.slice(0, 70));

  // Every semantic form must be scrolled into view before the click is dispatched. Gating that on
  // `ref` alone made a selector click fire at pre-scroll coordinates, which misses anything below the
  // fold while still reporting success.
  section('executor: targets below the fold are scrolled into view');

  await fresh();
  const placed = await page.evaluate(`(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '1600px';
    document.body.prepend(spacer);
    const r = document.getElementById('apply').getBoundingClientRect();
    return { top: Math.round(r.top), viewport: window.innerHeight };
  })()`);
  check('the target starts below the fold', placed.top > placed.viewport, JSON.stringify(placed));

  await page.click({ selector: '#apply' });
  const bannerText = await page.evaluate("document.getElementById('banner').textContent");
  check('a selector click below the fold still lands',
    /Filters applied/.test(bannerText), bannerText || '(no banner: the click missed)');

  // The same must hold for a role+name target, which is the third semantic form.
  await fresh();
  await page.evaluate(`(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '1600px';
    document.body.prepend(spacer);
  })()`);
  await page.click({ role: 'button', name: 'Apply filters' });
  check('a role+name click below the fold still lands',
    /Filters applied/.test(await page.evaluate("document.getElementById('banner').textContent")));

  // fill() has to reach the field the same way, or it types into nothing on a scrolled page.
  await fresh();
  await page.evaluate(`(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '1600px';
    document.body.prepend(spacer);
  })()`);
  await page.fill({ role: 'textbox', name: 'Search title' }, 'penguin');
  check('fill() below the fold reaches the field',
    (await page.evaluate("document.getElementById('count').textContent")).includes('1 of 7'),
    await page.evaluate("document.getElementById('count').textContent"));

  await fresh();

  // -------------------------------------------------------------- reflow stability
  section('executor: a handle survives layout shift, a coordinate would not');

  // Re-acquire the handle: navigation invalidates every outstanding one, which the harness correctly
  // refuses. This section is about *layout* shift, not navigation.
  const freshApplyRef = /button "Apply filters" \[(ref_\d+)\]/.exec((await page.snapshot()).text)[1];
  const before = await page.resolveTarget({ ref: freshApplyRef });
  await page.evaluate("document.getElementById('banner').style.display = 'block'; document.body.prepend(Object.assign(document.createElement('div'), { textContent: 'spacer', style: 'height:120px' }));");
  const after = await page.resolveTarget({ ref: freshApplyRef });
  check('the handle moved with the element',
    Math.abs(after.point.y - before.point.y) > 50,
    `${Math.round(before.point.y)} -> ${Math.round(after.point.y)}`);

  // And the stale handle from before the navigations is still refused, which is the other half of
  // the scoping rule.
  let staleAfterNav = '';
  try { await page.resolveTarget({ ref: applyRef }); } catch (err) { staleAfterNav = err.message; }
  check('a handle from before a navigation is refused', /Could not resolve target/.test(staleAfterNav),
    staleAfterNav.slice(0, 70));

  // -------------------------------------------------------------- native select
  section('executor: a native select takes the semantic path');

  await fresh();
  const selectRef2 = /combobox "Status" \[(ref_\d+)\]/.exec((await page.snapshot()).text)[1];
  const chosen = await page.selectOption({ ref: selectRef2 }, 'airing');
  check('selectOption reports the transition', chosen.previous === '' && chosen.value === 'airing',
    `${chosen.previous} -> ${chosen.value}`);
  check('the page sees the new value',
    (await page.evaluate("document.getElementById('status').value")) === 'airing');
  check('the page change handler ran',
    (await page.evaluate("document.getElementById('count').textContent")).includes('3 of 7'),
    await page.evaluate("document.getElementById('count').textContent"));

  let badSelect = '';
  try { await page.selectOption({ ref: selectRef2 }, 'nonexistent'); } catch (err) { badSelect = err.message; }
  check('an unmatched option is refused, not silently ignored', /no option with value/.test(badSelect),
    badSelect.slice(0, 70));

  // -------------------------------------------------------------- liveness
  section('executor: liveness is reported, not assumed');
  check('a live page reports alive', (await page.isAlive()) === true);
} finally {
  await runtime.close();
  await statics.close();
}

process.exitCode = summary() ? 0 : 1;