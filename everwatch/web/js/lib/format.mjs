// Text formatting shared by every view: ages, row age column, freshness,
// preview titles, and the `tailLines` / `stripChrome` port of ultrawatch's
// draw.py (P-37, P-44). Pure functions only — no DOM, no clock reads.

export const DEFAULTS = Object.freeze({
  snapshotInterval: 2,   // seconds (P-75)
  freshSeconds: 30,      // idle-less-than-this rows are "just finished"
  flashSeconds: 1.5,     // black-on-amber flash on a transition to waiting
  // §4.13: every toast (including errors — the D-generation "toasts" spec's
  // 6 s exception for actionable errors was overridden by the user: "whatever
  // popups we do need should disappear by themselves after 3-4 seconds").
  toastSeconds: 3.5,
});

export const KIND_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });

/** `draw.age_str`: whole seconds → `42s`, `3m`, `2h`, `4d` (floored). */
export function ageStr(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Spoken form of an age, for screen-reader labels. */
export function ageSpoken(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

/**
 * `list_view.row_age`: `wait {age}` while waiting; `idle {age}` for idle or
 * quiet sessions whose last change is at least 60 s old; otherwise ''.
 */
export function rowAge(session, now) {
  if (session.state === 'waiting' && session.state_since) {
    return `wait ${ageStr(now - session.state_since)}`;
  }
  if ((session.state === 'idle' || session.state === 'quiet') && session.last_change) {
    const age = now - session.last_change;
    if (age >= 60) return `idle ${ageStr(age)}`;
  }
  return '';
}

/**
 * `list_view.is_fresh`: not busy or waiting, last change more than 5 s after
 * startup (everything looks new at launch) and less than `freshSeconds` ago.
 */
export function isFresh(session, now, started, freshSeconds = DEFAULTS.freshSeconds) {
  if (session.state === 'waiting' || session.state === 'busy') return false;
  const change = session.last_change || 0;
  return change > (started || 0) + 5 && now - change < freshSeconds;
}

/** Preview footer freshness text (P-27). */
export function freshnessText(now, snapshotAt) {
  if (!snapshotAt) return 'waiting for first snapshot';
  const age = now - snapshotAt;
  return age < 3 ? 'live · updated just now' : `updated ${ageStr(age)} ago`;
}

/**
 * Preview title parts (P-27): path · label · kind · STATE + age. Busy gets no
 * age. Returns `{parts, state, age}` so the view can style the state chip.
 */
export function previewTitle(session, now) {
  if (!session) return { parts: ['no session'], state: null, age: '' };
  const parts = [session.path || session.name || session.uid.slice(0, 8)];
  if (session.label) parts.push(session.label);
  const kind = KIND_NAMES[session.kind];
  if (kind) parts.push(kind);
  const st = session.state;
  const shown = st === 'waiting' || st === 'busy' || st === 'idle';
  const age = shown && st !== 'busy' && session.state_since ? ageStr(now - session.state_since) : '';
  return { parts, state: shown ? st : null, age };
}

/** Status chip model for the toolbar (P-20). */
export function statusChip(iterm, now, snapshotInterval = DEFAULTS.snapshotInterval, conn = 'open') {
  if (conn !== 'open') {
    return conn === 'connecting'
      ? { level: 'muted', text: 'Connecting…', tip: 'Connecting to the Everwatch backend.' }
      : { level: 'warn', text: 'Reconnecting…', tip: 'Lost the connection to the Everwatch backend. Retrying automatically.' };
  }
  const status = iterm?.status || 'connecting';
  switch (status) {
    case 'not_running':
      return { level: 'danger', text: 'iTerm2 not running', tip: 'iTerm2 isn’t running. Everwatch keeps checking and recovers by itself.' };
    case 'permission_denied':
      return { level: 'danger', text: 'No permission', tip: 'macOS is blocking Everwatch from controlling iTerm2 (Automation permission denied).' };
    case 'connecting':
      return { level: 'muted', text: 'Connecting…', tip: 'Waiting for the first iTerm2 snapshot.' };
    case 'error':
    case 'timeout':
      return {
        level: 'warn', text: 'STALE',
        tip: `The last iTerm2 query failed${iterm.error ? `: ${iterm.error}` : ''}. Showing the previous snapshot.`,
      };
    default: {
      const at = iterm?.snapshot_at || 0;
      const age = now - at;
      if (at && age > 4 * snapshotInterval) {
        return { level: 'warn', text: `STALE ${ageStr(age)}`, tip: `No fresh iTerm2 snapshot for ${ageSpoken(age)}.` };
      }
      return { level: 'ok', text: 'Live', tip: 'Watching iTerm2. Snapshots arrive every few seconds.' };
    }
  }
}

/**
 * Which full-page empty state to show (P-29), or null when sessions render.
 * `no_token`: no auth token; `no_backend`: never got a state and the stream
 * is down; iTerm2 not running / permission denied win even over stale rows.
 */
export function emptyStateKind({ server, conn, token }) {
  if (!token) return 'no_token';
  if (!server) return conn === 'reconnecting' ? 'no_backend' : 'connecting';
  const status = server.iterm?.status || 'connecting';
  if (status === 'not_running') return 'not_running';
  if (status === 'permission_denied') return 'permission_denied';
  if ((server.sessions || []).length) return null;
  if (status === 'connecting') return 'connecting';
  if (status === 'error' || status === 'timeout') return 'error';
  return 'no_sessions';
}

// --- tailLines / stripChrome (draw.py:56-89) --------------------------------

const CHROME_PREFIXES = ['⏵⏵'];

/** Python's str.strip() whitespace set, close enough for terminal text. */
function pyStrip(s) {
  return s.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/gu, '');
}

function pyRstrip(s) {
  return s.replace(/[\s\u001c-\u001f\u0085]+$/u, '');
}

/** A trailing line of agent-CLI furniture (input box, bare prompt, footer). */
export function isChrome(line) {
  const s = pyStrip(line);
  if (!s || s === '❯') return true;
  if ([...s].every((ch) => ch === '─' || ch === '━')) return true;
  if (CHROME_PREFIXES.some((p) => s.startsWith(p))) return true;
  if (s.includes('% remaining]')) return true;
  return false;
}

/** Drop up to 8 trailing chrome lines, then any trailing blanks. */
export function stripChrome(lines) {
  const out = lines.slice();
  let stripped = 0;
  while (out.length && stripped < 8 && isChrome(out[out.length - 1])) {
    out.pop();
    stripped += 1;
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/**
 * Last `n` non-trailing-blank lines of `text`, each clipped to `width` code
 * points (`width` ≤ 0 clips to ''; pass Infinity for no clipping).
 */
export function tailLines(text, n, width = Infinity, strip = false) {
  let lines = String(text ?? '').split('\n').map(pyRstrip);
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (strip) lines = stripChrome(lines);
  if (!(n > 0)) return [];
  const w = Math.max(0, width);
  return lines.slice(-n).map((l) => (w === Infinity ? l : [...l].slice(0, w).join('')));
}

/** Full screen text minus trailing blank lines (the split preview body). */
export function screenBody(text) {
  return tailLines(text, Number.MAX_SAFE_INTEGER).join('\n');
}

/** `list pane N% of width` (P-22) — Python's `{:.0%}` rounds half-even. */
export function percent(ratio) {
  const x = ratio * 100;
  const floor = Math.floor(x);
  const diff = x - floor;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) r = floor % 2 === 0 ? floor : floor + 1;
  else r = Math.round(x);
  return `${r}%`;
}

/** Plural helper for counts: `1 tab`, `9 tabs`. */
export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/**
 * Dollar amount for the usage meters' `$` toggle (P-58): `$1,234` (no cents)
 * at $100 or more, `$12.50` below that. DESIGN.md gives only these two
 * examples, not an exact threshold; documented judgment call.
 */
export function formatDollars(amount) {
  if (amount === null || amount === undefined) return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}
