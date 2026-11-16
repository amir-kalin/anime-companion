// Step 1: where am I, and what does the page expose?
// I am the planner here. This program is the observation half of one loop iteration.
const info = await page.describe();
log(`url:   ${info.url}`);
log(`title: ${info.title}`);

// The semantic channel first: cheaper than a screenshot and it may already answer the question.
const snap = await page.snapshot({ filter: 'interactive' });
log(`a11y interactive nodes: ${snap.nodeCount} of ${snap.totalNodes}`);
log(snap.text.split('\n').slice(0, 14).join('\n'));

// YouTube's own state, read directly: a <video> element is the canonical surface the
// accessibility tree cannot describe, which is the whole reason both channels exist.
const media = await page.evaluate(`(() => {
  const v = document.querySelector('video');
  return {
    videoCount: document.querySelectorAll('video').length,
    audioCount: document.querySelectorAll('audio').length,
    hasVideo: Boolean(v),
    src: v ? (v.currentSrc || v.src || '').slice(0, 90) : null,
    currentTime: v ? v.currentTime : null,
    duration: v ? v.duration : null,
    paused: v ? v.paused : null,
    muted: v ? v.muted : null,
    readyState: v ? v.readyState : null,
    videoWidth: v ? v.videoWidth : null,
    videoHeight: v ? v.videoHeight : null,
  };
})()`);
log('media: ' + JSON.stringify(media));

const net = page.networkReport();
log(`net: ${net.allowed} allowed, ${net.blocked} blocked`);
for (const b of net.blockedRequests.slice(0, 5)) log(`  blocked ${b.url} (${b.reason})`);