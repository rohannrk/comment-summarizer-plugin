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
