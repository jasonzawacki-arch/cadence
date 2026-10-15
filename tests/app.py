"""End to end in a real browser: the demo dashboard against an independent Python reading of the same numbers,
switching periods, tooltips, table views, opening a collector file, refusing bad files, live GitHub mode against a
mocked API (success, unknown repository, rate limit, no releases, the token kept out of storage), and the phone layout.
Run: node build.mjs && python3 tests/app.py"""
import json, re, sys, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(Path(__file__).parent))
from helpers import ROOT, Checks, serve
import reference as ref
from test_collect import Collector

check, errs = Checks(), []
srv, BASE = serve()
demo = json.loads((ROOT / 'src' / 'data' / 'demo.json').read_text())
tmp = Path(tempfile.mkdtemp())
NOW = datetime(2026, 10, 14, 18, 0, tzinfo=timezone.utc)  # the page's clock is fixed here, so results do not drift


def open_page(b, **ctx):
    c = b.new_context(accept_downloads=True, **ctx)
    c.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
    c.route('https://fonts.gstatic.com/**', lambda r: r.abort())
    p = c.new_page()
    p.clock.set_fixed_time(NOW)
    p.on('pageerror', lambda e: errs.append(str(e)[:300]))
    p.goto(BASE)
    p.wait_for_selector('h1')
    return c, p


def tile(p, key):
    return p.inner_text(f'.tile[data-metric={key}] .val').replace('\n', '').strip()


def period(p, days):
    p.locator(f'.seg input[value="{days}"] + span').click()
    p.wait_for_timeout(150)


def expected(d, days):
    end = min(ref.t(d['until'] + 'T23:59:59Z'), NOW.timestamp())
    return ref.summary(d, end - days * ref.DAY, end)


def compare(p, d, days, label):
    e = expected(d, days)
    want = {
        'freq': ref.num(e['perWeek']) + ' a week',
        'lead': ref.dur(e['leadMedian']),
        'recovery': ref.dur(e['recoveryMedian']),
        'cfr': ref.pct(e['failRate']),
        'rework': ref.pct(e['reworkRate']),
    }
    got = {k: tile(p, k) for k in want}
    check(f'{label}: all five metrics match the Python reading', got == want, (got, want))
    return e


iso = lambda dt: dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def mock_github(ctx, mode, seen):
    """A tiny GitHub: acme/shop with three releases over the last month, one shipped change reverted a day later."""
    r1, r2, r3 = NOW - timedelta(days=20), NOW - timedelta(days=10), NOW - timedelta(days=8)
    commits = [
        ('a1' * 20, NOW - timedelta(days=22), 'Add search (#11)'),
        ('b2' * 20, NOW - timedelta(days=12), 'Cache prices (#12)'),
        ('c3' * 20, NOW - timedelta(days=11), 'Fix footer (#13)'),
        ('d4' * 20, NOW - timedelta(days=9), 'Revert "Cache prices (#12)"\n\nThis reverts commit ' + 'b2' * 20 + '.'),
        ('e5' * 20, NOW - timedelta(days=2), 'Tidy logs (#15)'),
    ]
    pulls = [{'number': 11 + i, 'created_at': iso(at - timedelta(hours=5)), 'merged_at': iso(at), 'updated_at': iso(at)} for i, (_, at, _) in enumerate(commits)]

    def handle(route):
        req = route.request
        seen.append((req.url, req.headers.get('authorization')))
        path = req.url.split('api.github.com', 1)[1]
        hdr = {'x-ratelimit-remaining': '0' if mode == 'ratelimit' else '55', 'access-control-expose-headers': 'x-ratelimit-remaining'}
        js = lambda body, status=200: route.fulfill(status=status, content_type='application/json', headers=hdr, body=json.dumps(body))
        if mode == 'missing':
            return js({'message': 'Not Found'}, 404)
        if mode == 'ratelimit':
            return js({'message': 'API rate limit exceeded'}, 403)
        if re.match(r'^/repos/acme/shop$', path):
            return js({'default_branch': 'main'})
        if path.startswith('/repos/acme/shop/deployments'):
            if mode != 'deploys' or 'page=1' not in path:
                return js([])
            deps = [{'sha': c[0], 'environment': 'github-pages', 'created_at': iso(at + timedelta(minutes=3))} for c, at in ((commits[1], commits[1][1]), (commits[3], commits[3][1]), (commits[4], commits[4][1]))]
            deps.append({'sha': commits[3][0], 'environment': 'github-pages', 'created_at': iso(commits[3][1] + timedelta(hours=2))})  # a rerun of the same commit
            deps.append({'sha': commits[2][0], 'environment': 'preview', 'created_at': iso(commits[2][1])})  # not production
            return js(deps)
        if path.startswith('/repos/acme/shop/releases'):
            if mode in ('norelease', 'deploys') or 'page=1' not in path:
                return js([])
            rel = [{'tag_name': n, 'published_at': iso(at), 'draft': False, 'prerelease': False} for n, at in [('v3', r3), ('v2', r2), ('v1', r1)]]
            rel.append({'tag_name': 'v4-rc1', 'published_at': iso(NOW - timedelta(days=1)), 'draft': False, 'prerelease': True})
            return js(rel)
        if path.startswith('/repos/acme/shop/commits'):
            if 'page=1' not in path:
                return js([])
            return js([{'sha': s, 'commit': {'message': m, 'committer': {'date': iso(at)}}} for s, at, m in reversed(commits)])
        if path.startswith('/repos/acme/shop/pulls'):
            return js(pulls if 'page=1' in path else [])
        return js({'message': 'unexpected ' + path}, 500)

    ctx.route('https://api.github.com/**', handle)


def read_live(p, repo, token=''):
    p.evaluate("location.hash = '#/data'")
    p.wait_for_selector('form[data-form=github]')
    p.fill('input[name=repo]', repo)
    p.fill('input[name=token]', token)
    p.select_option('select[name=days]', '30')
    p.click('form[data-form=github] button')
    p.wait_for_function("location.hash === '#/' || document.querySelector('#gh-status')?.textContent", timeout=10000)
    p.wait_for_timeout(200)


with sync_playwright() as pw:
    b = pw.chromium.launch()

    # ---- the demo: real history, checked against an independent reading ----
    ctx, p = open_page(b, viewport={'width': 1360, 'height': 900})
    check('opens on the demo with the repository name and a demo chip', demo['source']['name'] in p.inner_text('h1') and 'demo' in p.inner_text('.kicker').lower())
    check('no outside requests needed to open (works without login)', not errs, errs)
    e90 = compare(p, demo, 90, '90 days')
    lede = p.inner_text('.lede')
    check('the opening sentence states the release count', f"{e90['deploys']} release" in lede, lede)
    period(p, 365)
    e365 = compare(p, demo, 365, '12 months')
    check('12 months has more releases than 90 days', e365['deploys'] > e90['deploys'], (e365['deploys'], e90['deploys']))
    check('the period control keeps focus for keyboard users', p.evaluate("document.activeElement?.value") == '365')
    period(p, 30)
    compare(p, demo, 30, '30 days')
    period(p, 180)
    compare(p, demo, 180, '180 days')
    check('deltas compare with the previous period', p.locator('.tile .delta.up, .tile .delta.down, .tile .delta.same').count() >= 3)

    # failures table agrees with the reference list
    period(p, 365)
    fails_ref = sorted({f[0] for f in ref.failures(demo) if (ref.t(demo['until'] + 'T23:59:59Z') - 365 * ref.DAY) < ref.t(next(x['at'] for x in demo['deploys'] if x['name'] == f[0]))})
    panel = p.locator('section.panel').first
    shown = sorted(set(re.findall(r'\b\d+\.\d+\.\d+\b', panel.inner_text())) & set(x['name'] for x in demo['deploys']))
    check('the reverted-releases table lists the failed releases', set(fails_ref) <= set(shown), (fails_ref, shown))
    flagged = p.locator('.chart .hit.flag').count()
    check('failed releases are flagged on the lead-time chart, with a legend', flagged == len(fails_ref) and (flagged == 0 or p.locator('.key .k.dot.flag').count() == 1), (flagged, len(fails_ref)))

    # charts: tooltips on hover and on keyboard focus; a table under each
    bars = p.locator('.chart .hit')
    check('every chart mark is focusable', bars.count() > 50 and bars.first.get_attribute('tabindex') == '0')
    bars.nth(5).hover()
    p.wait_for_timeout(100)
    check('hovering a mark shows its tooltip', p.is_visible('#tip') and 'Week of' in p.inner_text('#tip'), p.inner_text('#tip'))
    p.mouse.move(5, 5)
    p.locator('.chart .hit.flag, .chart .hit').nth(0).focus()
    check('focusing a mark shows its tooltip', p.is_visible('#tip'))
    p.keyboard.press('Shift+Tab')
    cards = p.locator('figure.card')
    first = cards.first.locator('details.tbl')
    first.locator('summary').click()
    rows = first.locator('tbody tr').count()
    check('each chart has its numbers as a table', cards.count() >= 3 and rows >= 50 and cards.count() == p.locator('figure.card details.tbl').count(), (cards.count(), rows))
    check('charts carry an accessible name', all(x for x in p.locator('svg.chart').evaluate_all("s => s.map(e => e.getAttribute('aria-label'))")))
    p.click('details.how summary')
    check('the method notes name the 14-day failure window', '14 days' in p.inner_text('details.how'))

    # ---- download the data, then open a collector file ----
    p.evaluate("location.hash = '#/data'")
    p.wait_for_selector('[data-act=save]')
    with p.expect_download() as dl:
        p.click('[data-act=save]')
    saved = json.loads(Path(dl.value.path()).read_text())
    check('Download this data gives a Cadence data file', saved['format'] == 'cadence-data' and len(saved['changes']) == len(demo['changes']))
    check('the collector script is published beside the page', p.request.get(BASE + 'cadence_collect.py').text().startswith('#!/usr/bin/env python3'))

    Collector.setUpClass()
    coll = json.loads(Collector.out.read_text())
    p.set_input_files('input[data-act=open]', str(Collector.out))
    p.wait_for_function("location.hash === '#/'")
    p.wait_for_timeout(150)
    check('opening a collector file shows that repository', 'acme/svc' in p.inner_text('h1') and 'read from git' in p.inner_text('.kicker').lower())
    check('a short history picks the longest period that fits', p.evaluate("document.querySelector('.seg input:checked').value") == '30')
    ec = compare(p, coll, 30, 'collector file')
    check('collector file: one failed release out of three, recovered by the next', (ec['deploys'], ec['failed']) == (3, 1) and tile(p, 'cfr') == '33%', (ec, tile(p, 'cfr')))

    bad = tmp / 'bad.json'
    for body, msg in [('not json', 'not JSON'), (json.dumps({'format': 'other'}), 'not a Cadence data file'), (json.dumps({**coll, 'deploys': [{'name': 'v1', 'at': 'yesterday'}]}), 'Deploy 1 needs')]:
        bad.write_text(body)
        p.evaluate("location.hash = '#/data'")
        p.wait_for_selector('input[data-act=open]')
        p.set_input_files('input[data-act=open]', str(bad))
        p.wait_for_function("document.querySelector('#file-status')?.textContent")
        check(f'refuses a bad file ({msg})', msg in p.inner_text('#file-status'), p.inner_text('#file-status'))
    p.evaluate("location.hash = '#/'")
    p.wait_for_timeout(150)
    check('after refusals the last good data is still loaded', 'acme/svc' in p.inner_text('h1'))
    p.evaluate("location.hash = '#/data'")
    p.click('[data-act=demo]')
    p.evaluate("location.hash = '#/'")
    p.wait_for_timeout(150)
    check('Back to the demo restores it', demo['source']['name'] in p.inner_text('h1'))
    ctx.close()

    # ---- live mode, against a mocked GitHub ----
    for mode, repo, want in [
        ('missing', 'acme/nope', 'no repository by that name'),
        ('ratelimit', 'acme/shop', 'hourly limit'),
        ('norelease', 'acme/shop', 'has no published releases or deployments'),
        ('', 'not a repo', 'owner/name'),
    ]:
        ctx, p = open_page(b, viewport={'width': 1200, 'height': 900})
        seen = []
        mock_github(ctx, mode or 'ok', seen)
        read_live(p, repo)
        st = p.inner_text('#gh-status')
        check(f'live mode explains: {want}', want in st, st)
        check(f'live mode ({want}): the button is usable again', p.is_enabled('form[data-form=github] button'))
        ctx.close()

    ctx, p = open_page(b, viewport={'width': 1200, 'height': 900})
    seen = []
    mock_github(ctx, 'ok', seen)
    TOKEN = 'ghp_TESTTOKEN0000000000000000000000000000'
    read_live(p, 'https://github.com/acme/shop', TOKEN)
    check('live mode reads a repository and opens its dashboard', 'acme/shop' in p.inner_text('h1') and 'read live from github' in p.inner_text('.kicker').lower(), p.inner_text('h1'))
    check('live mode: pre-releases are not counted as deploys', '3 releases' in p.inner_text('.lede'), p.inner_text('.lede'))
    check('live mode: the reverted release counts as a failure', tile(p, 'cfr') == '33%' and tile(p, 'rework') == '33%' and tile(p, 'recovery') == '2.0 days', (tile(p, 'cfr'), tile(p, 'rework'), tile(p, 'recovery')))
    check('live mode: pull request cycle time shown', p.locator('figure.card h2', has_text='Pull request cycle time').count() == 1)
    check('the token goes to api.github.com and nowhere else', seen and all(u.startswith('https://api.github.com/') and a == f'Bearer {TOKEN}' for u, a in seen), seen[:2])
    stored = p.evaluate("""async () => {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      return JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), dbs, document.cookie, document.documentElement.outerHTML.length])
    }""")
    check('the token is not stored anywhere in the browser', TOKEN not in stored and TOKEN not in p.content(), stored[:200])
    p.evaluate("location.hash = '#/data'")
    p.wait_for_selector('input[name=token]')
    with p.expect_download() as dl:
        p.click('[data-act=save]')
    check('the token is not in downloaded data', TOKEN not in Path(dl.value.path()).read_text())
    p.evaluate("location.hash = '#/'")
    p.reload()
    p.wait_for_selector('h1')
    check('a reload forgets the token and returns to the demo', demo['source']['name'] in p.inner_text('h1'))
    ctx.close()

    # ---- links people paste, and a repository that deploys without releases ----
    for pasted in ['https://github.com/acme/shop/', 'github.com/acme/shop', 'https://acme.github.io/shop/', 'https://github.com/acme/shop/tree/main']:
        ctx, p = open_page(b, viewport={'width': 1200, 'height': 900})
        mock_github(ctx, 'ok', [])
        read_live(p, pasted)
        check(f'accepts a pasted link: {pasted}', 'acme/shop' in p.inner_text('h1'), p.inner_text('#gh-status') if p.locator('#gh-status').count() else p.inner_text('h1'))
        ctx.close()
    ctx, p = open_page(b, viewport={'width': 1200, 'height': 900})
    mock_github(ctx, 'deploys', [])
    read_live(p, 'acme/shop')
    lede = p.inner_text('.lede')
    check('no releases: counts GitHub deployments instead, one per commit, production only', '3 deployments' in lede, lede)
    check('deployments: the words on screen say deployments', 'Deployments per week' in p.inner_text('.charts') and 'deployments to github-pages' in p.inner_text('.src'), p.inner_text('.src'))
    check('deployments: the reverted deployment counts as a failure', tile(p, 'cfr') == '33%', tile(p, 'cfr'))
    ctx.close()

    # ---- phone width ----
    for w in (390, 320):
        ctx, p = open_page(b, viewport={'width': w, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True)
        # CI runners have only wide fallback fonts; test with one so the layout holds there too
        p.add_style_tag(content="body,input,select,button{font-family:'DejaVu Sans',Verdana,sans-serif !important}")
        over = p.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        check(f'no sideways scroll at {w}px', over <= 0, over)
        p.evaluate("location.hash = '#/data'")
        p.wait_for_timeout(150)
        over = p.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        check(f'data page fits at {w}px', over <= 0, over)
        ctx.close()

    check('no script errors', not errs, errs)
    b.close()

print(f"\n{len(check.fails)} failed" if check.fails else '\nall app checks passed')
sys.exit(1 if check.fails else 0)
