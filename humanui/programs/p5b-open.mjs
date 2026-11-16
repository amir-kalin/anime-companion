// Step 5b: choose a real video from the results, not a channel link.
// The previous attempt grabbed "Go to channel ..." because I filtered by name alone. Videos and
// channels both live in the tree, so match on the accessible name AND the role's own href, which the
// page can tell us without guessing at YouTube's class names.
const snap = await page.snapshot({ filter: 'interactive', maxNodes: 400 });
log(`nodes ${snap.nodeCount} of ${snap.totalNodes}`);

// Ask the page which of the tree's links are actual watch targets, keyed by accessible name.
const candidates = await page.evaluate(`(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/watch"]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    // The title lives in the enclosing renderer's title text, not on the anchor itself.
    const host = a.closest('ytd-video-renderer, ytd-rich-item-renderer') || a.parentElement;
    const titleEl = host ? host.querySelector('#video-title, .yt-lockup-metadata-view-model__title, h3') : null;
    const title = ((titleEl && titleEl.textContent) || a.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    if (!title) continue;
    out.push({ href: href.split('&')[0], title: title.slice(0, 80) });
  }
  return out.slice(0, 10);
})()`);
log(`video candidates: ${candidates.length}`);
for (const c of candidates) log(`  ${c.href}  "${c.title}"`);

// Now find the handle for that exact link. Walking from the video-id keeps the match exact.
const pick = candidates.find((c) => /blender|buck bunny/i.test(c.title)) ?? candidates[0];
log('picked: ' + JSON.stringify(pick));

const id = new URL('https://x' + pick.href).searchParams.get('v');
log('video id: ' + id);

// Resolve a handle whose element is the anchor carrying that video id.
const ref = await page.evaluate(`(() => {
  const a = [...document.querySelectorAll('a[href^="/watch"]')].find((el) =>
    (el.getAttribute('href') || '').includes('v=${id}'));
  if (!a) return null;
  a.setAttribute('data-humanui-target', '1');
  a.id = a.id || 'humanui-pick';
  return a.id;
})()`, );
log('anchor id: ' + ref);

// A CSS selector routes through the semantic channel too, so this is still handle-equivalent.
await page.click({ selector: `[data-humanui-target="1"]` });
log('clicked the video');

await new Promise((r) => setTimeout(r, 2500));
log('url:  ' + await page.url());
log('title: ' + await page.title());
globalThis.pickedId = id;
globalThis.pickedTitle = pick.title;