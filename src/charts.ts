// Small SVG charts, drawn by hand: thin marks, hairline grid, one hue per series, a tooltip on every mark
// (data-tip, shown by the UI on hover and focus), and the same numbers available as a table under each chart.
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let W = 640;
const H = 220,
  L = 48, // left margin for y labels
  R = 12,
  T = 12,
  B = 28;
let PW = W - L - R;
const PH = H - T - B;

/** Draw with a wider canvas, for a chart that spans the full row, so its text stays the same size as its neighbours'. */
export function wide<T>(on: boolean, draw: () => T): T {
  if (!on) return draw();
  const w = W;
  W = 1300;
  PW = W - L - R;
  try {
    return draw();
  } finally {
    W = w;
    PW = W - L - R;
  }
}

/** Round tick steps (1, 2, 2.5, 5 times a power of ten), whole numbers when the values are counts. */
export function scale(maxVal: number, integer = false): { top: number; ticks: number[] } {
  const raw = Math.max(maxVal, integer ? 1 : 1e-9) / 4,
    mag = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = mag;
  for (const m of integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]) {
    step = Math.max(integer ? 1 : 0, m * mag);
    if (integer) step = Math.ceil(step);
    if (step * 4 >= maxVal) break;
  }
  const top = Math.max(step, step * Math.ceil(maxVal / step));
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDate = (t: number) => {
  const d = new Date(t);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
export const longDate = (t: number) => `${shortDate(t)}, ${new Date(t).getUTCFullYear()}`;

function timeAxis(from: number, to: number) {
  const X = (t: number) => L + ((t - from) / Math.max(1, to - from)) * PW;
  // month ticks (or every other month when the range is long)
  const out: string[] = [];
  const d = new Date(from);
  let m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const months = (to - from) / (30 * 864e5);
  const step = months > 8 ? 2 : 1;
  let i = 0;
  for (; m <= to; i++) {
    const md = new Date(m);
    if (i % step === 0) out.push(`<g class="tick"><line x1="${X(m)}" x2="${X(m)}" y1="${T}" y2="${T + PH}"/><text x="${X(m)}" y="${H - 8}" text-anchor="middle">${MON[md.getUTCMonth()]}${md.getUTCMonth() === 0 ? ' ' + md.getUTCFullYear() : ''}</text></g>`);
    m = Date.UTC(md.getUTCFullYear(), md.getUTCMonth() + 1, 1);
  }
  return { X, svg: out.join('') };
}
function yAxis(maxVal: number, fmt: (v: number) => string, integer = false) {
  const { top: max, ticks } = scale(maxVal, integer);
  const Y = (v: number) => T + PH - (v / max) * PH;
  const svg = ticks
    .map((v) => `<g class="grid"><line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text></g>`)
    .join('');
  return { Y, svg };
}
const frame = (label: string, body: string) => `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${body}</svg>`;

/** Rounded-top bar from the baseline: 4px radius at the data end, square at the base. */
function bar(x: number, y: number, w: number, h: number) {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

export interface ColumnPoint {
  t: number; // start of the bucket
  v: number;
  tip: string;
}
/** Columns per week on a time axis. */
export function columns(label: string, pts: ColumnPoint[], from: number, to: number, fmt: (v: number) => string) {
  const ax = timeAxis(from, to),
    ya = yAxis(Math.max(1, ...pts.map((p) => p.v)), fmt, true);
  const slot = (7 * 864e5 * PW) / Math.max(1, to - from),
    w = Math.max(2, Math.min(24, slot - 2));
  const bars = pts
    .map((p) => {
      const x = Math.max(L, ax.X(p.t + 3.5 * 864e5) - w / 2),
        y = ya.Y(p.v);
      return `<g class="hit" tabindex="0" data-tip="${esc(p.tip)}"><rect class="hitbox" x="${x - 2}" y="${T}" width="${w + 4}" height="${PH}"/><path class="bar" d="${bar(x, y, w, T + PH - y)}"/></g>`;
    })
    .join('');
  return frame(label, `${ya.svg}${ax.svg}<line class="base" x1="${L}" x2="${W - R}" y1="${T + PH}" y2="${T + PH}"/>${bars}`);
}

export interface RangePoint {
  t: number;
  mid: number;
  hi: number;
  flag?: boolean; // drawn in the critical colour, explained by the legend
  tip: string;
}
/** A dot per item (the median) with a whisker up to a high value (the 85th percentile). */
export function dots(label: string, pts: RangePoint[], from: number, to: number, fmt: (v: number) => string) {
  const ax = timeAxis(from, to),
    ya = yAxis(Math.max(0.1, ...pts.map((p) => p.hi)), fmt);
  const xs = pts.map((p) => ax.X(p.t));
  const marks = pts
    .map((p, i) => {
      const x = xs[i];
      // hit area reaches halfway to each neighbour (at most 12 units), so close releases never cover each other
      const a = i ? Math.min(12, (x - xs[i - 1]) / 2) : 12,
        z = i < xs.length - 1 ? Math.min(12, (xs[i + 1] - x) / 2) : 12;
      return `<g class="hit${p.flag ? ' flag' : ''}" tabindex="0" data-tip="${esc(p.tip)}"><rect class="hitbox" x="${x - a}" y="${T}" width="${a + z}" height="${PH}"/><line class="whisker" x1="${x}" x2="${x}" y1="${ya.Y(p.mid)}" y2="${ya.Y(p.hi)}"/><circle class="dot" cx="${x}" cy="${ya.Y(p.mid)}" r="4.5"/></g>`;
    })
    .join('');
  return frame(label, `${ya.svg}${ax.svg}<line class="base" x1="${L}" x2="${W - R}" y1="${T + PH}" y2="${T + PH}"/>${marks}`);
}

export interface LinePoint {
  t: number;
  v: number | null;
  tip: string;
}
/** A 2px line through weekly values; gaps where a week has no value; a dot and hit area per point. */
export function line(label: string, pts: LinePoint[], from: number, to: number, fmt: (v: number) => string) {
  const ax = timeAxis(from, to),
    ya = yAxis(Math.max(1, ...pts.map((p) => p.v ?? 0)), fmt);
  let d = '',
    pen = false;
  for (const p of pts) {
    if (p.v == null) {
      pen = false;
      continue;
    }
    const x = ax.X(p.t + 3.5 * 864e5),
      y = ya.Y(p.v);
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  const hits = pts
    .filter((p) => p.v != null)
    .map((p) => {
      const x = ax.X(p.t + 3.5 * 864e5);
      return `<g class="hit" tabindex="0" data-tip="${esc(p.tip)}"><rect class="hitbox" x="${x - 6}" y="${T}" width="12" height="${PH}"/><circle class="pt" cx="${x}" cy="${ya.Y(p.v!)}" r="4"/></g>`;
    })
    .join('');
  return frame(label, `${ya.svg}${ax.svg}<line class="base" x1="${L}" x2="${W - R}" y1="${T + PH}" y2="${T + PH}"/><path class="line" d="${d}"/>${hits}`);
}

/** The same numbers as a table, for screen readers and anyone who wants exact values. */
export function table(head: string[], rows: (string | number)[][]) {
  return `<table class="data"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`)
    .join('')}</tbody></table>`;
}
