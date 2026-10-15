"""The collector, on a scratch repository built for the edge cases: annotated and lightweight release tags, a tag
that is not a release, a change shipped and reverted in a later release (a failure), a change reverted before it was
released (not one), squash-style subjects with pull request numbers, and sizes.
Run: python3 tests/test_collect.py"""
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'collect'))
import cadence_collect  # noqa: E402


def git(repo, *a, date=None):
    env = dict(os.environ, GIT_AUTHOR_NAME='T', GIT_AUTHOR_EMAIL='t@example.com', GIT_COMMITTER_NAME='T', GIT_COMMITTER_EMAIL='t@example.com')
    if date:
        env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    return subprocess.run(['git', '-C', str(repo), *a], check=True, capture_output=True, text=True, env=env).stdout


class Collector(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        r = cls.repo = cls.tmp / 'svc'
        r.mkdir()
        git(r, 'init', '-q', '-b', 'main')

        def commit(name, lines, subject, date):
            (r / name).write_text('\n'.join(f'line {i}' for i in range(lines)) + '\n')
            git(r, 'add', '-A')
            git(r, 'commit', '-q', '-m', subject, date=date)
            return git(r, 'rev-parse', 'HEAD').strip()

        commit('a.txt', 10, 'Start (#1)', '2026-03-01T10:00:00Z')
        git(r, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0', date='2026-03-02T12:00:00Z')  # annotated, dated by the tagger
        cls.risky = commit('b.txt', 30, 'Add risky cache (#2)', '2026-03-03T09:00:00Z')
        commit('c.txt', 5, 'Docs (#3)', '2026-03-03T15:00:00Z')
        git(r, 'tag', 'v1.1.0', date='2026-03-04T09:00:00Z')  # lightweight: dated by its commit
        git(r, 'tag', 'nightly-2026-03-04')  # not a release
        cls.early = commit('d.txt', 8, 'Try new parser (#4)', '2026-03-05T10:00:00Z')
        git(r, 'revert', '--no-edit', cls.early, date='2026-03-05T16:00:00Z')  # reverted before any release
        git(r, 'revert', '--no-edit', cls.risky, date='2026-03-06T08:00:00Z')  # reverts a released change
        git(r, 'tag', '-a', 'v1.1.1', '-m', 'fix', date='2026-03-06T10:00:00Z')
        commit('e.txt', 600, 'Big refactor (#5)', '2026-03-07T10:00:00Z')  # not released yet
        cls.out = cls.tmp / 'out.json'
        cadence_collect.main([str(r), '--since', '2026-02-01', '--until', '2026-03-31', '--name', 'acme/svc', '-o', str(cls.out)])
        cls.data = json.loads(cls.out.read_text())

    def by_subject(self, s):
        return next(c for c in self.data['changes'] if c['subject'] == s)

    def test_format(self):
        d = self.data
        self.assertEqual((d['format'], d['version'], d['source']['name'], d['source']['kind']), ('cadence-data', 1, 'acme/svc', 'git'))

    def test_release_tags_only(self):
        self.assertEqual([x['name'] for x in self.data['deploys']], ['v1.0.0', 'v1.1.0', 'v1.1.1'])

    def test_tag_times(self):
        at = {x['name']: x['at'] for x in self.data['deploys']}
        self.assertEqual(at['v1.0.0'], '2026-03-02T12:00:00Z')  # tagger date
        self.assertEqual(at['v1.1.0'], '2026-03-03T15:00:00Z')  # lightweight tag: its commit's date

    def test_changes_mapped_to_their_release(self):
        self.assertEqual(self.by_subject('Start (#1)')['deploy'], 'v1.0.0')
        self.assertEqual(self.by_subject('Add risky cache (#2)')['deploy'], 'v1.1.0')
        self.assertEqual(self.by_subject('Try new parser (#4)')['deploy'], 'v1.1.1')
        self.assertNotIn('deploy', self.by_subject('Big refactor (#5)'))

    def test_pull_requests_and_sizes(self):
        c = self.by_subject('Add risky cache (#2)')
        self.assertEqual((c['pr'], c['adds'], c['dels']), (2, 30, 0))

    def test_reverts_point_at_what_they_undo(self):
        rv = {c['subject']: c.get('revertOf') for c in self.data['changes'] if c['subject'].startswith('Revert')}
        self.assertEqual(rv['Revert "Add risky cache (#2)"'], self.risky[:12])
        self.assertEqual(rv['Revert "Try new parser (#4)"'], self.early[:12])

    def test_no_authors_collected(self):
        self.assertNotIn('"T"', self.out.read_text())
        self.assertNotIn('t@example.com', self.out.read_text())


if __name__ == '__main__':
    unittest.main()
