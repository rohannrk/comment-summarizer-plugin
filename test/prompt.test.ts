import { test } from "node:test";
import assert from "node:assert/strict";
import { formatComments, batchThreads, approxTokens } from "../src/prompt";
import type { CommentThread, FigmaComment } from "../src/figma-comments";

function root(id: string, msg: string, replies: FigmaComment[] = []): CommentThread {
  return {
    root: {
      id,
      message: msg,
      created_at: "2026-06-01T00:00:00Z",
      user: { handle: "alice" },
    },
    replies,
  };
}

test("formatComments: header counts threads + comments, nests replies", () => {
  const threads = [
    root("1", "First", [
      {
        id: "2",
        parent_id: "1",
        message: "Reply",
        created_at: "2026-06-02T00:00:00Z",
        user: { handle: "bob" },
        resolved_at: "2026-06-03T00:00:00Z",
      },
    ]),
  ];
  const out = formatComments(threads, 'Frame "X"');
  assert.match(out, /Scope: Frame "X"/);
  assert.match(out, /Total comments: 2 across 1 thread/);
  assert.match(out, /@alice \(2026-06-01\): First/);
  assert.match(out, /└ @bob \(2026-06-02\): Reply \[resolved\]/);
});

test("batchThreads: splits when over the char budget", () => {
  const big = "x".repeat(500);
  const threads = Array.from({ length: 6 }, (_, i) => root(String(i), big));
  const batches = batchThreads(threads, 1200);
  assert.ok(batches.length > 1, "should produce multiple batches");
  // every thread is preserved exactly once
  const total = batches.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 6);
});

test("approxTokens: ~4 chars per token", () => {
  assert.equal(approxTokens("abcd"), 1);
  assert.equal(approxTokens("abcde"), 2);
});
