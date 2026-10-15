// Cadence data model. One file describes one service's delivery history: its deploys and the changes that landed on
// its main branch, from the collector script (any git host) or read live from GitHub.

export interface Deploy {
  name: string; // release or tag name
  at: string; // ISO UTC
  sha?: string;
}

export interface Change {
  sha: string;
  at: string; // when it landed on the main branch, ISO UTC
  authored?: string;
  subject: string;
  pr?: number;
  adds?: number;
  dels?: number;
  deploy?: string; // name of the deploy that shipped it
  revertOf?: string; // sha of the change this one reverts
}

export interface PullRequest {
  number: number;
  created: string;
  merged: string;
}

export interface Source {
  kind: 'git' | 'github';
  name: string; // owner/repo or folder name
  branch?: string;
  collected: string;
  deploys: string; // how deploys were identified, in words
  url?: string;
  unit?: 'release' | 'deployment'; // what a deploy is called on screen (default: release)
}

export interface Data {
  format: 'cadence-data';
  version: 1;
  source: Source;
  since: string; // YYYY-MM-DD
  until: string;
  deploys: Deploy[];
  changes: Change[];
  prs?: PullRequest[];
}

/** One deploy that shipped a change later reverted in another deploy. */
export interface Failure {
  deploy: Deploy;
  reverted: Change; // the change that was undone
  revert: Change;
  fixedBy?: Deploy; // the deploy that shipped the revert; missing while unreleased
  hours?: number; // deploy to fix
}

export interface Summary {
  days: number;
  from: string;
  to: string;
  deploys: number;
  perWeek: number;
  daysBetween: number | null; // median
  leadMedian: number | null; // hours
  leadP85: number | null;
  shipped: number; // changes shipped in this window
  failed: number; // deploys that later needed a revert
  failRate: number | null; // 0..1
  recoveryMedian: number | null; // hours
  rework: number; // deploys that shipped a revert of something already released
  reworkRate: number | null;
  changes: number; // changes landed in the window
  sizeMedian: number | null; // lines changed
  largeShare: number | null; // share of changes over LARGE lines
  prCycleMedian: number | null; // hours, open to merge
  prs: number;
  failures: Failure[];
}

export const LARGE = 400;
