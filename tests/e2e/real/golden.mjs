// tests/golden/state_demo.json is exactly what a freshly spawned
// `everwatch serve --demo --seed 1 --clock fixed:2026-09-25T15:00:00-04:00`
// serves for its first /api/state (everwatch/sources/demo_scenario.json's
// own "clock" field is the same instant, and `make golden` is the same
// build_demo_engine() call `cli.py` makes). Reusing it here means the real
// e2e suite gets a `U` tab-label -> uid map the same way tests/e2e/
// fixtures.mjs does for the JS fixture server, without re-deriving it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_PATH = path.resolve(HERE, '../../golden/state_demo.json');

export function loadGolden() {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
}

export const GOLDEN = loadGolden();
export const NOW = GOLDEN.now;
/** tab_label ('1.1', '2.3', ...) -> uid */
export const U = GOLDEN.sessions.reduce((acc, s) => ({ ...acc, [s.tab_label]: s.uid }), {});
