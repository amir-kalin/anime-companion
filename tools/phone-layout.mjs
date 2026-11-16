/**
 * Phone layout audit.
 *
 * Drives a headless Chrome through the DevTools Protocol with a real mobile
 * emulation profile (touch events, coarse pointer, device pixel ratio) and
 * then MEASURES the result, rather than eyeballing a screenshot.
 *
 * Why a script and not a screenshot: the bugs this catches are all
 * off-by-a-few-pixels failures. "The toolbar is cut off" and "the panel is
 * 60px too wide" are invisible in a picture and obvious in numbers.
 *
 * It reports:
 *   - the emulated viewport, DPR, and whether `pointer: coarse` took effect
 *   - the computed `--app-h` and the app's real box
 *   - EVERY element whose right edge or bottom edge falls outside the
 *     viewport and is not clipped by a scrolling ancestor, which is the
 *     actual definition of a broken phone layout
 *
 * Usage:
 *   node tools/phone-layout.mjs [url] [--width=390] [--height=844] [--dismiss]
 *
 * It starts its own Chrome, so nothing you have open is affected.
 */

import { writeFileSync } from 'node:fs';
import { launchChrome } from './lib/cdp.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:5180/';
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const WIDTH = Number(opt('width', 390));
const HEIGHT = Number(opt('height', 844));
const DPR = Number(opt('dpr', 3));
const PORT = Number(opt('port', 9333));
const SHOT = opt('shot', '');
const WAIT = Number(opt('wait', 30000));

/**
 * The measurement, run inside the page.
 */
const PROBE = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.documentElement;
  const cs = getComputedStyle(root);

  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: el.className && typeof el.className === 'string' ? el.className : null,
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
    };
  };

  const named = {};
  for (const id of ['app', 'stage', 'panel', 'hud', 'log', 'input', 'send', 'mic',
                   'zoombar', 'audio-gate', 'cloud-sheet', 'sit-toggle',
                   'framing-toggle', 'lock-toggle', 'reset-orbit', 'fs-toggle',
                   'hud-toggle', 'cloud-toggle']) {
    const el = document.getElementById(id);
    if (el) named[id] = rect(el);
  }
  const fsBar = document.querySelector('.fs-bar');
  if (fsBar) named['.fs-bar'] = rect(fsBar);

  // Anything sticking out of the viewport.
  //
  // "Sticking out" only counts if the overflow is VISIBLE. An element inside
  // a scrolling container (the log) legitimately extends past the viewport
  // and is clipped by its parent, so it is not a broken layout. The check
  // walks up the ancestors looking for one that clips or scrolls the axis in
  // question.
  const clipped = (el, axis) => {
    const prop = axis === 'x' ? 'overflowX' : 'overflowY';
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s[prop] !== 'visible') return true;
    }
    return false;
  };

  const overflow = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.position === 'fixed' && style.visibility === 'hidden') continue;
    const pastRight = Math.round(r.right - vw);
    const pastBottom = Math.round(r.bottom - vh);
    const realRight = pastRight > 1 && !clipped(el, 'x');
    const realBottom = pastBottom > 1 && !clipped(el, 'y');
    if (realRight || realBottom) {
      overflow.push({
        ...rect(el),
        pastRight,
        pastBottom,
        clippedX: clipped(el, 'x'),
        clippedY: clipped(el, 'y'),
        display: style.display,
        visibility: style.visibility,
      });
    }
  }
  overflow.sort((a, b) => (b.pastRight + b.pastBottom) - (a.pastRight + a.pastBottom));

  return {
    viewport: {
      innerWidth: vw, innerHeight: vh,
      dpr: window.devicePixelRatio,
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    appH: cs.getPropertyValue('--app-h').trim(),
    scroll: {
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
    },
    named,
    overflow: overflow.slice(0, 20),
  };
})()`;

const { cdp, close } = await launchChrome({
  port: PORT,
  metrics: { width: WIDTH, height: HEIGHT, dpr: DPR, mobile: true },
  touch: true,
});

try {
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 1200));

  // Wait for the app to report itself ready, rather than a fixed sleep.
  const ready = await cdp.evaluate(`(() => new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.__companion && window.__companion.controller) {
        return res({ ok: true, ms: Date.now() - t0 });
      }
      if (Date.now() - t0 > ${WAIT}) return res({ ok: false, ms: Date.now() - t0 });
      setTimeout(tick, 250);
    };
    tick();
  }))()`);
  console.log(`booted in ${ready.ms}ms (ok=${ready.ok})`);

  // Let a few frames render so the canvas has painted.
  await new Promise((r) => setTimeout(r, 1500));

  // Optionally tap through the audio gate, so the screenshot shows the app
  // itself rather than the overlay.
  if (args.includes('--dismiss')) {
    await cdp.evaluate(`(() => {
      const b = document.getElementById('audio-gate-btn');
      if (b) b.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));
    console.log('gate dismissed');
  }

  const report = await cdp.evaluate(PROBE);
  console.log(JSON.stringify(report, null, 2));

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`screenshot -> ${SHOT}`);
  }
} finally {
  await close();
}
