// Usage-limit display helpers (docs/design/VISUAL_SPEC.md §4.14, §4.18.1):
// display names mapped from the row `id` (the backend `label` strings like
// "CC Session Limit" stay as they are), the severity/pace/hit state read
// straight off the backend's fields (the UI never re-derives thresholds),
// and local time phrases for resets and the projected run-out time
// (`projection.at`, engine/projection.py). Pure, no DOM: shared by the
// Usage page and the Tokens Used strip.

/** Per-id names. `full`/`short`: the strip's two widths; `page`: the Usage
 * page label when it differs from `full`; `title`: the never-abbreviated
 * tooltip / accessible name. Never "CC"/"CX" (§4.17). */
export const LIMITS = Object.freeze({
  'cc.five_hour': { full: 'Session', short: '5h', title: 'Claude Code — 5-hour session limit' },
  'cc.seven_day': { full: 'Weekly', short: '7d', title: 'Claude Code — weekly limit' },
  'cc.seven_day_sonnet': { full: 'Sonnet', short: 'Son.', title: 'Claude Code — weekly Sonnet limit' },
  'cc.monthly': { full: 'Monthly', short: 'Mo.', title: 'Claude Code — monthly limit' },
  'cc.extra': { full: 'Extra', short: 'Ext.', page: 'Extra usage', title: 'Claude Code — extra usage' },
  'cx.five_hour': { full: '5h', short: '5h', page: '5-hour', title: 'Codex — 5-hour limit' },
  'cx.seven_day': { full: 'Weekly', short: '7d', title: 'Codex — weekly limit' },
});

/** "Claude Code" / "Codex" from a row id's `cc.` / `cx.` prefix. */
export function providerName(id) {
  const s = String(id || '');
  if (s.startsWith('cc.')) return 'Claude Code';
  if (s.startsWith('cx.')) return 'Codex';
  return '';
}

/** Backend label minus its provider prefix and " Limit" suffix. */
function strippedLabel(label) {
  return String(label || '').trim().replace(/^(CC|CX)\s+/, '').replace(/\s+Limit$/, '').trim();
}

/** Display name for a usage row: `form` is 'full' | 'short' | 'page'. */
export function limitName(row, form = 'full') {
  const known = LIMITS[row?.id];
  if (known) return (form === 'page' && known.page) || known[form] || known.full;
  return strippedLabel(row?.label);
}

/** Tooltip / accessible name: "Claude Code — 5-hour session limit". */
export function limitTitle(row) {
  const known = LIMITS[row?.id];
  if (known) return known.title;
  const provider = providerName(row?.id);
  const name = `${strippedLabel(row?.label)} limit`;
  return provider ? `${provider} — ${name}` : name;
}

/** ISO timestamp → epoch seconds, or null. */
export function isoEpoch(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : null;
}

/**
 * §4.18.1: severity from the backend `level` (ok | yellow | red), pace
 * warning = a projection that isn't a hit, hit = either hit flag (hit wins
 * over pace), and the projected run-out time from `projection.at`.
 */
export function quotaState(row) {
  const proj = row?.projection || null;
  const hit = !!(row?.hit || proj?.hit);
  const pace = !!proj && !hit;
  const level = row?.level === 'red' || row?.level === 'yellow' ? row.level : 'ok';
  return {
    level, hit, pace, runOutAt: pace ? isoEpoch(proj.at) : null,
  };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local "4:41 PM". */
export function clock12(t) {
  const d = new Date(t * 1000);
  const hr = d.getHours();
  return `${hr % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${hr < 12 ? 'AM' : 'PM'}`;
}

/** Chart tick label in the §4.14 style: 'time' "4:41 PM", 'day'
 * "Thu 4:41 PM", 'date' "Sep 17" (lib/chart.mjs `timeStyle` picks one). */
export function clockLabel(t, style = 'time') {
  const d = new Date(t * 1000);
  if (style === 'date') return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return style === 'day' ? `${DAYS[d.getDay()]} ${clock12(t)}` : clock12(t);
}

function dayIndex(d) {
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
}

/** `{day, time}` relative to `now`: Today / Tomorrow / weekday (next 6
 * days) / "Oct 1" (further out, or in the past). */
export function dayTime(t, now) {
  const d = new Date(t * 1000);
  const diff = dayIndex(d) - dayIndex(new Date(now * 1000));
  let day;
  if (diff === 0) day = 'Today';
  else if (diff === 1) day = 'Tomorrow';
  else if (diff > 1 && diff < 7) day = DAYS[d.getDay()];
  else day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return { day, time: clock12(t) };
}

/** "today at 4:41 PM" / "tomorrow at …" / "Thu at …" / "Oct 1 at …". */
export function whenPhrase(t, now) {
  const { day, time } = dayTime(t, now);
  const lower = day === 'Today' || day === 'Tomorrow' ? day.toLowerCase() : day;
  return `${lower} at ${time}`;
}

export function sentenceCase(s) {
  const str = String(s ?? '');
  return str ? str[0].toUpperCase() + str.slice(1) : '';
}

/** §4.14 sub-line: "Resets in 2h 15m · Today 5:15 PM". The countdown is
 * the backend's `reset_text` (minus its parenthesised clock); the clock is
 * `reset_at` formatted locally. */
export function resetLine(row, now) {
  const delta = String(row?.reset_text || '').split(' (')[0].trim();
  const t = isoEpoch(row?.reset_at);
  const when = t === null ? '' : (({ day, time }) => `${day} ${time}`)(dayTime(t, now));
  if (delta && when) return `Resets in ${delta} · ${when}`;
  if (delta) return `Resets in ${delta}`;
  return when ? `Resets ${when}` : '';
}

/** §4.14 projection line: "On pace to reach 100% at 4:41 PM" (a day is
 * named when it isn't today), "Limit reached" when hit, or the backend's
 * own sentence when it sent no machine-readable time. */
export function projectionLine(row, now) {
  const st = quotaState(row);
  if (st.hit) return 'Limit reached';
  if (!st.pace) return '';
  if (st.runOutAt === null) return sentenceCase(row.projection.text);
  const phrase = whenPhrase(st.runOutAt, now);
  return `On pace to reach 100% ${phrase.startsWith('today ') ? phrase.slice(6) : phrase}`;
}
