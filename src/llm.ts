// BYOK LLM provider abstraction. Runs in the UI iframe (has network).
// Supports Gemini (Google Generative Language API) and any local/OpenAI-compatible endpoint.
// Adds retry-with-backoff on transient errors (503/429) and, for Gemini, a model
// fallback chain: try the most capable model first, step down if one stays unavailable.

import type { LLMConfig } from "./messages";

export class LLMError extends Error {}

// HTTP error carrying the status code so retry/fallback logic can branch on it.
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3; // per model

// Most capable -> lightest. Earlier = "nicer"; we fall back down the list.
const GEMINI_FALLBACK = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

export interface SummarizeOpts {
  // Called as each model/attempt starts, so the UI can show progress.
  onProgress?: (note: string) => void;
}

export async function summarize(
  config: LLMConfig,
  systemPrompt: string,
  userContent: string,
  opts: SummarizeOpts = {}
): Promise<string> {
  if (config.provider === "gemini")
    return callGemini(config, systemPrompt, userContent, opts);
  return callLocal(config, systemPrompt, userContent, opts);
}

async function callGemini(
  config: LLMConfig,
  systemPrompt: string,
  userContent: string,
  opts: SummarizeOpts
): Promise<string> {
  if (!config.apiKey) throw new LLMError("Gemini API key is required.");

  // Build the candidate list: user's chosen model first, then the rest of the chain.
  const models = dedupe([config.model, ...GEMINI_FALLBACK].filter(Boolean));
  let lastErr: unknown;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      return await withRetry(
        (attempt) => {
          opts.onProgress?.(
            `Summarizing with ${model}${attempt > 0 ? ` (retry ${attempt})` : ""}…`
          );
          return geminiOnce(config.apiKey!, model, systemPrompt, userContent);
        },
        opts
      );
    } catch (e) {
      lastErr = e;
      const status = e instanceof HttpError ? e.status : -1;
      const canFallback = RETRYABLE.has(status) || status === 404; // overloaded or model missing
      if (canFallback && i < models.length - 1) {
        opts.onProgress?.(`${model} unavailable — trying ${models[i + 1]}…`);
        continue;
      }
      throw toLLMError(e);
    }
  }
  throw toLLMError(lastErr);
}

async function geminiOnce(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;
  const data = await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text ?? "")
    .join("");
  if (!text) {
    const reason =
      data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
    throw new LLMError(`Gemini returned no text${reason ? ` (${reason})` : ""}.`);
  }
  return text.trim();
}

async function callLocal(
  config: LLMConfig,
  systemPrompt: string,
  userContent: string,
  opts: SummarizeOpts
): Promise<string> {
  const base = (config.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  const model = config.model || "llama3.1";

  try {
    const data = await withRetry((attempt) => {
      opts.onProgress?.(
        `Summarizing with ${model}${attempt > 0 ? ` (retry ${attempt})` : ""}…`
      );
      return requestJson(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
      });
    }, opts);
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new LLMError("Local LLM returned no content.");
    return String(text).trim();
  } catch (e) {
    throw toLLMError(e);
  }
}

// Lightweight reachability/auth check for the configured LLM (lists models;
// does not consume generation tokens).
export async function testLlm(config: LLMConfig): Promise<string> {
  try {
    if (config.provider === "gemini") {
      if (!config.apiKey) throw new LLMError("Gemini API key is required.");
      await requestJson("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": config.apiKey },
      });
      return "Gemini reachable";
    }
    const base = (config.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    const headers: Record<string, string> = {};
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    await requestJson(`${base}/v1/models`, { headers });
    return "Local endpoint reachable";
  } catch (e) {
    throw toLLMError(e);
  }
}

// --- shared helpers ---

// Retry the request while it fails with a transient (retryable) status.
async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: SummarizeOpts
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof HttpError && RETRYABLE.has(e.status);
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw e;
      const delay = 800 * Math.pow(2, attempt); // 0.8s, 1.6s
      opts.onProgress?.(`Model busy — retrying in ${Math.round(delay / 100) / 10}s…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function requestJson(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Network failures are transient enough to retry.
    throw new HttpError(
      0,
      `Could not reach the LLM endpoint. ${String(
        e
      )} (If using a local model, ensure it is running, CORS is allowed, and the host is in manifest networkAccess.)`
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new HttpError(res.status, `LLM request failed (${res.status}). ${detail.slice(0, 500)}`);
  }
  try {
    return await res.json();
  } catch {
    throw new LLMError("LLM returned a non-JSON response.");
  }
}

function toLLMError(e: unknown): LLMError {
  if (e instanceof LLMError) return e;
  if (e instanceof HttpError) return new LLMError(e.message);
  return new LLMError(String(e));
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
