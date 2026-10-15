"""Runs every test file; exits non-zero if any fails. Run after `npm run build`.
On GitHub Actions, failures are also reported as annotations so they show on the run page."""
import os, subprocess, sys
from pathlib import Path

here = Path(__file__).parent
failed = []


def annotate(title, text):
    esc = lambda x: x.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print(f"::error title={esc(title).replace(',', '%2C').replace(':', '%3A')}::{esc(text[-3000:])}", flush=True)


for t in ['test_collect.py', 'app.py']:
    print(f'\n== {t}', flush=True)
    r = subprocess.run([sys.executable, str(here / t)], capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    if r.returncode:
        failed.append(t)
        if os.environ.get('GITHUB_ACTIONS'):
            fails = [l for l in r.stdout.splitlines() if l.startswith('FAIL')]
            annotate(f'{t} failed', '\n'.join(fails + r.stderr.strip().splitlines()[-8:]))
print('\nAll tests passed.' if not failed else f"\nFailed: {', '.join(failed)}")
sys.exit(1 if failed else 0)
