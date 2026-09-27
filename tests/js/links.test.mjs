import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_URL, LICENSE_URL, RELEASES_URL } from '../../everwatch/web/js/lib/links.mjs';

test('About links point at the real repo and are all https', () => {
  for (const url of [GITHUB_URL, LICENSE_URL, RELEASES_URL]) {
    assert.match(url, /^https:\/\/github\.com\/burnsbert\/everwatch/);
  }
  assert.match(LICENSE_URL, /LICENSE$/);
  assert.match(RELEASES_URL, /\/releases$/);
});
