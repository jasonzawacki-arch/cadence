#!/usr/bin/env python3
"""Collect delivery data from a local git repository for Cadence.

Reads the repository's history and writes a JSON file that the Cadence dashboard opens. Nothing is sent anywhere,
and it works with any git host (GitHub, GitLab, Bitbucket, a company server), because it reads the clone on disk.

    python3 cadence_collect.py PATH/TO/REPO --since 2025-10-01 -o cadence-data.json

What it reads:
  - deploys: release tags matching --deploy-tags (default: version tags such as 1.4.2 or v1.4.2), timed when the
    tag was created
  - changes: commits on the branch's first-parent line (merges and squash-merges to the main branch), with when
    they landed, their size (lines added and removed) and the pull request number when the subject ends in (#123)
  - which deploy shipped each change, exactly, by walking the history between consecutive release tags
  - reverts: a change whose subject is Revert "..." or whose message says "This reverts commit <sha>"

Commit authors and file contents are not collected. Standard library only; needs git on the PATH."""
import argparse, datetime as dt, json, re, subprocess, sys
from pathlib import Path

FMT, VERSION = 'cadence-data', 1
SEP, END = '\x1f', '\x1e'


def git(repo, *args):
    r = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, errors='replace')
    if r.returncode:
        sys.exit(f'git {" ".join(args[:2])} failed: {r.stderr.strip()}')
    return r.stdout


def iso(s):
    """Any git ISO date to UTC, 'YYYY-MM-DDTHH:MM:SSZ'."""
    return dt.datetime.fromisoformat(s.strip().replace('Z', '+00:00')).astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def subject_key(s):
    """Subject without a trailing pull request number, for matching a revert to what it reverts."""
    return re.sub(r'\s*\(#\d+\)\s*$', '', s.strip()).lower()


def collect(repo, since, until, branch, tag_re, name):
    branch = branch or git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip()
    head = git(repo, 'rev-parse', branch).strip()
    # release tags reachable from the branch, oldest first
    tags = []
    for line in git(repo, 'for-each-ref', 'refs/tags', f'--format=%(refname:short){SEP}%(objectname){SEP}%(*objectname){SEP}%(creatordate:iso-strict)').splitlines():
        tname, obj, peeled, created = line.split(SEP)
        if not re.search(tag_re, tname):
            continue
        sha = peeled or obj
        if subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', sha, head], capture_output=True).returncode:
            continue
        tags.append({'name': tname, 'at': iso(created), 'sha': sha})
    tags.sort(key=lambda t: t['at'])

    # changes on the first-parent line, with size
    log = git(repo, 'log', '--first-parent', branch, f'--since={since}', *([f'--until={until}'] if until else []),
              f'--format={END}%H{SEP}%aI{SEP}%cI{SEP}%s{SEP}%b{SEP}', '--shortstat')
    changes, by_sha = [], {}
    for rec in log.split(END)[1:]:
        parts = rec.split(SEP)
        sha, authored, committed, subject, body, stat = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5] if len(parts) > 5 else ''
        adds = int((re.search(r'(\d+) insertion', stat) or [0, 0])[1])
        dels = int((re.search(r'(\d+) deletion', stat) or [0, 0])[1])
        pr = re.search(r'\(#(\d+)\)\s*$', subject)
        c = {'sha': sha[:12], 'at': iso(committed), 'authored': iso(authored), 'subject': subject.strip()[:200], 'adds': adds, 'dels': dels}
        if pr:
            c['pr'] = int(pr[1])
        m = re.search(r'This reverts commit ([0-9a-f]{7,40})', body)
        if m:
            c['_reverts_sha'] = m[1]
        elif re.match(r'^revert\b', subject, re.I):
            q = re.match(r'^revert\s+"(.+)"', subject.strip(), re.I)
            c['_reverts_subject'] = subject_key(q[1] if q else re.sub(r'^revert\s*:?\s*', '', subject, flags=re.I))
        changes.append(c)
        by_sha[sha] = c
    changes.sort(key=lambda c: c['at'])

    # which deploy shipped each change: the commits between consecutive release tags
    window_start = iso(dt.datetime.fromisoformat(since).replace(tzinfo=dt.timezone.utc).isoformat())
    prev = None
    for t in tags:
        rng = f'{prev}..{t["sha"]}' if prev else t['sha']
        for sha in git(repo, 'rev-list', '--first-parent', rng).split():
            if sha in by_sha and 'deploy' not in by_sha[sha]:
                by_sha[sha]['deploy'] = t['name']
        prev = t['sha']

    # reverts: point each one at the change it undoes
    key_index = {}
    for c in changes:
        key_index.setdefault(subject_key(c['subject']), []).append(c)
    for c in changes:
        target = None
        if '_reverts_sha' in c:
            full = next((s for s in by_sha if s.startswith(c['_reverts_sha'])), None)
            target = by_sha.get(full)
        elif '_reverts_subject' in c:
            target = next((o for o in reversed(key_index.get(c['_reverts_subject'], [])) if o['at'] < c['at']), None)
        if target:
            c['revertOf'] = target['sha']
        c.pop('_reverts_sha', None)
        c.pop('_reverts_subject', None)

    deploys = [{'name': t['name'], 'at': t['at'], 'sha': t['sha'][:12]} for t in tags if t['at'] >= window_start and (not until or t['at'] <= iso(until + 'T23:59:59+00:00'))]
    return {
        'format': FMT, 'version': VERSION,
        'source': {'kind': 'git', 'name': name or Path(repo).resolve().name, 'branch': branch, 'collected': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                   'deploys': f'tags matching {tag_re}'},
        'since': since, 'until': until or dt.date.today().isoformat(),
        'deploys': deploys, 'changes': changes,
    }


def main(argv=None):
    p = argparse.ArgumentParser(description='Collect delivery data from a local git repository for Cadence.')
    p.add_argument('repo', help='path to the repository')
    p.add_argument('--since', default=(dt.date.today() - dt.timedelta(days=365)).isoformat(), help='first day, YYYY-MM-DD (default: a year ago)')
    p.add_argument('--until', help='last day, YYYY-MM-DD (default: today)')
    p.add_argument('--branch', help='main branch (default: the checked-out branch)')
    p.add_argument('--deploy-tags', default=r'^v?\d+\.\d+\.\d+$', help='regular expression for release tags that count as deploys')
    p.add_argument('--name', help='name shown in the dashboard (default: the folder name)')
    p.add_argument('-o', '--out', default='cadence-data.json')
    a = p.parse_args(argv)
    data = collect(a.repo, a.since, a.until, a.branch, a.deploy_tags, a.name)
    Path(a.out).write_text(json.dumps(data, separators=(',', ':')))
    shipped = sum(1 for c in data['changes'] if c.get('deploy'))
    print(f"{a.out}: {len(data['changes'])} changes ({shipped} shipped), {len(data['deploys'])} deploys, "
          f"{sum(1 for c in data['changes'] if 'revertOf' in c)} reverts")


if __name__ == '__main__':
    main()
