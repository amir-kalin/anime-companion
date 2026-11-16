// Step 7: open the video via its title link, then confirm it is actually playing.
// The thumbnail anchor's centre is covered by an overlay that is not its child, so the click never
// reaches it. `#video-title` is the canonical target and is what a user clicks anyway.
const target = (globalThis.playing && globalThis.playing.id) || 'WaiZ8vjfxc4';

const prepared = await page.evaluate(`(() => {
  const title = document.querySelector('#video-title[href*="v=${target}"]')
    || [...document.querySelectorAll('#video-title')].find((a) => (a.getAttribute('href')||'').includes('v=${target}'));
  if (!title) return { found: false };
  title.setAttribute('data-target-title', '1');
  title.scrollIntoView({ block: 'center' });
  const r = title.getBoundingClientRect();
  return { found: true, href: title.getAttribute('href'), rect: [Math.round(r.x), Math.round(r.y)] };
})()`);
log('title link: ' + JSON.stringify(prepared));
if (!prepared.found) throw new Error('no #video-title for ' + target);

await page.click({ selector: '[data-target-title="1"]' });
log('clicked the title');

// Watch page navigation is not instantaneous; poll rather than guess a delay.
let landed = false;
for (let i = 0; i < 40; i++) {
  if ((await page.url()).includes('/watch')) { landed = true; break; }
  await new Promise((r) => setTimeout(r, 300));
}
log(`landed on a watch page: ${landed}`);
log('url:  ' + await page.url());
log('title: ' + await page.title());
globalThis.landed = landed;