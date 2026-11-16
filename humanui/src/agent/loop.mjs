// The agent loop.
//
// Structure follows the documented code-execution loop: request a step, run the program, return the
// observations, repeat until the model answers in prose or the step budget runs out. Three details
// from the docs are load-bearing rather than incidental:
//
//  * A step budget is required, not optional. The reference loop caps at 20 responses "to prevent
//    potential infinite loops that could result in unexpected API costs." This loop defaults to the
//    same 20 and additionally enforces a wall-clock deadline and cooperative cancellation.
//  * The environment is checked every turn. Conversation continuity does not imply the browser is
//    still there, so a dead environment surfaces as a stop reason instead of a cascade of
//    confusing per-action failures.
//  * Every tool call is answered, on both wire formats. An unanswered call is rejected by the API
//    on the next request, so a loop that only reads the first call fails one turn later.
//
// The loop talks to a "planner". `ModelClient` is one. `StaticPlanner` is another, which is what
// makes the harness verifiable end to end with no model available.

/**
 * Render a step outcome for the model.
 *
 * The sandbox already prefixes the error name (`Error: boom`), so adding another here produced
 * "Error: Error: boom". Keep exactly one prefix.
 */
function toolResultText({ error, text }) {
  if (!error) return text || '(the program produced no output)';
  return /^error:/i.test(error) ? error : `Error: ${error}`;
}

/**
 * Aggregate token usage across a run.
 *
 * `usage` arrives per response and is easy to ignore, which is how an agent loop ends up spending
 * without anyone noticing. Both vendors tell the integrator to bound the run: "Set step, time, or
 * cost limits, support cancellation."
 */
export class UsageMeter {
  #totals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, requests: 0, images: 0 };

  add(usage, images = 0) {
    if (usage) {
      for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
        if (Number.isFinite(usage[key])) this.#totals[key] += usage[key];
      }
    }
    this.#totals.requests += 1;
    this.#totals.images += images;
    return this.snapshot();
  }

  snapshot() { return { ...this.#totals }; }
  get tokens() { return this.#totals.total_tokens; }
  get images() { return this.#totals.images; }
}

/**
 * Keep a conversation inside the per-image limit.
 *
 * The docs note that image limits tighten once a request holds "more than 20 images", and that a
 * request over the limit is rejected outright rather than degraded. On the Chat Completions path the
 * transcript is ours, so older images can be dropped. On the Responses path the history is server-side
 * and cannot be rewritten, so the only honest move is to send fewer images per step and say so.
 */
export class ImageBudget {
  constructor({ keepRecent = 4, warnAfter = 16, maxPerStep = 4 } = {}) {
    this.keepRecent = keepRecent;
    this.warnAfter = warnAfter;
    this.maxPerStep = maxPerStep;
    this.sent = 0;
    this.warned = false;
  }

  /** How many of this step's images may actually be sent. */
  allow(count) {
    return Math.max(0, Math.min(count, this.maxPerStep));
  }

  /** Returns true exactly once, when the run crosses the warning threshold. */
  note(count) {
    this.sent += count;
    if (!this.warned && this.sent > this.warnAfter) {
      this.warned = true;
      return true;
    }
    return false;
  }

  /**
   * Replace image parts in older tool messages, keeping the most recent `keepRecent`.
   *
   * Returns a copy; the caller's transcript is left alone.
   */
  pruneChatHistory(history) {
    const imagePositions = [];
    history.forEach((message, i) => {
      if (message.role !== 'tool' || !Array.isArray(message.content)) return;
      message.content.forEach((part, j) => {
        if (part.type === 'image_url') imagePositions.push([i, j]);
      });
    });

    if (imagePositions.length <= this.keepRecent) return { history, pruned: 0 };

    const stale = imagePositions.slice(0, imagePositions.length - this.keepRecent);
    const copy = history.map((m) => (Array.isArray(m.content)
      ? { ...m, content: m.content.map((p) => ({ ...p })) }
      : m));

    for (const [i, j] of stale) {
      // Swap for text rather than removing: the tool result must keep the record of what the program
      // reported, or the model loses the thread of its own plan.
      copy[i].content[j] = {
        type: 'text',
        text: '[an earlier screenshot was omitted to stay within the request image limit]',
      };
    }
    return { history: copy, pruned: stale.length };
  }
}

export class AgentLoop {
  #page;
  #sandbox;
  #planner;
  #opts;
  #cancelled = false;
  #turn = 0;

  constructor({
    page,
    sandbox,
    planner,
    tool = null,
    task,
    maxSteps = 20,
    deadlineMs = 300_000,
    maxTokens = null,
    imageBudget = null,
    systemPrompt = null,
    initialObservation = null,
    onEvent = () => {},
  }) {
    this.#page = page;
    this.#sandbox = sandbox;
    this.#planner = planner;
    this.tool = tool;
    this.task = task;
    this.maxSteps = maxSteps;
    this.deadlineMs = deadlineMs;
    this.maxTokens = maxTokens;
    this.systemPrompt = systemPrompt;
    this.initialObservation = initialObservation;
    this.onEvent = onEvent;

    this.usage = new UsageMeter();
    this.images = imageBudget ?? new ImageBudget();

    this.events = [];
    this.steps = [];
    this.result = null;
  }

  get cancelled() { return this.#cancelled; }

  cancel() {
    this.#cancelled = true;
    this.#emit({ type: 'cancelled' });
  }

  #emit(event) {
    const record = { at: Date.now(), turn: this.#turn, ...event };
    this.events.push(record);
    try { this.onEvent(record); } catch { /* a broken listener must not kill the run */ }
  }

  async run() {
    const startedAt = Date.now();
    this.#emit({ type: 'run.start', task: this.task, maxSteps: this.maxSteps });

    // Chat Completions carries the transcript locally; Responses threads it server-side and needs
    // each step's tool output sent explicitly as an input item.
    // `let`, because image pruning can replace it with a trimmed copy each turn.
    let history = [];
    let previousResponseId = null;
    let pendingToolOutput = null;
    let observation = this.initialObservation;
    let finalText = '';
    let stopReason = 'max_steps';

    for (let turn = 0; turn < this.maxSteps; turn++) {
      this.#turn = turn + 1;

      if (this.#cancelled) { stopReason = 'cancelled'; break; }
      if (Date.now() - startedAt > this.deadlineMs) {
        stopReason = 'deadline';
        this.#emit({ type: 'run.deadline', elapsedMs: Date.now() - startedAt });
        break;
      }
      if (this.maxTokens && this.usage.tokens >= this.maxTokens) {
        stopReason = 'token_budget';
        this.#emit({ type: 'run.token_budget', usage: this.usage.snapshot(), limit: this.maxTokens });
        break;
      }

      // Keep the request inside the per-image limit before it is sent, not after it is rejected.
      if (this.#planner.transcriptStyle === 'chat') {
        const pruned = this.images.pruneChatHistory(history);
        if (pruned.pruned > 0) history = pruned.history;
      }

      // Environment liveness. Conversation continuity does not imply the browser is still there.
      if (!(await this.#page.isAlive())) {
        stopReason = 'environment_lost';
        this.#emit({ type: 'environment.lost' });
        break;
      }

      // Decide the image allowance before the request, since it determines what is sent.
      const produced = observation?.images?.length ?? 0;
      const sentImages = this.images.allow(produced);
      if (sentImages < produced) {
        this.#emit({
          type: 'images.capped',
          produced,
          sent: sentImages,
          reason: 'per-step image limit',
        });
      }

      let reply;
      try {
        reply = await this.#planner.step({
          turn: turn + 1,
          tool: this.tool,
          system: this.systemPrompt,
          instruction: this.#instruction(observation),
          observation,
          history,
          previousResponseId,
          toolOutput: pendingToolOutput,
          images: (observation?.images ?? []).slice(0, sentImages),
        });
      } catch (err) {
        stopReason = 'model_error';
        this.#emit({ type: 'model.error', message: err.message });
        break;
      }

      pendingToolOutput = null;
      previousResponseId = reply.responseId ?? previousResponseId;
      if (reply.commentary) this.#emit({ type: 'model.commentary', text: reply.commentary });

      if (this.images.note(sentImages)) {
        this.#emit({
          type: 'images.warning',
          sent: this.images.sent,
          note: 'the per-image request limit tightens past 20 images; older screenshots are being dropped',
        });
      }

      this.usage.add(reply.usage, sentImages);

      if (!reply.toolCall) {
        finalText = reply.text ?? '';
        stopReason = 'completed';
        this.#emit({ type: 'model.final', text: finalText });
        break;
      }

      let args = {};
      try {
        args = JSON.parse(reply.toolCall.args || '{}');
      } catch (err) {
        this.#emit({ type: 'step.parse_error', message: err.message });
      }

      // Record the assistant turn before executing, so a tool result has a call to attach to.
      if (this.#planner.transcriptStyle === 'chat') {
        history.push({
          role: 'assistant',
          content: reply.commentary || reply.text || null,
          tool_calls: [{
            id: reply.toolCall.id,
            type: 'function',
            function: { name: reply.toolCall.name, arguments: reply.toolCall.args },
          }],
        });
      }

      this.#emit({ type: 'tool.call', name: reply.toolCall.name, args: reply.toolCall.args });

      let code = '';
      let outcome;
      if (reply.toolCall.name !== 'exec_js') {
        // Answer it anyway: an unanswered call poisons the next request.
        outcome = {
          ok: false,
          text: '',
          images: [],
          error: `Unknown tool "${reply.toolCall.name}". The only tool is exec_js.`,
          durationMs: 0,
        };
      } else {
        code = String(args.code ?? '');
        this.#emit({ type: 'step.start', code });
        try {
          outcome = await this.#sandbox.run(code);
        } catch (err) {
          outcome = { ok: false, text: '', images: [], error: err.message, durationMs: 0 };
        }
      }

      const record = {
        turn: turn + 1,
        code,
        ok: outcome.ok,
        text: outcome.text,
        images: outcome.images.length,
        // Carried on the event, not just to the model, so the operator console shows exactly what
        // the agent was shown rather than a summary of it.
        imageData: outcome.images.map((i) => ({ url: i.url, caption: i.caption })),
        error: outcome.error,
        durationMs: outcome.durationMs,
      };
      this.steps.push(record);
      this.#emit({ type: 'step.end', ...record });

      const toolText = toolResultText(outcome);

      if (this.#planner.transcriptStyle === 'chat') {
        const content = [{ type: 'text', text: toolText }];
        for (const img of outcome.images) content.push({ type: 'image_url', image_url: { url: img.url } });
        history.push({ role: 'tool', tool_call_id: reply.toolCall.id, content });
      } else {
        const output = [{ type: 'input_text', text: toolText }];
        for (const img of outcome.images) {
          output.push({ type: 'input_image', image_url: img.url, detail: 'original' });
        }
        pendingToolOutput = { callId: reply.toolCall.id, output };
      }

      observation = {
        text: outcome.error ? '' : (outcome.text || '(no output)'),
        images: outcome.images.map((i) => ({ url: i.url, caption: i.caption })),
        error: outcome.error,
        telemetry: this.#page.telemetry.slice(-12),
      };
    }

    this.result = {
      stopReason,
      text: finalText,
      steps: this.steps,
      events: this.events,
      durationMs: Date.now() - startedAt,
      usage: this.usage.snapshot(),
      degraded: Boolean(this.#planner.degraded),
    };

    this.#emit({
      type: 'run.end',
      stopReason,
      steps: this.steps.length,
      durationMs: this.result.durationMs,
      usage: this.result.usage,
    });
    return this.result;
  }

  /** Compose the next instruction, carrying the previous step's output and executed actions. */
  #instruction(observation) {
    if (!observation) {
      return `${this.task}\n\nInspect the page before acting. Call exec_js once with a short program.`;
    }

    const parts = [];
    if (observation.error) {
      // The error is the most important thing in the message: it says which prefix of the plan took
      // effect and which did not, which is the concrete advantage of code execution over a fixed
      // action list where later actions in a batch are simply marked "not executed".
      parts.push(`The previous program failed: ${observation.error}`);
      parts.push('The page is in whatever state that failure left it. Inspect before retrying.');
    } else {
      parts.push('Previous step output:');
      parts.push(observation.text || '(no output)');
    }

    if (observation.telemetry?.length) {
      const lines = observation.telemetry.map((t) => {
        const how = t.channel ? ` [${t.channel}]` : '';
        const node = t.node ? ` -> ${t.node}` : '';
        return `  ${t.action ?? t.kind}${how}${node}`;
      });
      parts.push('Actions the harness executed for you:');
      parts.push(lines.join('\n'));
    }

    // A tab that opened but was not followed is the failure mode where the agent confidently reports
    // a document the user is no longer looking at. Say so plainly rather than leaving it in telemetry.
    const openedTab = [...(observation.telemetry ?? [])].reverse()
      .find((t) => t.kind === 'tabs.changed');
    if (openedTab) {
      const others = (openedTab.tabs ?? []).filter((t) => t.url !== openedTab.attachedTo);
      if (others.length) {
        parts.push(
          `A click opened ${others.length} new tab(s) and you are still on ` +
          `${openedTab.attachedTo}. Check page.tabs() and switchTab(index) if the new tab is the ` +
          `one you need:\n${others.map((t, i) => `  ${i}: ${t.title || '(untitled)'} — ${t.url}`).join('\n')}`,
        );
      }
    }

    parts.push('Continue the task. Call exec_js with your next program, or answer in plain text if it is done.');
    return parts.join('\n\n');
  }
}

/**
 * A planner that replays a fixed list of programs.
 *
 * This exists so the harness can be exercised and tested with no model in the loop. It presents the
 * same interface as `ModelClient`, so it drives the identical loop, transcript handling, sandbox,
 * approval gate, and event stream. What it does not exercise is the model itself; everything else
 * it exercises honestly.
 */
export class StaticPlanner {
  constructor(programs, { finalText = 'Done.', degraded = false } = {}) {
    this.programs = programs;
    this.finalText = finalText;
    this.degraded = degraded;
    this.transcriptStyle = 'chat';
    this.index = 0;
  }

  async step() {
    if (this.index < this.programs.length) {
      const code = this.programs[this.index++];
      return {
        responseId: null,
        commentary: '',
        text: '',
        toolCall: { id: `call_${this.index}`, name: 'exec_js', args: JSON.stringify({ code }) },
      };
    }
    return { responseId: null, commentary: '', text: this.finalText, toolCall: null };
  }
}