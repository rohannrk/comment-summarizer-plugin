import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySection,
  splitSections,
  listBullets,
  parsePerson,
  parseTask,
  initials,
  buildSummaryText,
} from "../src/summary-model";

test("classifySection: maps headings to keys", () => {
  assert.equal(classifySection("Summary"), "summary");
  assert.equal(classifySection("People involved"), "people");
  assert.equal(classifySection("Action items"), "actions");
  assert.equal(classifySection("Notes"), "other");
});

test("splitSections: groups lines under their heading", () => {
  const secs = splitSections("## Summary\nrecap\n## Action items\n- [ ] do it");
  assert.equal(secs.length, 2);
  assert.equal(secs[0].key, "summary");
  assert.deepEqual(secs[0].lines, ["recap"]);
  assert.equal(secs[1].key, "actions");
});

test("parsePerson: handles dash and colon, strips @ and bold", () => {
  assert.deepEqual(parsePerson("@sarah — Reduce friction"), { name: "sarah", phrase: "Reduce friction" });
  assert.deepEqual(parsePerson("**John**: improve validation"), { name: "John", phrase: "improve validation" });
  assert.deepEqual(parsePerson("Maya"), { name: "Maya", phrase: "" });
});

test("parseTask: detects done state and strips owner/status noise", () => {
  assert.deepEqual(parseTask("[x] Update copy"), { label: "Update copy", done: true });
  assert.deepEqual(parseTask("[ ] Simplify step 2"), { label: "Simplify step 2", done: false });
  assert.deepEqual(parseTask("[ ] Review states — owner: @bob"), { label: "Review states", done: false });
});

test("initials: 1-2 letters, uppercased", () => {
  assert.equal(initials("sarah"), "S");
  assert.equal(initials("Maya Rodriguez"), "MR");
  assert.equal(initials(""), "?");
});

test("listBullets: extracts bullet text", () => {
  assert.deepEqual(listBullets(["- a", "text", "* b"]), ["a", "b"]);
});

test("buildSummaryText: renders sections to text with titles, glyphs, and spans", () => {
  const md = [
    "## Summary",
    "Team discussed the onboarding flow.",
    "## People",
    "- **Sarah** — wants fewer steps",
    "## Action items",
    "- [x] Ship copy fix",
    "- [ ] Review empty state",
  ].join("\n");
  const { text, spans } = buildSummaryText(md);

  // Content + glyph substitutions.
  assert.ok(text.includes("Summary"));
  assert.ok(text.includes("Team discussed the onboarding flow."));
  assert.ok(text.includes("• Sarah"));
  assert.ok(text.includes("—  wants fewer steps"));
  assert.ok(text.includes("☑ Ship copy fix"));
  assert.ok(text.includes("☐ Review empty state"));
  assert.ok(!/\s$/.test(text), "trailing whitespace is trimmed");

  // Every span is within bounds.
  for (const sp of spans) {
    assert.ok(sp.start >= 0 && sp.start < sp.end && sp.end <= text.length);
  }

  // Section titles are bold headings covering exactly the title text.
  const heading = spans.find((s) => s.heading && text.slice(s.start, s.end).startsWith("Summary"));
  assert.ok(heading?.bold, "section title is a bold heading");

  // A completed task is struck through and secondary-colored.
  const struck = spans.find((s) => s.strike);
  assert.ok(struck, "done task produces a strike span");
  assert.equal(struck!.color, "secondary");
  assert.equal(text.slice(struck!.start, struck!.end).trim(), "Ship copy fix");

  // The person's name is bold (and not a heading).
  const nameSpan = spans.find((s) => s.bold && !s.heading && text.slice(s.start, s.end) === "Sarah");
  assert.ok(nameSpan, "person name is bold");
});

test("buildSummaryText: empty input yields empty text and no spans", () => {
  const { text, spans } = buildSummaryText("   \n  \n");
  assert.equal(text, "");
  assert.deepEqual(spans, []);
});

test("buildSummaryText: plain markdown with no headings still renders bullets", () => {
  const { text } = buildSummaryText("- first point\n- second point");
  assert.ok(text.includes("• first point"));
  assert.ok(text.includes("• second point"));
});
