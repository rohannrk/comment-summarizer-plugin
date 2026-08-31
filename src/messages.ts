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
  includeScreenshot?: boolean; // attach a screenshot of the selected frame as visual context (Gemini only)
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
      fileKey?: string; // this file's key, auto-detected via figma.fileKey
      singleNode: boolean; // true when exactly one node is selected
      selectionCount: number; // number of top-level selected nodes (0 for whole-page scope; screenshot-eligible when > 0)
    }
  | { type: "config"; config: SavedConfig }
  | { type: "screenshot"; images: ScreenshotImage[] }; // one PNG per exportable selected node (skips any that failed to export)

export interface ScreenshotImage {
  name: string; // the node's name, for labeling in the UI
  dataUrl: string;
}

// UI -> Main thread
export type UIToMain =
  | { type: "ready" }
  | { type: "save-config"; config: SavedConfig }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "resize"; height: number }
  | { type: "insert-frame"; markdown: string; label: string }
  | { type: "capture-screenshot" };
