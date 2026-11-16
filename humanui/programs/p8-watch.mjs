// Step 8: the watch page, and does the video actually play?
// The result anchors resolve correctly but do not activate under synthesized mouse events — worth
// recording as a finding. Navigating directly is still the harness driving the UI, and it gets us to
// the part that matters: verifying real media playback.
const id = (globalThis.playing && globalThis.playing.id) || 'WaiZ8vjfxc4';
await page.goto('https://www.youtube.com/watch?v=' + id);
log('navigated to the watch page');

// The player is created by script; wait for a <video> that actually has media behind it.
let state = null;
for (let i = 0; i < 60; i++) {
  state = await page.evaluate(`(() => {
    const v = document.querySelector('video');
    if (!v) return { present: false };
    return {
      present: true,
      paused: v.paused,
      currentTime: Number(v.currentTime.toFixed(2)),
      duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(1)) : null,
      readyState: v.readyState,
      networkState: v.networkState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      muted: v.muted,
      volume: v.volume,
      src: (v.currentSrc || '').slice(0, 60),
      ended: v.ended,
      error: v.error ? v.error.code : null,
    };
  })()`);
  if (state.present && state.readyState >= 2 && state.videoWidth > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
log('first reading: ' + JSON.stringify(state));
globalThis.firstReading = state;

// If autoplay did not start it, press play the way a user does: find the control and click it.
if (state.present && state.paused) {
  const snap = await page.snapshot({ filter: 'interactive', maxNodes: 200 });
  const playLine = snap.text.split('\\n').find((l) => /button "(Play|play)/.test(l))
    || snap.text.split('\\n').find((l) => /^button/.test(l));
  log('play control: ' + (playLine ?? '(none found in the tree)'));
  const ref = playLine && /\\[(ref_\\d+)\\]/.exec(playLine)[1];
  if (ref) {
    await page.click({ ref });
    log('clicked play via handle ' + ref);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// The decisive check: is the playhead actually advancing?
const a = await page.evaluate(`(() => { const v = document.querySelector('video'); return v ? v.currentTime : null; })()`);
await new Promise((r) => setTimeout(r, 3000));
const b = await page.evaluate(`(() => {
  const v = document.querySelector('video');
  return v ? { t: v.currentTime, paused: v.paused, w: v.videoWidth, h: v.videoHeight, rs: v.readyState } : null;
})()`);
const advanced = b && a !== null && b.t > a + 0.4;
log(`currentTime ${Number(a).toFixed(2)}s -> ${b ? Number(b.t).toFixed(2) : 'n/a'}s`);
log(`PLAYING: ${Boolean(advanced)}`);
log('final: ' + JSON.stringify(b));