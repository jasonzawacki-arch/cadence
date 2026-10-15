"""An independent Python reading of the same metrics, used to cross-check what the dashboard shows.
Written from the definitions in the README, not translated from src/metrics.ts."""
import math
from datetime import datetime, timezone

round = lambda x: int(math.floor(x + 0.5))  # JavaScript's Math.round, not banker's rounding

DAY = 86400.0
FAIL_WINDOW_DAYS = 14


def t(iso):
    return datetime.strptime(iso[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp()


def median(xs):
    return quantile(xs, 0.5)


def quantile(xs, q):
    if not xs:
        return None
    s = sorted(xs)
    i = (len(s) - 1) * q
    lo, hi = int(i), min(int(i) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


def failures(d):
    deps = {x['name']: t(x['at']) for x in d['deploys']}
    out = {}
    for r in d['changes']:
        target = r.get('revertOf')
        if not target:
            continue
        x = next((c for c in d['changes'] if c['sha'].startswith(target) or target.startswith(c['sha'])), None)
        if not x or x.get('deploy') not in deps:
            continue
        shipped = deps[x['deploy']]
        fix = deps.get(r.get('deploy'))
        if fix is not None and fix <= shipped:
            continue
        if t(r['at']) - shipped > FAIL_WINDOW_DAYS * DAY:
            continue
        out.setdefault((x['deploy'], r['sha']), (x['deploy'], r.get('deploy') if fix is not None else None, None if fix is None else (fix - shipped) / 3600))
    return list(out.values())


def summary(d, start, end):
    """Metrics for deploys and changes with start < time <= end (epoch seconds)."""
    inside = lambda iso: start < t(iso) <= end
    deps = [x for x in d['deploys'] if inside(x['at'])]
    names = {x['name'] for x in deps}
    at = {x['name']: t(x['at']) for x in d['deploys']}
    lead = [(at[c['deploy']] - t(c['at'])) / 3600 for c in d['changes'] if c.get('deploy') in names and at[c['deploy']] >= t(c['at'])]
    fs = failures(d)
    failed = {f[0] for f in fs if f[0] in names}
    first = {}
    for dep, _, h in fs:
        if dep in names and h is not None:
            first[dep] = min(first.get(dep, h), h)
    rework = {f[1] for f in fs if f[1] in names}
    n = len(deps)
    return {
        'deploys': n,
        'perWeek': n / ((end - start) / DAY / 7),
        'leadMedian': median(lead),
        'failed': len(failed),
        'failRate': len(failed) / n if n else None,
        'recoveryMedian': median(list(first.values())),
        'reworkRate': len(rework) / n if n else None,
    }


# the dashboard's display formats
def dur(h):
    if h is None:
        return 'none'
    if h < 1:
        return f'{max(1, round(h * 60))} min'
    if h < 48:
        return f'{h:.1f} hours' if h < 10 else f'{round(h)} hours'
    d = h / 24
    return f'{d:.1f} days' if d < 10 else f'{round(d)} days'


def pct(x):
    return 'none' if x is None else f'{round(x * 100)}%'


def num(x):
    return str(round(x)) if abs(x) >= 10 else f'{x:.1f}'.removesuffix('.0')
