"""Schema v2 persistence, prefs validation, and the ultrawatch import
(docs/DESIGN.md §3.7; P-48, P-66 policy, P-70, P-71). The v1-era tests
in test_persist.py still run against the same StateStore."""
import json
import os
import tempfile
import unittest

from everwatch.engine import config, persist

NOW = 1_790_000_000.0


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.path = os.path.join(self.dir, 'state.json')

    def write(self, data, path=None):
        with open(path or self.path, 'w', encoding='utf-8') as f:
            json.dump(data, f)

    def store(self, now=NOW):
        return persist.StateStore(path=self.path, now=now)


class TestSchemaV2(Base):
    def test_defaults_include_v2_keys_and_sound_off(self):  # parity: P-70, P-66
        st = self.store()
        self.assertEqual(st.get('version'), 2)
        self.assertFalse(st.get('sound_on_attention'))
        self.assertFalse(st.get('notify_on_waiting'))
        self.assertFalse(st.get('show_dock_badge'))
        self.assertEqual(st.get('session_font'), 'system')
        self.assertEqual(st.get('session_font_size'), 15)
        self.assertEqual(st.get('theme'), 'system')
        self.assertEqual(st.get('compact'), {'agents_only': True})
        self.assertIsNone(st.get('imported_from_ultrawatch'))
        self.assertNotIn('bell', st.state)

    def test_show_row_activity_defaults_off_and_is_patchable(self):
        # Settings "Show activity strip on sessions" (row/tile noise
        # reduction) — off by default, a normal PATCH-able bool pref.
        st = self.store()
        self.assertFalse(st.get('show_row_activity'))
        clean, rejected = st.update_prefs({'show_row_activity': True},
                                          now=NOW)
        self.assertEqual(rejected, [])
        self.assertTrue(clean['show_row_activity'])
        self.assertTrue(st.get('show_row_activity'))

    def test_agents_only_defaults_off_and_is_patchable(self):
        # Toolbar "AI sessions only" toggle — off by default (every
        # session is listed), a normal PATCH-able bool pref; junk values
        # are rejected rather than stored.
        st = self.store()
        self.assertFalse(st.get('agents_only'))
        clean, rejected = st.update_prefs({'agents_only': True}, now=NOW)
        self.assertEqual(rejected, [])
        self.assertTrue(clean['agents_only'])
        self.assertTrue(st.get('agents_only'))
        _, rejected = st.update_prefs({'agents_only': 'yes'}, now=NOW)
        self.assertEqual(rejected, ['agents_only'])
        self.assertTrue(st.get('agents_only'))

    def test_defaults_are_not_shared_between_stores(self):  # parity: P-70
        a = self.store()
        a.state['compact']['agents_only'] = False
        self.assertTrue(persist.DEFAULTS['compact']['agents_only'])

    def test_v1_bell_on_never_becomes_sound_on(self):  # parity: P-66, P-70
        self.write({'version': 1, 'bell': True, 'view': 'grid',
                    'labels': {'U': {'label': 'x', 'last_seen': NOW}}})
        st = self.store()
        self.assertFalse(st.get('sound_on_attention'))
        self.assertNotIn('bell', st.state)
        self.assertEqual(st.get('version'), 2)
        self.assertEqual(st.get('view'), 'grid')
        self.assertEqual(st.label('U'), 'x')

    def test_unknown_keys_survive_a_round_trip(self):  # parity: P-70
        self.write({'version': 2, 'future_key': {'a': 1}})
        st = self.store()
        st.set('theme', 'dark', now=NOW)
        st.save()
        with open(self.path) as f:
            data = json.load(f)
        self.assertEqual(data['future_key'], {'a': 1})
        self.assertEqual(data['theme'], 'dark')
        self.assertEqual(data['version'], 2)

    def test_invalid_values_normalized_on_load(self):  # parity: P-70
        self.write({'view': 'carousel', 'sort': 3, 'theme': 'neon',
                    'split_ratio': 9, 'sound_on_attention': 'yes',
                    'compact': 'no', 'hotkey_show': 'x' * 99,
                    'imported_from_ultrawatch': 'yesterday',
                    'labels': {'A': {'label': 'ok', 'last_seen': 'soon'}}})
        st = self.store()
        self.assertEqual(st.get('view'), 'split')
        self.assertEqual(st.get('sort'), 'natural')
        self.assertEqual(st.get('theme'), 'system')
        self.assertEqual(st.get('split_ratio'), 0.8)  # clamped, not reset
        self.assertFalse(st.get('sound_on_attention'))
        self.assertEqual(st.get('compact'), {'agents_only': True})
        self.assertEqual(st.get('hotkey_show'), 'opt+cmd+e')
        self.assertIsNone(st.get('imported_from_ultrawatch'))
        self.assertEqual(st.label('A'), '')

    def test_state_dir_comes_from_everwatch_home(self):  # parity: P-71
        # The Makefile points EVERWATCH_HOME at a fresh temp dir, so the
        # default state path is never the real user's.
        home = os.environ.get('EVERWATCH_HOME')
        if home:
            self.assertEqual(config.STATE_PATH,
                             os.path.join(home, 'state.json'))
        self.assertTrue(config.STATE_PATH.endswith('state.json'))


class TestPrefs(Base):
    def test_prefs_object_shape(self):  # parity: P-70
        prefs = self.store().prefs()
        self.assertEqual(set(prefs), set(persist.PREF_KEYS) -
                         {'projects_open'})
        self.assertFalse(prefs['sound_on_attention'])

    def test_patch_validation(self):  # parity: P-70
        clean, rejected = persist.normalize_prefs_patch({
            'split_ratio': 0.05, 'view': 'grid', 'theme': 'dark',
            'sound_on_attention': 1, 'nope': True, 'sort': 'random',
            'compact': {'agents_only': False}, 'hotkey_next': ''})
        self.assertEqual(clean, {'split_ratio': 0.2, 'view': 'grid',
                                 'theme': 'dark',
                                 'compact': {'agents_only': False},
                                 'hotkey_next': ''})
        self.assertEqual(rejected, ['nope', 'sort', 'sound_on_attention'])

    def test_session_appearance_and_attention_prefs_validate_independently(self):
        clean, rejected = persist.normalize_prefs_patch({
            'session_font': 'mono', 'session_font_size': 16,
            'show_dock_badge': True, 'notify_on_waiting': False,
        })
        self.assertEqual(rejected, [])
        self.assertEqual(clean, {
            'session_font': 'mono', 'session_font_size': 16,
            'show_dock_badge': True, 'notify_on_waiting': False,
        })
        _, rejected = persist.normalize_prefs_patch({
            'session_font': 'unknown', 'session_font_size': 100,
            'show_dock_badge': 'yes', 'notify_on_waiting': 1,
        })
        self.assertEqual(rejected, [
            'notify_on_waiting', 'session_font', 'session_font_size', 'show_dock_badge',
        ])

    def test_patch_rejects_odd_numbers_and_bodies(self):  # parity: P-70
        for bad in (True, float('nan'), '0.5', None):
            with self.subTest(bad=bad):
                self.assertEqual(persist.normalize_prefs_patch(
                    {'split_ratio': bad})[1], ['split_ratio'])
        self.assertEqual(persist.normalize_prefs_patch(
            {'compact': {'agents_only': 'x'}})[1], ['compact'])
        self.assertEqual(persist.normalize_prefs_patch([]), ({}, ['<body>']))

    def test_update_prefs_marks_dirty_and_saves(self):  # parity: P-70
        st = self.store()
        prefs, rejected = st.update_prefs({'theme': 'light', 'x': 1},
                                          now=NOW)
        self.assertEqual(prefs['theme'], 'light')
        self.assertEqual(rejected, ['x'])
        self.assertTrue(st.dirty)
        st.maybe_save(now=NOW + persist.SAVE_DEBOUNCE)
        self.assertFalse(st.dirty)
        self.assertEqual(self.store().get('theme'), 'light')

    def test_labels_touch_and_gc(self):  # parity: P-48
        st = self.store()
        st.set_label('A', 'api', now=NOW)
        st.touch_labels(['A'], now=NOW + 13 * 86400)
        st.save()
        later = persist.StateStore(path=self.path, now=NOW + 20 * 86400)
        self.assertEqual(later.label('A'), 'api')
        gone = persist.StateStore(path=self.path, now=NOW + 28 * 86400)
        self.assertEqual(gone.label('A'), '')


class TestUltrawatchImport(Base):
    def uw(self, **data):
        path = os.path.join(self.dir, 'uw', 'ultrawatch', 'state.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.write(data, path)
        return path

    def test_candidates_and_find(self):  # parity: P-71
        env = {'XDG_CONFIG_HOME': os.path.join(self.dir, 'uw')}
        self.assertEqual(persist.ultrawatch_state_candidates(env, '/h'), [
            os.path.join(self.dir, 'uw', 'ultrawatch', 'state.json'),
            '/h/.config/ultrawatch/state.json'])
        self.assertEqual(persist.ultrawatch_state_candidates({}, '/h'),
                         ['/h/.config/ultrawatch/state.json'])
        self.assertIsNone(persist.find_ultrawatch_state(env, self.dir))
        path = self.uw()
        self.assertEqual(persist.find_ultrawatch_state(env, self.dir), path)

    def test_import_labels_projects_prefs_never_sound(
            self):  # parity: P-71, P-66, P-48
        path = self.uw(
            version=1, bell=True, view='grid', sort='attention',
            split_ratio=0.6, show_dollars=True, projects_open=True,
            projects=['API', '', 'Billing', 7, 'Extra', 'Sixth'],
            labels={'U1': {'label': 'deploy', 'last_seen': NOW - 100},
                    'U2': {'label': 'old', 'last_seen': NOW - 30 * 86400},
                    'U3': {'label': '', 'last_seen': NOW},
                    'U4': 'garbage',
                    'KEEP': {'label': 'theirs', 'last_seen': NOW}})
        with open(path, 'rb') as f:
            before = f.read()
        st = self.store()
        st.set_label('KEEP', 'mine', now=NOW)
        st.set_project(5, 'Mine', now=NOW)
        result = st.import_ultrawatch(path=path, now=NOW)
        self.assertEqual(result['imported'],
                         {'labels': 1, 'projects': 2,
                          'prefs': ['view', 'sort', 'split_ratio',
                                    'show_dollars', 'projects_open']})
        self.assertTrue(result['bell_was_on'])
        self.assertFalse(st.get('sound_on_attention'))
        self.assertNotIn('bell', st.state)
        self.assertEqual(st.label('U1'), 'deploy')
        self.assertEqual(st.label('KEEP'), 'mine')
        self.assertEqual(st.state['projects'],
                         ['API', '', 'Billing', '', 'Mine'])
        self.assertEqual((st.get('view'), st.get('sort')),
                         ('grid', 'attention'))
        self.assertEqual(st.get('imported_from_ultrawatch'),
                         {'at': int(NOW), 'path': path, 'bell_was_on': True})
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), before)  # ultrawatch file untouched

    def test_import_skips_invalid_prefs(self):  # parity: P-71
        path = self.uw(view='carousel', labels='nope', projects='nope')
        result = self.store().import_ultrawatch(path=path, now=NOW)
        self.assertEqual(result['imported'],
                         {'labels': 0, 'projects': 0, 'prefs': []})
        self.assertFalse(result['bell_was_on'])

    def test_import_missing_or_corrupt(self):  # parity: P-71
        st = self.store()
        self.assertEqual(st.import_ultrawatch(
            path=os.path.join(self.dir, 'none.json'), now=NOW)['imported'],
            {'labels': 0, 'projects': 0, 'prefs': []})
        bad = os.path.join(self.dir, 'bad.json')
        with open(bad, 'w') as f:
            f.write('[1, 2]')
        self.assertIsNone(st.get('imported_from_ultrawatch'))
        st.import_ultrawatch(path=bad, now=NOW)
        self.assertIsNone(st.get('imported_from_ultrawatch'))

    def test_import_without_a_file_found(self):  # parity: P-71
        from unittest import mock
        with mock.patch.object(persist, 'find_ultrawatch_state',
                               return_value=None):
            result = self.store().import_ultrawatch(now=NOW)
        self.assertIsNone(result['path'])


if __name__ == '__main__':
    unittest.main()
