import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderSummary, escapeHtml } from "../src/markdown";

test("escapeHtml: neutralizes angle brackets and ampersands", () => {
  assert.equal(escapeHtml('<img src=x onerror="y">&'), "&lt;img src=x onerror=\"y\"&gt;&amp;");
});

test("renderMarkdown: headings, bold, code", () => {
  const html = renderMarkdown("## Summary\nSome **bold** and `code`.");
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test("renderMarkdown: task checkboxes reflect checked state", () => {
  const html = renderMarkdown("- [ ] open task\n- [x] done task");
  assert.match(html, /<input type="checkbox" disabled\/> <span>open task<\/span>/);
  assert.match(html, /<input type="checkbox" disabled checked\/> <span>done task<\/span>/);
});

test("renderMarkdown: does not allow raw HTML injection", () => {
  const html = renderMarkdown("- <script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("renderSummary: builds icon sections for the three headings", () => {
  const md = [
    "## Summary",
    "Short recap.",
    "## People involved",
    "- @sarah — Reduce friction",
    "## Action items",
    "- [x] Update onboarding copy",
    "- [ ] Simplify step 2",
  ].join("\n");
  const html = renderSummary(md);
  assert.match(html, /sec-summary/);
  assert.match(html, /sec-people/);
  assert.match(html, /sec-actions/);
});

test("renderSummary: people line splits name, avatar, and phrase", () => {
  const html = renderSummary("## People involved\n- @sarah — Reduce friction");
  assert.match(html, /class="avatar"[^>]*>S</);
  assert.match(html, /class="pname">sarah</);
  assert.match(html, /class="pphrase">Reduce friction</);
});

test("renderSummary: completed task is checked and struck through", () => {
  const html = renderSummary("## Action items\n- [x] Update copy\n- [ ] Simplify step 2");
  assert.match(html, /class="task done"/);
  assert.match(html, /class="box checked"/);
  assert.match(html, /class="task "><span class="box "/); // unchecked item
});
