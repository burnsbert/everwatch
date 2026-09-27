#!/usr/bin/env python3
"""Parity accounting (docs/DESIGN.md §5.2).

**Reporting-only in WP1.** WP9 flips this script to enforcing mode by
setting `EVERWATCH_CHECK_PARITY_ENFORCE=1`, once every work package that
owns a P-/W- row has landed its tests.

Tag convention: a test that exercises a parity-matrix row from
DESIGN.md carries a comment `# parity: P-12` (or `# parity: W-3`),
either on the same line as its `def test_...` or on the line directly
above. Multiple ids can be comma-separated: `# parity: P-11, P-15`.
grep-friendly and language-agnostic (works in .py/.js/.mjs/.swift), so
it needs no test-framework integration.

This script:
1. Parses every `P-\\d+` / `W-\\d+` id that starts a markdown table row
   in docs/DESIGN.md (section 1's parity tables and section 2's "ship
   in v1" wow-feature table), and whether that row is required (its
   "St" column, when present, is not `N/A`).
2. Walks tests/py, tests/js, tests/e2e, and shell/Tests (once they
   exist) for `# parity: ` comments and collects every id they
   reference.
3. Reports ids with no test tag (MISSING) and tags that reference an id
   not found in DESIGN.md (UNKNOWN — usually a typo). Exits 0 unless
   EVERWATCH_CHECK_PARITY_ENFORCE=1 and there's a MISSING or UNKNOWN id.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESIGN_PATH = os.path.join(ROOT, 'docs', 'DESIGN.md')
TEST_DIRS = ('tests/py', 'tests/js', 'tests/e2e', 'shell/Tests')
TEST_FILE_SUFFIXES = ('.py', '.mjs', '.js', '.swift')

ROW_ID_RE = re.compile(r'^\|\s*((?:P|W)-\d+)\s*\|')
TAG_RE = re.compile(r'#\s*parity:\s*([^\n]+)')
TAG_ID_RE = re.compile(r'(?:P|W)-\d+')

ENFORCE = os.environ.get('EVERWATCH_CHECK_PARITY_ENFORCE') == '1'


def design_ids(design_path=DESIGN_PATH):
    """{id: required} parsed from every DESIGN.md table row that starts
    with a P-xx or W-xx id. `required` is False only when that row's
    line also contains a literal `| N/A |` cell (ultrawatch behaviors
    that don't apply to Everwatch, e.g. P-73's curses redraw policy)."""
    ids = {}
    with open(design_path, encoding='utf-8') as f:
        for line in f:
            m = ROW_ID_RE.match(line)
            if not m:
                continue
            pid = m.group(1)
            required = '| N/A |' not in line
            ids[pid] = ids.get(pid, False) or required
    return ids


def tagged_ids(root=ROOT, test_dirs=TEST_DIRS):
    """{id: [ "path:lineno", ... ]} parsed from `# parity: ...` comments
    under each test directory that currently exists."""
    found = {}
    for rel in test_dirs:
        base = os.path.join(root, rel)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in filenames:
                if not name.endswith(TEST_FILE_SUFFIXES):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding='utf-8', errors='replace') as f:
                    for lineno, line in enumerate(f, 1):
                        tag_match = TAG_RE.search(line)
                        if not tag_match:
                            continue
                        for id_match in TAG_ID_RE.finditer(tag_match.group(1)):
                            pid = id_match.group(0)
                            found.setdefault(pid, []).append(
                                f'{os.path.relpath(path, root)}:{lineno}')
    return found


def main():
    ids = design_ids()
    tags = tagged_ids()

    required_count = sum(1 for required in ids.values() if required)
    missing = sorted(pid for pid, required in ids.items()
                     if required and pid not in tags)
    unknown = sorted(pid for pid in tags if pid not in ids)

    print(f'{len(ids)} parity ids in DESIGN.md '
         f'({required_count} required, {len(ids) - required_count} N/A)')
    print(f'{len(tags)} distinct ids tagged in tests under {", ".join(TEST_DIRS)}')
    if missing:
        print(f'MISSING test tag ({len(missing)}): {", ".join(missing)}')
    if unknown:
        print(f'UNKNOWN tag, not in DESIGN.md ({len(unknown)}): '
             f'{", ".join(unknown)}')
    if not missing and not unknown:
        print('OK: every required id is tagged and every tag is known')

    if ENFORCE and (missing or unknown):
        print('EVERWATCH_CHECK_PARITY_ENFORCE=1: failing the build.')
        return 1
    if not ENFORCE and (missing or unknown):
        print('Reporting-only (WP1): not failing the build. '
             'Set EVERWATCH_CHECK_PARITY_ENFORCE=1 to enforce (WP9).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
