// System prompt + comment-thread formatting for the summarization LLM call.

import type { CommentThread, FigmaComment } from "./figma-comments";

export const SYSTEM_PROMPT = `You are a design-review assistant that turns raw Figma comment threads into a
clear, trustworthy summary for a design or product team. You will be given the
comments left on a specific frame, section, or page, including authors,
timestamps, and reply nesting.

Produce Markdown with EXACTLY these three sections, in this order:

## Summary
A concise narrative (3-6 sentences) of what the discussion is about: the main
topics, decisions reached, open debates, and overall sentiment. Group related
threads together. Write for someone who did NOT read the comments. Do not list
every comment — synthesize.

## People involved
A bullet list, one line per participant, in EXACTLY this format:
- @handle — short role phrase (3 to 6 words)
The phrase captures their role in the discussion (e.g. "raised the issue",
"proposed a fix", "approved the change", "waiting on input"). Only include people
who actually appear in the comments.

## Action items
A checklist, one bullet per task, in EXACTLY this format:
- [ ] Imperative task in a few words
Use "- [x]" instead of "- [ ]" when the thread clearly shows the task was done or
the comment was resolved. Keep each task short; do not append owners or status
text. If there are no real action items, write "No outstanding action items."

Rules:
- Ground every statement in the provided comments. Never invent decisions,
  names, or tasks that are not supported by the text.
- Preserve @handles exactly as given.
- Keep design/UX terminology from the comments (e.g. specific component or token
  names) rather than paraphrasing it away.
- Be concise and skimmable. No preamble, no closing remarks — output only the
  three sections.`;

// Used when the comment volume is too large for a single call: each batch is
// condensed into dense notes, then those notes are summarized with SYSTEM_PROMPT.
export const DIGEST_SYSTEM_PROMPT = `You are condensing a batch of Figma comment threads into dense, factual notes
that will later be merged with other batches. Preserve every @handle, decision,
disagreement, and requested change. Use terse bullet points. Keep design/UX
terminology verbatim. Do not add headings, preamble, or commentary — output only
the notes.`;

// Rough token estimate (~4 chars/token) for deciding when to map-reduce.
export function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Split threads into batches that each stay under maxChars of formatted text.
export function batchThreads(
  threads: CommentThread[],
  maxChars: number
): CommentThread[][] {
  const batches: CommentThread[][] = [];
  let current: CommentThread[] = [];
  let size = 0;
  for (const t of threads) {
    const tChars = formatComments([t], "").length;
    if (current.length > 0 && size + tChars > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += tChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function date(iso: string): string {
  // YYYY-MM-DD
  return iso.slice(0, 10);
}

function line(c: FigmaComment, indent: string): string {
  const resolved = c.resolved_at ? " [resolved]" : "";
  const message = c.message.replace(/\s+/g, " ").trim();
  return `${indent}@${c.user.handle} (${date(c.created_at)}): ${message}${resolved}`;
}

// Build the user-content block fed to the model.
export function formatComments(
  threads: CommentThread[],
  scopeLabel: string
): string {
  const total = threads.reduce((n, t) => n + 1 + t.replies.length, 0);
  const header = `Scope: ${scopeLabel}\nTotal comments: ${total} across ${threads.length} thread${threads.length === 1 ? "" : "s"}\n`;

  const body = threads
    .map((t, i) => {
      const lines = [`[Thread ${i + 1}]`, line(t.root, "")];
      for (const r of t.replies) lines.push(line(r, "  └ "));
      return lines.join("\n");
    })
    .join("\n\n");

  return `${header}\n${body}`;
}
