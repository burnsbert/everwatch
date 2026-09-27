// Tokens Used strip + token alert chip model (docs/design/VISUAL_SPEC.md
// §4.18, T040). Pure, no DOM: views/tokens.mjs renders it. Severity, pace
// and hit come straight off the backend fields through lib/limits.mjs's
// `quotaState` — nothing here re-derives a threshold.

import {
  limitName, limitTitle, quotaState, whenPhrase, isoEpoch, sentenceCase, clock12,
} from './limits.mjs';
import { ageStr, formatDollars } from './format.mjs';

export const PROVIDERS = Object.freeze([
  { key: 'claude', name: 'Claude Code', word: 'Claude', glyph: 'agent-claude' },
  { key: 'codex', name: 'Codex', word: 'Codex', glyph: 'agent-codex' },
]);

/** Sort rank of an item's worst state: lower is worse. */
const RANK = { hit: 0, pace: 1, red: 2, yellow: 3, ok: 4 };

/** The single state an item is flagged with: hit > pace > red > yellow > ok. */
export function itemState(st) {
  if (st.hit) return 'hit';
  if (st.pace) return 'pace';
  return st.level; // 'red' | 'yellow' | 'ok'
}

function resetPhrase(row, now) {
  const t = isoEpoch(row?.reset_at);
  return t === null ? '' : whenPhrase(t, now);
}

/** "4:41 PM", or "Thu 4:41 PM" when the run-out isn't today. */
export function runOutText(t, now) {
  if (t === null || t === undefined) return '';
  const phrase = whenPhrase(t, now);
  return phrase.startsWith('today at ') ? clock12(t) : phrase.replace(' at ', ' ');
}

/** One strip item for a usage row. */
export function itemOf(row, now, { showDollars = false } = {}) {
  const st = quotaState(row);
  const pct = Math.round(row?.pct ?? 0);
  return {
    id: row.id,
    full: limitName(row, 'full'),
    short: limitName(row, 'short'),
    title: limitTitle(row),
    pct,
    meter: st.hit ? 100 : Math.max(0, Math.min(100, row?.pct ?? 0)),
    level: st.level,
    hit: st.hit,
    pace: st.pace,
    state: itemState(st),
    runOutAt: st.runOutAt,
    runOut: runOutText(st.runOutAt, now),
    runOutPhrase: st.runOutAt === null ? '' : whenPhrase(st.runOutAt, now).replace(/^today /, ''),
    reset: resetPhrase(row, now),
    projectionText: st.pace && st.runOutAt === null ? sentenceCase(row.projection?.text) : '',
    dollars: showDollars && row?.dollars != null ? formatDollars(row.dollars) : '',
  };
}

/** §4.18.2 tooltip content for one item: `{title, body, lines}`. */
export function itemTip(item) {
  const body = [`${item.pct}% used`];
  if (item.dollars) body.push(item.dollars);
  if (item.reset && !item.hit) body.push(`resets ${item.reset}`);
  const lines = [];
  if (item.hit) {
    lines.push({ text: `Limit reached${item.reset ? ` · resets ${item.reset}` : ''}`, tone: 'danger' });
  } else if (item.pace) {
    const text = item.runOutPhrase ? `On pace to run out ${item.runOutPhrase}, before it resets` : item.projectionText;
    lines.push({ text: text || 'On pace to run out before it resets', tone: 'warn' });
  }
  return { title: item.title, body: body.join(' · '), lines };
}

/** Accessible name for an item button (same words as the tooltip). */
export function itemLabel(item) {
  const t = itemTip(item);
  return [`${t.title}: ${t.body}`, ...t.lines.map((l) => l.text)].join('. ');
}

/**
 * Provider group model. `status`: 'ok' | 'stale' (last fetch failed, older
 * data shown) | 'failing' (no data) | 'no_token' | 'inactive'.
 */
export function providerModel(p, u, now, opts = {}) {
  const status = u?.status || 'inactive';
  const rows = u?.rows || [];
  const items = rows.map((r) => itemOf(r, now, opts));
  let note = '';
  if (status === 'no_token') note = 'Not connected';
  else if (status === 'failing' && !items.length) note = 'Fetch failed';
  else if (!items.length) note = 'Not running';
  let warning = '';
  if (status === 'stale' || (status === 'failing' && items.length)) {
    warning = u?.at ? `Usage fetch failing — showing data from ${ageStr(now - u.at)} ago` : 'Usage fetch failing';
  } else if (status === 'failing') {
    warning = u?.error ? `Usage fetch failed: ${u.error}` : 'Usage fetch failed';
  }
  const worst = items.reduce((a, b) => (!a || RANK[b.state] < RANK[a.state]
    || (RANK[b.state] === RANK[a.state] && b.pct > a.pct) ? b : a), null);
  return {
    ...p, status, items, note, warning, worst,
  };
}

/** Both provider groups, in fixed order. */
export function stripModel(usage, now, opts = {}) {
  return PROVIDERS.map((p) => providerModel(p, usage?.[p.key], now, opts));
}

/**
 * User request (T046): pace/hit warnings no longer live inside each meter
 * item (which keeps only its severity color/meter/pct, unchanged) or a
 * toolbar chip (removed entirely) — they're their own small chips in the
 * Tokens Used strip, side by side, each opening Usage and carrying the
 * full-detail §4.18.2 tooltip via itemTip. Hit sorts before pace; pace
 * sorts by earliest run-out first. Short label + time (never the full
 * limit name) is the default text; the narrow-width step-down drops the
 * short label too, leaving just the icon + time (icon only for a hit,
 * which has no time).
 */
export function paceHitAlerts(groups) {
  const out = [];
  for (const g of groups) {
    for (const item of g.items) {
      if (item.state !== 'pace' && item.state !== 'hit') continue;
      const kind = item.state;
      const full = kind === 'hit' ? `${g.word} ${item.full}`
        : item.runOut ? `${g.word} ${item.short} · ${item.runOut}` : `${g.word} ${item.short} on pace to run out`;
      out.push({
        id: item.id, kind, providerWord: g.word, item, full, short: kind === 'pace' ? item.runOut : '',
      });
    }
  }
  out.sort((a, b) => RANK[a.kind] - RANK[b.kind]
    || (a.kind === 'pace' ? (a.item.runOutAt ?? Infinity) - (b.item.runOutAt ?? Infinity) : 0));
  return out;
}
