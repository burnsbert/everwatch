import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../../everwatch/web/js/lib/clipboard.mjs';

function fakeDoc({ execOk = true } = {}) {
  const els = [];
  return {
    execCalls: 0,
    createElement(tag) {
      const el = {
        tag,
        style: {},
        value: '',
        select() {},
        remove() { const i = els.indexOf(el); if (i >= 0) els.splice(i, 1); },
      };
      els.push(el);
      return el;
    },
    body: { append(el) { els.push(el); } },
    execCommand(cmd) {
      this.execCalls = (this.execCalls || 0) + 1;
      if (!execOk) throw new Error('nope');
      return true;
    },
  };
}

test('copyText prefers navigator.clipboard.writeText when available', async () => {
  const written = [];
  const nav = { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } };
  const doc = fakeDoc();
  copyText('hello', doc, nav);
  await Promise.resolve(); // let the microtask settle
  assert.deepEqual(written, ['hello']);
});

test('copyText falls back to execCommand when clipboard.writeText rejects', async () => {
  const nav = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } };
  const doc = fakeDoc();
  copyText('fallback text', doc, nav);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doc.execCalls, 1);
});

test('copyText falls back to execCommand when navigator.clipboard is absent', () => {
  const doc = fakeDoc();
  copyText('no clipboard api', doc, {});
  assert.equal(doc.execCalls, 1);
});

test('copyText never throws even when every path fails', () => {
  const doc = fakeDoc({ execOk: false });
  assert.doesNotThrow(() => copyText('doomed', doc, {}));
});

test('copyText coerces non-string values and tolerates a null/undefined text', () => {
  const doc = fakeDoc();
  assert.doesNotThrow(() => copyText(undefined, doc, {}));
  assert.doesNotThrow(() => copyText(42, doc, {}));
});
