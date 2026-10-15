// The five DORA software delivery metrics, plus flow indicators, computed from a Cadence data file.
//
// How each one is read from version control (see the README for the reasoning):
// - Deployment frequency: deploys (release tags or GitHub releases) per week.
// - Change lead time: from a change landing on the main branch to the deploy that shipped it.
// - Change fail rate: deploys that shipped a change later undone by a revert in a later deploy, out of all deploys.
//   A revert that lands before its change is released is not a failure: nothing reached users.
// - Failed deployment recovery time: from a failed deploy to the deploy that shipped the revert.
// - Deployment rework rate: deploys that shipped a revert of something already released, out of all deploys.
// Failures are inferred from reverts, so incidents fixed forward without a revert are not seen. Only a revert that
// lands within FAIL_WINDOW_DAYS of the release counts: DORA's failures need immediate intervention, and a change
// undone months later is a change of direction, not a failed deployment.
import type { Change, Data, Deploy, Failure, Summary } from './model.js';
import { LARGE } from './model.js';

export const FAIL_WINDOW_DAYS = 14;
export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
export const ms = (iso: string) => Date.parse(iso);

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b),
    i = (s.length - 1) * q,
    lo = Math.floor(i),
    hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (xs: number[]) => quantile(xs, 0.5);

export interface Index {
  deploys: Map<string, Deploy>;
  bySha: Map<string, Change>;
  failures: Failure[]; // every failure in the data, oldest first
}

export function index(d: Data): Index {
  const deploys = new Map(d.deploys.map((x) => [x.name, x] as const));
  const bySha = new Map<string, Change>();
  d.changes.forEach((c) => bySha.set(c.sha, c));
  const find = (sha: string) => bySha.get(sha) || d.changes.find((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha));
  const failures: Failure[] = [];
  const seen = new Set<string>();
  for (const r of d.changes) {
    if (!r.revertOf) continue;
    const x = find(r.revertOf);
    if (!x || !x.deploy) continue; // reverted before it was ever released
    const shipped = deploys.get(x.deploy);
    if (!shipped) continue;
    const fix = r.deploy ? deploys.get(r.deploy) : undefined;
    if (fix && ms(fix.at) <= ms(shipped.at)) continue; // undone in the same release: never reached users
    if (ms(r.at) - ms(shipped.at) > FAIL_WINDOW_DAYS * DAY) continue; // undone much later: a change of direction
    const key = `${shipped.name}|${r.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({ deploy: shipped, reverted: x, revert: r, fixedBy: fix, hours: fix ? (ms(fix.at) - ms(shipped.at)) / HOUR : undefined });
  }
  failures.sort((a, b) => ms(a.deploy.at) - ms(b.deploy.at));
  return { deploys, bySha, failures };
}

/** The window ending at `end` (exclusive of nothing; inclusive ends) of `days` days. */
export function window(endIso: string, days: number) {
  const to = ms(endIso),
    from = to - days * DAY;
  return { from, to };
}

export function summarize(d: Data, ix: Index, from: number, to: number): Summary {
  const days = (to - from) / DAY;
  const inWin = (iso: string) => ms(iso) > from && ms(iso) <= to;
  const deps = d.deploys.filter((x) => inWin(x.at));
  const depNames = new Set(deps.map((x) => x.name));
  const gaps: number[] = [];
  const sortedAll = d.deploys;
  for (const x of deps) {
    const i = sortedAll.indexOf(x);
    if (i > 0) gaps.push((ms(x.at) - ms(sortedAll[i - 1].at)) / DAY);
  }
  const lead: number[] = [];
  for (const c of d.changes) {
    if (!c.deploy || !depNames.has(c.deploy)) continue;
    const dep = ix.deploys.get(c.deploy)!;
    const h = (ms(dep.at) - ms(c.at)) / HOUR;
    if (h >= 0) lead.push(h);
  }
  const fails = ix.failures.filter((f) => depNames.has(f.deploy.name));
  const failedDeploys = new Set(fails.map((f) => f.deploy.name));
  const recov: number[] = [];
  const firstFix = new Map<string, number>();
  for (const f of fails) if (f.hours != null) firstFix.set(f.deploy.name, Math.min(firstFix.get(f.deploy.name) ?? Infinity, f.hours));
  firstFix.forEach((h) => recov.push(h));
  const reworkDeploys = new Set(ix.failures.filter((f) => f.fixedBy && depNames.has(f.fixedBy.name)).map((f) => f.fixedBy!.name));
  const landed = d.changes.filter((c) => inWin(c.at));
  const sizes = landed.filter((c) => c.adds != null).map((c) => (c.adds || 0) + (c.dels || 0));
  const prs = (d.prs || []).filter((p) => inWin(p.merged));
  return {
    days,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    deploys: deps.length,
    perWeek: deps.length / (days / 7),
    daysBetween: median(gaps),
    leadMedian: median(lead),
    leadP85: quantile(lead, 0.85),
    shipped: lead.length,
    failed: failedDeploys.size,
    failRate: deps.length ? failedDeploys.size / deps.length : null,
    recoveryMedian: median(recov),
    rework: reworkDeploys.size,
    reworkRate: deps.length ? reworkDeploys.size / deps.length : null,
    changes: landed.length,
    sizeMedian: median(sizes),
    largeShare: sizes.length ? sizes.filter((s) => s > LARGE).length / sizes.length : null,
    prCycleMedian: median(prs.map((p) => (ms(p.merged) - ms(p.created)) / HOUR)),
    prs: prs.length,
    failures: fails,
  };
}

export const mondayOf = (t: number) => {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
};

export interface WeekPoint {
  week: number; // Monday 00:00 UTC
  deploys: number;
  changes: number;
  sizeMedian: number | null;
  prCycleMedian: number | null;
}
/** Week by week across [from, to]. */
export function weekly(d: Data, from: number, to: number): WeekPoint[] {
  const out: WeekPoint[] = [];
  for (let w = mondayOf(from); w <= to; w += 7 * DAY) {
    const inW = (iso: string) => ms(iso) >= w && ms(iso) < w + 7 * DAY && ms(iso) > from && ms(iso) <= to;
    const ch = d.changes.filter((c) => inW(c.at));
    const sizes = ch.filter((c) => c.adds != null).map((c) => (c.adds || 0) + (c.dels || 0));
    const prs = (d.prs || []).filter((p) => inW(p.merged));
    out.push({
      week: w,
      deploys: d.deploys.filter((x) => inW(x.at)).length,
      changes: ch.length,
      sizeMedian: median(sizes),
      prCycleMedian: median(prs.map((p) => (ms(p.merged) - ms(p.created)) / HOUR)),
    });
  }
  return out;
}

export interface DeployLead {
  deploy: Deploy;
  n: number;
  median: number;
  p85: number;
  max: number;
  failed: boolean;
}
/** Lead time of the changes in each deploy, for the lead-time chart. */
export function leadByDeploy(d: Data, ix: Index, from: number, to: number): DeployLead[] {
  const failed = new Set(ix.failures.map((f) => f.deploy.name));
  const per = new Map<string, number[]>();
  for (const c of d.changes) {
    if (!c.deploy) continue;
    const dep = ix.deploys.get(c.deploy);
    if (!dep || ms(dep.at) <= from || ms(dep.at) > to) continue;
    const h = (ms(dep.at) - ms(c.at)) / HOUR;
    if (h < 0) continue;
    (per.get(c.deploy) || per.set(c.deploy, []).get(c.deploy)!).push(h);
  }
  return d.deploys
    .filter((x) => per.has(x.name))
    .map((x) => {
      const hs = per.get(x.name)!;
      return { deploy: x, n: hs.length, median: median(hs)!, p85: quantile(hs, 0.85)!, max: Math.max(...hs), failed: failed.has(x.name) };
    });
}

/** Changes that waited longest between landing and release, in the window. */
export function slowest(d: Data, ix: Index, from: number, to: number, n = 8) {
  return d.changes
    .filter((c) => c.deploy && ix.deploys.has(c.deploy))
    .map((c) => ({ c, dep: ix.deploys.get(c.deploy!)!, hours: (ms(ix.deploys.get(c.deploy!)!.at) - ms(c.at)) / HOUR }))
    .filter((x) => ms(x.dep.at) > from && ms(x.dep.at) <= to && x.hours >= 0)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, n);
}
