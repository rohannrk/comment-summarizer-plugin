// Minimal, safe markdown -> HTML renderer for the results panel.
// Supports headings (#-###), bullet lists, task checkboxes, **bold** and `code`.
// Pure (no DOM/Figma globals) so it can be unit-tested.

import {
  type SectionKey,
  type RawSection,
  splitSections,
  listBullets,
  parsePerson,
  parseTask,
  initials,
  avatarHsl,
} from "./summary-model";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// --- Structured "card" renderer: Summary / People involved / Action items ---

const ICONS: Record<SectionKey, string> = {
  summary:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h5"/></svg>',
  people:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  actions:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 6h10M11 12h10M11 18h7"/><path d="M3 6l1.4 1.4L7 4.5"/><path d="M3 12l1.4 1.4L7 10.5"/><path d="M3 18l1.4 1.4L7 16.5"/></svg>',
  other:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
};

const CHECK =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

function avatar(name: string): string {
  const c = avatarHsl(name);
  return `<span class="avatar" style="background:hsl(${c.h} ${c.s}% ${c.l}%)">${escapeHtml(
    initials(name)
  )}</span>`;
}

function renderPeople(lines: string[]): string {
  const items = listBullets(lines).map((raw) => {
    const { name, phrase } = parsePerson(raw);
    return (
      `<div class="person">${avatar(name)}<span class="pname">${escapeHtml(name)}</span>` +
      (phrase
        ? `<span class="pdash">—</span><span class="pphrase">${inline(phrase)}</span>`
        : "") +
      `</div>`
    );
  });
  return items.length ? items.join("") : renderGeneric(lines);
}

function renderActions(lines: string[]): string {
  const items = listBullets(lines).map((raw) => {
    const { label, done } = parseTask(raw);
    return (
      `<div class="task ${done ? "done" : ""}">` +
      `<span class="box ${done ? "checked" : ""}">${done ? CHECK : ""}</span>` +
      `<span class="tlabel">${inline(label)}</span></div>`
    );
  });
  return items.length ? items.join("") : renderGeneric(lines);
}

function renderGeneric(lines: string[]): string {
  return renderMarkdown(lines.join("\n"));
}

function renderSection(s: RawSection): string {
  const body =
    s.key === "people"
      ? renderPeople(s.lines)
      : s.key === "actions"
      ? renderActions(s.lines)
      : renderGeneric(s.lines);
  return (
    `<div class="sec sec-${s.key}">` +
    `<div class="sec-ic ic-${s.key}">${ICONS[s.key]}</div>` +
    `<div class="sec-main">${s.title ? `<h3>${inline(s.title)}</h3>` : ""}${body}</div>` +
    `</div>`
  );
}

// Parse the model's markdown into sections and render the card layout.
export function renderSummary(md: string): string {
  const sections = splitSections(md);
  if (sections.length === 0) return renderMarkdown(md);
  return sections.map(renderSection).join("");
}

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of md.split("\n")) {
    const lineStr = raw.replace(/\s+$/, "");
    if (!lineStr.trim()) {
      closeList();
      continue;
    }
    const h = lineStr.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h2>${inline(h[2])}</h2>`);
      continue;
    }
    const li = lineStr.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      const checkbox = li[1].match(/^\[([ xX])\]\s*(.*)$/);
      if (checkbox) {
        const checked = checkbox[1].toLowerCase() === "x";
        out.push(
          `<li class="task"><input type="checkbox" disabled${
            checked ? " checked" : ""
          }/> <span>${inline(checkbox[2])}</span></li>`
        );
      } else {
        out.push(`<li>${inline(li[1])}</li>`);
      }
      continue;
    }
    closeList();
    out.push(`<p>${inline(lineStr)}</p>`);
  }
  closeList();
  return out.join("");
}
