# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-22

### Added
- FigJam support: the plugin now runs in FigJam files as well as design files
  (`editorType` includes `figjam`). Comment fetching, scope detection, and
  summarization are shared across both editors.
- FigJam insert path: since FigJam has no auto-layout frames, the summary is
  inserted as a single styled text node (bold section headings, bold names with
  secondary-colored phrases, ☐/☑ task glyphs with strike-through for completed
  items). Design files keep the auto-layout card.
- `buildSummaryText`, a pure markdown-to-text/span builder shared by the FigJam
  renderer, with unit tests.

## [0.1.0] - 2026-06-19

First release, submitted to the Figma Community for review.

### Added
- Summarize the comments pinned to the current selection (frame or section), or
  the whole page when nothing is selected.
- Reads comments through the Figma REST API using a personal access token, since
  the Plugin API cannot access comments.
- Bring-your-own-key summarization with Google Gemini, or any local /
  OpenAI-compatible endpoint (Ollama, LM Studio).
- Gemini calls retry on transient errors and fall back through a model chain
  (pro to flash to flash-lite) when a model is unavailable.
- Scan step that previews the in-scope comment and thread count, plus a token
  estimate, before spending an LLM call.
- Toggle to ignore resolved threads (persisted).
- Automatic map-reduce for large comment volumes: condense in batches, then merge.
- Test-connection button that validates the Figma token and the LLM endpoint
  without consuming generation tokens.
- Structured result card with section icons, avatar chips for people, and
  checkbox rows (completed items shown checked and struck through).
- Insert the summary onto the canvas as a styled auto-layout frame that mirrors
  the on-screen card.
- Credentials (Figma token and LLM config) stored locally via `clientStorage`;
  the file URL is entered per session.

### Build & quality
- TypeScript plus esbuild; `npm run build`, `build:prod` (minified), `watch`,
  `typecheck`, and `test`.
- Unit tests for the pure logic: URL parsing, scope filtering (node-pinned and
  coordinate-pinned), threading, prompt formatting, batching, markdown rendering,
  and summary parsing.
- Manifest uses `documentAccess: "dynamic-page"` and a scoped network allowlist.
