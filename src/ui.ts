// UI iframe logic. Has network access; no figma.* here.
// Talks to the main thread via postMessage, fetches comments, calls the BYOK LLM.

import type { MainToUI, UIToMain, SavedConfig, LLMConfig, Rect, ScreenshotImage } from "./messages";
import {
  parseFileKey,
  fetchComments,
  filterByScope,
  groupThreads,
  testToken,
  FigmaApiError,
  type CommentThread,
} from "./figma-comments";
import { summarize, testLlm, LLMError, type ImageInput } from "./llm";
import {
  SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  formatComments,
  batchThreads,
  approxTokens,
} from "./prompt";
import { renderSummary, escapeHtml } from "./markdown";

// Keep input well under typical model context windows; above this we map-reduce.
const MAX_CHARS = 90000;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function send(msg: UIToMain) {
  parent.postMessage({ pluginMessage: msg }, "*");
}

const els = {
  app: $("app"),
  mainView: $("mainView"),
  settingsView: $("settingsView"),
  openSettings: $<HTMLButtonElement>("openSettings"),
  closeSettings: $<HTMLButtonElement>("closeSettings"),
  scope: $("scope"),
  fileUrl: $<HTMLInputElement>("fileUrl"),
  pat: $<HTMLInputElement>("pat"),
  provider: $<HTMLSelectElement>("provider"),
  geminiFields: $("geminiFields"),
  geminiKey: $<HTMLInputElement>("geminiKey"),
  geminiModel: $<HTMLInputElement>("geminiModel"),
  localFields: $("localFields"),
  localUrl: $<HTMLInputElement>("localUrl"),
  localModel: $<HTMLInputElement>("localModel"),
  localKey: $<HTMLInputElement>("localKey"),
  excludeResolved: $<HTMLInputElement>("excludeResolved"),
  includeScreenshotRow: $("includeScreenshotRow"),
  includeScreenshot: $<HTMLInputElement>("includeScreenshot"),
  includeScreenshotLabel: $("includeScreenshotLabel"),
  dataHint: $("dataHint"),
  save: $<HTMLButtonElement>("save"),
  test: $<HTMLButtonElement>("test"),
  testResult: $("testResult"),
  run: $<HTMLButtonElement>("run"),
  preview: $("preview"),
  error: $("error"),
  status: $("status"),
  imageProof: $("imageProof"),
  result: $("result"),
  resultToolbar: $("resultToolbar"),
  copy: $<HTMLButtonElement>("copy"),
  copyLabel: $("copyLabel"),
  insert: $<HTMLButtonElement>("insert"),
};

// --- state ---
let scopeNodeIds: string[] = [];
let scopeBboxes: Rect[] = [];
let scopeWholePage = false;
let scopeSelectionCount = 0;
let scopeReady = false;
let pendingScreenshot: Promise<ScreenshotImage[]> | null = null;
let resolveScreenshot: ((images: ScreenshotImage[]) => void) | null = null;
let busy = false;
let lastMarkdown = "";
let loadedThreads: CommentThread[] | null = null; // result of a scan, pending summarize
let scanSignature = ""; // invalidates loadedThreads when scope/url/options change
let resultSignature = ""; // invalidates the rendered result when scope/url/options change

// --- config ---
function readConfig(): SavedConfig {
  const provider = els.provider.value as LLMConfig["provider"];
  const llm: LLMConfig =
    provider === "gemini"
      ? {
          provider,
          apiKey: els.geminiKey.value.trim() || undefined,
          model: els.geminiModel.value.trim() || "gemini-2.5-pro",
        }
      : {
          provider,
          baseUrl: els.localUrl.value.trim() || "http://localhost:11434",
          model: els.localModel.value.trim() || "llama3.1",
          apiKey: els.localKey.value.trim() || undefined,
        };
  return {
    pat: els.pat.value.trim() || undefined,
    llm,
    excludeResolved: els.excludeResolved.checked,
    includeScreenshot: els.includeScreenshot.checked,
  };
}

function applyConfig(cfg: SavedConfig) {
  if (cfg.pat) els.pat.value = cfg.pat;
  els.excludeResolved.checked = !!cfg.excludeResolved;
  els.includeScreenshot.checked = !!cfg.includeScreenshot;
  const llm = cfg.llm;
  if (llm) {
    els.provider.value = llm.provider;
    if (llm.provider === "gemini") {
      els.geminiKey.value = llm.apiKey ?? "";
      els.geminiModel.value = llm.model ?? "gemini-2.5-pro";
    } else {
      els.localUrl.value = llm.baseUrl ?? "";
      els.localModel.value = llm.model ?? "";
      els.localKey.value = llm.apiKey ?? "";
    }
  }
  toggleProviderFields();
  if (!cfg.pat || !hasLlmKey(readConfig().llm)) showSettings();
  refreshRunState();
}

// --- view navigation: main summarizer vs. the credentials/model screen ---
function showSettings() {
  els.mainView.classList.add("hidden");
  els.settingsView.classList.remove("hidden");
  reportHeight();
}
function showMain() {
  els.settingsView.classList.add("hidden");
  els.mainView.classList.remove("hidden");
  reportHeight();
}

function persist() {
  send({ type: "save-config", config: readConfig() });
}

function hasLlmKey(llm?: LLMConfig): boolean {
  if (!llm) return false;
  return llm.provider === "gemini" ? !!llm.apiKey : !!llm.baseUrl;
}

function toggleProviderFields() {
  const gemini = els.provider.value === "gemini";
  els.geminiFields.classList.toggle("hidden", !gemini);
  els.localFields.classList.toggle("hidden", gemini);
  updateScreenshotRowVisibility();
}

// Screenshot context needs at least one specific selected node to export (not
// a whole-page scope), and only Gemini supports image input in this plugin.
function updateScreenshotRowVisibility() {
  const eligible = els.provider.value === "gemini" && scopeSelectionCount > 0;
  els.includeScreenshotRow.classList.toggle("hidden", !eligible);
  els.includeScreenshotLabel.textContent =
    scopeSelectionCount > 1
      ? `Include screenshots of the ${scopeSelectionCount} selected frames as visual context`
      : "Include a screenshot of the selection as visual context";
  updateDataHint(eligible);
}

function updateDataHint(screenshotEligible: boolean) {
  const sendingScreenshot = screenshotEligible && els.includeScreenshot.checked;
  els.dataHint.textContent = sendingScreenshot
    ? "Your token & LLM key are stored locally in Figma (clientStorage). Comment text AND a screenshot of the selected frame are sent to your chosen LLM for summarization — review its provider's data policy."
    : "Your token & LLM key are stored locally in Figma (clientStorage). Comment text is sent to your chosen LLM for summarization — review its provider's data policy.";
}

function currentSignature(): string {
  return [
    els.fileUrl.value.trim(),
    els.excludeResolved.checked ? "1" : "0",
    els.includeScreenshot.checked ? "1" : "0",
    scopeNodeIds.length,
    els.scope.dataset.label || "",
  ].join("|");
}

function configReady(): boolean {
  const cfg = readConfig();
  return scopeReady && !!cfg.pat && hasLlmKey(cfg.llm) && !!parseFileKey(els.fileUrl.value);
}

function refreshRunState() {
  // Invalidate a previous scan if scope/url/options changed.
  if (loadedThreads && currentSignature() !== scanSignature) {
    loadedThreads = null;
    els.preview.classList.add("hidden");
  }
  // Same for a previously-rendered result: don't leave a summary for a frame
  // you're no longer scoped to sitting on screen (and holding the window tall).
  if (!els.result.classList.contains("hidden") && currentSignature() !== resultSignature) {
    els.result.classList.add("hidden");
    els.resultToolbar.classList.add("hidden");
    els.imageProof.classList.add("hidden");
    lastMarkdown = "";
  }
  els.run.disabled = busy || !configReady();
  els.run.textContent = loadedThreads
    ? `Summarize ${countComments(loadedThreads)} comments`
    : "Scan comments";
}

function countComments(threads: CommentThread[]): number {
  return threads.reduce((n, t) => n + 1 + t.replies.length, 0);
}

// --- UI helpers ---
function showError(msg: string) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
}
function clearError() {
  els.error.classList.add("hidden");
  els.error.textContent = "";
}
function setStatus(msg: string | null) {
  if (!msg) {
    els.status.classList.add("hidden");
    els.status.innerHTML = "";
  } else {
    els.status.classList.remove("hidden");
    els.status.innerHTML = `<span class="spinner"></span>${escapeHtml(msg)}`;
  }
}
// Measure the content wrapper itself, not document.body: Figma's plugin
// iframe host can impose its own sizing on <body> (observed in practice as
// the window never shrinking back down), which also makes body.scrollHeight
// an unreliable read. #app's height is purely intrinsic to its content.
let lastReportedHeight = 0;
function reportHeight() {
  const h = Math.ceil(els.app.getBoundingClientRect().height) + 4;
  // Guard against feedback loops: resizing the window can itself change
  // #app's measured height by a px or two (rounding/scrollbar), which would
  // otherwise re-trigger the observer below and creep the height up forever.
  if (Math.abs(h - lastReportedHeight) < 2) return;
  lastReportedHeight = h;
  send({ type: "resize", height: h });
}

// Belt-and-suspenders: rather than relying solely on every state change
// remembering to call reportHeight() (a manual list that's proven easy to
// miss a spot on), watch the content wrapper's actual rendered size directly
// and stay in sync automatically whenever it changes, for any reason.
new ResizeObserver(() => reportHeight()).observe(els.app);

// --- scan: fetch + filter, preview the count before spending an LLM call ---
async function scan() {
  clearError();
  els.result.classList.add("hidden");
  els.resultToolbar.classList.add("hidden");
  els.imageProof.classList.add("hidden");
  const cfg = readConfig();
  const fileKey = parseFileKey(els.fileUrl.value);
  if (!fileKey)
    return showError(
      "Could not detect this file's key. It may be unsaved — save it in Figma and reopen the plugin."
    );
  if (!cfg.pat) return showError("Add your Figma personal access token in Credentials.");

  busy = true;
  refreshRunState();
  try {
    setStatus("Fetching comments…");
    const all = await fetchComments(fileKey, cfg.pat);
    const scoped = filterByScope(all, {
      nodeIds: scopeNodeIds,
      bboxes: scopeBboxes,
      wholePage: scopeWholePage,
    });
    let threads = groupThreads(scoped);
    if (cfg.excludeResolved) threads = threads.filter((t) => !t.root.resolved_at);

    if (threads.length === 0) {
      setStatus(null);
      els.preview.classList.add("hidden");
      return showError(
        cfg.excludeResolved
          ? "No unresolved comments are pinned to the current selection. Try a different frame, deselect for the whole page, or include resolved threads."
          : "No comments are pinned to the current selection. Try a different frame/section, deselect for the whole page, or confirm the file URL matches this file."
      );
    }

    loadedThreads = threads;
    scanSignature = currentSignature();
    const n = countComments(threads);
    const tokens = approxTokens(formatComments(threads, els.scope.dataset.label || ""));
    const big = formatComments(threads, "").length > MAX_CHARS;
    els.preview.innerHTML =
      `Found <b>${n}</b> comment${n === 1 ? "" : "s"} across <b>${threads.length}</b> thread${
        threads.length === 1 ? "" : "s"
      } (~${tokens.toLocaleString()} tokens).` +
      (big ? " Large volume — will summarize in batches." : "");
    els.preview.classList.remove("hidden");
    setStatus(null);
  } catch (e) {
    setStatus(null);
    showError(errMsg(e));
  } finally {
    busy = false;
    refreshRunState();
    reportHeight();
  }
}

// Ask the main thread to export every currently-selected node as a PNG and
// wait for the reply.
function requestScreenshot(): Promise<ScreenshotImage[]> {
  if (!pendingScreenshot) {
    pendingScreenshot = new Promise((resolve) => {
      resolveScreenshot = resolve;
    });
    send({ type: "capture-screenshot" });
  }
  return pendingScreenshot;
}

// Visible proof of whether screenshots actually went into this summary's LLM
// call, with thumbnails of the exact images sent — not just a trust-me toggle.
function showImageProof(requested: boolean | undefined, screenshots: ScreenshotImage[]) {
  if (!requested) {
    els.imageProof.classList.add("hidden");
    els.imageProof.innerHTML = "";
    return;
  }
  els.imageProof.classList.remove("hidden");
  if (screenshots.length > 0) {
    const thumbs = screenshots
      .map(
        (s) =>
          `<img src="${s.dataUrl}" title="${escapeHtml(s.name)}" ` +
          `style="width:32px;height:32px;object-fit:cover;border-radius:4px;border:1px solid var(--border);flex:none" />`
      )
      .join("");
    const note =
      screenshots.length === 1
        ? `This screenshot was sent to the LLM as visual context alongside the comments.`
        : `These ${screenshots.length} screenshots were sent to the LLM as visual context alongside the comments.`;
    els.imageProof.innerHTML = `<div style="display:flex;gap:4px;flex:none">${thumbs}</div><span class="hint">${note}</span>`;
  } else {
    els.imageProof.innerHTML =
      `<span class="hint">⚠ Screenshots were requested but none could be captured — this summary used comment text only.</span>`;
  }
}

// --- summarize: single call, or map-reduce when the volume is large ---
async function doSummarize() {
  if (!loadedThreads) return;
  clearError();
  els.imageProof.classList.add("hidden");
  const cfg = readConfig();
  const label = els.scope.dataset.label || "selection";
  const onProgress = (note: string) => setStatus(note);

  busy = true;
  refreshRunState();
  try {
    let screenshots: ScreenshotImage[] = [];
    const wantsImage =
      cfg.includeScreenshot && cfg.llm?.provider === "gemini" && scopeSelectionCount > 0;
    if (wantsImage) {
      setStatus(
        scopeSelectionCount > 1 ? `Capturing ${scopeSelectionCount} screenshots…` : "Capturing screenshot…"
      );
      screenshots = await requestScreenshot();
    }
    const images: ImageInput[] = screenshots.map((s) => ({
      mimeType: "image/png",
      base64: s.dataUrl.split(",")[1] ?? "",
    }));

    const content = formatComments(loadedThreads, label);
    let markdown: string;

    if (content.length <= MAX_CHARS) {
      setStatus(`Summarizing ${countComments(loadedThreads)} comments…`);
      markdown = await summarize(cfg.llm!, SYSTEM_PROMPT, content, { onProgress, images });
    } else {
      const batches = batchThreads(loadedThreads, MAX_CHARS - 6000);
      const digests: string[] = [];
      for (let i = 0; i < batches.length; i++) {
        setStatus(`Condensing batch ${i + 1} of ${batches.length}…`);
        const d = await summarize(
          cfg.llm!,
          DIGEST_SYSTEM_PROMPT,
          formatComments(batches[i], label),
          { onProgress }
        );
        digests.push(d);
      }
      setStatus("Merging into final summary…");
      const combined = `Scope: ${label}\nCondensed notes from ${countComments(
        loadedThreads
      )} comments across ${loadedThreads.length} threads:\n\n${digests.join("\n\n")}`;
      // Only the final synthesis call gets the images — the per-batch condensing
      // calls are pure text digests, so there's nothing visual for them to ground.
      markdown = await summarize(cfg.llm!, SYSTEM_PROMPT, combined, { onProgress, images });
    }

    lastMarkdown = markdown;
    resultSignature = currentSignature();
    els.result.innerHTML = renderSummary(markdown);
    els.result.classList.remove("hidden");
    els.resultToolbar.classList.remove("hidden");
    showImageProof(wantsImage, screenshots);
    setStatus(null);
  } catch (e) {
    setStatus(null);
    showError(errMsg(e));
  } finally {
    busy = false;
    refreshRunState();
    reportHeight();
  }
}

function errMsg(e: unknown): string {
  if (e instanceof FigmaApiError || e instanceof LLMError) return e.message;
  return `Unexpected error: ${String(e)}`;
}

// --- test connection ---
async function testConnection() {
  els.testResult.classList.remove("hidden");
  els.testResult.className = "muted";
  els.testResult.textContent = "Testing…";
  const cfg = readConfig();
  const results: string[] = [];
  let ok = true;
  try {
    if (!cfg.pat) throw new FigmaApiError(0, "no token");
    const who = await testToken(cfg.pat);
    results.push(`✓ Figma token (${who})`);
  } catch (e) {
    ok = false;
    results.push(`✗ Figma token: ${errMsg(e)}`);
  }
  try {
    if (!hasLlmKey(cfg.llm)) throw new LLMError("no key/endpoint");
    results.push(`✓ ${await testLlm(cfg.llm!)}`);
  } catch (e) {
    ok = false;
    results.push(`✗ LLM: ${errMsg(e)}`);
  }
  els.testResult.className = ok ? "ok-text" : "error";
  els.testResult.textContent = results.join("\n");
  reportHeight();
}

// --- events ---
els.provider.addEventListener("change", () => {
  toggleProviderFields();
  refreshRunState();
  reportHeight();
});
for (const el of [els.pat, els.geminiKey, els.localUrl]) {
  el.addEventListener("input", refreshRunState);
}
els.excludeResolved.addEventListener("change", () => {
  persist();
  refreshRunState();
});
els.includeScreenshot.addEventListener("change", () => {
  persist();
  updateDataHint(els.provider.value === "gemini" && scopeSelectionCount > 0);
  refreshRunState();
});
els.save.addEventListener("click", () => {
  persist();
  send({ type: "notify", message: "Credentials saved" });
});
els.test.addEventListener("click", testConnection);
els.openSettings.addEventListener("click", showSettings);
els.closeSettings.addEventListener("click", showMain);
els.run.addEventListener("click", () => {
  if (loadedThreads) void doSummarize();
  else void scan();
});
els.insert.addEventListener("click", () => {
  if (!lastMarkdown) return;
  send({
    type: "insert-frame",
    markdown: lastMarkdown,
    label: els.scope.dataset.label || "selection",
  });
});
// Figma's plugin iframe frequently blocks the async Clipboard API (permissions
// policy varies by desktop/browser build), so fall back to the classic
// textarea + execCommand trick, which works reliably in that sandbox.
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

// Confirm in-place (swap the label) rather than relying on the toast alone —
// a copy button needs its own visible confirmation, not just a side notification.
function confirmCopied() {
  els.copyLabel.textContent = "Copied";
  els.copy.disabled = true;
  setTimeout(() => {
    els.copyLabel.textContent = "Copy";
    els.copy.disabled = false;
  }, 1500);
}

els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastMarkdown);
    confirmCopied();
  } catch {
    if (legacyCopy(lastMarkdown)) {
      confirmCopied();
    } else {
      send({ type: "notify", message: "Copy failed", error: true });
    }
  }
});

window.onmessage = (event: MessageEvent) => {
  const msg = event.data.pluginMessage as MainToUI | undefined;
  if (!msg) return;
  if (msg.type === "config") {
    applyConfig(msg.config);
    reportHeight();
  } else if (msg.type === "scope") {
    scopeNodeIds = msg.nodeIds;
    scopeBboxes = msg.bboxes;
    scopeWholePage = msg.wholePage;
    scopeSelectionCount = msg.selectionCount;
    scopeReady = true;
    els.scope.dataset.label = msg.label;
    els.scope.innerHTML = `Summarizing comments on: <b>${escapeHtml(msg.label)}</b>`;
    els.fileUrl.value = msg.fileKey ?? ""; // auto-detected; no manual entry UI
    updateScreenshotRowVisibility();
    refreshRunState();
    reportHeight();
  } else if (msg.type === "screenshot") {
    resolveScreenshot?.(msg.images);
    resolveScreenshot = null;
    pendingScreenshot = null;
  }
};

send({ type: "ready" });
