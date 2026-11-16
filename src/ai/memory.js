/**
 * MemoryClient
 *
 * Thin client for the server-side memory file. The server owns the document, so
 * this never writes directly - it reports what she has remembered and posts new
 * exchanges to be recorded.
 *
 * The memory file lives on disk (data/memory.json), so it survives a browser
 * restart, a crash and a machine reboot.
 */
import { apiUrl } from '../utils/connection.js';

export class MemoryClient {
  constructor({ endpoint = '/api/memory' } = {}) {
    this.endpoint = endpoint;
    this.notes = [];
    this.events = [];
    this.turns = 0;
    this.available = null;
  }

  /**
   * Fetch the stored memory.
   *
   * A failure leaves `available` as null ("unknown"), NOT false. This mirrors
   * ChatClient, and for the same reason: the dev server can be briefly
   * unreachable (a Vite config change restarts it, the port is still settling
   * after a reboot), and latching `false` on the first failure used to disable
   * every later `record()` for the rest of the session - so she silently stopped
   * remembering, which is the one thing a memory system must not do quietly.
   */
  async load() {
    try {
      const r = await fetch(apiUrl(this.endpoint), { cache: 'no-store' });
      if (!r.ok) throw new Error(`memory ${r.status}`);
      const j = await r.json();
      this.notes = j.notes || [];
      this.events = j.events || [];
      this.turns = j.turns || 0;
      this.available = true;
      return j;
    } catch (e) {
      this.available = null;
      this.lastError = e.message;
      return { notes: [], events: [], turns: 0 };
    }
  }

  /**
   * Post a finished exchange. Fire-and-forget: never delay the reply.
   *
   * Retries once on a transport failure, because the usual cause is the dev
   * server restarting under us rather than memory being broken.
   */
  async record(user, mika) {
    if (this.available === false) return null;
    const body = JSON.stringify({ user, mika });
    const send = async () => {
      const r = await fetch(apiUrl(this.endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!r.ok) throw new Error(`memory ${r.status}`);
      return r.json();
    };
    try {
      const j = await this._withRetry(send);
      this.available = true;
      // The server may have distilled in the background; refresh so the HUD and
      // any UI stay honest about what she knows.
      this.notes = j.notes || this.notes;
      this.events = j.events || this.events;
      this.turns = j.turns || this.turns;
      return j;
    } catch (e) {
      // Unknown, not unavailable: a transport failure here is almost always the
      // dev server restarting, and the next turn should try again.
      this.available = null;
      this.lastError = e.message;
      return null;
    }
  }

  /**
   * One retry, after a short pause.
   *
   * The common cause of a single failed write is the dev server bouncing (a
   * Vite config edit restarts it), which is transient. Without this, a turn
   * during that window is lost for good.
   */
  async _withRetry(fn) {
    try {
      return await fn();
    } catch (first) {
      // A rejected status is a real answer from a live server, not a blip, so
      // only retry transport-level failures.
      if (/\bmemory \d{3}\b/.test(first.message)) throw first;
      await new Promise((r) => setTimeout(r, 600));
      return await fn();
    }
  }

  /** Record something that happened rather than something said. */
  async event(what) {
    if (this.available === false) return null;
    try {
      const r = await fetch(apiUrl(this.endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: what }),
      });
      const j = r.ok ? await r.json() : null;
      if (j?.events) this.events = j.events;
      return j;
    } catch {
      return null;
    }
  }

  async clear() {
    const r = await fetch(apiUrl(this.endpoint), { method: 'DELETE' });
    const j = r.ok ? await r.json() : null;
    this.notes = j?.doc?.notes || [];
    this.events = j?.doc?.events || [];
    this.turns = 0;
    return j;
  }

  get summary() {
    if (this.available === false) return 'memory off';
    if (!this.notes.length && !this.events.length) return 'nothing yet';
    return `${this.notes.length} note${this.notes.length === 1 ? '' : 's'}, ${this.events.length} moment${this.events.length === 1 ? '' : 's'}`;
  }
}
