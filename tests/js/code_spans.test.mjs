import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeSpans } from '../../everwatch/web/js/lib/code_spans.mjs';

test('codeSpans splits backtick spans out of plain text (VISUAL_SPEC §4.15 diagnostics)', () => {
  assert.deepEqual(codeSpans('The optional `iterm2` Python package is not installed.'), [
    { code: false, text: 'The optional ' },
    { code: true, text: 'iterm2' },
    { code: false, text: ' Python package is not installed.' },
  ]);
  assert.deepEqual(codeSpans('`lsof` and `claude`'), [
    { code: true, text: 'lsof' },
    { code: false, text: ' and ' },
    { code: true, text: 'claude' },
  ]);
});

test('codeSpans leaves text without a matched pair alone', () => {
  assert.deepEqual(codeSpans('plain'), [{ code: false, text: 'plain' }]);
  assert.deepEqual(codeSpans('a ` lone tick'), [{ code: false, text: 'a ` lone tick' }]);
  assert.deepEqual(codeSpans('empty `` pair'), [{ code: false, text: 'empty `` pair' }]);
  assert.deepEqual(codeSpans(''), []);
  assert.deepEqual(codeSpans(null), []);
});

test('codeSpans never interprets markup: angle brackets stay text', () => {
  assert.deepEqual(codeSpans('`<b>x</b>` <i>'), [
    { code: true, text: '<b>x</b>' },
    { code: false, text: ' <i>' },
  ]);
});
