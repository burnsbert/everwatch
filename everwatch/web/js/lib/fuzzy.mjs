// `/` filter matcher (P-46): case-insensitive subsequence match, ported from
// ultrawatch's draw.fuzzy_match, plus the matched positions so views can
// highlight characters. Pure; positions are code-point indexes.

/** True when every character of `needle` appears in order in `haystack`. */
export function fuzzyMatch(needle, haystack) {
  return fuzzyPositions(needle, haystack) !== null;
}

/**
 * Greedy leftmost match positions (the same greedy scan the Python matcher
 * does), or null when there's no match. An empty needle matches with [].
 */
export function fuzzyPositions(needle, haystack) {
  if (!needle) return [];
  const n = [...String(needle).toLowerCase()];
  const h = [...String(haystack ?? '').toLowerCase()];
  const out = [];
  let pos = 0;
  for (const ch of n) {
    let found = -1;
    for (let i = pos; i < h.length; i += 1) {
      if (h[i] === ch) { found = i; break; }
    }
    if (found < 0) return null;
    out.push(found);
    pos = found + 1;
  }
  return out;
}

/**
 * Ranking score for the command palette (W-3): higher is better, from the
 * same greedy positions as `fuzzyPositions` so results agree with the `/`
 * filter's notion of a match. Earlier and more contiguous runs score
 * higher; `null` when there's no match (mirrors `fuzzyPositions`).
 */
export function fuzzyScore(needle, haystack) {
  const positions = fuzzyPositions(needle, haystack);
  if (positions === null) return null;
  if (!positions.length) return 0;
  let score = 100 - positions[0];
  let run = 1;
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] === positions[i - 1] + 1) {
      run += 1;
      score += run * 2;
    } else {
      run = 1;
      score -= positions[i] - positions[i - 1];
    }
  }
  return score;
}

/** The haystack ultrawatch filters on: `"{path} {name} {label}"`. */
export function sessionHaystack(s) {
  return `${s.path || ''} ${s.name || ''} ${s.label || ''}`;
}

/**
 * Split haystack positions back into per-field index lists.
 * Returns `{path:[…], name:[…], label:[…]}` (indexes local to each field).
 */
export function fieldHighlights(s, positions) {
  const fields = ['path', 'name', 'label'];
  const out = { path: [], name: [], label: [] };
  if (!positions || !positions.length) return out;
  let offset = 0;
  const spans = fields.map((f) => {
    const len = [...String(s[f] || '')].length;
    const span = { f, start: offset, end: offset + len };
    offset += len + 1; // the joining space
    return span;
  });
  for (const p of positions) {
    const span = spans.find((sp) => p >= sp.start && p < sp.end);
    if (span) out[span.f].push(p - span.start);
  }
  return out;
}

/**
 * Break `text` into `[{text, hit}]` runs for the given code-point indexes so
 * a view can wrap hits in <mark> using textContent only.
 */
export function highlightRuns(text, indexes) {
  const chars = [...String(text ?? '')];
  if (!chars.length) return [];
  const hits = new Set(indexes || []);
  const runs = [];
  for (let i = 0; i < chars.length; i += 1) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += chars[i];
    else runs.push({ text: chars[i], hit });
  }
  return runs;
}
