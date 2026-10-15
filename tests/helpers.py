"""Shared test setup: serve dist/site on a local port and open pages with error capture."""
import functools, http.server, threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'dist' / 'site'
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SITE))
    s = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, f'http://127.0.0.1:{s.server_address[1]}/'


class Checks:
    def __init__(self):
        self.fails = []

    def __call__(self, name, ok, detail=''):
        print(('OK  ' if ok else 'FAIL'), name, '' if ok else str(detail)[:400], flush=True)
        if not ok:
            self.fails.append(name)



def page(browser, base, errs, **ctx):
    c = browser.new_context(accept_downloads=True, **ctx)
    # the web font is the only outside request; keep tests offline and quiet
    c.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
    c.route('https://fonts.gstatic.com/**', lambda r: r.abort())
    p = c.new_page()
    p.on('pageerror', lambda e: errs.append(str(e)[:300]))
    p.goto(base)
    p.wait_for_selector('h1')
    return c, p


def download(p, selector):
    with p.expect_download() as d:
        p.click(selector)
    dl = d.value
    return dl.suggested_filename, Path(dl.path()).read_bytes()
