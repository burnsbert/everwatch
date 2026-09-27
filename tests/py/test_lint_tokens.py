"""scripts/lint_tokens.py: the `make lint` design-token rule
(docs/design/VISUAL_SPEC.md §8 per-WP acceptance)."""
import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_spec = importlib.util.spec_from_file_location('lint_tokens', os.path.join(ROOT, 'scripts', 'lint_tokens.py'))
lint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lint)


def msgs(found):
    return [m for _, m in found]


class LiteralTests(unittest.TestCase):
    def test_hex_colors_flagged_except_the_white_knob(self):
        found = lint.check_literals('.a { color: #1d1d1f; }\n.b { background: #fff; }\n.c { color: #FFFFFF; }')
        self.assertEqual(found, [(1, 'literal color #1d1d1f')])

    def test_font_sizes(self):
        self.assertEqual(msgs(lint.check_literals('.a { font-size: 12.5px; }')), ['literal font-size: 12.5px'])
        self.assertEqual(msgs(lint.check_literals('.a { font: 600 11px/1.3 var(--font-mono); }')),
                         ['literal font: 600 11px/1.3 var(--font-mono)'])
        self.assertEqual(lint.check_literals('.a { font-size: var(--text-small-size); font: 500 var(--text-body); }'), [])
        self.assertEqual(lint.check_literals('.a { font-family: var(--font-ui); font-weight: 600; }'), [])

    def test_radii(self):
        self.assertEqual(msgs(lint.check_literals('.a { border-radius: 5px; }')), ['literal border-radius: 5px'])
        self.assertEqual(lint.check_literals('.a { border-radius: 50%; } .b { border-radius: 0; } .c { border-radius: var(--radius-s); }'), [])
        self.assertEqual(len(lint.check_literals('.a { border-top-left-radius: 3px; }')), 1)

    def test_shadows(self):
        self.assertEqual(len(lint.check_literals('.a { box-shadow: 0 1px 2px var(--shadow); }')), 1)
        self.assertEqual(len(lint.check_literals('.a { box-shadow: inset 0 0 0 1px var(--border); }')), 1)
        self.assertEqual(lint.check_literals(
            '.a { box-shadow: var(--shadow-1), var(--focus-ring); } .b { box-shadow: none; } .c { box-shadow: var(--x) !important; }'), [])

    def test_comments_are_ignored_and_line_numbers_survive(self):
        self.assertEqual(lint.check_literals('/* #123456\n font-size: 12px */\n.a { color: #abcdef; }'),
                         [(3, 'literal color #abcdef')])

    def test_press_scale_on_active_is_flagged(self):
        self.assertEqual(lint.check_active_transform('.a:active { transform: scale(0.98); }'),
                         [(1, 'transform on :active (press-scale; darken instead)')])
        self.assertEqual(lint.check_active_transform('.a:active { background: red; }\n.b { transform: none; }'), [])


class MainTests(unittest.TestCase):
    def run_main(self, files):
        with tempfile.TemporaryDirectory() as d:
            for name, text in files.items():
                with open(os.path.join(d, name), 'w') as f:
                    f.write(text)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = lint.main(d)
            return code, out.getvalue()

    def exempt_all_dirty(self):
        return {name: '.x { color: #123456; }' for name in lint.EXEMPT}

    def test_enforced_file_with_literals_fails_exempt_ones_pass(self):
        files = self.exempt_all_dirty()
        files['tokens.css'] = ':root { --bg: #151517; }'
        files['base.css'] = '.a { color: var(--fg); }'
        self.assertEqual(self.run_main(files)[0], 0)
        files['base.css'] = '.a { font-size: 13px; }'
        code, out = self.run_main(files)
        self.assertEqual(code, 1)
        self.assertIn('base.css:1: literal font-size: 13px', out)

    def test_a_clean_exempt_file_must_drop_its_exemption(self):
        # EXEMPT is empty in the repo now (WP-B migrated the last three
        # files); exercise the mechanism with a stand-in entry.
        with mock.patch.dict(lint.EXEMPT, {'reply.css': 'test'}):
            files = self.exempt_all_dirty()
            files['reply.css'] = '.a { color: var(--fg); }'
            code, out = self.run_main(files)
        self.assertEqual(code, 1)
        self.assertIn('reply.css: no literal values left; remove it from EXEMPT', out)

    def test_press_scale_fails_even_in_exempt_files(self):
        with mock.patch.dict(lint.EXEMPT, {'chrome.css': 'test'}):
            files = self.exempt_all_dirty()
            files['chrome.css'] += '\n.b:active { transform: scale(0.97); }'
            code, out = self.run_main(files)
        self.assertEqual(code, 1)
        self.assertIn('chrome.css:2: transform on :active', out)

    def test_exempt_is_empty_after_the_visual_pass(self):
        self.assertEqual(lint.EXEMPT, {})

    def test_the_repo_passes(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(lint.main(), 0, out.getvalue())


if __name__ == '__main__':
    unittest.main()
