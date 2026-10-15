// Reading and checking a Cadence data file. Anything malformed is refused with a message that says what is wrong.
import type { Data } from './model.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readData(text: string): Data {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('This file is not JSON. Open a file made by the Cadence collector (cadence-data.json).');
  }
  if (!o || o.format !== 'cadence-data') throw new Error('This is not a Cadence data file. Make one with the collector script on the Data page.');
  if (o.version !== 1) throw new Error(`This file is version ${o.version}; this copy of Cadence reads version 1.`);
  if (!o.source || typeof o.source.name !== 'string') throw new Error('The file has no source name.');
  if (!DAY.test(o.since) || !DAY.test(o.until)) throw new Error('The file needs since and until dates (YYYY-MM-DD).');
  if (!Array.isArray(o.deploys) || !Array.isArray(o.changes)) throw new Error('The file needs deploys and changes lists.');
  o.deploys.forEach((d: any, i: number) => {
    if (typeof d?.name !== 'string' || !ISO.test(d?.at)) throw new Error(`Deploy ${i + 1} needs a name and a time (UTC, like 2026-05-01T14:00:00Z).`);
  });
  o.changes.forEach((c: any, i: number) => {
    if (typeof c?.sha !== 'string' || !ISO.test(c?.at) || typeof c?.subject !== 'string') throw new Error(`Change ${i + 1} needs a sha, a time and a subject.`);
  });
  if (o.prs != null && !Array.isArray(o.prs)) throw new Error('prs must be a list.');
  o.deploys.sort((a: any, b: any) => (a.at < b.at ? -1 : 1));
  o.changes.sort((a: any, b: any) => (a.at < b.at ? -1 : 1));
  return o as Data;
}
