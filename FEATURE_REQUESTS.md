# Feature requests

Ideas that are worth doing but not yet built. Move an entry into `CHANGELOG.md`
once it ships.

## Send comment-pin coordinates alongside the screenshot

**Why:** the plugin already sends a screenshot of the selected frame(s) plus the
comment text to the LLM as visual context, but the model still has to guess
*where in the image* each comment is talking about. Figma's comment API returns
the pin location for every comment, so we can hand the model that directly
instead of making it infer position from wording alone.

**What Figma gives us:** `client_meta` on each comment is either
- `node_id` + `node_offset: {x, y}` — offset relative to the top-left of the
  node the comment is pinned to, for node-pinned comments, or
- `x` + `y` — absolute canvas coordinates, for free-floating (coordinate-pinned)
  comments.

**The catch:** `node_offset` is relative to whatever node the comment is pinned
to, which is often a small element nested deep inside the frame we screenshot —
not the frame's own top-left corner. Resolving a node's absolute position needs
`figma.getNodeByIdAsync`, which only the main thread (`code.ts`) can call; comment
fetching happens in the UI thread over the network. So this needs one more
round trip between the two before the prompt can be built.

**Rough plan:**
1. After comments are scoped (in `scan()`, `ui.ts`), collect the distinct
   `node_id`s referenced by pinned comments.
2. Send them to `code.ts` (new `UIToMain` message) and resolve each to an
   absolute `{x, y}` via `figma.getNodeByIdAsync(...).absoluteBoundingBox`.
3. Combine that with the comment's `node_offset` (or use `x`/`y` directly for
   coordinate-pinned comments) to get an absolute canvas point.
4. Convert to pixel coordinates within whichever captured screenshot the point
   falls inside, using that frame's bounding box and its known export scale
   (`1200 / frame.width`, since screenshots are always exported at 1200px wide —
   see `captureScreenshot` in `code.ts`).
5. Append the pixel position to that comment's line when building the prompt
   (`formatComments` in `prompt.ts`), e.g. `pinned near (412, 180) in the screenshot`.

**Caveat to set expectations on:** this is a hint, not pixel-perfect grounding —
Gemini reasons reasonably well over stated coordinates next to an image, but
isn't a dedicated vision-detection model. Worth doing a manual before/after
comparison (same approach as the original screenshot-context spike) before
assuming it clearly helps.

**Touches:** `messages.ts`, `code.ts`, `ui.ts`, `prompt.ts`. Similar scope to the
multi-frame screenshot feature.

## Copy AI context (highest priority)

**Why:** not everyone wants to configure a BYOK key in the plugin, or the
plugin's two supported providers (Gemini / local) aren't the model they'd
rather use. Let them take the exact same formatted comment data the plugin
would send, and paste it into any AI chat themselves.

**What:** a button (next to or instead of "Copy") that copies the already-built
prompt — `SYSTEM_PROMPT` plus `formatComments(...)` output from `prompt.ts` —
as plain text, self-contained enough to paste directly into ChatGPT, Claude,
or anywhere else and get a usable result without the plugin's own LLM call.

**Touches:** `ui.ts` mainly — the formatting logic already exists (`prompt.ts`),
this is largely a new button wired to the existing `formatComments` +
`SYSTEM_PROMPT` output plus a clipboard write (reuse the `legacyCopy` fallback
already built for the existing Copy button).

## Export as Markdown (file download, not just clipboard)

**Why:** "Copy" already puts the markdown on the clipboard; this is for
sharing as an actual `.md` file (attaching to a ticket, dropping in a repo,
etc.) rather than pasting.

**Watch out for:** Figma's plugin UI iframe may block script-triggered
downloads (`<a download>` / blob URLs) depending on the host — confirm this
actually works inside the real Figma app before assuming it's a small feature.

## Export as JSON

**Why:** for piping the structured result (summary / people / action items)
into other tooling programmatically instead of parsing markdown.

**What:** reuse the existing parsing already in `summary-model.ts`
(`splitSections`, `parsePerson`, `parseTask`) — it already turns the model's
markdown into structured data for the result card and the inserted Figma
frame; this would just serialize that same structure to JSON instead of
(or alongside) rendering it.

## Custom prompt templates

**Why:** `SYSTEM_PROMPT` in `prompt.ts` is currently fixed. Some teams will
want different section names, tone, or output format.

**Caveat:** the result renderer (`markdown.ts` / `summary-model.ts`) expects
the three-section `## Summary` / `## People involved` / `## Action items`
shape reasonably closely — a fully freeform custom prompt would need either a
guardrail (append the structural requirement regardless of what the user
customizes) or a fallback render path for output that doesn't match.

## Multi-language summaries

**Why:** output in a language other than English.

**Rough approach:** a language picker in settings, appended as an instruction
to `SYSTEM_PROMPT` — comments can stay in their original language, only the
generated summary needs to shift.

## Jira / Linear export — on hold

Deliberately not scoping this one yet. Pushing auto-generated action items
straight into Jira/Linear as real tickets only makes sense once summary
accuracy is reliably good — a wrong auto-created ticket is worse than no
integration at all. Revisit after the summarization quality itself has been
pushed on (prompt tuning, the coordinate-context idea above, real usage
feedback) rather than building this on the current baseline.
