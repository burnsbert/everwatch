"""Ported from ultrawatch tests/test_persist.py. Schema v1 only (WP2
upgrades this to schema v2 — see persist.py's module docstring), so
these aren't tagged with a WP1 parity id."""
import json
import os
import tempfile
import unittest
from unittest import mock

from everwatch.engine import persist


class TestStateStore(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, 'state.json')

    def store(self, now=1000.0):
        return persist.StateStore(path=self.path, now=now)

    def test_defaults_when_no_file(self):
        st = self.store()
        self.assertEqual(st.get('view'), 'split')
        self.assertEqual(st.get('sort'), 'natural')
        self.assertFalse(st.get('show_dollars'))
        self.assertEqual(st.label('X'), '')

    def test_round_trip(self):
        st = self.store(now=1000.0)
        st.set_label('UID-1', 'api server', now=1000.0)
        st.set('view', 'grid', now=1000.0)
        st.set('show_dollars', True, now=1000.0)
        st.save()
        st2 = self.store(now=1001.0)
        self.assertEqual(st2.label('UID-1'), 'api server')
        self.assertEqual(st2.get('view'), 'grid')
        self.assertTrue(st2.get('show_dollars'))

    def test_empty_label_removes(self):
        st = self.store()
        st.set_label('UID-1', 'x', now=1000.0)
        st.set_label('UID-1', '', now=1001.0)
        self.assertEqual(st.label('UID-1'), '')
        self.assertNotIn('UID-1', st.state['labels'])

    def test_debounce(self):
        st = self.store()
        st.set('view', 'list', now=1000.0)
        st.maybe_save(now=1001.0)
        self.assertFalse(os.path.exists(self.path))  # within debounce
        st.maybe_save(now=1002.5)
        self.assertTrue(os.path.exists(self.path))
        st.maybe_save(now=1010.0)  # not dirty anymore — no rewrite needed
        with open(self.path) as f:
            self.assertEqual(json.load(f)['view'], 'list')

    def test_label_gc(self):
        old = 1000.0
        st = self.store(now=old)
        st.set_label('UID-OLD', 'stale', now=old)
        st.set_label('UID-NEW', 'fresh', now=old)
        st.save()
        # 20 days later, only the touched label survives
        later = old + 20 * 86400
        raw = json.load(open(self.path))
        raw['labels']['UID-NEW']['last_seen'] = int(later - 100)
        json.dump(raw, open(self.path, 'w'))
        st2 = self.store(now=later)
        self.assertEqual(st2.label('UID-OLD'), '')
        self.assertEqual(st2.label('UID-NEW'), 'fresh')

    def test_corrupt_file_falls_back_to_defaults(self):
        with open(self.path, 'w') as f:
            f.write('{not json')
        st = self.store()
        self.assertEqual(st.get('view'), 'split')

    def test_touch_labels_refreshes_last_seen(self):
        st = self.store()
        st.set_label('UID-1', 'x', now=1000.0)
        st.touch_labels(['UID-1', 'UID-MISSING'], now=5000.0)
        self.assertEqual(st.state['labels']['UID-1']['last_seen'], 5000)

    def test_projects_default_five_empty_slots(self):
        st = self.store()
        for i in range(1, 6):
            self.assertEqual(st.project(i), '')
        self.assertFalse(st.get('projects_open'))

    def test_set_project_round_trips_and_persists(self):
        st = self.store(now=1000.0)
        st.set_project(1, 'api-gateway', now=1000.0)
        st.set_project(5, 'billing', now=1000.0)
        st.set('projects_open', True, now=1000.0)
        st.save()
        st2 = self.store(now=1001.0)
        self.assertEqual(st2.project(1), 'api-gateway')
        self.assertEqual(st2.project(2), '')
        self.assertEqual(st2.project(5), 'billing')
        self.assertTrue(st2.get('projects_open'))

    def test_clear_projects_resets_all_five(self):
        st = self.store(now=1000.0)
        for i in range(1, 6):
            st.set_project(i, f'proj-{i}', now=1000.0)
        st.clear_projects(now=1001.0)
        for i in range(1, 6):
            self.assertEqual(st.project(i), '')

    def test_malformed_projects_on_load_defaults_safely(self):
        with open(self.path, 'w') as f:
            json.dump({'projects': 'not-a-list'}, f)
        st = self.store()
        for i in range(1, 6):
            self.assertEqual(st.project(i), '')

    def test_short_projects_list_on_load_padded(self):
        with open(self.path, 'w') as f:
            json.dump({'projects': ['only-one']}, f)
        st = self.store()
        self.assertEqual(st.project(1), 'only-one')
        self.assertEqual(st.project(5), '')

    def test_save_survives_unwritable_directory(self):
        # persistence is best-effort; save() must swallow errors, not
        # crash the engine. Point the state path *inside* a regular
        # file (not a directory) so os.makedirs is guaranteed to fail
        # regardless of the test runner's permissions.
        blocker = os.path.join(self.dir.name, 'not-a-dir')
        with open(blocker, 'w') as f:
            f.write('x')
        st = self.store()
        st.path = os.path.join(blocker, 'state.json')
        st.set('view', 'grid', now=1000.0)
        st.save()  # must not raise

    def test_save_cleans_up_temp_file_on_write_failure(self):
        # A failure *after* mkstemp (e.g. os.replace) must still unlink
        # the temp file and must not raise (best-effort persistence).
        st = self.store()
        st.set('view', 'grid', now=1000.0)
        with mock.patch('everwatch.engine.persist.os.replace',
                        side_effect=OSError('boom')):
            st.save()  # must not raise
        leftovers = [f for f in os.listdir(self.dir.name)
                    if f.startswith('.state-')]
        self.assertEqual(leftovers, [])

    def test_gc_labels_non_dict_resets_to_empty(self):
        with open(self.path, 'w') as f:
            json.dump({'labels': 'not-a-dict'}, f)
        st = self.store()
        self.assertEqual(st.state['labels'], {})

    def test_set_is_a_noop_when_value_unchanged(self):
        st = self.store(now=1000.0)
        st.set('view', 'split', now=1000.0)  # already the default
        self.assertIsNone(st._dirty_at)

    def test_set_project_out_of_range_is_a_noop(self):
        st = self.store(now=1000.0)
        st.set_project(0, 'x', now=1000.0)
        st.set_project(6, 'x', now=1000.0)
        self.assertIsNone(st._dirty_at)
        for i in range(1, 6):
            self.assertEqual(st.project(i), '')

    def test_set_project_same_value_is_a_noop(self):
        st = self.store(now=1000.0)
        st.set_project(1, 'api', now=1000.0)
        st.save()
        st._dirty_at = None
        st.set_project(1, 'api', now=2000.0)  # unchanged value
        self.assertIsNone(st._dirty_at)


if __name__ == '__main__':
    unittest.main()
