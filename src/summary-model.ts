// Pure parsing of the model's summary markdown into a structured model.
// Shared by the HTML renderer (markdown.ts) and the Figma frame builder (code.ts)
// so both stay in sync. No DOM/Figma globals here, so it is unit-testable.

export type SectionKey = "summary" | "people" | "actions" | "other";

export interface RawSection {
  title: string;
  key: SectionKey;
  lines: string[];
}

export interface Person {
  name: string;
  phrase: string;
}

export interface Task {
  label: string;
  done: boolean;
}

export function classifySection(title: string): SectionKey {
  const t = title.toLowerCase();
  if (t.includes("summary")) return "summary";
  if (t.includes("people") || t.includes("involved") || t.includes("participant"))
    return "people";
  if (t.includes("action") || t.includes("task") || t.includes("to-do") || t.includes("todo"))
    return "actions";
  return "other";
}

export function splitSections(md: string): RawSection[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (const raw of md.split("\n")) {
    const lineStr = raw.replace(/\s+$/, "");
    const h = lineStr.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      cur = { title: h[1].trim(), key: classifySection(h[1]), lines: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      if (!lineStr.trim()) continue;
      cur = { title: "", key: "other", lines: [] };
      sections.push(cur);
    }
    cur.lines.push(lineStr);
  }
  return sections;
}

export function listBullets(lines: string[]): string[] {
  return lines
    .map((l) => l.match(/^\s*[-*]\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1]);
}

export function parsePerson(text: string): Person {
  const t = text.replace(/^\*\*([^*]+)\*\*/, "$1").trim();
  let name = t;
  let phrase = "";
  const dash = t.match(/^(.+?)\s+[—–-]\s+(.+)$/);
  const colon = t.match(/^([^:]+):\s+(.+)$/);
  if (dash) {
    name = dash[1];
    phrase = dash[2];
  } else if (colon) {
    name = colon[1];
    phrase = colon[2];
  }
  name = name.replace(/\*\*/g, "").replace(/^@/, "").trim();
  phrase = phrase.replace(/\*\*/g, "").trim();
  return { name, phrase };
}

export function parseTask(text: string): Task {
  const cb = text.match(/^\[([ xX])\]\s*(.*)$/);
  const done = !!cb && cb[1].toLowerCase() === "x";
  let label = cb ? cb[2] : text;
  label = label.replace(/\s*[—–-]\s*owner:.*$/i, "").replace(/\s*\(status:[^)]*\)/i, "").trim();
  return { label, done };
}

// Initials for an avatar, e.g. "Sarah Lee" -> "SL", "sarah" -> "S".
export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

// Deterministic HSL color from a string (used for avatar backgrounds).
export function avatarHsl(name: string): { h: number; s: number; l: number } {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return { h, s: 60, l: 55 };
}
