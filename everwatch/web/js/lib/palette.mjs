// Command palette entry building + ranking (W-3): fuzzy "go to session"
// entries plus every keymap command, scored the same way as the `/` filter
// (lib/fuzzy.mjs) so results feel consistent. Pure; views/palette.mjs owns
// rendering and keyboard handling.

import { fuzzyPositions, sessionHaystack } from './fuzzy.mjs';

// --- palette-specific ranking (W-8 polish) -----------------------------
// The shared `/` filter (lib/fuzzy.mjs `fuzzyScore`) rewards an early
// first hit above everything else, which is fine for filtering a short
// session list but reads as noisy in the palette: typing "sort" lit up
// "Show/hide dollar amounts" and "Refactor dashboard charts" almost as
// brightly as "Cycle sort order", because a single early character
// dominated the score regardless of how scattered the rest of the match
// was. `paletteScore` instead weighs contiguous and word-start runs far
// more than isolated characters, and `filterPalette` drops anything that
// doesn't clear a threshold relative to the best match for the query.
// Deliberately a separate function from `fuzzyScore`, not a change to it:
// the shared golden fuzzy cases and the `/` filter's semantics are
// untouched (see tests/golden/fuzzy_cases.json).

const NON_WORD = /[^\p{L}\p{N}]/u;

/** True when `haystack[idx]` starts a "word" (idx 0, or preceded by a
 * non letter/number — space, `/`, `-`, `.`, …). */
function isWordStart(haystack, idx) {
  if (idx <= 0) return true;
  return NON_WORD.test(haystack[idx - 1]);
}

/** Ascending, distinct index positions → consecutive runs `[{start, end}]`
 * (end exclusive). */
function runsOf(positions) {
  const runs = [];
  for (const p of positions) {
    const last = runs[runs.length - 1];
    if (last && last.end === p) last.end = p + 1;
    else runs.push({ start: p, end: p + 1 });
  }
  return runs;
}

/**
 * Palette match score + the subset of `positions` worth highlighting.
 * `null` when there's no match (mirrors `fuzzyPositions`). A longer run
 * scores quadratically (contiguous >> scattered); a run starting a word
 * scores extra; a gap between two runs is a small penalty (more, smaller
 * runs score worse than one bigger one); `strongPositions` keeps only
 * runs of 2+ characters or a word-start hit, so a single stray
 * mid-word letter is matched (for filtering) but never highlighted.
 */
export function paletteScore(needle, haystack) {
  const positions = fuzzyPositions(needle, haystack);
  if (positions === null) return null;
  if (!positions.length) return { score: 0, positions: [], strongPositions: [] };
  const runs = runsOf(positions);
  let score = -positions[0] * 0.05;
  let prevEnd = null;
  const strongPositions = [];
  for (const run of runs) {
    const len = run.end - run.start;
    const wordStart = isWordStart(haystack, run.start);
    score += len * len * (wordStart ? 4 : 1.5);
    if (prevEnd !== null) score -= (run.start - prevEnd) * 0.5;
    prevEnd = run.end;
    if (len >= 2 || wordStart) {
      for (let p = run.start; p < run.end; p += 1) strongPositions.push(p);
    }
  }
  return { score, positions, strongPositions };
}

/** Matches scoring below `best * REL_THRESHOLD` (and always below
 * `MIN_SCORE`) are dropped as noise rather than ranked last. */
const REL_THRESHOLD = 0.35;
const MIN_SCORE = 1;

/** `{type:'session', …}` entries from live sessions, in the given order. */
export function sessionEntries(sessions) {
  return (sessions || []).map((s) => ({
    type: 'session',
    id: s.uid,
    uid: s.uid,
    label: s.display_name || s.name || s.uid.slice(0, 8),
    sublabel: s.path || '',
    haystack: sessionHaystack(s),
    session: s,
  }));
}

/** `{type:'command', …}` entries from `keymap.paletteCommands()`. */
export function commandEntries(commands) {
  return (commands || []).map((c) => ({
    type: 'command',
    id: c.id,
    label: c.label,
    sublabel: c.group || '',
    haystack: c.label,
    keys: c.keys || [],
    args: c.args || {},
  }));
}

/** Stable identity for recency tracking and dedupe. */
export function entryKey(e) {
  return `${e.type}:${e.id}`;
}

/**
 * Rank + filter entries for a query.
 *
 * Empty query: recently used entries first (most-recent-first, deduped by
 * `entryKey`), then the rest in input order — all with `positions: []`
 * (nothing to highlight).
 *
 * Non-empty query: ranked by `paletteScore` (contiguous/word-start runs
 * far outweigh scattered single characters); matches, non-matches, and
 * matches too weak relative to the best one for this query are all
 * dropped; ties keep the input order. `positions` on the returned entries
 * is the *highlight-worthy* subset (`strongPositions`) only — a lone
 * scattered hit still counts toward matching but is never marked.
 */
export function filterPalette(entries, query, recentKeys = []) {
  const list = entries || [];
  if (!query) {
    const recentSet = new Set();
    const recent = [];
    for (const k of recentKeys || []) {
      if (recentSet.has(k)) continue;
      recentSet.add(k);
      const e = list.find((x) => entryKey(x) === k);
      if (e) recent.push(e);
    }
    const rest = list.filter((e) => !recentSet.has(entryKey(e)));
    return [...recent, ...rest].map((e) => ({ ...e, positions: [] }));
  }
  const scored = [];
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    const result = paletteScore(query, e.haystack);
    if (result === null) continue;
    scored.push({ e, result, i });
  }
  if (!scored.length) return [];
  const best = Math.max(...scored.map((s) => s.result.score));
  const cutoff = Math.max(MIN_SCORE, best * REL_THRESHOLD);
  const kept = scored.filter((s) => s.result.score >= cutoff);
  kept.sort((a, b) => b.result.score - a.result.score || a.i - b.i);
  return kept.map(({ e, result }) => ({ ...e, positions: result.strongPositions }));
}
