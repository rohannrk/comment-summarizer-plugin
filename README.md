# Comment Summarizer (Figma plugin)

Summarizes the comments pinned to a selected **frame / section** (or the whole current page) into a clean, skimmable report:

- **Summary** — what the discussion is about
- **People involved** — who said what
- **Action items** — a checklist with owners and status

Summarization is **bring-your-own-key (BYOK)**: use **Gemini** or any **local / OpenAI-compatible** model (Ollama, LM Studio, etc.). Nothing is sent anywhere except Figma's API and the LLM you choose.

## Why a Figma token is needed

Figma's Plugin API can't read comments — only the [REST API](https://developers.figma.com/docs/rest-api/comments-endpoints/) can. So the plugin needs:

1. A **Figma personal access token** with the `file_comments:read` scope
   (figma.com → Settings → Security → *Personal access tokens*).
2. The **file URL** of the file you're in (a public plugin can't auto-detect it).

Both are entered in the plugin UI. The token and your LLM key are stored locally via Figma `clientStorage` and reused; the file URL is entered per session.

## Develop

```bash
npm install
npm run build       # dev build  (or: npm run watch)
npm run build:prod  # minified build for publishing
npm run typecheck
npm test            # unit tests for the pure logic
```

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`. Build output lands in `dist/` (`code.js`, `ui.html`).

## Usage

1. Open the file, select a frame/section (or nothing for the whole page), run the plugin.
2. First time: open **Credentials & model**, paste your Figma token and LLM key, optionally hit **Test connection**, then **Save**.
3. Paste the file URL and click **Scan comments** — you'll see how many comments are in scope before spending an LLM call.
4. Click **Summarize N comments**, then **Copy** or **Insert into Figma**.

### Options & behavior
- **Ignore resolved threads** — toggle (persisted) to skip resolved comments.
- **Scan-then-summarize** — scanning previews the comment/thread count and token estimate; the summarize button shows the exact count.
- **Large volumes** — if comments exceed the context budget, the plugin automatically map-reduces: it condenses batches first, then merges them into the final summary.
- **Insert into Figma** — drops the summary as a styled auto-layout text frame on the canvas.

## Using a local LLM

- Set provider to **Local / OpenAI-compatible**, base URL e.g. `http://localhost:11434` (Ollama) and a model like `llama3.1`.
- Enable CORS on the server (Ollama: run with `OLLAMA_ORIGINS=*`).
- The manifest's `devAllowedDomains` already lists common local ports (Ollama `11434`, LM Studio `1234`) for the imported dev plugin. For a different host/port, add it there. For a **published** plugin, the host must also be added to `allowedDomains`.

## Notes / limitations

- Only **node-pinned** comments are matched to a selection; free-floating (coordinate-pinned) comments are skipped.
- Very large comment volumes may exceed the model's context window.
- Before publishing publicly, tighten `networkAccess.allowedDomains` and remove `devAllowedDomains: ["*"]`.
