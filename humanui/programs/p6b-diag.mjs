// Step 6b: is the click landing on the anchor, or missing it?
const pick = globalThis.playing ?? { id: 'WaiZ8vjfxc4' };
log('target video: ' + pick.id);

const info = await page.evaluate(`(() => {
  const a = [...document.querySelectorAll('a[href^="/watch"]')].find(
    (el) => (el.getAttribute('href') || '').includes('v=${pick.id}'));
  if (!a) return { found: false };
  a.setAttribute('data-target-video', '1');
  // Count real clicks that reach the anchor, so "the click worked" is measured rather than inferred.
  window.__clicks = 0;
  a.addEventListener('click', () => { window.__clicks++; }, true);
  const r = a.getBoundingClientRect();
  return {
    found: true,
    href: a.getAttribute('href'),
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    viewport: [window.innerWidth, window.innerHeight],
    visible: r.width > 0 && r.height > 0,
  };
})()`);
log('anchor: ' + JSON.stringify(info));

if (!info.found) throw new Error('anchor not found');

// Scroll it into view the way the harness does, then measure the point that would be clicked.
await page.evaluate(`(() => {
  const a = document.querySelector('[data-target-video="1"]');
  a.scrollIntoView({ block: 'center' });
})()`);
await new Promise((r) => setTimeout(r, 300));

const probe = await page.evaluate(`(() => {
  const a = document.querySelector('[data-target-video="1"]');
  const r = a.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return {
    center: [Math.round(cx), Math.round(cy)],
    onScreen: cy >= 0 && cy <= window.innerHeight,
    hits: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : 'nothing',
    hitsAnchorOrChild: Boolean(hit && (hit === a || a.contains(hit))),
    scrollY: Math.round(window.scrollY),
  };
})()`);
log('probe: ' + JSON.stringify(probe));