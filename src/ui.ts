// UI iframe logic. Has network access; no figma.* here.
// Talks to the main thread via postMessage, fetches comments, calls the BYOK LLM.

import type { MainToUI, UIToMain, SavedConfig, LLMConfig, Rect } from "./messages";
import {
  parseFileKey,
  fetchComments,
  filterByScope,
  groupThreads,
  testToken,
  FigmaApiError,
  type CommentThread,
} from "./figma-comments";
import { summarize, testLlm, LLMError } from "./llm";
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
  scope: $("scope"),
  fileUrl: $<HTMLInputElement>("fileUrl"),
  config: $<HTMLDetailsElement>("config"),
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
  save: $<HTMLButtonElement>("save"),
  test: $<HTMLButtonElement>("test"),
  testResult: $("testResult"),
  run: $<HTMLButtonElement>("run"),
  preview: $("preview"),
  error: $("error"),
  status: $("status"),
  result: $("result"),
  resultToolbar: $("resultToolbar"),
  copy: $<HTMLButtonElement>("copy"),
  insert: $<HTMLButtonElement>("insert"),
};

// --- state ---
let scopeNodeIds: string[] = [];
let scopeBboxes: Rect[] = [];
let scopeWholePage = false;
let scopeReady = false;
let busy = false;
let lastMarkdown = "";
let loadedThreads: CommentThread[] | null = null; // result of a scan, pending summarize
let scanSignature = ""; // invalidates loadedThreads when scope/url/options change

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
  };
}

function applyConfig(cfg: SavedConfig) {
  if (cfg.pat) els.pat.value = cfg.pat;
  els.excludeResolved.checked = !!cfg.excludeResolved;
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
  if (!cfg.pat || !hasLlmKey(readConfig().llm)) els.config.open = true;
  refreshRunState();
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
}

function currentSignature(): string {
  return [
    els.fileUrl.value.trim(),
    els.excludeResolved.checked ? "1" : "0",
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
function reportHeight() {
  send({ type: "resize", height: document.body.scrollHeight + 4 });
}

// --- scan: fetch + filter, preview the count before spending an LLM call ---
async function scan() {
  clearError();
  els.result.classList.add("hidden");
  els.resultToolbar.classList.add("hidden");
  const cfg = readConfig();
  const fileKey = parseFileKey(els.fileUrl.value);
  if (!fileKey) return showError("Could not read a file key from that URL.");
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

// --- summarize: single call, or map-reduce when the volume is large ---
async function doSummarize() {
  if (!loadedThreads) return;
  clearError();
  const cfg = readConfig();
  const label = els.scope.dataset.label || "selection";
  const onProgress = (note: string) => setStatus(note);

  busy = true;
  refreshRunState();
  try {
    const content = formatComments(loadedThreads, label);
    let markdown: string;

    if (content.length <= MAX_CHARS) {
      setStatus(`Summarizing ${countComments(loadedThreads)} comments…`);
      markdown = await summarize(cfg.llm!, SYSTEM_PROMPT, content, { onProgress });
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
      markdown = await summarize(cfg.llm!, SYSTEM_PROMPT, combined, { onProgress });
    }

    lastMarkdown = markdown;
    els.result.innerHTML = renderSummary(markdown);
    els.result.classList.remove("hidden");
    els.resultToolbar.classList.remove("hidden");
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
for (const el of [els.fileUrl, els.pat, els.geminiKey, els.localUrl]) {
  el.addEventListener("input", refreshRunState);
}
els.excludeResolved.addEventListener("change", () => {
  persist();
  refreshRunState();
});
els.save.addEventListener("click", () => {
  persist();
  send({ type: "notify", message: "Credentials saved" });
});
els.test.addEventListener("click", testConnection);
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
els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastMarkdown);
    send({ type: "notify", message: "Copied summary" });
  } catch {
    send({ type: "notify", message: "Copy failed", error: true });
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
    scopeReady = true;
    els.scope.dataset.label = msg.label;
    els.scope.innerHTML = `Summarizing comments on: <b>${escapeHtml(msg.label)}</b>`;
    refreshRunState();
  }
};

send({ type: "ready" });
