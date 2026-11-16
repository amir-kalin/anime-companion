// Step 3: why did the consent click not dismiss the dialog?
// Two candidates: the coordinates are wrong, or the element lives in a cross-origin frame whose
// accessibility box is not in page coordinates. Measure instead of guessing.
const line = 'button "Reject the use of cookies and other data for the purposes described"';
const snap = await page.snapshot({ filter: 'interactive' });
const hit = snap.text.split('\n').find((l) => l.startsWith(line));
log('listing line: ' + hit);

const ref = /\[(ref_\d+)\]/.exec(hit ?? '')?.[1];
const resolved = await page.resolveTarget({ ref });
log(`resolved channel=${resolved.channel} point=${JSON.stringify(resolved.point)}`);

// What does the page think is actually at that point?
const at = await page.evaluate(`(() => {
  const el = document.elementFromPoint(${resolved.point.x}, ${resolved.point.y});
  const chain = [];
  let cur = el;
  for (let i = 0; i < 6 && cur; i++) {
    chain.push(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') +
      (cur.className && typeof cur.className === 'string' ? '.' + cur.className.split(' ')[0] : ''));
    cur = cur.parentElement;
  }
  return {
    at: el ? el.tagName.toLowerCase() + (el.getAttribute('aria-label') || '').slice(0, 40) : null,
    chain,
    frames: [...document.querySelectorAll('iframe')].map((f) => ({
      src: (f.src || '').slice(0, 70),
      rect: (() => { const r = f.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })(),
    })),
    dialogCount: document.querySelectorAll('[role=dialog], tp-yt-paper-dialoghost').length,
  };
})()`);
log('elementFromPoint: ' + JSON.stringify(at, null, 1));

// Is the consent dialog inside a frame? If so its box is in that frame's coordinates.
const frames = await page.evaluate(
  '[...document.querySelectorAll("iframe")].map(f => (f.src||f.name||"(unnamed)").slice(0,80))',
);
log('iframes on the page: ' + JSON.stringify(frames));