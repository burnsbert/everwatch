# Everwatch — one entry point for every test layer (docs/DESIGN.md §5.1).
#
# Every layer below is real (WP1: test-py/test-py39/lint; WP4: test-js;
# WP5/WP6/WP9: test-e2e/test-swift/test-shell-integration/test-e2e-real).
# `make test` runs all of them (screenshots is separate -- run `make
# screenshots` explicitly); `make test-fast` skips the slower
# real-backend/shell-integration/e2e layers for a quick local loop.

PYTHON ?= python3
PY39   ?= /usr/bin/python3
NODE   ?= node

.PHONY: test test-fast test-py test-py39 test-js test-swift test-e2e test-e2e-real \
        test-shell-integration test-install lint screenshots clean app app-dev coverage-swift \
        icon golden install install-dev uninstall dist release docs-keys

test: test-py test-py39 test-js test-swift test-shell-integration test-e2e test-e2e-real test-install lint

test-fast: test-py test-py39 test-js test-swift test-install lint

# Real unit tests with branch coverage over everwatch/engine/ (§5.2).
# EVERWATCH_HOME points at a fresh temp dir so no test ever touches a
# real user's state, and EVERWATCH_NO_SOUND=1 is set even though the
# engine itself has no way to make sound (belt and suspenders, and it
# matches every other test target's environment).
test-py:
	EVERWATCH_NO_SOUND=1 EVERWATCH_HOME=$$(mktemp -d) $(PYTHON) -m coverage run \
		--branch --source=everwatch -m unittest discover -s tests/py -t . -v
	$(PYTHON) -m coverage report --fail-under=90 --show-missing

# Same suite under the CLT's stock Python (3.9.6 here), no coverage
# instrumentation (coverage isn't guaranteed installed there).
test-py39:
	EVERWATCH_NO_SOUND=1 EVERWATCH_HOME=$$(mktemp -d) $(PY39) -m unittest discover -s tests/py -t . -v

# JS unit tests (node:test) with c8 thresholds over everwatch/web/js (§5.2).
# --all counts files no test imports; DOM views and the main.mjs bootstrap
# are excluded here because they're covered by the Playwright suite.
test-js:
	EVERWATCH_NO_SOUND=1 npx --no-install c8 --all --src everwatch/web/js \
		--temp-directory build/c8/tmp --report-dir build/c8/report \
		--include 'everwatch/web/js/**/*.mjs' \
		--exclude 'everwatch/web/js/views/**' --exclude 'everwatch/web/js/main.mjs' \
		--reporter text --check-coverage --lines 90 --branches 85 \
		$(NODE) --test tests/js/

test-swift:
	EVERWATCH_NO_SOUND=1 scripts/build_app.sh --tests && EVERWATCH_NO_SOUND=1 build/shell-tests

# Headless runtime test of the built app (scripts/shell_selftest.sh): runs a
# throwaway LSUIElement copy of Everwatch.app directly (never `open`) with
# EVERWATCH_SELFTEST=1 against a `serve --demo --selftest` backend in a temp
# EVERWATCH_HOME. Nothing is shown, focused, prompted for, or played.
# In `make test` only (it builds the app and spawns real processes).
test-shell-integration:
	EVERWATCH_NO_SOUND=1 PYTHON=$(PYTHON) EVERWATCH_PYTHON=$$(command -v $(PYTHON)) scripts/shell_selftest.sh

app:
	scripts/build_app.sh

app-dev:
	scripts/build_app.sh --dev

coverage-swift:
	EVERWATCH_NO_SOUND=1 scripts/build_app.sh --coverage

icon:
	scripts/make_icon.sh

# install.sh's own end-to-end tests (docs/DESIGN.md §7 WP10 row): the
# --from-local path, and the real release path (latest-release resolution
# + download URLs), the latter served entirely from a local
# `python3 -m http.server` -- never real GitHub. Entirely inside temp
# --prefix dirs; never touches the real ~/Applications, ~/Library/
# Application Support/Everwatch, or ~/.local/bin, and never launches
# Everwatch.app.
test-install:
	bash tests/install/test_install.sh
	bash tests/install/test_install_release.sh

# Real installs -- these touch the actual $HOME (~/Applications,
# ~/Library/Application Support/Everwatch, ~/.local/bin). Never run by
# `make test`/`make test-fast`; see test-install above for the hermetic
# version of this same flow.
install: app
	./install.sh --from-local "$(CURDIR)" --yes

install-dev: app-dev
	EVERWATCH_DEV_LINK=1 ./install.sh --from-local "$(CURDIR)" --yes

uninstall:
	./install.sh --uninstall --yes

dist release:
	scripts/release.sh

# Headless Chromium only (cached revision 1243; @playwright/test pinned
# 1.63.0). Against tests/e2e/fixture-server.mjs, a JS stand-in server --
# see test-e2e-real below for the same-shaped suite against the real
# Python backend.
test-e2e:
	EVERWATCH_NO_SOUND=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npx --no-install playwright test --project=chromium

# Headless Chromium only, against the real `python3 -m everwatch serve
# --demo` process (tests/e2e/real/backend.mjs spawns one per test, never
# the non-demo backend, never opens a browser, never plays a sound).
test-e2e-real:
	EVERWATCH_NO_SOUND=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 EVERWATCH_E2E_PYTHON=$(PYTHON) npx --no-install playwright test --project=real

lint:
	$(PYTHON) scripts/lint_nosound.py
	$(PYTHON) scripts/lint_tokens.py
	EVERWATCH_CHECK_PARITY_ENFORCE=1 $(PYTHON) scripts/check_parity.py
	$(PYTHON) -m py_compile $$(find everwatch scripts tests -name '*.py')
	bash -n install.sh
	bash -n scripts/release.sh
	bash -n tests/install/test_install.sh
	bash -n tests/install/test_install_release.sh
	@! grep -rnE "h\\(['\"](svg|use|path)['\"]" everwatch/web/js || { echo "lint: build SVG with icon()/createElementNS, not h('svg') (HTML namespace renders blank)"; exit 1; }
	bash scripts/lint_shell_utf8.sh install.sh scripts/*.sh tests/install/test_install.sh tests/install/test_install_release.sh
	@if command -v shellcheck >/dev/null 2>&1; then shellcheck install.sh scripts/release.sh; fi
	@if [ -d everwatch/web ]; then \
		find everwatch/web \( -name '*.mjs' -o -name '*.js' \) -exec $(NODE) --check {} \; ; \
	fi

# Deterministic PNGs into docs/screenshots/, headless Chromium only,
# against the real demo backend (scripts/screenshots.mjs; never a
# visible window, never the real display, never a sound).
screenshots:
	EVERWATCH_NO_SOUND=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 EVERWATCH_E2E_PYTHON=$(PYTHON) $(NODE) scripts/screenshots.mjs

# Regenerates README.md's "Keyboard shortcuts" table from the single
# source of truth, everwatch/web/js/keymap.mjs's BINDINGS table, so the
# two can't drift (docs/DESIGN.md P-30, W-3).
docs-keys:
	$(NODE) scripts/gen_keys_table.mjs --write

clean:
	find . -name __pycache__ -type d -not -path './.git/*' -exec rm -rf {} +
	rm -rf build dist .coverage htmlcov

# Regenerates the golden demo-state fixture (docs/DESIGN.md §3.5, §7 WP3).
# Deterministic for a given seed/clock, so running it twice must produce
# a byte-identical file (checked by test_demo_source.py's own staleness
# test, and by the WP3 acceptance smoke: `make golden && make golden &&
# git diff --no-index` / shasum).
golden:
	$(PYTHON) -m everwatch.sources.demo -o tests/golden/state_demo.json
