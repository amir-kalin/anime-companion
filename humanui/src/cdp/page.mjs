// The page: one object exposing both grounding channels over one browser.
//
// This mirrors the vendor architecture exactly. A program gets a Playwright-like semantic surface
// (`click('Apply filters')`, `snapshot()`) *and* a PyAutoGUI-like perceptual surface
// (`mouse.click(x, y)`, `screenshot()`, `zoom(region)`), because a single sandbox that speaks both
// is what lets one model handle both well-described DOM and undescribable canvas.
//
// Three properties are enforced here rather than left to the caller, because all three are places
// this class of harness quietly breaks:
//
//  * Coordinates arriving from the model are in *screenshot* space. They are mapped through the
//    capture Frame before any event is dispatched.
//  * Every synthetic event goes through the real input pipeline (Input.dispatch*), not through
//    `element.click()`. A human's click is trusted and hits-tested; a synthetic DOM click is not,
//    so menus, overlays and hit-testing behave differently. Fidelity here is the point.
//  * Navigation is filtered through a URL parser and an allowlist, and re-checked after redirects,
//    because "the API doesn't filter the URLs Claude opens, so it can't reject one for you."

import { CdpSession, SessionHolder, listPageTargets, sleep } from './client.mjs';
import { captureRegion, captureViewport, settle, viewportSize } from './image.mjs';
import { isPrintable, keyDefinition, modifierMask, normalizeKey, textForKey } from './keys.mjs';

const HISTORY_KEYWORDS = new Set(['back', 'forward', 'reload']);

/**
 * Navigation policy.
 *
 * `allowHosts` of null means "any http(s) host", which is fine for a local sandbox and unsafe
 * anywhere else. Pass a list to lock the agent to specific origins.
 */
export class UrlPolicy {
  constructor({ allowHosts = null, allowSchemes = ['http:', 'https:'] } = {}) {
    this.allowHosts = allowHosts;
    this.allowSchemes = allowSchemes;
  }

  /**
   * Normalize and validate a navigation target.
   *
   * History keywords pass through. A bare host gets https://. Then the scheme is checked with a URL
   * parser rather than a string prefix, so `javascript:`, `file:`, `data:`, and
   * `https://ok.com\n@evil.com` style tricks are rejected on the parsed value, not the text.
   */
  resolve(raw) {
    const input = String(raw ?? '').trim();
    if (!input) throw new Error('navigate requires a url');

    if (HISTORY_KEYWORDS.has(input.toLowerCase())) return { kind: input.toLowerCase() };

    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input) ? input : `https://${input}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`Could not parse "${raw}" as a URL.`);
    }

    if (!this.allowSchemes.includes(url.protocol)) {
      throw new Error(
        `Refusing scheme ${url.protocol}. Only ${this.allowSchemes.join(' and ')} are allowed ` +
        `(a string-prefix check would be too weak here; this is parsed).`,
      );
    }

    if (this.allowHosts) {
      const host = url.hostname.toLowerCase();
      const ok = this.allowHosts.some((h) => {
        const needle = String(h).toLowerCase();
        return host === needle || host.endsWith(`.${needle}`);
      });
      if (!ok) {
        throw new Error(`Host ${url.hostname} is not in the allowlist: ${this.allowHosts.join(', ')}`);
      }
    }
    return { kind: 'url', url: url.href };
  }
}

/**
 * A short description of whatever is under a point.
 *
 * This is the payoff of running both channels: a coordinate click that would otherwise be blind gets
 * verified feedback ("hit <button id=apply>Apply filters</button>"), so the model can tell whether
 * its pixel estimate was right instead of inferring success from a later screenshot.
 */
async function describePoint(session, x, y) {
  const expr = `(() => {
    const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
    if (!el) return null;
    const label = el.getAttribute('aria-label') || el.textContent || '';
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      label: label.replace(/\\s+/g, ' ').trim().slice(0, 80) || null,
      rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(el.getBoundingClientRect()),
    };
  })()`;
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression: expr, returnByValue: true,
  });
  if (exceptionDetails) return null;
  const d = result.value;
  if (!d) return 'nothing';
  const bits = [`<${d.tag}`];
  if (d.id) bits.push(` id=${d.id}`);
  if (d.type) bits.push(` type=${d.type}`);
  if (d.role) bits.push(` role=${d.role}`);
  bits.push('>');
  let out = bits.join('');
  if (d.label) out += ` "${d.label}"`;
  return out;
}

export class Page {
  #session;
  #lastFrame = null;
  #port = null;
  #tabSignature = '';
  telemetry = [];

  constructor(session, {
    accessibility,
    urlPolicy = new UrlPolicy(),
    network = null,
    onRisk = null,
    onEvent = null,
    port = null,
  } = {}) {
    this.#session = session;
    this.#port = port;
    this.accessibility = accessibility;
    this.urlPolicy = urlPolicy;
    this.network = network;
    this.onRisk = onRisk;
    this.onEvent = onEvent ?? (() => {});
    this.mouse = makeMouse(this);
    this.keyboard = makeKeyboard(this);

    // Handles are scoped to a tab, so a swap invalidates every outstanding ref.
    if (session instanceof SessionHolder) {
      session.onSwap(() => {
        this.accessibility?.reset();
        this.#lastFrame = null;
        this.#tabSignature = '';
      });
    }
  }

  get session() { return this.#session; }

  #emit(event) {
    this.telemetry.push({ ...event, at: Date.now() });
    if (this.telemetry.length > 500) this.telemetry.shift();
    this.onEvent({ type: 'action', ...event });
  }

  /**
   * Ask the host whether an action may proceed.
   *
   * The interlock lives here, inside the executor, not around the model turn. Both vendors insist
   * on that placement, and both give the same reason: a single turn can carry several actions, so
   * a check outside the turn is both too coarse and too late.
   */
  async #gate(action) {
    if (!this.onRisk) return { allowed: true };
    const verdict = await this.onRisk(action);
    if (verdict && verdict.allowed === false) {
      const reason = verdict.reason ?? 'denied by operator';
      this.#emit({ kind: 'risk-denied', ...action, reason });
      throw new Error(`Blocked: ${reason}`);
    }
    return verdict ?? { allowed: true };
  }

  // ---------------------------------------------------------------- navigation

  async goto(rawUrl, { waitUntil = 'load', timeoutMs = 15000 } = {}) {
    const target = this.urlPolicy.resolve(rawUrl);

    if (target.kind === 'back' || target.kind === 'forward' || target.kind === 'reload') {
      const method = target.kind === 'reload' ? 'Page.reload' : 'Page.navigateToHistoryEntry';
      if (target.kind === 'reload') {
        await this.#session.send('Page.reload', {});
      } else {
        const { currentIndex, entries } = await this.#session.send('Page.getNavigationHistory');
        const idx = target.kind === 'back' ? currentIndex - 1 : currentIndex + 1;
        if (idx < 0 || idx >= entries.length) throw new Error(`No ${target.kind} entry in history.`);
        await this.#session.send(method, { entryId: entries[idx].id });
      }
    } else {
      await this.gotoUnvalidated(target.url, { waitUntil, timeoutMs });
    }

    this.accessibility.reset();
    await this.#afterLoad(timeoutMs);
    const url = await this.url();
    // Re-check after redirects: the host we land on is the one that matters. The network guard also
    // covers each hop, but a defence that depends on interception being enabled is a single point
    // of failure, so the post-navigation check stays.
    this.urlPolicy.resolve(url);
    return { url, title: await this.title() };
  }

  /**
   * Network decisions the guard made during this session.
   *
   * Surfaced rather than swallowed, because "the browser could not reach X" and "the page silently
   * rendered without X" look identical to an agent working from a screenshot.
   */
  networkReport() {
    return this.network
      ? {
          allowed: this.network.stats.allowed,
          blocked: this.network.stats.blocked,
          degraded: this.network.stats.degraded,
          error: this.network.stats.error,
          blockedRequests: [...this.network.stats.blockedRequests],
        }
      : { allowed: 0, blocked: 0, degraded: true, error: 'no network guard attached', blockedRequests: [] };
  }

  /** Internal: navigate to a URL already validated by the policy. */
  async gotoUnvalidated(url, { waitUntil = 'load', timeoutMs = 15000 } = {}) {
    const loaded = waitUntil === 'load'
      ? this.#session.once((m) => m === 'Page.loadEventFired', timeoutMs)
      : Promise.resolve();
    await this.#session.send('Page.navigate', { url });
    await loaded.catch(() => { /* fall through to the error-document check below */ });

    // A failed navigation does not reject `Page.navigate`. Chrome substitutes an error document whose
    // URL is `chrome-error://chromewebdata/`, so without this check the caller sees an unrelated
    // "refusing scheme" error from the post-navigation policy check — which points at the wrong cause
    // entirely. This is what a blocked request, a DNS failure, and an offline machine all look like.
    const landed = await this.url().catch(() => null);
    if (landed && landed.startsWith('chrome-error:')) {
      const detail = await this.evaluate(
        'document.body ? document.body.innerText.slice(0, 200) : ""',
      ).catch(() => '');
      throw new Error(
        `Navigation to ${url} failed at the network layer` +
        (detail ? `: ${detail.replace(/\s+/g, ' ').trim().slice(0, 160)}` : '.'),
      );
    }
  }

  /**
   * List the open page targets, marking which one this session is attached to.
   *
   * The model needs this because a click can move the user somewhere the harness is not looking. Any
   * agent that ignores tabs will happily report the state of a document the user has navigated away
   * from.
   */
  async tabs() {
    if (!this.#port) return [];
    const targets = await listPageTargets(this.#port).catch(() => []);
    const attached = await this.url().catch(() => null);
    const signature = targets.map((t) => `${t.id}:${t.url}`).join('|');

    if (signature !== this.#tabSignature) {
      const previous = this.#tabSignature;
      this.#tabSignature = signature;
      if (previous !== '') {
        this.#emit({
          kind: 'tabs.changed',
          tabs: targets.map((t, i) => ({ index: i, url: t.url, title: t.title })),
          attachedTo: attached,
        });
      }
    }

    return targets.map((t, i) => ({
      index: i,
      id: t.id,
      url: t.url,
      title: t.title,
      attached: attached !== null && t.url === attached,
    }));
  }

  /**
   * Attach to a different tab.
   *
   * Requires a swappable session; a raw CdpSession is bound to one target for life, which is exactly
   * the constraint this method exists to work around.
   */
  async switchTab(indexOrUrl) {
    if (!(this.#session instanceof SessionHolder)) {
      throw new Error('switchTab needs a swappable session; the harness was started without one.');
    }
    const targets = await listPageTargets(this.#port);
    const target = typeof indexOrUrl === 'number'
      ? targets[indexOrUrl]
      : targets.find((t) => t.url === indexOrUrl || t.url.startsWith(String(indexOrUrl)));

    if (!target) {
      throw new Error(`No tab matches ${JSON.stringify(indexOrUrl)}. Open tabs: ${
        targets.map((t, i) => `${i}=${t.url}`).join(', ') || '(none)'}`);
    }
    if (!target.wsUrl) throw new Error(`Tab ${target.url} exposes no debugger URL.`);

    const raw = await CdpSession.connect(target.wsUrl);
    await SessionHolder.attach(raw);
    await this.#session.replace(raw);

    const viewport = await viewportSize(this.#session).catch(() => null);
    if (viewport) {
      await this.#session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
      }).catch(() => {});
    }

    this.#emit({ kind: 'tabs.switched', url: target.url, title: target.title });
    return { url: await this.url(), title: await this.title() };
  }

  /** Close a tab by index. Closing the attached tab is refused rather than left to strand the session. */
  async closeTab(index) {
    if (!this.#port) throw new Error('closeTab needs the browser port.');
    const targets = await listPageTargets(this.#port);
    const target = targets[index];
    if (!target) throw new Error(`No tab at index ${index}.`);
    if (target.url === (await this.url().catch(() => null))) {
      throw new Error('Refusing to close the tab this session is attached to; switch away first.');
    }
    await fetch(`http://127.0.0.1:${this.#port}/json/close/${target.id}`);
    this.#emit({ kind: 'tabs.closed', url: target.url });
    return { closed: target.url, remaining: (await this.tabs()).length };
  }

  /**
   * Is the environment still there?
   *
   * The docs warn that "the API conversation and the execution environment have separate state" and
   * that continuing a response "does not restore a browser session, login state, or runtime
   * variables." So the loop checks this every turn instead of assuming a long conversation implies
   * a live page. A crash here is reported, not silently absorbed into the next failed action.
   */
  async isAlive() {
    try {
      const { result, exceptionDetails } = await this.#session.send('Runtime.evaluate', {
        expression: 'document.readyState', returnByValue: true,
      });
      return !exceptionDetails && typeof result.value === 'string';
    } catch {
      return false;
    }
  }

  /** Describe what the environment is currently showing, for the operator UI and event log. */
  async describe() {
    const [url, title] = await Promise.all([this.url(), this.title().catch(() => '')]);
    return { url, title };
  }

  async #afterLoad(timeoutMs) {
    await this.#session.send('Emulation.setDeviceMetricsOverride', {
      ...(await viewportSize(this.#session)), deviceScaleFactor: 1, mobile: false,
    });
    await settle(this.#session);
  }

  async url() {
    const { result } = await this.#session.send('Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    });
    return result.value;
  }

  async title() {
    const { result } = await this.#session.send('Runtime.evaluate', {
      expression: 'document.title', returnByValue: true,
    });
    return result.value;
  }

  // ---------------------------------------------------------------- observation

  /** The semantic channel. Returns the a11y listing plus a handle-resolution helper. */
  async snapshot(options = {}) {
    const listing = await this.accessibility.read(options);
    this.#emit({ kind: 'snapshot', nodes: listing.nodeCount });
    return {
      ...listing,
      resolve: (ref) => this.accessibility.resolveRef(ref),
    };
  }

  async waitForName(text, options = {}) {
    return this.accessibility.waitForName(text, options);
  }

  /** The perceptual channel. Captures the viewport through a Frame that owns the coord mapping. */
  async screenshot(options = {}) {
    const frame = options.region
      ? await captureRegion(this.#session, options.region, options)
      : await captureViewport(this.#session, options);
    this.#lastFrame = frame;
    this.#emit({ kind: 'screenshot', detail: frame.describe() });
    return frame;
  }

  /**
   * Native-resolution crop of a region.
   *
   * A zoom does not move the coordinate frame: the model keeps emitting full-viewport coordinates
   * afterwards, so `Frame.toViewport` remains relative to the whole viewport. That is the vendor
   * rule, and honoring it is why `page.mouse.click` needs no special zoom handling.
   */
  async zoom(region, options = {}) {
    return this.screenshot({ ...options, region });
  }

  /**
   * Map a coordinate the model produced into viewport CSS pixels.
   *
   * Delegates to the last captured Frame, which knows both the scale that was applied and which
   * space the model's numbers are in. With no capture yet there is nothing to correct for.
   */
  #viewportPoint(x, y) {
    if (!this.#lastFrame) return { x, y };
    return this.#lastFrame.fromModel(x, y);
  }

  async text() {
    const { result } = await this.#session.send('Runtime.evaluate', {
      expression: `(document.body ? document.body.innerText : '').slice(0, 20000)`,
      returnByValue: true,
    });
    return result.value ?? '';
  }

  /** Run an expression in the page. Read-only by convention; the sandbox decides what is allowed. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.#session.send('Runtime.evaluate', {
      expression: String(expression), returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  // ---------------------------------------------------------------- targeting

  /**
   * Resolve any supported target form to a viewport point, recording which channel served it.
   *
   * Accepted forms:
   *   'ref_3'                  handle from snapshot()      -> semantic
   *   { ref: 'ref_3' }         same                        -> semantic
   *   { role: 'button', name: 'Apply filters' }           -> semantic (name lookup)
   *   '#submit' / 'button.ok'  CSS selector                -> semantic
   *   { x: 405, y: 157 }       screenshot pixels           -> perceptual
   */
  async resolveTarget(target) {
    const backendNodeId = await this.#backendNodeFor(target);
    if (backendNodeId !== null) {
      const box = await this.#boxOf(backendNodeId);
      if (box) {
        const [name, node] = await Promise.all([
          this.#axName(backendNodeId),
          this.#describeNode(backendNodeId),
        ]);
        return {
          point: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          channel: 'semantic',
          via: describeTargetForm(target),
          ref: this.accessibility.refFor(backendNodeId),
          backendNodeId,
          name,
          node,
        };
      }
      // A handle that resolves but has no box must fall back to pixels, exactly as the vendor
      // guidance describes for content the tree cannot describe.
    }

    if (target && typeof target === 'object' && Number.isFinite(target.x) && Number.isFinite(target.y)) {
      const point = this.#viewportPoint(target.x, target.y);
      return {
        point,
        channel: 'perceptual',
        via: 'coordinate',
        name: null,
        node: await describePoint(this.#session, point.x, point.y),
      };
    }

    throw new Error(
      `Could not resolve target ${JSON.stringify(target)}. Pass a ref from snapshot(), a selector, ` +
      `or {x, y} in screenshot pixels.`,
    );
  }

  /**
   * The node's accessible name, as the browser computes it.
   *
   * Worth an extra round trip: approval prompts and action logs read far better with "Delete
   * everything" than with `<button id=wipe type=button>`, and the browser's own name computation
   * already accounts for aria-label, label association, and text content.
   */
  async #axName(backendNodeId) {
    try {
      const { nodes } = await this.#session.send('Accessibility.getPartialAXTree', {
        backendNodeId, fetchRelatives: false,
      });
      const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId) ?? nodes[0];
      return (node?.name?.value ?? '').replace(/\s+/g, ' ').trim() || null;
    } catch {
      return null;
    }
  }

  async #backendNodeFor(target) {
    if (typeof target === 'string') {
      if (/^ref_\d+$/.test(target)) return this.accessibility.resolveRef(target);
      return this.#backendNodeForSelector(target);
    }
    if (target && typeof target === 'object') {
      if (typeof target.ref === 'string') return this.accessibility.resolveRef(target.ref);
      if (typeof target.selector === 'string') return this.#backendNodeForSelector(target.selector);
      if (target.role) {
        const listing = await this.accessibility.read({ filter: 'interactive' });
        const needle = `${target.role} "${target.name ?? ''}"`;
        const line = listing.text.split('\n').find((l) => l.startsWith(needle) || l.includes(needle));
        const m = line && /\[(ref_\d+)\]/.exec(line);
        return m ? this.accessibility.resolveRef(m[1]) : null;
      }
    }
    return null;
  }

  async #backendNodeForSelector(selector) {
    const { root } = await this.#session.send('DOM.getDocument', { depth: -1 });
    try {
      const { nodeId } = await this.#session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) return null;
      const described = await this.#session.send('DOM.describeNode', { nodeId });
      return described.node.backendNodeId ?? null;
    } catch {
      return null;
    }
  }

  async #boxOf(backendNodeId) {
    try {
      const { model } = await this.#session.send('DOM.getBoxModel', { backendNodeId });
      const q = model.border;
      const x = Math.min(q[0], q[2], q[4], q[6]);
      const y = Math.min(q[1], q[3], q[5], q[7]);
      return {
        x,
        y,
        width: Math.max(q[0], q[2], q[4], q[6]) - x,
        height: Math.max(q[1], q[3], q[5], q[7]) - y,
      };
    } catch {
      return null;
    }
  }

  async #describeNode(backendNodeId) {
    try {
      const { node } = await this.#session.send('DOM.describeNode', { backendNodeId });
      const tag = node.nodeName.toLowerCase();
      // CDP returns `attributes` as a flat [name, value, name, value, ...] array, not as pairs.
      // Flattening it naively loses every id, which is what makes a node recognizable in a log.
      const attrs = node.attributes ?? [];
      const pairs = [];
      for (let i = 0; i + 1 < attrs.length; i += 2) pairs.push(`${attrs[i]}=${attrs[i + 1]}`);
      const useful = pairs.filter((p) => /^(id|role|type|name|aria-label)=/.test(p));
      return `<${tag}${useful.length ? ' ' + useful.join(' ') : ''}>`;
    } catch {
      return null;
    }
  }

  /** Bring a node into view, then return its post-scroll box. */
  async #scrollIntoView(backendNodeId) {
    try {
      await this.#session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
      await sleep(60);
    } catch { /* not scrollable; keep going */ }
    return this.#boxOf(backendNodeId);
  }

  // ---------------------------------------------------------------- actions

  /**
   * Bring a resolved target into view and click it.
   *
   * Shared by click, fill, and selectOption because all three are "the user reaches for this
   * control": scrolling first, then clicking its current position. Doing this per-method is how
   * `fill` ended up typing into nothing on a scrolled page while `click` worked fine.
   */
  async #reachTarget(resolved) {
    if (resolved.channel === 'semantic' && resolved.backendNodeId != null) {
      const box = await this.#scrollIntoView(resolved.backendNodeId);
      if (box) resolved.point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    await this.#dispatchMouse({ ...resolved.point, button: 'left', clickCount: 1 });
    return resolved;
  }

  async click(target, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
    const resolved = await this.resolveTarget(target);

    // Scroll before measuring, for every semantic form. Gating this on `ref` meant a selector or a
    // {role, name} target was clicked at its pre-scroll coordinates — which silently misses anything
    // below the fold, and reports success while nothing happened.
    if (resolved.channel === 'semantic' && resolved.backendNodeId != null) {
      const box = await this.#scrollIntoView(resolved.backendNodeId);
      if (box) resolved.point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    await this.#gate({
      kind: 'click',
      channel: resolved.channel,
      via: resolved.via,
      name: resolved.name,
      node: resolved.node,
      target: resolved.ref ?? resolved.point,
    });

    await this.#dispatchMouse({ ...resolved.point, button, clickCount, modifiers });
    await this.#afterAct();
    return this.#report('click', resolved, resolved.point);
  }

  async #dispatchMouse({ x, y, button = 'left', clickCount = 1, modifiers = [], buttons = null }) {
    const buttonCode = { left: 1, middle: 2, right: 3 }[button] ?? 1;
    const mask = modifierMask(modifiers);
    const activeButtons = buttons ?? buttonCode;

    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, modifiers: mask, buttons: 0,
    });
    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, buttons: activeButtons, clickCount, modifiers: mask,
    });
    if (clickCount === 2) {
      await this.#session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, modifiers: mask,
      });
      await this.#session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, buttons: activeButtons, clickCount: 2, modifiers: mask,
      });
    }
    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers: mask,
    });
  }

  async move(point) {
    const p = this.#viewportPoint(point.x, point.y);
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 });
    return p;
  }

  async drag(from, to, { steps = 12 } = {}) {
    const a = this.#viewportPoint(from.x, from.y);
    const b = this.#viewportPoint(to.x, to.y);
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 });
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.#session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, buttons: 1,
      });
    }
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
    this.#emit({ kind: 'drag', from: a, to: b });
    return { from: a, to: b };
  }

  async scroll({ x = 0, y = 0, at = null } = {}) {
    let point = null;
    if (at) point = this.#viewportPoint(at.x, at.y);
    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: point?.x ?? 10, y: point?.y ?? 10, deltaX: x, deltaY: y, buttons: 0,
    });
    await this.#afterAct();
    this.#emit({ kind: 'scroll', deltaX: x, deltaY: y, at: point });
    return { deltaX: x, deltaY: y };
  }

  async type(text, { delayMs = 0 } = {}) {
    const value = String(text ?? '');
    await this.#gate({ kind: 'type', length: value.length, sample: value.slice(0, 40) });
    for (const ch of value) {
      await this.#typeChar(ch);
      if (delayMs) await sleep(delayMs);
    }
    this.#emit({ kind: 'type', length: value.length });
    return { typed: value.length };
  }

  async #typeChar(ch) {
    if (ch === '\n' || ch === '\r') return this.press('Enter');
    if (ch === '\t') return this.press('Tab');

    if (isPrintable(ch)) {
      // keyDown with `text` produces a real keydown + keypress + input sequence, which is what a
      // human generates. insertText alone would skip keydown and break any UI that listens for it.
      await this.#dispatchKey('keyDown', ch, 0);
      await this.#dispatchKey('keyUp', ch, 0);
      return undefined;
    }

    // Non-ASCII has no meaningful virtual key code; insertText is the correct path.
    await this.#session.send('Input.insertText', { text: ch });
    return undefined;
  }

  /** Dispatch exactly one key event. Modifiers are reported in the bitmask only. */
  async #dispatchKey(type, keyName, mask) {
    const def = keyDefinition(keyName);
    const text = type === 'keyUp' ? '' : textForKey(def.key);
    const payload = {
      type: text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code || undefined,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.nativeVirtualKeyCode,
      modifiers: mask,
    };
    if (text) {
      payload.text = text;
      payload.unmodifiedText = text;
    }
    await this.#session.send('Input.dispatchKeyEvent', payload);
  }

  /**
   * Press a key or a `+`-joined chord.
   *
   * Modifiers are dispatched as their own real keyDown/keyUp pairs, not just flagged in the
   * `modifiers` bitmask. That distinction is not cosmetic: with the bitmask alone, Chromium stays
   * out of the modifier state and `ctrl+a` inserts a literal "a" instead of selecting all, so a
   * fill-style helper silently appends instead of replacing. Playwright's `keyboard.down` sends
   * real events for the same reason.
   */
  async press(key, { repeat = 1 } = {}) {
    const parts = String(key).split('+').map((part) => part.trim()).filter(Boolean);
    const main = parts.pop();
    const modifiers = parts.map(normalizeKey);
    const mainKey = keyDefinition(main).key;

    for (let i = 0; i < repeat; i++) {
      let mask = 0;
      for (const mod of modifiers) {
        await this.#dispatchKey('keyDown', mod, mask);
        mask |= modifierMask([mod]);
      }
      await this.#dispatchKey('keyDown', main, mask);
      await this.#dispatchKey('keyUp', main, mask);
      for (const mod of [...modifiers].reverse()) {
        await this.#dispatchKey('keyUp', mod, mask);
        mask &= ~modifierMask([mod]);
      }
    }
    this.#emit({ kind: 'press', key: mainKey, repeat });
    return { key: mainKey, repeat };
  }

  /**
   * Choose an option in a native `<select>`.
   *
   * This one control does NOT go through synthetic keystrokes, and that is deliberate. Measured in
   * this browser, a headless select ignores `ArrowDown` for its committed value (only `Enter`
   * applies the highlighted option) and ignores type-ahead entirely, so a key-driven approach either
   * lands on an arbitrary option or silently does nothing. Playwright's `selectOption` sidesteps the
   * same problem the same way: set the value, then dispatch `input` and `change`.
   *
   * The click is still dispatched as a real mouse event first, so focus lands where a user's would
   * and any focus-dependent behaviour still runs. See probe/probe-select.mjs for the measurements.
   */
  async selectOption(target, value) {
    const resolved = await this.resolveTarget(target);
    await this.#gate({
      kind: 'select',
      channel: resolved.channel,
      name: resolved.name,
      node: resolved.node,
      target: resolved.ref ?? resolved.point,
    });
    await this.#reachTarget(resolved);

    const wanted = JSON.stringify(String(value));
    const applied = await this.evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'SELECT') {
        return { ok: false, reason: 'focus did not land on a <select> (got ' + (el ? el.tagName : 'nothing') + ')' };
      }
      const before = el.value;
      el.value = ${wanted};
      if (el.value !== ${wanted}) {
        const options = [...el.options].map((o) => o.value);
        return { ok: false, reason: 'no option with value ' + ${wanted}, before, options };
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, before, after: el.value };
    })()`);

    if (!applied?.ok) {
      throw new Error(`selectOption failed: ${applied?.reason ?? 'unknown error'}`);
    }

    await this.#afterAct();
    const record = this.#report('selectOption', resolved, resolved.point);
    return { ...record, value: applied.after, previous: applied.before };
  }

  /** Focus a field then type into it, via the real keyboard path. */
  async fill(target, text) {
    const resolved = await this.resolveTarget(target);
    await this.#gate({
      kind: 'fill',
      channel: resolved.channel,
      name: resolved.name,
      node: resolved.node,
      target: resolved.ref ?? resolved.point,
    });
    await this.#reachTarget(resolved);

    // Clear existing content the way a user does: select-all, then overwrite.
    await this.press('ctrl+a');
    await this.press('Delete');
    await this.type(text);
    await this.#afterAct();
    return this.#report('fill', resolved, resolved.point);
  }

  async #afterAct() {
    await settle(this.#session, 80, 1500);
    // A click can open a popup. Detect it here, where the change actually happens, rather than
    // hoping the model notices from a screenshot of a page it is no longer looking at.
    if (this.#port) await this.tabs().catch(() => {});
  }

  #report(action, resolved, point) {
    const record = {
      action,
      channel: resolved.channel,
      via: resolved.via,
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      node: resolved.node,
    };
    this.#emit(record);
    return record;
  }
}

function describeTargetForm(target) {
  if (typeof target === 'string') return /^ref_\d+$/.test(target) ? 'ref' : 'selector';
  if (target && typeof target === 'object') {
    if (target.ref) return 'ref';
    if (target.selector) return 'selector';
    if (target.role) return 'role+name';
  }
  return 'unknown';
}

/** PyAutoGUI-shaped raw pointer control, in screenshot pixels. */
function makeMouse(page) {
  return {
    click: (x, y, opts = {}) => page.click({ x, y }, opts),
    doubleClick: (x, y, opts = {}) => page.click({ x, y }, { ...opts, clickCount: 2 }),
    move: (x, y) => page.move({ x, y }),
    drag: (from, to, opts) => page.drag(from, to, opts),
    wheel: (deltaX, deltaY, at) => page.scroll({ x: deltaX, y: deltaY, at }),
  };
}

/** PyAutoGUI-shaped raw keyboard control. */
function makeKeyboard(page) {
  return {
    type: (text, opts) => page.type(text, opts),
    press: (key, opts) => page.press(key, opts),
    /** Alias matching the vendor's `key` member name. */
    key: (key, opts) => page.press(key, opts),
  };
}