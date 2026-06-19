// Message contracts shared between the main thread (code.ts) and the UI iframe (ui.ts).

export interface LLMConfig {
  provider: "gemini" | "local";
  apiKey?: string; // Gemini API key, or optional bearer token for a local endpoint
  baseUrl?: string; // local/OpenAI-compatible base URL, e.g. http://localhost:11434
  model: string;
}

export interface SavedConfig {
  pat?: string; // Figma personal access token
  llm?: LLMConfig;
  excludeResolved?: boolean; // skip resolved threads when summarizing
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Main thread -> UI
export type MainToUI =
  | {
      type: "scope";
      nodeIds: string[];
      bboxes: Rect[]; // absolute bounding boxes of the selection, for coordinate-pinned comments
      wholePage: boolean; // true when nothing is selected (whole-page scope)
      label: string;
      count: number;
    }
  | { type: "config"; config: SavedConfig };

// UI -> Main thread
export type UIToMain =
  | { type: "ready" }
  | { type: "save-config"; config: SavedConfig }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "resize"; height: number }
  | { type: "insert-frame"; markdown: string; label: string };
