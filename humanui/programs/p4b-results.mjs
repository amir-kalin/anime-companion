// Step 4b: find the result links by their href rather than by guessing at YouTube's class names.
let found = null;
for (let i = 0; i < 50; i++) {
  found = await page.evaluate(`(() => {
    const anchors = [...document.querySelectorAll('a[href^="/watch"]')];
    const uniq = [];
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (!href || seen.has(href)) continue;
      const title = (a.getAttribute('title') || a.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!title) continue;
      seen.add(href);
      uniq.push({ href, title: title.slice(0, 70) });
    }
    return { url: location.href, total: anchors.length, withTitle: uniq.length, items: uniq.slice(0, 8) };
  })()`);
  if (found.withTitle >= 3) break;
  await new Promise((r) => setTimeout(r, 400));
}
log(`url: ${found.url}`);
log(`anchors to /watch: ${found.total}, with a usable title: ${found.withTitle}`);
for (const it of found.items) log(`  ${it.href}  "${it.title}"`);

// Keep going: prefer the official Blender upload, which is a real, playable, long-form video.
const official = found.items.find((i) => /blender/i.test(i.title)) ?? found.items[0];
log('chosen: ' + JSON.stringify(official));
globalThis.watchHref = official?.href ?? null;
globalThis.watchTitle = official?.title ?? null;