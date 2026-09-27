# Contributing to Everwatch

Thanks for taking a look. This is a small, focused project — read
`docs/DESIGN.md` first for the full design, parity matrix, and rationale;
this file just covers the mechanics of working in the repo.

## Dev setup

```bash
git clone https://github.com/burnsbert/everwatch.git
cd everwatch
npm install          # dev-only JS test tooling (Playwright, c8)
make install-dev     # builds the shell and symlinks the runtime to this checkout
```

Requirements: macOS with the Xcode Command Line Tools (`xcode-select -p`),
Python 3.9+ (both your regular `python3` and the CLT's `/usr/bin/python3`
are exercised by the test suite), and Node 20+ (dev tooling only — the
shipped runtime has zero npm dependencies).

## Test commands

| Command | Runs |
|---|---|
| `make test` | Everything: `test-py`, `test-py39`, `test-js`, `test-swift`, `test-shell-integration`, `test-e2e`, `test-e2e-real`, `test-install`, `lint`. |
| `make test-fast` | Everything except the slower shell-integration and end-to-end suites — the one to run in a tight loop. |
| `make test-py` | Python unit tests (stdlib `unittest`) with branch coverage, gated at ≥90% for `everwatch/`. |
| `make test-py39` | The same suite under the exact Python 3.9.6 the Command Line Tools ship, no coverage. |
| `make test-js` | `node:test` unit tests over `everwatch/web/js`, gated at ≥90% lines / 85% branches via `c8`. |
| `make test-swift` | Swift Testing over `shell/Sources/Core` (built with `swiftc`, not SwiftPM — see `docs/DESIGN.md` §5.4), plus a compile check of `Sources/App`. |
| `make test-e2e` | Headless Playwright/Chromium end-to-end tests against a demo backend (a JS fixture server stands in for the Python backend). |
| `make test-e2e-real` | Browser smoke tests (`tests/e2e/real/smoke.spec.mjs`) against the real `python3 -m everwatch serve --demo` backend instead of the JS fixture server. |
| `make test-shell-integration` | A headless runtime test of the built `Everwatch.app` (`scripts/shell_selftest.sh`): never shown, focused, or given a real permission prompt. |
| `make test-install` | `install.sh`'s own hermetic end-to-end test (`tests/install/test_install.sh`) — runs entirely inside a temp `--prefix`/`--from-local`, never touching the real `~/Applications`, `~/Library/Application Support/Everwatch`, or `~/.local/bin`. |
| `make lint` | No-sound lint, parity accounting (`scripts/check_parity.py`), Python byte-compile, `bash -n` checks of the shell scripts, JS syntax checks, and `shellcheck` (if installed). |

Run `make test-fast` before every commit; run `make test` before opening a
PR.

## Hard rules

**No sound, ever, in dev or tests.** There's exactly one place in the repo
allowed to make sound: the Swift shell's `SoundPolicy`/
`SystemSoundPlayer`, gated behind a persisted, default-off preference and
hard-disabled by `EVERWATCH_NO_SOUND=1` (which every test harness sets).
The Python backend and the web UI have no way to make sound at all.
`scripts/lint_nosound.py` enforces this by grepping the whole repo for
sound-making APIs and failing on anything outside the one allowlisted
file pair. If your change needs a new allowlisted site, it needs a very
good reason and a note in `docs/DESIGN.md` §5.2.

**Tests stay headless.** No test may open a visible window, Dock icon, or
menu bar item, drive or focus a real window, call `screencapture`, or call
real `osascript`/`ps`/`lsof`/`security`, or touch the network. (One
exception in spirit only, not in visibility: `make test-shell-integration`
runs a throwaway, `LSBackgroundOnly` copy of the compiled `Everwatch.app`
binary directly — never via `open` — that shows no window, Dock icon, or
menu bar item and asks for no permission; see `scripts/shell_selftest.sh`.)
Python tests get this enforced automatically (`tests/py/__init__.py`
patches the relevant `subprocess`/`urllib`/`socket` calls and raises
`RealIOForbidden` if anything reaches them unmocked); Playwright is
configured `headless: true` with a lint check that rejects `--headed`. Use
the injected `DataSource` fakes (`FakeSource`, `DemoSource`) instead of the
real thing.

## Parity tags

Every behavior ported from ultrawatch (or added new) has an id in
`docs/DESIGN.md`'s parity matrix (`P-01`, `P-02`, …) or wow-feature table
(`W-1`, `W-2`, …). A test that covers one of those rows should carry a
comment tagging it:

```python
# parity: P-12
def test_classifier_matches_menu_option(self):
    ...
```

```js
// parity: P-30
test('help sheet closes on any key', () => { ... });
```

Multiple ids can be comma-separated (`# parity: P-11, P-15`). Swift tests
use the same convention, one line above `@Test`.
`scripts/check_parity.py` parses `docs/DESIGN.md` and every test
directory and reports any parity id with no tagged test (and any tag that
references an unknown id — usually a typo). Run it directly with
`python3 scripts/check_parity.py`.

## Maintainer manual checks (visible app)

Everything above runs headless. After shell (`shell/Sources/**`) changes,
a maintainer should also run the 12-item manual smoke test in
[shell/README.md](shell/README.md#manual-smoke-test-maintainer-on-a-real-mac-not-ci)
on a real Mac — it covers things like the actual TCC prompt wording and
notification/hotkey behavior that can't be automated headlessly.

## Regenerating generated docs

If you change `everwatch/web/js/keymap.mjs`'s `BINDINGS` table, regenerate
the keyboard-shortcuts table in `README.md` so it doesn't drift from what
the app's own help sheet (`?`) shows:

```bash
make docs-keys
```

To explore sample data or update the README images, use `make demo` or
`make screenshots`, respectively. Both run separately from an installed
Everwatch app. The [screenshot guide](docs/SCREENSHOTS.md) covers the
temporary data directory, fixed scenario, and image review.

## Code review expectations

- Keep changes scoped — this repo has file ownership per work package
  (see `docs/DESIGN.md` §7); don't drive-by edit files another change is
  actively working on.
- New behavior that has an ultrawatch precedent should read the ported
  source, not just its README, and should get a parity tag.
- Runtime code (`everwatch/`, `everwatch/web/`, `shell/`) stays dependency-free
  (Python stdlib, vanilla ES modules, Foundation-only Swift). npm packages
  are fine as dev-only test tooling.
