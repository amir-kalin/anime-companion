# How frontier agents use UIs and tools built for humans

Every claim below is sourced. Vendor docs were read directly; nothing here is inferred from memory.
Retrieved 2026-10-03.

---

## 1. The headline: the action layer collapsed into "write code"

OpenAI's computer-use guide states three integration paths, and for their newest model it is explicit:

> "For [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), we recommend code execution.
> The `computer` tool remains supported as an alternative."

— [OpenAI, Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)

So the frontier did **not** converge on a fixed vocabulary of "click(x,y)" actions. For the leading
model the entire tool surface is one function that accepts a program:

```js
{
  name: "exec_js",
  description: `Run JavaScript in a persistent browser. Available: Playwright's
browser, context, and page objects; console.log(value); and display(base64Image).
Save reusable variables on globalThis. Inspect a screenshot before acting and
check the screen after a short group of actions. Keep screenshots in memory. ...`,
  parameters: { type: "object", properties: { code: { type: "string" } },
                required: ["code"], additionalProperties: false },
  strict: true
}
```

Three consequences that matter more than the API shape:

- **Logic moves out of the action stream and into the program.** "One call can combine actions,
  loops, or conditional logic." An agent that must click 40 times across a paginated table pays
  one round trip when it can write a `for` loop, versus 40 when every action is a discrete tool call.
- **The observation channel is a function, not a tool.** `display(image)` is how the model sees;
  `log(value)` is how it gets text. `display(pyautogui.screenshot())` is the literal idiom.
- **Persistence is a documented requirement, twice.** "Keep the environment available between calls
  so the model can build on earlier work" and "Save reusable variables on `globalThis`."

## 2. The control surface is the platform's own, and there are two

| Target | Control surface | Nature |
|---|---|---|
| Browser | **Playwright** (`browser`, `context`, `page`) | semantic — DOM/role/name, stable selectors |
| Desktop | **PyAutoGUI** | perceptual — synthesizes OS mouse/keyboard events |

Both are libraries *humans' tools already have*. The agent does not get a privileged API; it gets the
same automation surface an engineer would use. This is the actual answer to "how do agents use tools
built for humans": they reuse the human automation stack, and they read the screen for state.

> "Inspect the screen with `display(pyautogui.screenshot())` before acting. Use screenshot
> coordinates and check the screen after a short group of actions."

## 3. The perception/action split is the real design axis

Anthropic took the opposite action layer: fixed **client toolsets** with named members.

- `computer_toolset_20260801` — 17 members: `screenshot`, `zoom`, `left_click`, `type`, `key`,
  `scroll`, `left_click_drag`, `cursor_position`, `hold_key`, `wait`, …
- `browser_toolset_20260801` — 27 members: `navigate`, `read_page`, `find`, `left_click`,
  `screenshot`, `hover`, `scroll_to`, `form_input`, `new_tab`, …

— [Anthropic, Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) · [Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)

But Anthropic's browser toolset carries the most useful piece of guidance in either corpus, because it
makes the two channels **coexist** rather than compete. A targeting parameter is a tagged union:

- `RefTarget` — `{"type":"ref","ref":"ref_2"}`, a handle from `read_page`
- `CoordinateTarget` — `{"type":"coordinate","x":640,"y":380}`

> "**Prefer references where the page has a usable accessibility tree.** A reference survives layout
> shifts and reflows that make pixel coordinates fragile, and lets Claude act on controls that are
> hard to hit with a pointer.
>
> **Fall back to coordinates for content the tree doesn't describe.** Canvas-rendered interfaces,
> embedded video or remote-desktop surfaces, heavily virtualized lists, and elements inside
> cross-origin iframes often have no useful node, so Claude works from `screenshot` and `zoom` and
> clicks by coordinate."

`read_page` output is a flat, speakable listing where every element carries a handle:

```text
link "Documentation" [ref_1]
textbox "Search docs" [ref_3]
button "Search" [ref_4]
```

So the abstraction is: **semantic handles where they exist, pixels where they don't, and a switch
between them decided at runtime by what the target surface exposes.** Coordinate grounding and
semantic grounding are not competing philosophies; they are two channels into one executor.

## 4. Details that are easy to get wrong

These are all stated explicitly in the vendor docs, and all of them are places a naive
implementation breaks:

| Rule | Consequence if ignored | Source |
|---|---|---|
| "If you downscale a screenshot, map the model's coordinates back to the environment's coordinate space before executing actions." | Clicks land at the wrong pixel whenever the screenshot was resized | both vendors |
| "The API conversation and the execution environment have separate state. Continuing a response does not restore a browser session, login state, or runtime variables." | A resumed conversation silently acts on a dead page | OpenAI |
| Zoom does not change the coordinate frame: "after a `zoom`, Claude still expresses coordinates in the full screenshot's space, never relative to the zoomed image." | Offsets applied twice | Anthropic |
| Refs are "scoped to the tab that produced them and stay valid until that tab navigates or its DOM changes materially… The API can't detect a stale or unknown reference" | Executor must return an error for stale refs and get the model to re-read | Anthropic |
| "Run the blocks in order and stop at the first failure" + exact halt text `"Not executed: an earlier computer action in this turn failed."` | Later actions run against state that never existed | Anthropic |
| "A request that leaves any `tool_use` block in the batch unanswered is rejected" | Every call needs a result, or the next request 400s | Anthropic |
| Screenshots must fit image limits, and the per-image limit gets stricter once a request holds more than 20 images | Late-turn requests rejected | Anthropic |
| "build page reads from what the page renders (the accessibility tree or visible text), not raw DOM source, so hidden text doesn't reach Claude" | Prompt-injection surface | Anthropic |
| "Do not execute a partially generated action" | Half-typed form fields | OpenAI |

### Batch semantics genuinely differ between the two designs

- **Anthropic** returns N `tool_use` blocks; you must answer N `tool_result` blocks, stop at the
  first failure, and mark the remainder unexecuted with fixed text. It is a *protocol* concern.
- **OpenAI** returns one `computer_call` containing an ordered `actions` array, and you return one
  `computer_screenshot` for the whole call. It is an *executor* concern.

With code execution there is no per-action protocol at all: one program, one result. A mid-program
throw is self-describing — the error plus a screenshot of the post-failure screen tells the model
exactly which prefix of its plan actually took effect. That is the one place code execution is
genuinely simpler, and it is worth naming.

## 5. Safety is enforced inside the executor, not in the prompt

Both vendors place the human check in the same spot, and both explain why:

> "Have a human confirm consequential actions… and make that check in your executor before each
> block runs, **because one turn can carry several**."

— Anthropic; OpenAI says the same under "Confirm consequential actions."

The clause "because one turn can carry several" is the whole point. Batching means a confirmation
prompt emitted *around* the model turn is both too coarse and too late — the agent can execute a
purchase and the delete that follows it inside a single turn. The interrupt must live at the moment
of the individual side-effecting call.

OpenAI also separates *who may authorize*, which is a distinction worth copying:

> "Treat only direct user instructions as permission." … "Confirm at the point of risk."

## 6. The visual bridge: Set-of-Mark

There is a third channel between "pixels" and "DOM", predating both vendor designs: overlay numbered
labels on a screenshot so the model can refer to regions by index instead of by coordinate.

> "Set-of-Mark (SoM), a visual prompting method, to unleash the visual grounding abilities of large
> multimodal models" — [Yang et al., arXiv:2310.11441](https://arxiv.org/abs/2310.11441)

SoM matters here because it is the only technique that gives *pixel-only* surfaces (canvas, video,
images of UIs) something handle-shaped. It is also a screen-reader annotation, which is a nice
reciprocity: the human UI's accessibility layer and the agent's handle system are the same object.

---

## What this implies for an MVP

1. Implement the **code-execution** loop, not the fixed action list. One function tool, one program
   per turn, persistent environment. It is the recommended path for the newest model and it composes.
2. Give the sandbox **both** control surfaces at once: a semantic `page` (roles, names, handles) and
   a perceptual one (`page.mouse.click(x, y)`, `screenshot`, `zoom`). Let the generated program pick.
3. Make the channel choice **mechanical, not advisory**: resolve a coordinate to the nearest
   accessible node within a radius and log which channel served the click.
4. Ship the safety interlock **inside** the page API so it catches side effects per call.
5. Handle the **coordinate frame** explicitly and centrally, since the model cannot know it.
6. Treat conversation and environment as **two independent lifecycles**, and verify both.