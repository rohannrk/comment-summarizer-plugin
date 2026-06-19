// Figma REST API comment fetching + threading. Runs in the UI iframe (has network).

import type { Rect } from "./messages";

export interface FigmaComment {
  id: string;
  parent_id?: string;
  message: string;
  created_at: string;
  resolved_at?: string | null;
  user: { handle: string; id?: string };
  client_meta?: {
    node_id?: string;
    node_offset?: { x: number; y: number };
    x?: number;
    y?: number;
  } | null;
}

export interface CommentThread {
  root: FigmaComment;
  replies: FigmaComment[];
}

export class FigmaApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FigmaApiError";
  }
}

// Extract the file key from a figma.com file/design URL.
export function parseFileKey(url: string): string | null {
  const trimmed = url.trim();
  // Accept a bare key as well.
  if (/^[A-Za-z0-9]{10,}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/figma\.com\/(?:file|design|board)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Cheap validation of a personal access token (does not need a file key).
export async function testToken(pat: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch("https://api.figma.com/v1/me", {
      headers: { "X-Figma-Token": pat },
    });
  } catch (e) {
    throw new FigmaApiError(0, `Network error reaching Figma: ${String(e)}`);
  }
  if (res.status === 403) {
    throw new FigmaApiError(403, "Token rejected (403). Check the token value.");
  }
  if (!res.ok) {
    throw new FigmaApiError(res.status, `Figma API error ${res.status}.`);
  }
  const me = await res.json();
  return me?.handle || me?.email || "your account";
}

export async function fetchComments(
  fileKey: string,
  pat: string
): Promise<FigmaComment[]> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/comments`,
      { headers: { "X-Figma-Token": pat } }
    );
  } catch (e) {
    throw new FigmaApiError(0, `Network error reaching Figma: ${String(e)}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.err || body?.message || "";
    } catch {
      /* ignore */
    }
    if (res.status === 403) {
      throw new FigmaApiError(
        403,
        `Figma rejected the token (403). Check that your personal access token is valid and has the "file_comments:read" scope. ${detail}`
      );
    }
    if (res.status === 404) {
      throw new FigmaApiError(
        404,
        `File not found (404). Check the file URL points to a file you can access. ${detail}`
      );
    }
    throw new FigmaApiError(res.status, `Figma API error ${res.status}. ${detail}`);
  }

  const data = await res.json();
  return (data.comments ?? []) as FigmaComment[];
}

export interface Scope {
  nodeIds: string[];
  bboxes?: Rect[]; // for coordinate-pinned (free-floating) comments
  wholePage?: boolean; // include all coordinate-pinned comments when true
}

function pointInAny(x: number, y: number, rects: Rect[]): boolean {
  return rects.some(
    (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
  );
}

// Keep comments in scope:
//   - node-pinned  -> the pinned node id is within the scope's node-id set
//   - coordinate-pinned (no node_id) -> the pin falls inside a selection bbox,
//     or the whole page is in scope
// Replies (which carry no client_meta) are kept when their parent root is in scope.
export function filterByScope(comments: FigmaComment[], scope: Scope): FigmaComment[] {
  const ids = new Set(scope.nodeIds);
  const bboxes = scope.bboxes ?? [];
  const wholePage = !!scope.wholePage;
  const inScopeIds = new Set<string>();

  // First pass: roots in scope.
  for (const c of comments) {
    if (c.parent_id) continue;
    const cm = c.client_meta;
    if (!cm) continue;
    if (cm.node_id) {
      if (ids.has(cm.node_id)) inScopeIds.add(c.id);
    } else if (typeof cm.x === "number" && typeof cm.y === "number") {
      if (wholePage || pointInAny(cm.x, cm.y, bboxes)) inScopeIds.add(c.id);
    }
  }

  // Second pass: replies whose parent root is in scope.
  return comments.filter(
    (c) => inScopeIds.has(c.id) || (c.parent_id && inScopeIds.has(c.parent_id))
  );
}

// Group flat comments into threads (root + chronological replies).
export function groupThreads(comments: FigmaComment[]): CommentThread[] {
  const roots = comments.filter((c) => !c.parent_id);
  const byParent = new Map<string, FigmaComment[]>();
  for (const c of comments) {
    if (!c.parent_id) continue;
    const arr = byParent.get(c.parent_id) ?? [];
    arr.push(c);
    byParent.set(c.parent_id, arr);
  }
  const byTime = (a: FigmaComment, b: FigmaComment) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime();

  return roots.sort(byTime).map((root) => ({
    root,
    replies: (byParent.get(root.id) ?? []).sort(byTime),
  }));
}
