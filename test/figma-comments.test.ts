import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFileKey,
  filterByScope,
  groupThreads,
  type FigmaComment,
} from "../src/figma-comments";

function c(over: Partial<FigmaComment>): FigmaComment {
  return {
    id: "x",
    message: "m",
    created_at: "2026-06-01T00:00:00Z",
    user: { handle: "alice" },
    ...over,
  };
}

test("parseFileKey: design/file/board URLs and bare keys", () => {
  assert.equal(parseFileKey("https://www.figma.com/design/AbC123xyz/My-File"), "AbC123xyz");
  assert.equal(parseFileKey("https://figma.com/file/KEY9876/Thing?node-id=1-2"), "KEY9876");
  assert.equal(parseFileKey("  KEY1234567  "), "KEY1234567");
  assert.equal(parseFileKey("not a url"), null);
  assert.equal(parseFileKey("https://example.com/design/x"), null);
});

test("filterByScope: keeps in-scope roots and their replies, drops out-of-scope", () => {
  const comments = [
    c({ id: "1", client_meta: { node_id: "10:1" } }), // in scope
    c({ id: "2", parent_id: "1" }), // reply to in-scope root
    c({ id: "3", client_meta: { node_id: "99:9" } }), // out of scope
    c({ id: "4", parent_id: "3" }), // reply to out-of-scope root
    c({ id: "5", client_meta: null }), // no client_meta -> dropped
  ];
  const kept = filterByScope(comments, { nodeIds: ["10:1", "10:2"] }).map((x) => x.id);
  assert.deepEqual(kept.sort(), ["1", "2"]);
});

test("filterByScope: coordinate-pinned comments match selection bbox", () => {
  const comments = [
    c({ id: "in", client_meta: { x: 50, y: 50 } }), // inside the box
    c({ id: "out", client_meta: { x: 500, y: 500 } }), // outside
  ];
  const bboxes = [{ x: 0, y: 0, width: 100, height: 100 }];
  const kept = filterByScope(comments, { nodeIds: [], bboxes }).map((x) => x.id);
  assert.deepEqual(kept, ["in"]);
});

test("filterByScope: wholePage includes all coordinate-pinned comments", () => {
  const comments = [c({ id: "a", client_meta: { x: 9999, y: 9999 } })];
  const kept = filterByScope(comments, { nodeIds: [], wholePage: true }).map((x) => x.id);
  assert.deepEqual(kept, ["a"]);
});

test("groupThreads: roots sorted by time, replies attached chronologically", () => {
  const comments = [
    c({ id: "r2", created_at: "2026-06-02T00:00:00Z" }),
    c({ id: "r1", created_at: "2026-06-01T00:00:00Z" }),
    c({ id: "a", parent_id: "r1", created_at: "2026-06-03T00:00:00Z" }),
    c({ id: "b", parent_id: "r1", created_at: "2026-06-01T12:00:00Z" }),
  ];
  const threads = groupThreads(comments);
  assert.deepEqual(threads.map((t) => t.root.id), ["r1", "r2"]);
  assert.deepEqual(threads[0].replies.map((r) => r.id), ["b", "a"]);
});
