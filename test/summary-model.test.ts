import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySection,
  splitSections,
  listBullets,
  parsePerson,
  parseTask,
  initials,
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
