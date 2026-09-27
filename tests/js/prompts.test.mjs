// W-10 quick-reply detection (everwatch/web/js/lib/prompts.mjs) against
// the demo backend's scripted screens and the tests/fixtures screen dumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectPrompt, sendFor, sanitizeReply, optionLabel, quickReplies } from '../../everwatch/web/js/lib/prompts.mjs';

const scenario = JSON.parse(readFileSync(new URL('../../everwatch/sources/demo_scenario.json', import.meta.url), 'utf8'));
const demo = (key) => scenario.screens[key].lines.join('\n');
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// # parity: W-10
test('Claude Code permission menu (boxed, ❯ 1.) → digit replies', () => {
  const p = detectPrompt(demo('cc_api_permission'), { kind: 'claude' });
  assert.equal(p.kind, 'menu');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => [o.n, o.label, o.selected]), [
    [1, 'Yes', true],
    [2, "Yes, and don't ask again for kubectl rollout commands", false],
    [3, 'No, and tell Claude what to do differently', false],
  ]);
  assert.deepEqual(p.options.map((o) => o.send), [{ text: '1' }, { text: '2' }, { text: '3' }]);
  assert.equal(p.options[2].shortcut, 'esc');
  assert.deepEqual(p.options.map((o) => o.risky), [false, true, false]);
  assert.deepEqual(quickReplies(p).map((o) => o.n), [1, 3], "no quick reply for \"don't ask again\"");
});

// # parity: W-10
test('Claude Code question menu with description lines between options', () => {
  const p = detectPrompt(demo('cc_dash_question'), { kind: 'claude' });
  assert.equal(p.kind, 'menu');
  assert.equal(p.question, 'Where should the chart colors come from?');
  assert.deepEqual(p.options.map((o) => o.label), ['Tailwind tokens', 'Dedicated palette', 'Type something.']);
});

// # parity: W-10
test('Codex numbered approval (› 1. … (y)) → letter shortcuts, (esc) → Esc key', () => {
  const p = detectPrompt(demo('cx_billing_approval'), { kind: 'codex' });
  assert.equal(p.kind, 'menu');
  assert.equal(p.question, 'Would you like to run the following command?');
  assert.deepEqual(p.options.map((o) => o.label), ['Yes, proceed', "Yes, and don't ask again for this command", 'No, and tell Codex what to do differently']);
  assert.deepEqual(p.options.map((o) => o.send), [{ text: 'y' }, { text: 'a' }, { key: 'esc' }]);
  assert.deepEqual(quickReplies(p).map((o) => o.send), [{ text: 'y' }, { key: 'esc' }]);
  // the › marker alone implies Codex when the kind is unknown
  assert.deepEqual(detectPrompt(demo('cx_billing_approval')).options[0].send, { text: 'y' });
});

test('fixture screens: Claude permission prompt and older unnumbered Codex approval', () => {
  const cc = detectPrompt(fixture('claude_permission_prompt.txt'), { kind: 'claude' });
  assert.equal(cc.kind, 'menu');
  assert.equal(cc.options.length, 3);
  const cx = detectPrompt(fixture('codex_approval.txt'), { kind: 'codex' });
  assert.equal(cx.kind, 'shortcut');
  assert.deepEqual(cx.options.map((o) => [o.label, o.send]), [
    ['Yes', { text: 'y' }],
    ['No, and tell Codex what to do differently', { key: 'esc' }],
  ]);
});

test('one-line Codex approval: "▌ Yes (y)   No (n)   Always for this session (a)"', () => {
  const screen = '• Proposed change to services/refunds.py (+28 -4)\n\n  Allow command?\n\n    pytest tests/test_refunds.py -q\n\n  ▌ Yes (y)   No (n)   Always for this session (a)\n';
  const p = detectPrompt(screen, { kind: 'codex' });
  assert.equal(p.kind, 'shortcut');
  assert.equal(p.question, 'Allow command?');
  assert.deepEqual(p.options.map((o) => [o.label, o.send.text]), [['Yes', 'y'], ['No', 'n'], ['Always for this session', 'a']]);
  assert.deepEqual(quickReplies(p).map((o) => o.label), ['Yes', 'No']);
  assert.equal(detectPrompt('  Allow command?\n  Yes (y)   and some prose'), null);
  assert.equal(detectPrompt('Yes (y)   No (n)'), null, 'needs a question above');
});

// # parity: W-10
test('no prompt on busy / idle / shell screens (numbered lists without a ❯ marker are not menus)', () => {
  for (const key of ['cc_api_busy', 'cc_dash_busy', 'cx_billing_working', 'cc_docs_idle', 'cx_ml_idle', 'sh_home', 'sh_vite', 'cc_infra_idle']) {
    assert.equal(detectPrompt(demo(key)), null, key);
  }
  for (const name of ['claude_busy_esc.txt', 'claude_busy_spinner.txt', 'claude_idle.txt', 'codex_working.txt', 'plain_shell.txt']) {
    assert.equal(detectPrompt(fixture(name)), null, name);
  }
  const list = 'Summary\n  1. Batched writes\n  2. Added --resume\n\n❯ ';
  assert.equal(detectPrompt(list), null);
  assert.equal(detectPrompt(''), null);
  assert.equal(detectPrompt(null), null);
});

test('a menu scrolled far above the bottom is stale', () => {
  const old = `${demo('cc_api_permission')}\n${Array.from({ length: 10 }, (_, i) => `later output ${i}`).join('\n')}`;
  assert.equal(detectPrompt(old), null);
});

test('numbering must run 1, 2, 3… and a new "1." restarts the block', () => {
  assert.equal(detectPrompt('❯ 1. A\n  3. C'), null);
  const p = detectPrompt('  1. old\n  2. old\n❯ 1. New A\n  2. New B');
  assert.deepEqual(p.options.map((o) => o.label), ['New A', 'New B']);
});

// # parity: W-10
test('shell y/n questions → y/n + Return', () => {
  const p = detectPrompt('Removing 3 files.\nContinue? [y/N] ');
  assert.equal(p.kind, 'yn');
  assert.deepEqual(p.options.map((o) => o.send), [{ text: 'y', enter: true }, { text: 'n', enter: true }]);
  const w = detectPrompt('Overwrite config (yes/no)?');
  assert.deepEqual(w.options.map((o) => o.send.text), ['yes', 'no']);
  assert.equal(detectPrompt('Continue? [y/N]\nsam@mbp ~ % '), null, 'only the cursor line counts');
});

test('sendFor, optionLabel, sanitizeReply', () => {
  assert.deepEqual(sendFor({ n: 2, shortcut: 'a' }, 'claude'), { text: '2' });
  assert.deepEqual(sendFor({ n: 2, shortcut: '' }, 'codex'), { text: '2' });
  assert.equal(optionLabel({ n: 1, label: 'Yes' }, 'menu'), '1. Yes');
  assert.equal(optionLabel({ n: 1, label: 'Yes', shortcut: 'y' }, 'shortcut'), 'Yes (y)');
  assert.equal(optionLabel({ n: 1, label: 'Yes', shortcut: 'y' }, 'yn'), 'Yes');
  assert.equal(sanitizeReply('a\tb\nc\u001b[2J\u0085'), 'a b c [2J ');
  assert.equal(sanitizeReply(undefined), '');
  assert.deepEqual(quickReplies(null), []);
  assert.deepEqual(quickReplies(detectPrompt('Continue? [y/N]')).map((o) => o.label), ['Yes', 'No']);
});
