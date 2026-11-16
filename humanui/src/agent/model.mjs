// Model client for an OpenAI-compatible endpoint.
//
// Two wire formats are supported because the two deployments you will actually point this at
// differ: the OpenAI Responses API (where `gpt-6-astra` and the code-execution pattern live) and
// the Chat Completions API (what LM Studio and most local servers expose). `api: 'auto'` probes
// Responses first and falls back, so the same harness runs against both.
//
// Deliberate simplifications, all of them visible in the returned object rather than hidden:
//  * No streaming. A step's whole program must arrive before it runs, which is also the vendor
//    rule: "Do not execute a partially generated action."
//  * Images are only attached when `vision` is on. A local model without a vision tower will
//    reject image parts, so a failed call is retried once text-only and the step is marked
//    degraded instead of aborting the run.

export class ModelClient {
  constructor({
    baseUrl = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1234/v1',
    apiKey = process.env.OPENAI_API_KEY ?? 'local',
    model = process.env.HUMANUI_MODEL ?? 'gpt-6-astra',
    api = 'auto',
    vision = true,
    reasoningEffort = null,
    timeoutMs = 180_000,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.api = api;
    this.vision = vision;
    this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs;
    this._resolvedApi = null;
    this.degraded = false;
  }

  get endpoint() {
    return `${this.baseUrl}/${this._resolvedApi === 'chat' ? 'chat/completions' : 'responses'}`;
  }

  async #post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
        err.status = res.status;
        throw err;
      }
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Which transcript convention this client is using.
   *
   * Before the first call there is no probe result yet, so fall back to the configured `api`. An
   * `auto` client cannot know until it probes, and reports `chat` until then — which the loop never
   * observes, because it reads this only after a step has run.
   */
  get transcriptStyle() {
    const resolved = this._resolvedApi ?? (this.api === 'responses' ? 'responses' : null);
    return resolved === 'responses' ? 'responses' : 'chat';
  }

  /**
   * Ask the model for one step.
   *
   * `history` is only used by the Chat Completions adapter; the Responses adapter threads the
   * conversation with `previousResponseId` and instead requires each step's `toolOutput` to be sent
   * back as an explicit input item. That asymmetry is the concrete form of the docs' warning that
   * "the API conversation and the execution environment have separate state" — a conversation handle
   * is not a handle on the browser, and it is not even a substitute for returning a tool result.
   */
  async step({ system, instruction, tool, history = [], previousResponseId = null, toolOutput = null, images = [] }) {
    if (this._resolvedApi === null) await this.#probe();

    const call = this._resolvedApi === 'chat'
      ? this.#stepChat({ system, instruction, tool, history, images })
      : this.#stepResponses({ system, instruction, tool, previousResponseId, toolOutput, images });

    if (!this.vision || images.length === 0) return call;

    try {
      return await call;
    } catch (err) {
      if (this.degraded) throw err;
      // One text-only retry: a local model without a vision tower is a setup fact, not a bug.
      this.degraded = true;
      console.warn(`[humanui] vision request failed (${err.message.slice(0, 120)}); retrying text-only.`);
      return this._resolvedApi === 'chat'
        ? this.#stepChat({ system, instruction, tool, history, images: [] })
        : this.#stepResponses({ system, instruction, tool, previousResponseId, toolOutput, images: [] });
    }
  }

  async #probe() {
    if (this.api === 'chat') { this._resolvedApi = 'chat'; return; }
    if (this.api === 'responses') { this._resolvedApi = 'responses'; return; }
    try {
      const res = await fetch(`${this.baseUrl}/responses`, {
        method: 'OPTIONS',
        headers: { authorization: `Bearer ${this.apiKey}` },
      }).catch(() => null);
      if (res && res.ok) { this._resolvedApi = 'responses'; return; }
    } catch { /* fall through to chat */ }
    this._resolvedApi = 'chat';
  }

  async #stepResponses({ system, instruction, tool, previousResponseId, toolOutput, images }) {
    const content = [{ type: 'input_text', text: instruction }];
    // Instruction text goes before the image, which the computer-use docs call out as improving
    // targeting accuracy: "place the instruction text before the screenshot image".
    for (const img of images) {
      content.push({ type: 'input_image', image_url: img.url, detail: 'original' });
    }

    // The previous step's tool result has to be returned explicitly. Leaving it out makes the API
    // reject the next request, which is the failure mode the vendor docs call out: "A request that
    // leaves any tool_use block in the batch unanswered is rejected."
    const input = [];
    if (toolOutput) {
      input.push({
        type: 'function_call_output',
        call_id: toolOutput.callId,
        output: toolOutput.output,
      });
    }
    input.push({ role: 'user', content });

    const body = {
      model: this.model,
      tools: [tool],
      input,
    };
    if (system) body.instructions = system;
    if (previousResponseId) body.previous_response_id = previousResponseId;
    if (this.reasoningEffort) body.reasoning = { effort: this.reasoningEffort };

    const data = await this.#post('/responses', body);
    const functionCall = (data.output ?? []).find((o) => o.type === 'function_call');
    const message = (data.output ?? []).find(
      (o) => o.type === 'message' && o.phase !== 'commentary',
    );
    const commentary = (data.output ?? [])
      .filter((o) => o.type === 'message' && o.phase === 'commentary')
      .flatMap((o) => (o.content ?? []).map((c) => c.text ?? ''))
      .join('\n');

    return {
      responseId: data.id ?? null,
      commentary,
      text: message ? (message.content ?? []).map((c) => c.text ?? '').join('') : '',
      toolCall: functionCall
        ? { id: functionCall.call_id, name: functionCall.name, args: functionCall.arguments ?? '{}' }
        : null,
      usage: data.usage ?? null,
      raw: data,
    };
  }

  async #stepChat({ system, instruction, tool, history, images }) {
    const content = [{ type: 'text', text: instruction }];
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: img.url } });
    }

    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...history,
      { role: 'user', content },
    ];

    const data = await this.#post('/chat/completions', {
      model: this.model,
      messages,
      tools: [{
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }],
      tool_choice: 'auto',
    });

    const choice = data.choices?.[0]?.message ?? {};
    const call = (choice.tool_calls ?? [])[0];

    return {
      responseId: null,
      commentary: '',
      text: choice.content ?? '',
      toolCall: call
        ? { id: call.id, name: call.function?.name, args: call.function?.arguments ?? '{}' }
        : null,
      usage: data.usage ?? null,
      raw: data,
    };
  }
}

/**
 * The single function tool.
 *
 * The schema and the shape of the description follow the documented code-execution tool closely,
 * including the advice to keep the environment alive and to verify with a screenshot. `display()`
 * and `log()` are named in the description because they are how observations get back, and a model
 * cannot use a capability it was never told about.
 */
export function execTool(pageDescription = 'a web page') {
  return {
    type: 'function',
    name: 'exec_js',
    strict: true,
    description:
      `Run JavaScript in a persistent browser session driving ${pageDescription}. ` +
      'The session, the page, and any variables you assign to globalThis survive between calls, ' +
      'so build on previous work instead of starting over. ' +
      'Available: the `page` object, `log(value)` to return text, and `display(frame)` to return a ' +
      'screenshot. `page` exposes two ways to act, and you may mix them in one program: ' +
      '`page.snapshot()` returns the accessibility tree as text with [ref_N] handles, and ' +
      '`page.click(target)` accepts a ref, a CSS selector, a {role, name} pair, or {x, y} in ' +
      'screenshot pixels. Also `page.goto`, `page.fill`, `page.type`, `page.press`, `page.text`, ' +
      '`page.selectOption`, `page.snapshot({ref})` to read one subtree, `page.screenshot()`, ' +
      '`page.zoom(region)`, `page.mouse.*`, `page.keyboard.*`, and ' +
      '`page.evaluate`. Prefer a handle or selector when the control appears in the snapshot, ' +
      'because a handle survives layout shifts; use {x, y} when it does not, such as canvas or ' +
      'embedded frames. Coordinates are in the pixels of the last screenshot you were shown. ' +
      'Inspect with a screenshot before acting when the state is unknown, and check the result ' +
      'after a short group of actions rather than assuming it worked. ' +
      'A click can open a new tab and this session stays where it was, so if something did not ' +
      'appear where you expected, check `page.tabs()` and follow it with `page.switchTab(index)`. ' +
      'Handles belong to the tab they came from and are void after a switch.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    },
  };
}