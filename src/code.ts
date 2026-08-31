// Main thread (Figma sandbox). Has access to figma.* but NO network.
// Responsibilities:
//   1. Compute the set of node IDs in scope (current selection, or whole page).
//   2. Persist / load credentials via figma.clientStorage on behalf of the UI.

import type { MainToUI, UIToMain, SavedConfig, Rect, ScreenshotImage } from "./messages";
import {
  splitSections,
  listBullets,
  parsePerson,
  parseTask,
  initials,
  avatarHsl,
  buildSummaryText,
  type SectionKey,
} from "./summary-model";

const CONFIG_KEY = "comment-summarizer-config";

function post(msg: MainToUI) {
  figma.ui.postMessage(msg);
}

// Walk a node's descendants breadth-first, yielding to the event loop every
// few hundred nodes so a huge subtree doesn't block Figma's UI thread while
// it's collected (a real problem on large enterprise files with 10k+ nodes).
async function collectDescendantIds(root: BaseNode, ids: Set<string>): Promise<void> {
  if (!("children" in root)) return;
  const queue: BaseNode[] = [...(root as ChildrenMixin).children];
  let sinceYield = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    ids.add(node.id);
    if ("children" in node) queue.push(...(node as ChildrenMixin).children);
    if (++sinceYield >= 500) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

// Collect the node IDs (and bounding boxes) in scope plus a readable label.
async function computeScope(): Promise<{
  nodeIds: string[];
  bboxes: Rect[];
  wholePage: boolean;
  label: string;
  singleNode: boolean;
  selectionCount: number;
}> {
  const ids = new Set<string>();
  const sel = figma.currentPage.selection;

  if (sel.length === 0) {
    // No selection -> whole current page (all coordinate-pinned comments count).
    ids.add(figma.currentPage.id);
    await collectDescendantIds(figma.currentPage, ids);
    return {
      nodeIds: [...ids],
      bboxes: [],
      wholePage: true,
      label: `Page "${figma.currentPage.name}"`,
      singleNode: false,
      selectionCount: 0,
    };
  }

  const bboxes: Rect[] = [];
  for (const node of sel) {
    ids.add(node.id);
    await collectDescendantIds(node, ids);
    if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
      const b = node.absoluteBoundingBox;
      bboxes.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
  }

  const top = sel[0];
  const label =
    sel.length === 1 ? `${prettyType(top.type)} "${top.name}"` : listLabel(sel);
  return {
    nodeIds: [...ids],
    bboxes,
    wholePage: false,
    label,
    singleNode: sel.length === 1,
    selectionCount: sel.length,
  };
}

// "Header, Footer, +2 more" style summary of a multi-selection, so the user
// can see exactly what's in scope without expanding it themselves.
function listLabel(sel: readonly SceneNode[]): string {
  const maxNamed = 3;
  const names = sel.slice(0, maxNamed).map((n) => n.name);
  const rest = sel.length - names.length;
  return rest > 0 ? `${names.join(", ")}, +${rest} more` : names.join(", ");
}

function prettyType(type: string): string {
  switch (type) {
    case "FRAME":
      return "Frame";
    case "SECTION":
      return "Section";
    case "GROUP":
      return "Group";
    case "COMPONENT":
      return "Component";
    case "INSTANCE":
      return "Instance";
    default:
      return type.charAt(0) + type.slice(1).toLowerCase();
  }
}

// Guards against a slow traversal from an older selection finishing after (and
// overwriting) the result of a newer one, when selections change in quick succession.
let scopeGeneration = 0;

async function sendScope() {
  const generation = ++scopeGeneration;
  const { nodeIds, bboxes, wholePage, label, singleNode, selectionCount } = await computeScope();
  if (generation !== scopeGeneration) return; // superseded by a later selection change
  post({
    type: "scope",
    nodeIds,
    bboxes,
    wholePage,
    label,
    count: nodeIds.length,
    fileKey: figma.fileKey,
    singleNode,
    selectionCount,
  });
}

// Cap on how many frames get screenshotted at once — bounds payload size and
// image token cost when someone selects a large batch of frames.
const MAX_SCREENSHOTS = 6;

// Export each currently-selected node as a PNG data URL for use as LLM visual
// context. Capped at 1200px wide per image, and MAX_SCREENSHOTS nodes total.
// Nodes that can't export (or error) are silently skipped rather than failing
// the whole batch.
async function captureScreenshot(): Promise<ScreenshotImage[]> {
  const sel = figma.currentPage.selection.slice(0, MAX_SCREENSHOTS);
  const images: ScreenshotImage[] = [];
  for (const node of sel) {
    if (!("exportAsync" in node)) continue;
    try {
      const bytes = await (node as ExportMixin).exportAsync({
        format: "PNG",
        constraint: { type: "WIDTH", value: 1200 },
      });
      images.push({ name: node.name, dataUrl: `data:image/png;base64,${figma.base64Encode(bytes)}` });
    } catch {
      // skip nodes that fail to export (e.g. empty groups)
    }
  }
  return images;
}

async function sendConfig() {
  const config = ((await figma.clientStorage.getAsync(CONFIG_KEY)) ??
    {}) as SavedConfig;
  post({ type: "config", config });
}

// --- styled "card" frame, mirroring the plugin's result panel ---

type RGB = { r: number; g: number; b: number };
const COL = {
  blue: hex("#1E90FF"),
  purple: hex("#7C6CF0"),
  green: hex("#22C55E"),
  gray: hex("#9AA5B1"),
  text: hex("#10172A"),
  textSecondary: hex("#525E70"),
  border: hex("#CDD5DF"),
  white: { r: 1, g: 1, b: 1 },
};

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

const ICON_BG: Record<SectionKey, RGB> = {
  summary: COL.blue,
  people: COL.purple,
  actions: COL.green,
  other: COL.gray,
};

// Section glyphs drawn on a colored circle (single self-contained SVG each).
function iconSvg(key: SectionKey): string {
  const c = ICON_BG[key];
  const bg = `<circle cx="15" cy="15" r="15" fill="${rgbToHex(c)}"/>`;
  const glyph: Record<SectionKey, string> = {
    summary:
      '<g stroke="#fff" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="11" x2="20" y2="11"/><line x1="10" y1="15" x2="20" y2="15"/><line x1="10" y1="19" x2="17" y2="19"/></g>',
    people:
      '<g fill="#fff"><circle cx="12" cy="12.5" r="2.6"/><circle cx="19" cy="13" r="2.1"/><path d="M7.5 21c0-2.8 2-4.3 4.5-4.3s4.5 1.5 4.5 4.3z"/><path d="M16.2 21c0-2.4 1.5-3.7 3.1-3.7 1.7 0 3.2 1.3 3.2 3.7z" opacity="0.9"/></g>',
    actions:
      '<path d="M9 15l4 4 8-9" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    other: '<circle cx="15" cy="15" r="4" fill="#fff"/>',
  };
  return `<svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">${bg}${glyph[key]}</svg>`;
}

function checkboxSvg(done: boolean): string {
  return done
    ? '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="20" height="20" rx="6" fill="#22C55E"/><path d="M5 10l3 3 7-8" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="17" height="17" rx="5" fill="none" stroke="#CDD5DF" stroke-width="2"/></svg>';
}

function rgbToHex(c: RGB): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

async function loadFonts(): Promise<{ regular: FontName; bold: FontName }> {
  const inter = { regular: { family: "Inter", style: "Regular" }, bold: { family: "Inter", style: "Bold" } };
  try {
    await figma.loadFontAsync(inter.regular);
    await figma.loadFontAsync(inter.bold);
    return inter;
  } catch {
    const probe = figma.createText();
    const base = probe.fontName as FontName;
    probe.remove();
    await figma.loadFontAsync(base);
    let bold: FontName = { family: base.family, style: "Bold" };
    try {
      await figma.loadFontAsync(bold);
    } catch {
      bold = base;
    }
    return { regular: base, bold };
  }
}

function makeText(chars: string, font: FontName, size: number, color: RGB): TextNode {
  const t = figma.createText();
  t.fontName = font;
  t.fontSize = size;
  t.characters = chars;
  t.lineHeight = { value: 145, unit: "PERCENT" };
  t.fills = [{ type: "SOLID", color }];
  return t;
}

function fillText(t: TextNode): TextNode {
  t.layoutAlign = "STRETCH";
  t.layoutGrow = 1;
  t.textAutoResize = "HEIGHT";
  return t;
}

function svgNode(svg: string): SceneNode {
  const n = figma.createNodeFromSvg(svg);
  n.name = "icon";
  return n;
}

function avatarNode(name: string, bold: FontName): FrameNode {
  const f = figma.createFrame();
  f.resize(26, 26);
  f.cornerRadius = 13;
  f.clipsContent = true;
  const c = avatarHsl(name);
  f.fills = [{ type: "SOLID", color: hslToRgb(c.h, c.s, c.l) }];
  f.layoutMode = "HORIZONTAL";
  f.primaryAxisSizingMode = "FIXED";
  f.counterAxisSizingMode = "FIXED";
  f.primaryAxisAlignItems = "CENTER";
  f.counterAxisAlignItems = "CENTER";
  f.appendChild(makeText(initials(name), bold, 10, COL.white));
  return f;
}

function hRow(): FrameNode {
  const row = figma.createFrame();
  row.layoutMode = "HORIZONTAL";
  row.itemSpacing = 8;
  row.primaryAxisSizingMode = "FIXED";
  row.counterAxisSizingMode = "AUTO";
  row.counterAxisAlignItems = "CENTER";
  row.layoutAlign = "STRETCH";
  row.fills = [];
  return row;
}

function personNode(name: string, phrase: string, regular: FontName, bold: FontName): FrameNode {
  const row = hRow();
  row.appendChild(avatarNode(name, bold));
  const label = phrase ? `${name}  —  ${phrase}` : name;
  const t = makeText(label, regular, 12, COL.text);
  t.setRangeFontName(0, name.length, bold);
  if (phrase) t.setRangeFills(name.length, label.length, [{ type: "SOLID", color: COL.textSecondary }]);
  row.appendChild(fillText(t));
  return row;
}

function taskNode(labelText: string, done: boolean, regular: FontName): FrameNode {
  const row = hRow();
  row.appendChild(svgNode(checkboxSvg(done)));
  const t = makeText(labelText, regular, 12, done ? COL.textSecondary : COL.text);
  if (done) t.textDecoration = "STRIKETHROUGH";
  row.appendChild(fillText(t));
  return row;
}

function paragraphNode(lines: string[], regular: FontName): TextNode {
  const text = lines
    .map((l) => l.replace(/^\s*[-*]\s+/, "• ").replace(/^•\s*\[ \]\s*/, "• ☐ ").replace(/^•\s*\[[xX]\]\s*/, "• ☑ "))
    .join("\n")
    .trim();
  return fillText(makeText(text || "(no content)", regular, 12, COL.text));
}

function sectionRow(key: SectionKey, title: string, content: SceneNode[], bold: FontName): FrameNode {
  const row = hRow();
  row.itemSpacing = 12;
  row.counterAxisAlignItems = "MIN";
  row.appendChild(svgNode(iconSvg(key)));

  const col = figma.createFrame();
  col.layoutMode = "VERTICAL";
  col.itemSpacing = 6;
  col.primaryAxisSizingMode = "AUTO";
  col.counterAxisSizingMode = "AUTO";
  col.layoutGrow = 1;
  col.layoutAlign = "STRETCH";
  col.fills = [];
  if (title) {
    const h = makeText(title, bold, 14, COL.text);
    col.appendChild(fillText(h));
  }
  for (const n of content) col.appendChild(n);
  row.appendChild(col);
  return row;
}

async function insertFrame(markdown: string, label: string) {
  const { regular, bold } = await loadFonts();
  const sections = splitSections(markdown);

  const root = figma.createFrame();
  root.name = `Summary — ${label}`;
  root.layoutMode = "VERTICAL";
  root.itemSpacing = 16;
  root.paddingLeft = root.paddingRight = 24;
  root.paddingTop = root.paddingBottom = 22;
  root.primaryAxisSizingMode = "AUTO";
  root.counterAxisSizingMode = "FIXED";
  root.cornerRadius = 16;
  root.fills = [{ type: "SOLID", color: COL.white }];
  root.effects = [
    {
      type: "DROP_SHADOW",
      color: { r: 0.043, g: 0.435, b: 0.878, a: 0.16 },
      offset: { x: 0, y: 8 },
      radius: 24,
      spread: 0,
      visible: true,
      blendMode: "NORMAL",
    },
  ];
  root.resize(480, 100);

  if (sections.length === 0) {
    root.appendChild(paragraphNode(markdown.split("\n"), regular));
  } else {
    for (const s of sections) {
      const content: SceneNode[] = [];
      if (s.key === "people") {
        const bullets = listBullets(s.lines);
        for (const b of bullets) {
          const p = parsePerson(b);
          content.push(personNode(p.name, p.phrase, regular, bold));
        }
        if (!bullets.length) content.push(paragraphNode(s.lines, regular));
      } else if (s.key === "actions") {
        const bullets = listBullets(s.lines);
        for (const b of bullets) {
          const t = parseTask(b);
          content.push(taskNode(t.label, t.done, regular));
        }
        if (!bullets.length) content.push(paragraphNode(s.lines, regular));
      } else {
        content.push(paragraphNode(s.lines, regular));
      }
      root.appendChild(sectionRow(s.key, s.title, content, bold));
    }
  }

  const c = figma.viewport.center;
  root.x = Math.round(c.x - root.width / 2);
  root.y = Math.round(c.y - root.height / 2);
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  figma.notify("Inserted summary frame");
}

// FigJam has no auto-layout frames, so render the summary as one styled text
// node. Reuses buildSummaryText (pure) and maps its semantic spans onto fonts
// and colors here.
async function insertFigjam(markdown: string, label: string) {
  const { regular, bold } = await loadFonts();
  const { text, spans } = buildSummaryText(markdown);

  const node = figma.createText();
  node.fontName = regular;
  node.fontSize = 13;
  node.lineHeight = { value: 150, unit: "PERCENT" };
  node.fills = [{ type: "SOLID", color: COL.text }];
  node.characters = text || "(no content)";
  node.textAutoResize = "HEIGHT";
  node.resize(440, node.height); // fixed width so long lines wrap

  const len = node.characters.length;
  for (const sp of spans) {
    const end = Math.min(sp.end, len);
    if (sp.start >= end) continue;
    if (sp.bold) node.setRangeFontName(sp.start, end, bold);
    if (sp.heading) node.setRangeFontSize(sp.start, end, 16);
    if (sp.color === "secondary")
      node.setRangeFills(sp.start, end, [{ type: "SOLID", color: COL.textSecondary }]);
    if (sp.strike) node.setRangeTextDecoration(sp.start, end, "STRIKETHROUGH");
  }

  node.name = `Summary — ${label}`;
  const c = figma.viewport.center;
  node.x = Math.round(c.x - node.width / 2);
  node.y = Math.round(c.y - node.height / 2);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
  figma.notify("Inserted summary");
}

figma.showUI(__html__, { width: 420, height: 640, themeColors: true });

figma.ui.onmessage = async (msg: UIToMain) => {
  switch (msg.type) {
    case "ready":
      await sendConfig();
      await sendScope();
      break;
    case "save-config":
      await figma.clientStorage.setAsync(CONFIG_KEY, msg.config);
      break;
    case "notify":
      figma.notify(msg.message, { error: msg.error });
      break;
    case "resize":
      // Floor is just a sanity minimum (not a target) — the main view alone
      // is well under 320px now that credentials moved to their own screen.
      figma.ui.resize(420, Math.max(180, Math.min(900, Math.round(msg.height))));
      break;
    case "capture-screenshot":
      post({ type: "screenshot", images: await captureScreenshot() });
      break;
    case "insert-frame":
      try {
        if (figma.editorType === "figjam") {
          await insertFigjam(msg.markdown, msg.label);
        } else {
          await insertFrame(msg.markdown, msg.label);
        }
      } catch (e) {
        figma.notify(`Could not insert summary: ${String(e)}`, { error: true });
      }
      break;
  }
};

// Re-send scope when the selection changes so the UI label stays accurate.
figma.on("selectionchange", () => {
  void sendScope();
});
