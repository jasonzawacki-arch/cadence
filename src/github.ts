// Live mode: read a repository's delivery history straight from the GitHub API, in the browser.
// Deploys are the repository's published GitHub releases (pre-releases and drafts left out). A change counts as
// shipped by the first release published after it landed on the default branch, which is exact for a straight main
// line (squash or rebase merges) and close otherwise; the collector script maps changes to releases exactly.
// A token is optional (60 requests an hour without one, 5,000 with); it is held in memory for this page only and
// sent only to api.github.com.
import type { Change, Data, Deploy, PullRequest } from './model.js';

export const API = 'https://api.github.com';
const PAGE = 100;

export interface Progress {
  (msg: string): void;
}

export class GitHubError extends Error {}

async function get(path: string, token: string, rate: { left: number | null }): Promise<any> {
  const r = await fetch(API + path, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const left = r.headers.get('x-ratelimit-remaining');
  if (left != null) rate.left = +left;
  if (r.status === 404) throw new GitHubError('GitHub has no repository by that name, or it is private. For a private repository, add a token with read access.');
  if (r.status === 401) throw new GitHubError('GitHub did not accept the token. Check it, or leave it empty for a public repository.');
  if (r.status === 403 || r.status === 429) {
    throw new GitHubError(rate.left === 0 ? 'GitHub\'s hourly limit for this browser is used up. Add a token, or try again in an hour.' : 'GitHub refused the request (HTTP ' + r.status + ').');
  }
  if (!r.ok) throw new GitHubError(`GitHub answered HTTP ${r.status}.`);
  return r.json();
}

const subjectKey = (s: string) => s.trim().replace(/\s*\(#\d+\)\s*$/, '').toLowerCase();

/** owner/name from what people paste: owner/name, a github.com link (with or without https://, www, a trailing
 *  slash, .git, or a deeper path such as /tree/main), or a GitHub Pages address (owner.github.io/name). */
export function parseRepo(input: string): { owner: string; name: string } {
  const s = input.trim().replace(/^git@github\.com:/i, '').replace(/^(https?:\/\/)?(www\.)?/i, '');
  const part = '[A-Za-z0-9_.-]+';
  const gh = new RegExp(`^(?:github\\.com\\/)?(${part})\\/(${part})`, 'i').exec(s);
  const pages = new RegExp(`^(${part})\\.github\\.io\\/(${part})`, 'i').exec(s);
  const m = pages || gh;
  if (!m || /\.github\.io$|^github\.com$/i.test(m[1])) throw new GitHubError('Enter the repository as owner/name, for example astral-sh/ruff, or paste its GitHub link.');
  return { owner: m[1], name: m[2].replace(/\.git$/i, '') };
}

export interface LiveOptions {
  repo: string; // owner/name
  days: number;
  token: string;
  progress?: Progress;
  maxPages?: number;
}

export async function fetchRepo(o: LiveOptions): Promise<{ data: Data; capped: boolean; rateLeft: number | null }> {
  const { owner, name } = parseRepo(o.repo);
  const base = `/repos/${owner}/${name}`;
  const rate = { left: null as number | null };
  const say = o.progress || (() => {});
  const maxPages = o.maxPages ?? 20;
  const now = Date.now(),
    since = new Date(now - o.days * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
  let capped = false;

  say('Reading the repository');
  const repo = await get(base, o.token, rate);
  const branch: string = repo.default_branch;

  say('Reading releases');
  const deploys: Deploy[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rel: any[] = await get(`${base}/releases?per_page=${PAGE}&page=${page}`, o.token, rate);
    for (const r of rel) if (!r.draft && !r.prerelease && r.published_at) deploys.push({ name: r.tag_name, at: r.published_at });
    if (rel.length < PAGE || rel.some((r) => r.published_at && r.published_at < since)) break;
  }
  // No releases: fall back to GitHub deployments (GitHub Pages, Actions environments, other deploy tools), which many
  // repositories record on every push. Production-like environments are preferred; a redeploy of the same commit counts once.
  let unit: 'release' | 'deployment' = 'release';
  let envName = '';
  if (!deploys.length) {
    say('No releases; reading deployments');
    const all: any[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const ds: any[] = await get(`${base}/deployments?per_page=${PAGE}&page=${page}`, o.token, rate);
      all.push(...ds);
      if (ds.length < PAGE || ds.some((d) => d.created_at < since)) break;
    }
    const envs = [...new Set(all.map((d) => String(d.environment || '')))];
    envName = envs.find((e) => /^(production|prod|github-pages|live)$/i.test(e)) || envs.find((e) => /prod/i.test(e)) || (envs.length === 1 ? envs[0] : '');
    const seen = new Set<string>();
    for (const d of all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
      if (envName && d.environment !== envName) continue;
      if (!d.sha || seen.has(d.sha)) continue;
      seen.add(d.sha);
      deploys.push({ name: String(d.sha).slice(0, 7), at: String(d.created_at).replace(/\.\d+Z$/, 'Z') });
    }
    unit = 'deployment';
  }
  deploys.sort((a, b) => (a.at < b.at ? -1 : 1));
  if (!deploys.length) throw new GitHubError(`${owner}/${name} has no published releases or deployments on GitHub, so there is nothing to count as a deploy. For a repository that deploys from tags or a pipeline, use the collector script.`);

  const changes: Change[] = [];
  for (let page = 1; ; page++) {
    say(`Reading changes on ${branch} (page ${page})`);
    const cs: any[] = await get(`${base}/commits?sha=${encodeURIComponent(branch)}&since=${since}&per_page=${PAGE}&page=${page}`, o.token, rate);
    for (const c of cs) {
      const msg: string = c.commit?.message || '';
      const subject = msg.split('\n')[0].slice(0, 200);
      const at = c.commit?.committer?.date;
      if (!at) continue;
      const ch: Change = { sha: String(c.sha).slice(0, 12), at: at.replace(/\.\d+Z$/, 'Z'), subject };
      const pr = /\(#(\d+)\)\s*$/.exec(subject);
      if (pr) ch.pr = +pr[1];
      const rs = /This reverts commit ([0-9a-f]{7,40})/.exec(msg);
      if (rs) ch.revertOf = rs[1].slice(0, 12);
      else if (/^revert\b/i.test(subject)) (ch as any)._rk = subjectKey((/^revert\s+"(.+)"/i.exec(subject) || [])[1] || subject.replace(/^revert\s*:?\s*/i, ''));
      changes.push(ch);
    }
    if (cs.length < PAGE) break;
    if (page >= maxPages) {
      capped = true;
      break;
    }
  }
  changes.sort((a, b) => (a.at < b.at ? -1 : 1));
  // shipped by the first release published at or after the change landed
  let j = 0;
  for (const c of changes) {
    while (j < deploys.length && deploys[j].at < c.at) j++;
    if (j < deploys.length) c.deploy = deploys[j].name;
  }
  // reverts matched by subject when the message names no commit
  for (const c of changes as any[]) {
    if (c._rk) {
      const target = [...changes].reverse().find((x) => x.at < c.at && subjectKey(x.subject) === c._rk);
      if (target) c.revertOf = target.sha;
      delete c._rk;
    }
  }

  say('Reading pull requests');
  const prs: PullRequest[] = [];
  for (let page = 1; page <= Math.min(maxPages, 10); page++) {
    const ps: any[] = await get(`${base}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`, o.token, rate);
    for (const p of ps) if (p.merged_at && p.merged_at >= since) prs.push({ number: p.number, created: p.created_at, merged: p.merged_at });
    if (ps.length < PAGE || ps.every((p) => p.updated_at < since)) break;
  }

  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const data: Data = {
    format: 'cadence-data',
    version: 1,
    source: {
      kind: 'github',
      name: `${owner}/${name}`,
      branch,
      collected: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
      deploys:
        unit === 'release'
          ? 'GitHub releases (pre-releases left out); each change counted in the first release after it landed'
          : `GitHub deployments${envName ? ` to ${envName}` : ''}, named by commit; each change counted in the first deployment after it landed`,
      unit,
      url: `https://github.com/${owner}/${name}`,
    },
    since: day(now - o.days * 864e5),
    until: day(now),
    deploys: deploys.filter((d) => d.at >= since),
    changes,
    prs,
  };
  return { data, capped, rateLeft: rate.left };
}
