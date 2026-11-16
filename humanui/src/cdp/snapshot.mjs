// The semantic channel: the page's accessibility tree as a flat, speakable listing with handles.
//
// This is the `read_page` idea from Anthropic's browser toolset:
//
//     link "Documentation" [ref_1]
//     textbox "Search docs" [ref_3]
//     button "Search" [ref_4]
//
// Two deliberate differences:
//
//  1. Every line also carries its viewport box. The vendor format omits geometry because their
//     executor knows it; here it lets a program reason about *both* channels from one read, which
//     is the whole point of the harness.
//  2. Nodes with no usable geometry are still listed, explicitly flagged. The vendor guidance is
//     "fall back to coordinates for content the tree doesn't describe" — surfacing *which* nodes
//     those are makes that decision available to the program instead of leaving it to guesswork.
//
// Handles are derived from `backendDOMNodeId`, which is stable across layout shifts and reflow.
// That is the property the docs credit references with: "A reference survives layout shifts and
// reflows that make pixel coordinates fragile."

import { sleep } from './client.mjs';

/** Roles worth surfacing even without a name, because they are actionable by nature. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton',
  'switch', 'button', 'DisclosureTriangle', 'treeitem', 'gridcell', 'cell', 'row', 'columnheader',
  'rowheader', 'toolbar', 'menubar', 'tablist', 'progressbar', 'meter',
]);

/** Roles that describe page structure and help the model orient. */
const STRUCTURAL_ROLES = new Set([
  'heading', 'image', 'img', 'banner', 'navigation', 'main', 'complementary', 'contentinfo',
  'form', 'region', 'article', 'list', 'listitem', 'group', 'dialog', 'alert', 'status',
  'table', 'RowGroup', 'figure', 'Log', 'Document', 'application',
]);

/** Chrome's AX engine names plain text nodes "StaticText"; some builds say "text". */
const TEXT_ROLES = new Set(['StaticText', 'text']);

function axValue(node, prop) {
  const found = (node.properties ?? []).find((p) => p.name === prop);
  return found?.value?.value;
}

/** Concurrency-limited map, so a wide tree does not open 200 sockets at once. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Reads and caches the accessibility tree for one navigation generation.
 *
 * Handles are NOT renumbered between reads. The docs are explicit: "Don't renumber references
 * you've already handed out for a tab until it navigates, because that silently invalidates
 * references Claude still holds." So `ref_N` keeps meaning the same node until the page navigates.
 */
export class AccessibilityIndex {
  #session;
  #generation = 0;
  #byBackendId = new Map();   // backendDOMNodeId -> ref name, survives repeat reads
  #byRef = new Map();         // ref name -> backendDOMNodeId
  #boxCache = new Map();      // backendDOMNodeId -> box | null
  #nextRef = 1;

  constructor(session) {
    this.#session = session;
  }

  get generation() {
    return this.#generation;
  }

  /** Called on navigation, which invalidates every outstanding handle. */
  reset() {
    this.#generation++;
    this.#byBackendId.clear();
    this.#byRef.clear();
    this.#boxCache.clear();
  }

  /** Look up a handle without re-reading the tree. Returns null when it is stale. */
  resolveRef(refName) {
    const backendNodeId = this.#byRef.get(refName);
    return backendNodeId === undefined ? null : backendNodeId;
  }

  refFor(backendNodeId) {
    return this.#byBackendId.get(backendNodeId) ?? null;
  }

  #assignRef(backendNodeId) {
    const existing = this.#byBackendId.get(backendNodeId);
    if (existing) return existing;
    const ref = `ref_${this.#nextRef++}`;
    this.#byBackendId.set(backendNodeId, ref);
    this.#byRef.set(ref, backendNodeId);
    return ref;
  }

  /** Viewport-space border box, or null when the node has no layout box. */
  async #boxFor(backendNodeId) {
    if (this.#boxCache.has(backendNodeId)) return this.#boxCache.get(backendNodeId);
    let box = null;
    try {
      // Verified convention: CDP box quads are viewport-relative and match
      // getBoundingClientRect(), so no scroll correction is applied. See probe-boxmodel.mjs.
      const { model } = await this.#session.send('DOM.getBoxModel', { backendNodeId });
      const q = model.border;
      const x = Math.min(q[0], q[2], q[4], q[6]);
      const y = Math.min(q[1], q[3], q[5], q[7]);
      const width = Math.max(q[0], q[2], q[4], q[6]) - x;
      const height = Math.max(q[1], q[3], q[5], q[7]) - y;
      if (Number.isFinite(x) && Number.isFinite(y)) box = { x, y, width, height };
    } catch {
      box = null; // detached or not laid out
    }
    this.#boxCache.set(backendNodeId, box);
    return box;
  }

  /**
   * Collect a node and everything beneath it, using the AX tree's own child links.
   *
   * Walking childIds rather than re-querying with a DOM traversal keeps the accessibility semantics the
   * browser computed — name from aria-label, from a label element, from text content — instead of
   * reimplementing them and getting the edge cases wrong.
   */
  async #subtreeOf(nodes, backendNodeId) {
    const byBackend = new Map();
    const byAxId = new Map();
    for (const node of nodes) {
      if (node.backendDOMNodeId !== undefined) byBackend.set(node.backendDOMNodeId, node);
      if (node.nodeId) byAxId.set(node.nodeId, node);
    }

    const root = byBackend.get(backendNodeId);
    if (!root) return null;

    const collected = [];
    const seen = new Set();
    const queue = [root];

    while (queue.length) {
      const node = queue.shift();
      const key = node.nodeId ?? node.backendDOMNodeId;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(node);
      for (const childId of node.childIds ?? []) {
        const child = byAxId.get(childId);
        if (child) queue.push(child);
      }
      if (collected.length > 4000) break; // pathological tree guard
    }
    return collected;
  }

  /**
 * Build a listing of the current page.
 *
 * `filter`:
 *   'interactive' — only actionable nodes. Cheaper than a screenshot and enough when the
 *                   program just needs to find a control to act on.
 *   'all'         — also named structural and text nodes. Use for orientation.
 *
 * `ref` scopes the read to one container's subtree, which is how a large page gets read in pieces.
 * The top-level listing truncates at `maxNodes`; without a way to descend, the tail of a long document
 * is simply invisible, and "not shown" reads a lot like "not there".
 */
async read({ filter = 'interactive', maxNodes = 120, ref = null } = {}) {
    const { nodes } = await this.#session.send('Accessibility.getFullAXTree');

    let pool = nodes;
    if (ref) {
      const backendNodeId = this.resolveRef(ref);
      if (backendNodeId === null) {
        return {
          generation: this.#generation,
          url: '', title: '',
          text: `ref ${ref} is stale or unknown on this tab. Re-read the page for fresh handles.`,
          nodeCount: 0, truncated: false, pixelOnly: [], error: 'stale_ref',
        };
      }
      pool = await this.#subtreeOf(nodes, backendNodeId);
      if (pool === null) {
        return {
          generation: this.#generation,
          url: '', title: '',
          text: `Could not collect the subtree under ${ref}.`,
          nodeCount: 0, truncated: false, pixelOnly: [], error: 'subtree_unavailable',
        };
      }
    }

    const candidates = pool.filter((node) => {
      if (node.ignored) return false;
      if (node.backendDOMNodeId === undefined) return false;
      const role = node.role?.value ?? '';
      const name = node.name?.value ?? '';
      if (INTERACTIVE_ROLES.has(role)) return true;
      if (filter === 'interactive') return false;
      if (STRUCTURAL_ROLES.has(role)) return true;
      if (TEXT_ROLES.has(role)) return name.length > 0 && name.length <= 160;
      return false;
    });

    const shown = candidates.slice(0, maxNodes);
    const enriched = await mapLimit(shown, 8, async (node) => {
      const ref = this.#assignRef(node.backendDOMNodeId);
      const box = await this.#boxFor(node.backendDOMNodeId);
      return { node, ref, box };
    });

    const lines = [];
    const pixelOnly = [];

    for (const { node, ref, box } of enriched) {
      const role = node.role?.value ?? 'unknown';
      const name = (node.name?.value ?? '').replace(/\s+/g, ' ').trim();
      const value = axValue(node, 'value');
      const checked = axValue(node, 'checked');
      const disabled = axValue(node, 'disabled');
      const focused = axValue(node, 'focused');

      const parts = [];
      if (name) parts.push(JSON.stringify(name));
      if (value !== undefined && value !== '' && value !== name) parts.push(`value=${JSON.stringify(String(value))}`);
      if (checked !== undefined) parts.push(`checked=${checked}`);
      if (disabled) parts.push('disabled');
      if (focused) parts.push('focused');

      const head = `${role}${parts.length ? ' ' + parts.join(' ') : ''}`;
      const geometry = box
        ? `(${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)})`
        : '(no box: click by coordinate)';

      lines.push(`${head} [${ref}] ${geometry}`);

      // Record what the tree cannot describe. These are precisely the surfaces the vendor docs
      // say need the pixel channel: canvas, video, remote desktop, virtualized lists.
      if (!box && (INTERACTIVE_ROLES.has(role) || /canvas|video|application/i.test(role))) {
        pixelOnly.push(`${role}${name ? ` "${name}"` : ''}`);
      }
    }

    const url = await this.#session.send('Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    }).then((r) => r.result.value).catch(() => '');

    const title = await this.#session.send('Runtime.evaluate', {
      expression: 'document.title', returnByValue: true,
    }).then((r) => r.result.value).catch(() => '');

    const truncated = candidates.length > shown.length;

    // When the listing is cut short, say so *and* say how to continue. A bare truncation flag is
    // invisible to a model reading text, and a silently shortened document reads exactly like a
    // complete one.
    const body = lines.join('\n');
    const trailer = truncated
      ? `\n… ${candidates.length - shown.length} more nodes were not shown. ` +
        'Re-read with { ref } using a container handle from this listing, or raise maxNodes.'
      : '';

    return {
      generation: this.#generation,
      url,
      title,
      text: body + trailer,
      nodeCount: shown.length,
      totalNodes: candidates.length,
      truncated,
      pixelOnly,
    };
  }

  /** Poll until a node whose accessible name contains `text` appears. */
  async waitForName(text, { timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const needle = text.toLowerCase();
    while (Date.now() < deadline) {
      const listing = await this.read({ filter: 'all' });
      const hit = listing.text.split('\n').find((l) => l.toLowerCase().includes(needle));
      if (hit) {
        const m = /\[(ref_\d+)\]/.exec(hit);
        return m ? { ref: m[1], line: hit } : { ref: null, line: hit };
      }
      await sleep(150);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for an element named "${text}".`);
  }
}