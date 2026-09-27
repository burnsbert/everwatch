// Tokens Used strip + token alert chip model (VISUAL_SPEC §4.18, T040).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, itemState, runOutText, itemOf, itemTip, itemLabel, providerModel, stripModel, paceHitAlerts,
} from '../../everwatch/web/js/lib/tokens.mjs';

// Local-time epoch seconds / ISO, so the tests don't depend on the zone.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
const iso = (t) => new Date(t * 1000).toISOString();
const NOW = at(2026, 9, 21, 12, 0); // Monday noon

const row = (over = {}) => ({
  id: 'cc.five_hour', label: 'CC Session Limit', pct: 30, level: 'green', hit: false, projection: null, reset_at: iso(at(2026, 9, 21, 17, 15)), reset_text: '5h 15m', dollars: null, ...over,
});

test('itemState: hit > pace > red > yellow > ok, straight off the backend fields', () => {
  assert.equal(itemState({ hit: true, pace: false, level: 'red' }), 'hit');
  assert.equal(itemState({ hit: false, pace: true, level: 'ok' }), 'pace');
  assert.equal(itemState({ hit: false, pace: false, level: 'red' }), 'red');
  assert.equal(itemState({ hit: false, pace: false, level: 'yellow' }), 'yellow');
  assert.equal(itemState({ hit: false, pace: false, level: 'ok' }), 'ok');
});

test('severity follows the backend level at the 49/50/79/80/100 boundaries (the UI never re-derives)', () => {
  const cases = [[49, 'green', 'ok'], [50, 'yellow', 'yellow'], [79, 'yellow', 'yellow'], [80, 'red', 'red'], [100, 'red', 'red']];
  for (const [pct, level, want] of cases) {
    const it = itemOf(row({ pct, level }), NOW);
    assert.equal(it.state, want, `${pct}%`);
    assert.equal(it.pct, pct);
  }
  const hit = itemOf(row({ pct: 100, level: 'red', hit: true }), NOW);
  assert.equal(hit.state, 'hit');
  assert.equal(hit.meter, 100);
});

test('pace: an hourglass state with the run-out time from projection.at; a day is named when not today', () => {
  const it = itemOf(row({ pct: 34, level: 'green', projection: { hit: false, at: iso(at(2026, 9, 21, 16, 41)), text: 'on pace…' } }), NOW);
  assert.equal(it.state, 'pace');
  assert.equal(it.runOut, '4:41 PM');
  const tip = itemTip(it);
  assert.equal(tip.title, 'Claude Code — 5-hour session limit');
  assert.equal(tip.body, '34% used · resets today at 5:15 PM');
  assert.deepEqual(tip.lines, [{ text: 'On pace to run out at 4:41 PM, before it resets', tone: 'warn' }]);
  const thu = itemOf(row({ projection: { hit: false, at: iso(at(2026, 9, 24, 9, 5)) } }), NOW);
  assert.equal(thu.runOut, 'Thu 9:05 AM');
  assert.equal(itemTip(thu).lines[0].text, 'On pace to run out Thu at 9:05 AM, before it resets');
  const tomorrow = itemOf(row({ projection: { hit: false, at: iso(at(2026, 9, 22, 9, 5)) } }), NOW);
  assert.equal(itemTip(tomorrow).lines[0].text, 'On pace to run out tomorrow at 9:05 AM, before it resets');
  // no machine-readable time: the backend sentence, in sentence case
  const text = itemOf(row({ projection: { hit: false, at: null, text: 'on pace to hit session limit soon' } }), NOW);
  assert.equal(text.runOut, '');
  assert.equal(itemTip(text).lines[0].text, 'On pace to hit session limit soon');
  const bare = itemOf(row({ projection: { hit: false } }), NOW);
  assert.equal(itemTip(bare).lines[0].text, 'On pace to run out before it resets');
  assert.equal(runOutText(null, NOW), '');
});

test('hit: "Limit reached · resets …" in danger; dollars only when shown', () => {
  const it = itemOf(row({
    id: 'cc.seven_day_sonnet', pct: 100, level: 'red', hit: true, reset_at: iso(at(2026, 9, 27, 19, 0)), dollars: 12.5,
  }), NOW, { showDollars: true });
  const tip = itemTip(it);
  assert.equal(tip.title, 'Claude Code — weekly Sonnet limit');
  assert.equal(tip.body, '100% used · $12.50');
  assert.deepEqual(tip.lines, [{ text: 'Limit reached · resets Sun at 7:00 PM', tone: 'danger' }]);
  assert.match(itemLabel(it), /^Claude Code — weekly Sonnet limit: 100% used · \$12\.50\. Limit reached/);
  assert.equal(itemOf(row({ dollars: 3 }), NOW).dollars, '');
  const noReset = itemOf(row({ hit: true, reset_at: null }), NOW);
  assert.deepEqual(itemTip(noReset).lines, [{ text: 'Limit reached', tone: 'danger' }]);
});

test('providerModel: statuses, notes, stale warning, worst item', () => {
  const [claude, codex] = PROVIDERS;
  const ok = providerModel(claude, { status: 'ok', rows: [row({ pct: 62, level: 'yellow' }), row({ id: 'cc.seven_day', pct: 90, level: 'red' })] }, NOW);
  assert.equal(ok.worst.id, 'cc.seven_day');
  assert.equal(ok.note, '');
  assert.equal(ok.warning, '');
  assert.equal(providerModel(codex, undefined, NOW).note, 'Not running');
  assert.equal(providerModel(codex, { status: 'no_token', rows: [] }, NOW).note, 'Not connected');
  const failing = providerModel(codex, { status: 'failing', rows: [], error: 'HTTP 500' }, NOW);
  assert.equal(failing.note, 'Fetch failed');
  assert.equal(failing.warning, 'Usage fetch failed: HTTP 500');
  assert.equal(providerModel(codex, { status: 'failing', rows: [] }, NOW).warning, 'Usage fetch failed');
  const stale = providerModel(claude, { status: 'stale', at: NOW - 720, rows: [row()] }, NOW);
  assert.equal(stale.warning, 'Usage fetch failing — showing data from 12m ago');
  assert.equal(providerModel(claude, { status: 'stale', rows: [row()] }, NOW).warning, 'Usage fetch failing');
  // ties on state break by the higher percentage
  const tie = providerModel(claude, { status: 'ok', rows: [row({ pct: 55, level: 'yellow' }), row({ id: 'cc.monthly', pct: 70, level: 'yellow' })] }, NOW);
  assert.equal(tie.worst.id, 'cc.monthly');
});

test('stripModel shows every quota for both providers, in fixed order', () => {
  const groups = stripModel({
    claude: { status: 'ok', rows: [row(), row({ id: 'cc.seven_day' }), row({ id: 'cc.seven_day_sonnet' }), row({ id: 'cc.monthly' })] },
    codex: { status: 'ok', rows: [row({ id: 'cx.five_hour' }), row({ id: 'cx.seven_day' })] },
  }, NOW);
  assert.deepEqual(groups.map((g) => g.key), ['claude', 'codex']);
  assert.deepEqual(groups[0].items.map((i) => i.full), ['Session', 'Weekly', 'Sonnet', 'Monthly']);
  assert.deepEqual(groups[1].items.map((i) => i.full), ['5h', 'Weekly']);
  assert.deepEqual(groups[0].items.map((i) => i.short), ['5h', '7d', 'Son.', 'Mo.']);
  assert.deepEqual(stripModel(null, NOW).map((g) => g.note), ['Not running', 'Not running']);
});

// T046: the toolbar's single-worst-state chip is gone; every pace/hit
// quota gets its own small chip instead, side by side, worst first.
test('paceHitAlerts: hit before pace (earliest run-out first); short label + time, never the full name', () => {
  const groups = stripModel({
    claude: {
      status: 'ok',
      rows: [
        row({ pct: 62, level: 'yellow', projection: { hit: false, at: iso(at(2026, 9, 21, 16, 41)) } }),
        row({ id: 'cc.seven_day', pct: 34, level: 'green', projection: { hit: false, at: iso(at(2026, 9, 21, 14, 0)) } }),
        row({ id: 'cc.seven_day_sonnet', pct: 100, level: 'red', hit: true }),
        row({ id: 'cc.monthly', pct: 84, level: 'red' }), // red, not pace/hit — no alert chip
      ],
    },
    codex: { status: 'ok', rows: [row({ id: 'cx.seven_day', pct: 58, level: 'yellow' }), row({ id: 'cx.five_hour', pct: 10 })] },
  }, NOW);
  const alerts = paceHitAlerts(groups);
  assert.deepEqual(alerts.map((a) => a.item.id), ['cc.seven_day_sonnet', 'cc.seven_day', 'cc.five_hour']);
  assert.deepEqual(alerts.map((a) => a.kind), ['hit', 'pace', 'pace']);
  assert.deepEqual(alerts.map((a) => a.full), [
    'Claude Sonnet',
    'Claude 7d · 2:00 PM',
    'Claude 5h · 4:41 PM',
  ]);
  assert.deepEqual(alerts.map((a) => a.short), ['', '2:00 PM', '4:41 PM']);
  for (const a of alerts) {
    const t = itemTip(a.item);
    assert.doesNotMatch(t.title, /\b(CC|CX)\b/);
  }
  // no run-out time known: falls back to a wordier full label, no short form
  const noTime = paceHitAlerts(stripModel({ claude: { status: 'ok', rows: [row({ projection: { hit: false, at: null } })] } }, NOW));
  assert.deepEqual([noTime[0].full, noTime[0].short], ['Claude 5h on pace to run out', '']);
  // ok/red/yellow-only quotas never get an alert chip
  assert.deepEqual(paceHitAlerts(stripModel({ claude: { status: 'ok', rows: [row({ pct: 84, level: 'red' })] } }, NOW)), []);
  assert.deepEqual(paceHitAlerts(stripModel({ claude: { status: 'ok', rows: [row()] } }, NOW)), []);
});
