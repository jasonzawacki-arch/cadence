// Screens: the dashboard (#/) and the Data page (#/data).
import type { Data } from './model.js';
import { LARGE } from './model.js';
import { DAY, FAIL_WINDOW_DAYS, index, leadByDeploy, ms, slowest, summarize, weekly } from './metrics.js';
import type { Index } from './metrics.js';
import { columns, dots, esc, line, longDate, shortDate, table, wide } from './charts.js';
import { readData } from './data.js';
import { fetchRepo, GitHubError } from './github.js';

let data: Data;
let ix: Index;
let demo: Data;
let days = 90;
let isDemo = true;
let busy = '';
// What a deploy is called on screen: releases (tags, GitHub releases) or deployments (GitHub deployments).
const unitWords = (u?: string) =>
  u === 'deployment' ? { one: 'deployment', many: 'deployments', One: 'Deployment', Many: 'Deployments' } : { one: 'release', many: 'releases', One: 'Release', Many: 'Releases' };
let U = unitWords();
const app = () => document.getElementById('app')!;

// ---------- formatting ----------
export function dur(h: number | null): string {
  if (h == null) return 'none';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} hours`;
  const d = h / 24;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} days`;
}
const points = (v: number) => { const n = Math.round(v * 100); return `${n} ${n === 1 ? 'point' : 'points'}`; };
const pct = (x: number | null) => (x == null ? 'none' : `${Math.round(x * 100)}%`);
const num = (x: number, digits = 1) => (Math.abs(x) >= 10 ? String(Math.round(x)) : x.toFixed(digits).replace(/\.0$/, ''));
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const spanDays = (d: Data) => Math.round((Date.parse(d.until + 'T23:59:59Z') - Date.parse(d.since + 'T00:00:00Z')) / DAY);
const endOf = (d: Data) => Math.min(Date.parse(d.until + 'T23:59:59Z'), Date.now());

/** "0.4 days shorter than the previous 90 days", coloured by whether that is better. */
function delta(cur: number | null, prev: number | null, lowerIsBetter: boolean, fmt: (v: number) => string, unit = ''): string {
  if (cur == null || prev == null) return '<span class="delta none">no earlier period to compare</span>';
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9 || (prev !== 0 && Math.abs(diff / prev) < 0.02)) return `<span class="delta same">about the same as the previous ${days} days</span>`;
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  const word = lowerIsBetter ? (diff < 0 ? 'lower' : 'higher') : diff > 0 ? 'higher' : 'lower';
  return `<span class="delta ${better ? 'up' : 'down'}"><i aria-hidden="true">${diff > 0 ? '▲' : '▼'}</i> ${esc(fmt(Math.abs(diff)))}${unit} ${word} than the previous ${days} days</span>`;
}

// ---------- shell ----------
export function mount(demoData: Data) {
  demo = demoData;
  load(demoData, true);
  document.body.innerHTML = `<div class="orbs" aria-hidden="true"><i></i><i></i><i></i></div><a class="skip" href="#app">Skip to content</a>
  <header class="top"><a class="brand" href="#/"><span class="logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18h2.5v-6H5zm4 0h2.5V8H9zm4 0h2.5v-4H13zm4 0h2.5V5H17z" fill="currentColor"/></svg></span>Cadence</a>
  <nav class="tabs" aria-label="Sections"><a href="#/" data-v="dash">Dashboard</a><a href="#/data" data-v="data">Data</a></nav></header>
  <main id="app" tabindex="-1"></main>
  <div id="tip" class="tip" role="tooltip" hidden></div>`;
  window.addEventListener('hashchange', render);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('submit', onSubmit);
  const tip = document.getElementById('tip')!;
  const show = (el: Element | null, x: number, y: number) => {
    const t = el?.closest('[data-tip]') as HTMLElement | null;
    if (!t) return (tip.hidden = true);
    tip.textContent = t.dataset.tip!;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
    tip.style.top = `${Math.max(8, y - r.height - 14)}px`;
  };
  document.addEventListener('pointermove', (e) => show(e.target as Element, e.clientX, e.clientY));
  document.addEventListener('focusin', (e) => {
    const el = e.target as Element;
    if (!el.closest('[data-tip]')) return (tip.hidden = true);
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', () => (tip.hidden = true));
  render();
}

function load(d: Data, fromDemo: boolean) {
  data = d;
  ix = index(d);
  U = unitWords(d.source.unit);
  isDemo = fromDemo;
  const span = spanDays(d);
  if (days > span) days = [30, 90, 180, 365].filter((x) => x <= span).pop() || 30;
}

function render() {
  const v = location.hash.startsWith('#/data') ? 'data' : 'dash';
  document.querySelectorAll<HTMLAnchorElement>('nav a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.v === v)));
  app().innerHTML = v === 'data' ? dataView() : dashboard();
  document.title = `${v === 'data' ? 'Data' : data.source.name} · Cadence`;
}

// ---------- dashboard ----------
function dashboard(): string {
  const end = endOf(data),
    from = end - days * DAY;
  const s = summarize(data, ix, from, end),
    p = summarize(data, ix, from - days * DAY, from);
  const hasPrev = Date.parse(data.since + 'T00:00:00Z') <= from - days * DAY + DAY;
  const prev = hasPrev ? p : null;
  const span = spanDays(data);
  const src = data.source;
  const link = (n: number, label: string) => (src.url ? `<a href="${esc(src.url)}/pull/${n}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label));
  const repoLink = src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a>` : esc(src.name);
  const weeks = weekly(data, from, end);
  const leads = leadByDeploy(data, ix, from, end);
  const slow = slowest(data, ix, from, end, 6);
  // With no pull request chart beside it, the change-size chart spans the row on wide screens; it is drawn on a wider
  // canvas there so its text matches the other charts, and at the normal shape for narrow screens.
  const sizeChart = () => {
    const draw = () => line(`Median change size by week, last ${days} days`, weeks.map((w) => ({ t: w.week, v: w.sizeMedian, tip: `Week of ${shortDate(w.week)}: median ${w.sizeMedian == null ? 'none' : Math.round(w.sizeMedian)} lines over ${plural(w.changes, 'change')}` })), from, end, (v) => String(Math.round(v)));
    return s.prs ? draw() : `<div class="w-only">${wide(true, draw)}</div><div class="n-only">${draw()}</div>`;
  };
  return `
  <section class="hero">
    <div class="hero-top">
      <div class="id">
        <p class="kicker">${isDemo ? '<span class="chip">Demo</span>Real public history, ' : ''}${src.kind === 'git' ? 'read from git' : 'read live from GitHub'}</p>
        <h1>${repoLink}</h1>
        <p class="src">${src.branch ? `Branch <code>${esc(src.branch)}</code>. ` : ''}Deploys are ${esc(src.deploys)}. Collected ${esc(longDate(ms(src.collected)))}.</p>
      </div>
      <div class="seg" role="radiogroup" aria-label="Period">${[30, 90, 180, 365]
        .filter((x) => x <= span)
        .map((x) => `<label><input type="radio" name="days" value="${x}" data-act="days"${x === days ? ' checked' : ''}><span>${x === 365 ? '12 months' : `${x} days`}</span></label>`)
        .join('')}</div>
    </div>
    <p class="lede">In the last ${days} days, ${esc(src.name)} shipped <b>${plural(s.deploys, U.one, U.many)}</b>, about ${num(s.perWeek)} a week. A change took a median <b>${dur(s.leadMedian)}</b> from merging to ${U.one}${s.failed ? `, and <b>${plural(s.failed, U.one, U.many)}</b> later needed a revert` : `, and no ${U.one} needed a revert`}.</p>
  </section>

  <section class="metrics" aria-label="DORA metrics">
    <div class="group thr"><h2>Throughput</h2><div class="tiles">
      ${tile('Deployment frequency', `${num(s.perWeek)}<small> a week</small>`, `${plural(s.deploys, U.one, U.many)}; median ${s.daysBetween == null ? 'none' : num(s.daysBetween)} days apart`, delta(s.perWeek, prev?.perWeek ?? null, false, (v) => num(v), ' a week'), 'freq')}
      ${tile('Change lead time', dur(s.leadMedian), `median, merge to ${U.one}; 85% within ${dur(s.leadP85)}`, delta(s.leadMedian, prev?.leadMedian ?? null, true, (v) => dur(v)), 'lead')}
      ${tile('Failed deployment recovery time', dur(s.recoveryMedian), s.failed ? `median, failed ${U.one} to the ${U.one} with the revert` : `no failed ${U.many} in this period`, delta(s.recoveryMedian, prev?.recoveryMedian ?? null, true, (v) => dur(v)), 'recovery')}
    </div></div>
    <div class="group ins"><h2>Instability</h2><div class="tiles">
      ${tile('Change fail rate', pct(s.failRate), `${s.failed} of ${plural(s.deploys, U.one, U.many)} later needed a revert`, delta(s.failRate, prev?.failRate ?? null, true, (v) => points(v), ''), 'cfr')}
      ${tile('Deployment rework rate', pct(s.reworkRate), `${s.rework} of ${plural(s.deploys, U.one, U.many)} shipped a revert of something already shipped`, delta(s.reworkRate, prev?.reworkRate ?? null, true, (v) => points(v), ''), 'rework')}
    </div></div>
  </section>
  <p class="guide">Compare a service with itself over time. DORA publishes no fixed targets and advises against ranking teams by these numbers.</p>

  <section class="charts">
    ${card('', `${U.Many} per week`, 'Each column is one week.', columns(`${U.Many} per week, last ${days} days`, weeks.map((w) => ({ t: w.week, v: w.deploys, tip: `Week of ${shortDate(w.week)}: ${plural(w.deploys, U.one, U.many)}` })), from, end, (v) => String(Math.round(v))),
      table(['Week of', `${U.Many}`, 'Changes merged'], weeks.map((w) => [shortDate(w.week), w.deploys, w.changes])))}
    ${card('', `Lead time by ${U.one}`, `Dot: median wait from merge to ${U.one} for the changes in that ${U.one}. Line: 85% of them shipped within this.`, dots(`Lead time by ${U.one}, last ${days} days`, leads.map((l) => ({ t: ms(l.deploy.at), mid: l.median / 24, hi: l.p85 / 24, flag: l.failed, tip: `${l.deploy.name}, ${shortDate(ms(l.deploy.at))}: ${plural(l.n, 'change')}, median ${dur(l.median)}, 85% within ${dur(l.p85)}${l.failed ? '. Later needed a revert.' : ''}` })), from, end, (v) => `${num(v)}d`),
      table([`${U.One}`, 'Date', 'Changes', 'Median wait', '85% within', 'Later reverted'], leads.map((l) => [l.deploy.name, shortDate(ms(l.deploy.at)), l.n, dur(l.median), dur(l.p85), l.failed ? 'yes' : 'no'])),
      leads.some((l) => l.failed) ? `<p class="key"><i class="k dot"></i>${U.One} <i class="k dot flag"></i>${U.One} that later needed a revert</p>` : '')}
    ${s.sizeMedian != null ? card(s.prs ? '' : 'span', 'Change size', `Median lines changed per merged change, by week. ${pct(s.largeShare)} of changes in this period touched more than ${LARGE} lines.`, sizeChart(),
      table(['Week of', 'Changes', 'Median lines'], weeks.map((w) => [shortDate(w.week), w.changes, w.sizeMedian == null ? '' : Math.round(w.sizeMedian)]))) : ''}
    ${s.prs ? card('', 'Pull request cycle time', `Median hours from opening a pull request to merging it, by week. ${plural(s.prs, 'pull request')} merged in this period, median ${dur(s.prCycleMedian)}.`, line(`Pull request cycle time by week, last ${days} days`, weeks.map((w) => ({ t: w.week, v: w.prCycleMedian, tip: `Week of ${shortDate(w.week)}: median ${dur(w.prCycleMedian)}` })), from, end, (v) => `${Math.round(v)}h`),
      table(['Week of', 'Median cycle time'], weeks.map((w) => [shortDate(w.week), dur(w.prCycleMedian)]))) : ''}
  </section>

  <section class="panel">
    <h2>${U.Many} that needed a revert</h2>
    ${s.failures.length ? `<div class="tw"><table class="list"><thead><tr><th scope="col">${U.One}</th><th scope="col">Change that was reverted</th><th scope="col">Fixed in</th><th scope="col">Recovery</th></tr></thead><tbody>${s.failures
      .map((f) => `<tr><td><b class="rel">${esc(f.deploy.name)}</b><div class="hint m">${esc(shortDate(ms(f.deploy.at)))}</div></td><td>${f.reverted.pr ? link(f.reverted.pr, f.reverted.subject) : esc(f.reverted.subject)}<div class="hint">reverted by ${f.revert.pr ? link(f.revert.pr, '#' + f.revert.pr) : esc(f.revert.sha.slice(0, 9))}</div></td><td class="m">${f.fixedBy ? esc(f.fixedBy.name) : `<span class="warn">not shipped yet</span>`}</td><td class="m">${f.hours != null ? dur(f.hours) : ''}</td></tr>`)
      .join('')}</tbody></table></div>` : '<p class="hint">None in this period. Failures are found through reverts, so a problem fixed forward without a revert does not show here.</p>'}
  </section>

  <section class="panel">
    <h2>Changes that waited longest for a ${U.one}</h2>
    ${slow.length ? `<div class="tw"><table class="list"><thead><tr><th scope="col">Change</th><th scope="col">Merged</th><th scope="col">Shipped in</th><th scope="col">Waited</th></tr></thead><tbody>${slow
      .map((x) => `<tr><td>${x.c.pr ? link(x.c.pr, x.c.subject) : esc(x.c.subject)}</td><td class="m">${esc(shortDate(ms(x.c.at)))}</td><td class="m">${esc(x.dep.name)}</td><td class="m">${dur(x.hours)}</td></tr>`)
      .join('')}</tbody></table></div>` : `<p class="hint">No shipped changes in this period.</p>`}
  </section>

  <details class="panel how"><summary>How Cadence reads these numbers</summary>
    <ul>
      <li><b>Deployment frequency:</b> ${esc(data.source.deploys)}, per week.</li>
      <li><b>Change lead time:</b> from a change merging to <code>${esc(data.source.branch || 'main')}</code> to the ${U.one} that shipped it. DORA measures from commit; for squash-merged pull requests the merge is the commit on the main branch.</li>
      <li><b>Change fail rate:</b> ${U.many} that shipped a change undone by a revert within ${FAIL_WINDOW_DAYS} days, shipped in a later ${U.one}. A revert before the change was shipped doesn't count, because nothing reached users. Neither does one months later, which is a change of direction rather than a failure that needed immediate attention.</li>
      <li><b>Failed deployment recovery time:</b> from the failed ${U.one} to the first ${U.one} that shipped its revert.</li>
      <li><b>Deployment rework rate:</b> ${U.many} that shipped a revert of something already shipped, an unplanned ${U.one} caused by a problem in production.</li>
      <li>Failures are inferred from reverts. A problem fixed forward with a new change, or rolled back outside git, is not seen; pair these numbers with your incident records.</li>
    </ul>
  </details>`;
}

function tile(label: string, value: string, sub: string, d: string, key: string) {
  return `<div class="tile" data-metric="${key}"><h3>${esc(label)}</h3><p class="val">${value}</p><p class="sub">${esc(sub)}</p>${d}</div>`;
}
function card(cls: string, title: string, sub: string, svg: string, tbl: string, extra = '') {
  return `<figure class="card ${cls}"><figcaption><h2>${esc(title)}</h2><p>${esc(sub)}</p></figcaption>${svg}${extra}<details class="tbl"><summary>Show as a table</summary>${tbl}</details></figure>`;
}

// ---------- data ----------
let tokenMem = '';
function dataView(): string {
  return `<section class="page">
    <h1>Data</h1>
    <p class="lede">Cadence shows one service at a time. Point it at a GitHub repository, or open a file from the collector script, which reads any git repository on your own machine.</p>
    <div class="cols">
      <form class="panel" data-form="github">
        <h2>Read a GitHub repository</h2>
        <p>Public repositories work without signing in. Cadence counts the repository's GitHub releases as deploys, or its GitHub deployments (such as GitHub Pages) when it has no releases.</p>
        <label>Repository<input name="repo" placeholder="owner/name or a GitHub link, e.g. astral-sh/ruff" required autocomplete="off"></label>
        <div class="grid2">
          <label>Period<select name="days"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="180">180 days</option></select></label>
          <label>Token <span class="hint">optional</span><input name="token" type="password" autocomplete="off" placeholder="for private repos or large histories"></label>
        </div>
        <p class="hint">A token is kept in this page's memory only and sent only to GitHub. A fine-grained token with read-only access to the repository is enough. Without one, GitHub allows 60 requests an hour from your browser.</p>
        <button class="btn"${busy ? ' disabled' : ''}>${busy ? esc(busy) : 'Read from GitHub'}</button>
        <p id="gh-status" class="status" aria-live="polite"></p>
      </form>
      <section class="panel">
        <h2>Open a collector file</h2>
        <p>The collector reads a repository on your own machine. It works with GitHub, GitLab, Bitbucket or a company server, uses release tags as deploys, and maps every change to its release exactly. Nothing leaves your machine.</p>
        <ol class="steps">
          <li>Download <a href="cadence_collect.py" download>cadence_collect.py</a>. It needs only Python 3 and git.</li>
          <li>Run it on a clone:<pre><code>python3 cadence_collect.py path/to/repo --since 2025-10-01</code></pre>Options: <code>--deploy-tags</code> (a pattern for your release tags), <code>--branch</code>, <code>--name</code>.</li>
          <li>Open the file it writes:</li>
        </ol>
        <label class="btn ghost file">Open cadence-data.json<input type="file" accept=".json,application/json" data-act="open"></label>
        <p id="file-status" class="status" aria-live="polite"></p>
      </section>
    </div>
    <section class="panel quiet">
      <h2>Now showing</h2>
      <p>${esc(data.source.name)}: ${plural(data.deploys.length, U.one, U.many)} and ${plural(data.changes.length, 'change')} from ${esc(longDate(Date.parse(data.since + 'T00:00:00Z')))} to ${esc(longDate(Date.parse(data.until + 'T00:00:00Z')))}${isDemo ? ', the demo' : ''}.</p>
      <div class="row wrap"><a class="btn small" href="#/">Open the dashboard</a>${isDemo ? '' : '<button class="btn small ghost" data-act="demo">Back to the demo</button>'}<button class="btn small ghost" data-act="save">Download this data</button></div>
      <p class="hint">Data stays in this page. Reloading returns to the demo.</p>
    </section>
  </section>`;
}

async function onSubmit(e: Event) {
  const f = e.target as HTMLFormElement;
  if (f.dataset.form !== 'github') return;
  e.preventDefault();
  const fd = new FormData(f);
  tokenMem = String(fd.get('token') || '');
  const st = document.getElementById('gh-status')!;
  const btn = f.querySelector('button')!;
  btn.disabled = true;
  try {
    const r = await fetchRepo({
      repo: String(fd.get('repo') || ''),
      days: +String(fd.get('days') || '90'),
      token: tokenMem,
      progress: (m) => {
        btn.textContent = m;
      },
    });
    days = Math.min(+String(fd.get('days') || '90'), 365);
    load(r.data, false);
    location.hash = '#/';
    render();
    if (r.capped) toast('Showing the most recent changes only: the history is longer than Cadence reads without a token.');
  } catch (err: any) {
    st.textContent = err instanceof GitHubError ? err.message : `Could not reach GitHub: ${err.message || err}`;
    st.className = 'status warn';
    btn.disabled = false;
    btn.textContent = 'Read from GitHub';
  }
}

async function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.dataset.act === 'days') {
    days = +el.value;
    render();
    (document.querySelector(`input[name=days][value="${days}"]`) as HTMLElement)?.focus();
  }
  if (el.dataset.act === 'open') {
    const f = el.files && el.files[0];
    el.value = '';
    if (!f) return;
    const st = document.getElementById('file-status')!;
    try {
      load(readData(await f.text()), false);
      location.hash = '#/';
      render();
    } catch (err: any) {
      st.textContent = err.message || String(err);
      st.className = 'status warn';
    }
  }
}

function onClick(e: Event) {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!t || t.tagName === 'INPUT') return;
  if (t.dataset.act === 'demo') {
    load(demo, true);
    render();
  }
  if (t.dataset.act === 'save') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `${data.source.name.replace(/[^\w.-]+/g, '-')}-cadence-data.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  }
}

function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

