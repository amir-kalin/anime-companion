# humanui

A working MVP of how current frontier agents operate interfaces that were built for humans.

The research is in [`research/FINDINGS.md`](research/FINDINGS.md). Every claim in it is sourced to
vendor documentation. This file is the implementation.

**Zero npm dependencies.** No Playwright, no Puppeteer, no `ws`. The harness drives a real Chrome or
Edge over the DevTools Protocol using Node's built-in `WebSocket`. The only requirement is a Chrome or
Chromium binary, which is found automatically (override with `HUMANUI_BROWSER`).

---

## What it is

The one tool a current model is recommended to use is a **code executor**, not a list of click
actions. From OpenAI's computer-use guide:

> "For GPT-6 Astra, we recommend code execution. The `computer` tool remains supported as an
> alternative."

The model writes a short program that drives a real browser through a real human-facing page, and the
program stays alive between turns. This harness implements that architecture, plus the parts that
make it safe and debuggable:

| Layer | File | What it does |
|---|---|---|
| Loop | `src/agent/loop.mjs` | step budget, deadline, cancellation, environment liveness, per-turn tool results |
| Tool | `src/agent/model.mjs` | one function tool; speaks Responses and Chat Completions |
| Sandbox | `src/runtime/sandbox.mjs` | persistent `vm` realm; `log()` and `display()` observations; no host reach |
| Executor | `src/cdp/page.mjs` | both grounding channels over one page; real trusted input; approval interlock |
| Semantics | `src/cdp/snapshot.mjs` | accessibility tree as a speakable listing with stable handles |
| Perception | `src/cdp/image.mjs` | screenshots, zoom, and the coordinate frame |
| Safety | `src/agent/approvals.mjs` | risk classification and fail-closed operator approval |

---

## Run it

Scenarios use a scripted planner, so **the whole thing runs with no model configured**:

```bash
node bin/humanui.mjs check              # verify browser + CDP + sandbox
node bin/humanui.mjs list               # available scenarios
node bin/humanui.mjs scenario filter    # run one headless, with a trace
node bin/humanui.mjs serve              # operator console on :5180
node test/run-all.mjs                   # 142 assertions, ~6s
node tools/shoot.mjs channels 1600 1000 # screenshot the console at a desktop width
```

`tools/shoot.mjs` exists because the console's three-column layout cannot be reviewed in a narrow
review window — it collapses to the mobile breakpoint and hides whether the grid works. It drives the
harness's own browser at an explicit viewport instead.

`scenario blocked` is the one to watch: the agent tries to click "Delete everything", the interlock
asks, and the denial is reported back *into the running program*.

### With a live model

```bash
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY=sk-...
export HUMANUI_MODEL=gpt-6-astra
node bin/humanui.mjs serve
```

Or point it at a local server (LM Studio, Ollama, vLLM):

```bash
export OPENAI_BASE_URL=http://127.0.0.1:1234/v1 HUMANUI_MODEL=<a model you loaded>
node bin/humanui.mjs serve --api chat
```

`--api chat|responses|auto` picks the wire format. A vision request that fails is retried once
text-only and the run is marked degraded, so a model without a vision tower still runs.

---

## The design decisions worth knowing

### Both channels, in one sandbox

The vendor guidance is not "pick pixels" or "pick the DOM", it is a runtime switch:

> "Prefer references where the page has a usable accessibility tree. […] Fall back to coordinates for
> content the tree doesn't describe. Canvas-rendered interfaces, embedded video or remote-desktop
> surfaces, heavily virtualized lists, and elements inside cross-origin iframes often have no useful
> node."

So `page` exposes both and a program may mix them:

```js
const snap = await page.snapshot({ filter: 'interactive' });
// button "Apply filters" [ref_7] (39,399 99x37)

await page.click({ ref: 'ref_7' });        // semantic — survives reflow
await page.mouse.click(700, 520);          // perceptual — for canvas, iframes
```

And the harness records which channel served every action, so you can see the decision rather than
infer it:

```
click  [semantic  ] via ref        -> <button id=apply type=button>
click  [perceptual] via coordinate -> <section> "Matches Title…"
```

That last line matters more than it looks: a coordinate click is otherwise blind, so every
perceptual click is verified against `elementFromPoint` and the model is told what it actually hit.

### Handles survive reflow; coordinates do not

`page.snapshot()` returns lines like `button "Apply filters" [ref_7] (39,399 99x37)` — the
accessible name, a stable handle, and geometry. Handles come from `backendDOMNodeId`, and the docs
are explicit that they must not be renumbered until the page navigates, so this implementation keeps
assigning them for the life of a navigation.

The difference is not theoretical. In this repo's own demo page, showing a status banner pushes the
Apply button from y=342 to y=399. A stored coordinate now clicks the wrong row; the handle does not.

### The coordinate frame is handled once, centrally

Both vendors warn about this independently. A bare image is never handed to anything that acts on it;
every capture returns a `Frame` that owns the mapping:

```js
const f = await page.screenshot();
// f.scale, f.space, f.toViewport(x, y), f.fromModel(x, y)
```

`Frame.scale` is relative to the **crop** for a zoom, not the viewport — dividing by viewport width
for a zoom is a real bug that produces wildly wrong clicks. And `space` records whether coordinates
the model emits are image pixels or already viewport pixels, because after a zoom the documented rule
is that they are the latter:

> "after a `zoom`, Claude still expresses coordinates in the full screenshot's space, never relative
> to the zoomed image."

### Input is real input

Every action goes through `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, never
`element.click()`. A human's click is trusted and hit-tested; a synthetic DOM event is not, so menus,
overlays, and hit-testing behave differently.

One sharp edge, found by probe and now fixed: **modifier chords need real modifier key events.** CDP's
`modifiers` bitmask alone does not put Chromium into a modifier state — `ctrl+a` inserted a literal
`a`, which turned every `fill()` into an append and silently produced `xyapenguin` instead of
`penguin`. See `probe/probe-input.mjs`.

### One control opts out of synthetic keys, deliberately

A native `<select>` does not take synthetic keystrokes reliably. Measured in this browser
(`probe/probe-select.mjs`):

| after focusing the select | committed value |
|---|---|
| `ArrowDown` | *unchanged* — only `Enter` applies the highlighted option |
| type-ahead (`a`, `q`, `d`) | *unchanged* |
| `ArrowUp` | changes |

So a key-driven approach either lands on an arbitrary option or does nothing and reports success.
`page.selectOption()` therefore uses the semantic path — a real click for focus, then set the value
and dispatch `input`/`change`, which is what Playwright's `selectOption` does for the same reason. An
unmatched value is refused loudly rather than silently ignored.

This is the dual-channel thesis paying off: the answer to "keyboard does not work here" is not a
cleverer key sequence, it is the other channel.

### Safety lives inside the executor

> "make that check in your executor before each block runs, because one turn can carry several."

The check is wired into `page`'s action gate, per side effect. Both vendors put it there, and the
reason is structural: with batching — and more so with code execution — an agent can reach a purchase
and the delete after it inside one turn, so a prompt wrapped around the turn is both too coarse and
too late.

Destructive and spend verbs are high risk; consent verbs are low risk and resolve after a grace
period; ordinary controls are not gated. Unanswered prompts **fail closed**.

### A failed program tells the model what actually happened

This is the concrete advantage of code execution over a fixed action list. When a program throws
partway through, the harness returns the error *and* a screenshot of the post-failure state, so the
model can see which prefix of its plan took effect. Anthropic's fixed-action protocol has to
synthesise this: later actions in a batch are answered with the literal text
`"Not executed: an earlier computer action in this turn failed."`

---

## The demo target

`public/target.html` is a small watchlist console built to exercise every documented case:

| Surface | Why it is there |
|---|---|
| labelled textbox, combobox, checkbox, buttons | fully described by the accessibility tree |
| a `<canvas>` chart | `aria-hidden`, no accessible node — pixels only |
| an `<iframe>` | cross-document, the parent cannot introspect it |
| 9px low-contrast caption | the case that needs `zoom` |
| "Delete everything" | triggers the approval interlock |
| a native `<select>` | not text entry; must be driven by keyboard |

Running the `channels` scenario prints, from a real browser:

```
a11y nodes: 120
canvas has an a11y node: false
chart box (viewport px): [396.8, 563.4, 989.2, 248.5]
```

---

## Operator console

`node bin/humanui.mjs serve` → <http://127.0.0.1:5180>

Three columns: run controls and the safety interlock, the agent's step programs with their output,
and the observations the agent returned. The accessibility tree refreshes alongside, so both channels
are visible at once. Approval requests appear inline with the action, its risk, and the rule that
classified it.

There is also a manual step console for running a single program against the persistent session,
which is how you explore the API without a model in the loop.

---

## Tests

```
node test/run-all.mjs
```

| Suite | Checks | Covers |
|---|---|---|
| `sandbox-isolation.mjs` | 22 | no `process`/`require`/`fetch`/`Buffer`, dynamic import blocked, persistence, partial failure |
| `url-policy.mjs` | 25 | scheme parsing, host allowlist boundary, suffix traps, malformed input |
| `risk-policy.mjs` | 35 | destructive/spend/consent boundaries, typing classification |
| `executor.mjs` | 35 | both channels, handle stability, coordinate frame, chords, reflow, select |
| `loop.mjs` | 25 | budget, cancellation, failure recovery, approvals, telemetry |

The three browser suites finish in under 5 seconds because nothing waits on a model.

One test earned its keep immediately: the sensitive-field regex was written as
`type="?(password|email|tel|number)?"?`, where the optional group collapses the whole pattern to
matching a bare `type=`. Every form field on the page classified as sensitive, so the interlock would
have fired on all typing and trained operators to approve without reading.

---

## Limits

Worth being explicit about what this does not do:

- **Web only.** No desktop path. The vendor docs build that on a VM with `Xvfb` + `xdotool`; on
  Windows the equivalent would be UI Automation or `SendInput`.
- **Single tab, single agent.** One run at a time, by design: two agents sharing a page interleave
  actions and produce unattributable telemetry.
- **Risk classification is regexes.** Adequate for a demo; production wants an LLM judge and a real
  allowlist of permitted actions.
- **The browser runs unsandboxed.** It is a throwaway profile with extensions disabled, but it is not
  a container. Anything you point it at can reach the machine.
- **`StaticPlanner` tests everything except the model.** The loop, sandbox, gate, and telemetry are
  genuinely covered. Whether a given model picks good handles is not.