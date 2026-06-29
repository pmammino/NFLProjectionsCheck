import type { MetricMeta, Row } from "./types";

// Pull the per-row arrays we need for a metric (respecting position + volume).
interface Series {
  m: number[]; // projected median
  a: number[]; // actual
  f: number[]; // labeled floor value (25th pct estimate)
  c: number[]; // labeled ceiling value (75th pct estimate)
  lo: number[]; // min(f,c) — interval lower bound
  hi: number[]; // max(f,c) — interval upper bound
}

function seriesFor(rows: Row[], metric: MetricMeta, minVolume: number): Series {
  const s: Series = { m: [], a: [], f: [], c: [], lo: [], hi: [] };
  for (const r of rows) {
    if (!metric.positions.includes(r.pos)) continue;
    const cell = r.m[metric.key];
    if (!cell || cell.av < minVolume) continue;
    s.m.push(cell.m);
    s.a.push(cell.a);
    s.f.push(cell.f);
    s.c.push(cell.c);
    s.lo.push(Math.min(cell.f, cell.c));
    s.hi.push(Math.max(cell.f, cell.c));
  }
  return s;
}

// Average-rank vector with tie handling (for Spearman).
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as [number, number]);
  idx.sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank for ties
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    syy += y[i] * y[i];
    sxy += x[i] * y[i];
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  const d = Math.sqrt(vx * vy);
  return d === 0 ? NaN : cov / d;
}

// 95% Wilson score interval for a binomial proportion. Robust for small n and
// proportions near 0/1, where the normal approximation misbehaves.
export function wilson(
  successes: number,
  n: number,
  z = 1.96
): { lo: number; hi: number; half: number } {
  if (n === 0) return { lo: 0, hi: 0, half: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lo = Math.max(0, center - margin);
  const hi = Math.min(1, center + margin);
  return { lo, hi, half: (hi - lo) / 2 };
}

export interface CI {
  lo: number;
  hi: number;
}

export interface DeepStats {
  key: string;
  meta: MetricMeta;
  n: number;
  // Coverage — empirical P(actual <= quantile estimate). Targets: 25/50/75%.
  covFloor: number;
  covMedian: number;
  covCeiling: number;
  within: number; // P(Floor <= actual <= Ceiling); target 50%
  overMedianRate: number; // P(actual > median); target 50%
  // 95% Wilson confidence intervals for the proportions above.
  ciFloor: CI;
  ciMedian: CI;
  ciCeiling: CI;
  ciWithin: CI;
  ciOverMedian: CI;
  // Brier score for the quantile-exceedance forecasts (Floor/Median/Ceiling,
  // implied probs 0.75/0.50/0.25), averaged over the three thresholds. Lower
  // is better; the best achievable with these fixed probs is ~0.2083.
  brier: number;
  // Interval quality
  sharpness: number; // mean(hi - lo), raw units
  relSharpness: number; // mean((hi - lo) / |median|)
  winkler: number; // mean Winkler interval score (α=0.5); lower better
  pinball: number; // mean pinball loss over q∈{.25,.5,.75}; lower better
  // Point accuracy of the median
  rmse: number;
  mae: number;
  wape: number; // Σ|a-m| / Σ|a|  (robust to zero actuals)
  spearman: number; // rank corr(median, actual)
  slope: number; // OLS actual ~ median; target 1.0
  intercept: number;
}

const ALPHA = 0.5; // central 50% interval (Floor=25th, Ceiling=75th)

export function deepStats(
  rows: Row[],
  metric: MetricMeta,
  minVolume: number
): DeepStats | null {
  const s = seriesFor(rows, metric, minVolume);
  const n = s.a.length;
  if (n === 0) return null;

  let leFloor = 0,
    leMedian = 0,
    leCeiling = 0,
    overMed = 0,
    inBand = 0;
  let widthSum = 0,
    relWidthSum = 0,
    winklerSum = 0,
    pinballSum = 0,
    brierSum = 0;
  let seSum = 0,
    aeSum = 0,
    absActualSum = 0;

  for (let i = 0; i < n; i++) {
    const a = s.a[i],
      m = s.m[i],
      f = s.f[i],
      c = s.c[i],
      lo = s.lo[i],
      hi = s.hi[i];

    if (a <= f) leFloor++;
    if (a <= m) leMedian++;
    if (a <= c) leCeiling++;
    if (a > m) overMed++;
    if (a >= lo && a <= hi) inBand++;

    // Brier score over the three quantile-exceedance events. The projection
    // implies P(actual > Floor)=.75, P(actual > Median)=.5, P(actual > Ceiling)=.25.
    const yF = a > f ? 1 : 0;
    const yM = a > m ? 1 : 0;
    const yC = a > c ? 1 : 0;
    brierSum +=
      ((0.75 - yF) ** 2 + (0.5 - yM) ** 2 + (0.25 - yC) ** 2) / 3;

    const width = hi - lo;
    widthSum += width;
    if (m !== 0) relWidthSum += width / Math.abs(m);

    // Winkler interval score for a central (1-ALPHA) interval.
    let w = width;
    if (a < lo) w += (2 / ALPHA) * (lo - a);
    else if (a > hi) w += (2 / ALPHA) * (a - hi);
    winklerSum += w;

    // Pinball loss averaged over the three quantiles.
    pinballSum +=
      (pinball(0.25, f, a) + pinball(0.5, m, a) + pinball(0.75, c, a)) / 3;

    const err = a - m;
    seSum += err * err;
    aeSum += Math.abs(err);
    absActualSum += Math.abs(a);
  }

  const rk = pearson(ranks(s.m), ranks(s.a));
  const { slope, intercept } = ols(s.m, s.a);

  return {
    key: metric.key,
    meta: metric,
    n,
    covFloor: leFloor / n,
    covMedian: leMedian / n,
    covCeiling: leCeiling / n,
    within: inBand / n,
    overMedianRate: overMed / n,
    ciFloor: wilson(leFloor, n),
    ciMedian: wilson(leMedian, n),
    ciCeiling: wilson(leCeiling, n),
    ciWithin: wilson(inBand, n),
    ciOverMedian: wilson(overMed, n),
    brier: brierSum / n,
    sharpness: widthSum / n,
    relSharpness: relWidthSum / n,
    winkler: winklerSum / n,
    pinball: pinballSum / n,
    rmse: Math.sqrt(seSum / n),
    mae: aeSum / n,
    wape: absActualSum === 0 ? NaN : aeSum / absActualSum,
    spearman: rk,
    slope,
    intercept,
  };
}

function pinball(q: number, forecast: number, actual: number): number {
  const d = actual - forecast;
  return d >= 0 ? q * d : (q - 1) * d;
}

function ols(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: NaN, intercept: NaN };
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

// ---- Conditional calibration ------------------------------------------

export interface Bucket {
  label: string;
  n: number;
  withinRate: number;
  withinCI: CI; // 95% Wilson CI on withinRate
  covMedian: number; // P(actual <= median)
  meanErr: number; // mean(actual - median)
}

function bucketStats(label: string, cells: { a: number; m: number; lo: number; hi: number }[]): Bucket {
  const n = cells.length;
  let within = 0,
    leMed = 0,
    errSum = 0;
  for (const c of cells) {
    if (c.a >= c.lo && c.a <= c.hi) within++;
    if (c.a <= c.m) leMed++;
    errSum += c.a - c.m;
  }
  return {
    label,
    n,
    withinRate: n ? within / n : 0,
    withinCI: wilson(within, n),
    covMedian: n ? leMed / n : 0,
    meanErr: n ? errSum / n : 0,
  };
}

interface CellLite {
  a: number;
  m: number;
  lo: number;
  hi: number;
  wk: number;
  pos: string;
}

function cellsFor(rows: Row[], metric: MetricMeta, minVolume: number): CellLite[] {
  const out: CellLite[] = [];
  for (const r of rows) {
    if (!metric.positions.includes(r.pos)) continue;
    const c = r.m[metric.key];
    if (!c || c.av < minVolume) continue;
    out.push({
      a: c.a,
      m: c.m,
      lo: Math.min(c.f, c.c),
      hi: Math.max(c.f, c.c),
      wk: r.wk,
      pos: r.pos,
    });
  }
  return out;
}

export interface Conditional {
  byWeek: Bucket[];
  byMagnitude: Bucket[]; // quartile tiers of projected median
  byPosition: Bucket[];
}

export function conditional(
  rows: Row[],
  metric: MetricMeta,
  minVolume: number
): Conditional {
  const cells = cellsFor(rows, metric, minVolume);

  // by week
  const wkMap = new Map<number, CellLite[]>();
  for (const c of cells) {
    if (!wkMap.has(c.wk)) wkMap.set(c.wk, []);
    wkMap.get(c.wk)!.push(c);
  }
  const byWeek = [...wkMap.keys()]
    .sort((x, y) => x - y)
    .map((wk) => bucketStats(`Wk ${wk}`, wkMap.get(wk)!));

  // by position
  const posMap = new Map<string, CellLite[]>();
  for (const c of cells) {
    if (!posMap.has(c.pos)) posMap.set(c.pos, []);
    posMap.get(c.pos)!.push(c);
  }
  const byPosition = [...posMap.keys()]
    .sort()
    .map((p) => bucketStats(p, posMap.get(p)!));

  // by magnitude tier (quartiles of projected median)
  const byMagnitude = magnitudeTiers(cells);

  return { byWeek, byMagnitude, byPosition };
}

function magnitudeTiers(cells: CellLite[]): Bucket[] {
  if (cells.length < 4) return [bucketStats("All", cells)];
  const sorted = [...cells].sort((a, b) => a.m - b.m);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))].m;
  const q1 = q(0.25),
    q2 = q(0.5),
    q3 = q(0.75);
  const tiers: Record<string, CellLite[]> = {
    [`Q1 lowest (≤${q1.toFixed(1)})`]: [],
    [`Q2 (${q1.toFixed(1)}–${q2.toFixed(1)})`]: [],
    [`Q3 (${q2.toFixed(1)}–${q3.toFixed(1)})`]: [],
    [`Q4 highest (>${q3.toFixed(1)})`]: [],
  };
  const keys = Object.keys(tiers);
  for (const c of cells) {
    const k = c.m <= q1 ? keys[0] : c.m <= q2 ? keys[1] : c.m <= q3 ? keys[2] : keys[3];
    tiers[k].push(c);
  }
  return keys.map((k) => bucketStats(k, tiers[k]));
}
