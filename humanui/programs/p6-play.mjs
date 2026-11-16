// Step 6: open the official Blender short film and get it playing.
// The thumbnail anchor did not navigate before, because it sits far below the fold and selector
// clicks were not being scrolled into view. That is fixed; this run is the check.
const candidates = await page.evaluate(`(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/watch"]')) {
    const host = a.closest('ytd-video-renderer, ytd-rich-item-renderer') || a.parentElement;
    const t = host && host.querySelector('#video-title, h3');
    const title = ((t && t.textContent) || a.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    if (title) out.push({ href: a.getAttribute('href').split('&')[0], title: title.slice(0, 70) });
  }
  return out;
})()`);

// The official Blender Foundation upload, deduplicated by video id.
const byId = new Map();
for (const c of candidates) {
  const id = new URL('https://x' + c.href).searchParams.get('v');
  if (!byId.has(id)) byId.set(id, { id, title: c.title });
}
const videos = [...byId.values()];
log('unique videos: ' + videos.length);
for (const v of videos.slice(0, 6)) log(`  ${v.id}  "${v.title}"`);

const pick = videos.find((v) => /official blender/i.test(v.title)) ?? videos[0];
log('playing: ' + JSON.stringify(pick));

// Tag the element so the selector resolves to exactly this video, then click it.
await page.evaluate(`(() => {
  const a = [...document.querySelectorAll('a[href^="/watch"]')].find(
    (el) => (el.getAttribute('href') || '').includes('v=${pick.id}'));
  a.setAttribute('data-target-video', '${pick.id}');
})()`);

await page.click({ selector: `[data-target-video="${pick.id}"]` });
log('clicked the thumbnail');

await new Promise((r) => setTimeout(r, 3000));
log('url:  ' + await page.url());
log('title: ' + await page.title());
globalThis.playing = pick;