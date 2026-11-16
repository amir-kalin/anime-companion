/**
 * Hud
 *
 * A live readout of everything the animation system is doing. This exists
 * because the whole project is about things that happen in 150ms windows:
 * without a cross-fade weight readout and a blink-phase indicator there is no
 * way to tell whether a transition actually cross-faded or just snapped.
 */
export class Hud {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = `
      <div class="hud-card">
        <div class="hud-title">Animation State</div>
        <div class="hud-state">
          <span class="hud-state-name" data-f="state">--</span>
          <span class="hud-state-prev" data-f="prev"></span>
        </div>
        <div class="hud-row"><span>time in state</span><b data-f="timeInState">0.00s</b></div>
        <div class="hud-row"><span>she chose</span><b data-f="chosen">--</b></div>
        <div class="hud-row"><span>framing</span><b data-f="framing">full</b></div>
        <div class="hud-fades" data-f="fades"></div>
      </div>

      <div class="hud-card">
        <div class="hud-title">Inactivity</div>
        <div class="hud-row"><span>countdown</span><b data-f="countdown">15.0s</b></div>
        <div class="hud-meter"><i data-f="idleBar"></i></div>
        <div class="hud-row"><span>bored triggers</span><b data-f="boredCount">0</b></div>
      </div>

      <div class="hud-card">
        <div class="hud-title">Procedural Life</div>
        <div class="hud-row"><span>blink phase</span><b data-f="blinkPhase">wait</b></div>
        <div class="hud-meter"><i data-f="blinkBar"></i></div>
        <div class="hud-row"><span>blinks fired</span><b data-f="blinkCount">0</b></div>
        <div class="hud-row"><span>eye yaw / pitch</span><b data-f="gaze">0.0&deg; / 0.0&deg;</b></div>
        <div class="hud-row"><span>eye track</span><b data-f="eyeTrack">--</b></div>
        <div class="hud-row"><span data-f="petLabel">petting</span><b data-f="petState">off</b></div>
        <div class="hud-meter"><i data-f="petBar"></i></div>
      </div>

      <div class="hud-card">
        <div class="hud-title">Lip Sync</div>
        <div class="hud-row"><span>voice source</span><b data-f="voiceMode">idle</b></div>
        <div class="hud-row"><span>rms</span><b data-f="rms">0.000</b></div>
        <div class="hud-meters" data-f="visemes"></div>
      </div>

      <div class="hud-card">
        <div class="hud-title">Memory</div>
        <div class="hud-row"><span data-f="memorySummary">nothing yet</span></div>
        <div class="hud-row"><span>notes</span><b data-f="memoryNotes">0</b></div>
        <div class="hud-row"><span>turns remembered</span><b data-f="memoryTurns">0</b></div>
      </div>

      <div class="hud-card">
        <div class="hud-title">Rig</div>
        <div class="hud-row"><span data-f="rigSummary">--</span></div>
        <div class="hud-row"><span>frame errors</span><b data-f="frameErrors">0</b></div>
      </div>
    `;

    this.fields = {};
    for (const el of this.root.querySelectorAll('[data-f]')) {
      this.fields[el.dataset.f] = el;
    }

    // Build one bar per viseme that the rig actually resolved, so the panel
    // never shows a permanently dead channel.
    this.visemeBars = {};
  }

  /** Called once after the rig resolves, to build the viseme meters. */
  setVisemes(available) {
    const host = this.fields.visemes;
    host.innerHTML = '';
    this.visemeBars = {};
    for (const key of available) {
      const row = document.createElement('div');
      row.className = 'hud-viseme';
      const label = document.createElement('span');
      label.textContent = key;
      const meter = document.createElement('i');
      const fill = document.createElement('b');
      meter.appendChild(fill);
      row.append(label, meter);
      host.appendChild(row);
      this.visemeBars[key] = fill;
    }
  }

  setRigSummary(text) {
    this._set('rigSummary', text);
  }

  setMemorySummary(text) {
    this._set('memorySummary', text);
  }

  _set(field, value) {
    const el = this.fields[field];
    if (el && el.textContent !== value) el.textContent = value;
  }

  _meter(field, ratio) {
    const el = this.fields[field];
    if (el) el.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }

  /**
   * @param {object} s snapshot of the running system
   */
  update(s) {
    // --- state machine
    this._set('state', s.state);
    this._set('prev', s.previous ? `was ${s.previous}` : '');
    this._set('timeInState', `${s.timeInState.toFixed(2)}s`);
    this._set('chosen', s.chosen || '--');
    this._set('framing', s.framing || 'full');

    // Cross-fade weights: the sum should sit near 1.0 during a transition.
    // `s.weights` is a list of [stateName, weight] pairs.
    const fades = this.fields.fades;
    const sig = s.weights.map(([, w]) => w.toFixed(2)).join(',');
    if (fades.dataset.sig !== sig) {
      fades.dataset.sig = sig;
      fades.innerHTML = s.weights
        .map(([name, w]) => `<div class="hud-fade"><span>${name}</span><div class="hud-meter"><i style="width:${(w * 100).toFixed(1)}%"></i></div><b>${w.toFixed(2)}</b></div>`)
        .join('');
    }

    // --- inactivity
    this._set('countdown', `${(s.inactivityRemaining / 1000).toFixed(1)}s`);
    this._meter('idleBar', s.inactivityProgress);
    this._set('boredCount', String(s.boredCount));

    // --- procedural
    this._set('blinkPhase', s.blinkPhase);
    this._meter('blinkBar', s.blinkValue);
    this._set('blinkCount', String(s.blinkCount));
    this._set('gaze', `${((s.gazeYaw * 180) / Math.PI).toFixed(1)}\u00b0 / ${((s.gazePitch * 180) / Math.PI).toFixed(1)}\u00b0`);
    this._set('eyeTrack', s.eyeTrack);
    this._set('petState', s.petting ? 'petted' : 'off');
    this._meter('petBar', s.petting ? 1 : s.squint || 0);

    // --- lip sync
    this._set('voiceMode', s.voiceMode);
    this._set('rms', s.rms.toFixed(3));
    for (const [key, bar] of Object.entries(this.visemeBars)) {
      const w = s.visemes?.[key] ?? 0;
      const pct = `${(Math.max(0, Math.min(1, w)) * 100).toFixed(0)}%`;
      if (bar.style.width !== pct) bar.style.width = pct;
    }

    // --- health: a non-zero count here means an update threw and was swallowed
    this._set('frameErrors', String(s.frameErrors ?? 0));

    // --- memory
    this._set('memoryNotes', String(s.memoryNotes ?? 0));
    this._set('memoryTurns', String(s.memoryTurns ?? 0));
  }
}
