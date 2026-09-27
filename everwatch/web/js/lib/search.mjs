// Screen-content search (W-8): grep every live session's screen text for a
// literal, case-insensitive substring, with a line of context and the
// matched span for highlighting. Pure; views/palette.mjs jumps to the
// session and highlights the match in the preview.

/**
 * `{uid, session, lineIndex, before, line, matchStart, matchEnd, after}[]`,
 * in session order, capped at `maxPerSession` hits per session. `before`/
 * `after` are arrays of up to `contextLines` raw lines (oldest first).
 * Sessions with no screen text, or no match, contribute nothing. An empty
 * query returns no hits (there's nothing useful to grep for).
 */
export function searchScreens(screens, sessions, query, { contextLines = 1, maxPerSession = 5 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const needle = q.toLowerCase();
  const out = [];
  for (const s of sessions || []) {
    const text = (screens || {})[s.uid];
    if (!text) continue;
    const lines = String(text).split('\n');
    let count = 0;
    for (let i = 0; i < lines.length && count < maxPerSession; i += 1) {
      const idx = lines[i].toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      count += 1;
      out.push({
        uid: s.uid,
        session: s,
        lineIndex: i,
        before: lines.slice(Math.max(0, i - contextLines), i),
        line: lines[i],
        matchStart: idx,
        matchEnd: idx + needle.length,
        after: lines.slice(i + 1, i + 1 + contextLines),
      });
    }
  }
  return out;
}

/**
 * Global character offset of `lineIndex`'s `matchStart`/`matchEnd` within
 * the full joined text (used to highlight the match inside the preview's
 * full screen body, which is one text blob, not a single line).
 */
export function globalMatchSpan(text, lineIndex, matchStart, matchEnd) {
  const lines = String(text ?? '').split('\n');
  let offset = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i += 1) offset += lines[i].length + 1;
  return { start: offset + matchStart, end: offset + matchEnd };
}
