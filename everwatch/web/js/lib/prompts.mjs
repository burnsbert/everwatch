// Quick-reply detection for the reply bar (docs/DESIGN.md W-10): given the
// selected session's visible screen text, find the prompt it's sitting at —
// a Claude Code / Codex numbered menu ("❯ 1. Yes", "› 1. Yes, proceed (y)"),
// an older Codex "Yes (y) / No (esc)" approval, or a shell-style y/n
// question ("Continue? [y/N]") — and say what each answer should send.
// Pure: no DOM, no I/O. Nothing here ever sends anything; the reply bar
// only shows buttons, and only a click sends.

const TAIL_LINES = 30;          // how far up from the bottom to look
const MENU_NEAR_BOTTOM = 8;     // last option must be within this many non-blank lines of the end
const MAX_GAP = 3;              // description lines allowed between two options
const MAX_OPTIONS = 9;

// "│ ❯ 1. Yes   │", "  2. No, and tell Claude … (esc)", "› 1. Yes, proceed (y)"
const OPTION_RE = /^[\s│┃|]*([❯›▶>])?\s*(\d{1,2})[.)]\s+(.*?)[\s│┃|]*$/;
// "Yes (y)", "› No, and tell Codex what to do differently (esc)"
const SHORTCUT_OPTION_RE = /^[\s│┃|]*([❯›▶>])?\s*([A-Z][^()]*?)\s*\(([a-z]|esc)\)[\s│┃|]*$/;
const SHORTCUT_RE = /\s*\(([a-z]|esc)\)\s*$/i;
const QUESTION_RE = /\?\s*[│┃|]?\s*$|Would you like to|Do you want|Allow command/;
const YN_RE = /[[(]\s*(y\/n|yes\/no)\s*[\])]\s*[:?]?\s*$/i;
// Answers that widen what an agent may do from now on. docs/DESIGN.md §2:
// quick replies never offer these; type the digit yourself if you mean it.
const RISKY_RE = /don['’]t ask again|\balways\b/i;

function clean(label) {
  return label.replace(SHORTCUT_RE, '').replace(/\s+/g, ' ').trim();
}

function shortcutOf(label) {
  const m = SHORTCUT_RE.exec(label);
  return m ? m[1].toLowerCase() : '';
}

/** What pressing one option should send ({text} or {key}); never with Enter. */
export function sendFor({ n, shortcut }, agent) {
  if (agent === 'codex') {
    if (shortcut === 'esc') return { key: 'esc' };
    if (shortcut) return { text: shortcut };
  }
  return { text: String(n) };
}

function questionAbove(lines, index) {
  for (let i = index - 1; i >= Math.max(0, index - 6); i -= 1) {
    const t = lines[i].replace(/^[\s│┃|]+|[\s│┃|]+$/g, '');
    if (!t) continue;
    if (QUESTION_RE.test(t)) return t;
  }
  return '';
}

function numberedMenu(lines, agent) {
  let best = null;
  let block = null;
  let gap = 0;
  lines.forEach((line, i) => {
    const m = OPTION_RE.exec(line);
    if (m) {
      const n = Number(m[2]);
      const opt = { n, label: clean(m[3]), shortcut: shortcutOf(m[3]), selected: !!m[1], line: i, marker: m[1] || '' };
      if (n === 1) {
        block = { options: [opt], start: i };
      } else if (block && n === block.options[block.options.length - 1].n + 1 && gap <= MAX_GAP) {
        block.options.push(opt);
      } else {
        block = null;
      }
      gap = 0;
      if (block && block.options.length >= 2 && block.options.some((o) => o.selected)) best = block;
      return;
    }
    if (line.trim()) gap += 1;
  });
  if (!best) return null;
  const last = best.options[best.options.length - 1].line;
  const after = lines.slice(last + 1).filter((l) => l.trim()).length;
  if (after >= MENU_NEAR_BOTTOM) return null;
  const marker = best.options.find((o) => o.selected).marker;
  const who = agent || (marker === '›' ? 'codex' : 'claude');
  return {
    kind: 'menu',
    question: questionAbove(lines, best.start),
    options: best.options.slice(0, MAX_OPTIONS).map((o) => ({
      n: o.n, label: o.label, shortcut: o.shortcut, selected: o.selected, send: sendFor(o, who), risky: RISKY_RE.test(o.label),
    })),
  };
}

function shortcutMenu(lines) {
  const nonBlank = lines.map((l, i) => [l, i]).filter(([l]) => l.trim()).slice(-MENU_NEAR_BOTTOM);
  const opts = [];
  for (const [line, i] of nonBlank) {
    const m = SHORTCUT_OPTION_RE.exec(line);
    if (m) opts.push({ label: clean(m[2]), shortcut: m[3].toLowerCase(), selected: !!m[1], line: i });
    else if (opts.length) break; // options must be one contiguous run
  }
  if (opts.length < 2) {
    // one-line variant: "▌ Yes (y)   No (n)   Always for this session (a)"
    const [line, i] = nonBlank[nonBlank.length - 1] || ['', 0];
    const parts = line.replace(/^[\s▌│┃|]+/, '').split(/\s{2,}/).map((part) => SHORTCUT_OPTION_RE.exec(part));
    if (parts.length < 2 || !parts.every(Boolean)) return null;
    opts.length = 0;
    for (const m of parts) opts.push({ label: clean(m[2]), shortcut: m[3].toLowerCase(), selected: false, line: i });
  }
  const question = questionAbove(lines, opts[0].line);
  if (!question) return null;
  return {
    kind: 'shortcut',
    question,
    options: opts.slice(0, MAX_OPTIONS).map((o, i) => ({
      n: i + 1, label: o.label, shortcut: o.shortcut, selected: o.selected,
      send: o.shortcut === 'esc' ? { key: 'esc' } : { text: o.shortcut }, risky: RISKY_RE.test(o.label),
    })),
  };
}

function yesNo(lines) {
  const last = [...lines].reverse().find((l) => l.trim());
  const m = last && YN_RE.exec(last);
  if (!m) return null;
  const words = m[1].toLowerCase() === 'yes/no';
  return {
    kind: 'yn',
    question: last.trim(),
    options: [
      { n: 1, label: 'Yes', shortcut: 'y', selected: false, send: { text: words ? 'yes' : 'y', enter: true }, risky: false },
      { n: 2, label: 'No', shortcut: 'n', selected: false, send: { text: words ? 'no' : 'n', enter: true }, risky: false },
    ],
  };
}

/**
 * detectPrompt(screenText, { kind }) → null | { kind: 'menu'|'shortcut'|'yn',
 * question, options: [{ n, label, shortcut, selected, send, risky }] }.
 * `risky` marks "don't ask again" / "always" answers (no quick reply).
 * `kind` is the session's agent kind ('claude' | 'codex' | null); it picks
 * how a numbered option is answered (Codex options with a letter shortcut
 * use the letter).
 */
export function detectPrompt(text, { kind = null } = {}) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-TAIL_LINES);
  return numberedMenu(tail, kind) || shortcutMenu(tail) || yesNo(tail);
}

/** Printable text only: control characters (which the server rejects) become spaces. */
export function sanitizeReply(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

/** The options that get a quick-reply button (never the risky ones). */
export function quickReplies(prompt) {
  return prompt ? prompt.options.filter((o) => !o.risky) : [];
}

/** Label for a quick-reply button: "1. Yes" / "Yes (y)". */
export function optionLabel(o, kind) {
  if (kind === 'menu') return `${o.n}. ${o.label}`;
  return o.shortcut && kind === 'shortcut' ? `${o.label} (${o.shortcut})` : o.label;
}
