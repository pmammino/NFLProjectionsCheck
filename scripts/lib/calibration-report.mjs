// Quantile-calibration analysis over the built dashboard dataset. Pure — no
// I/O, and no randomness that isn't seeded — so the CLI stays a thin wrapper
// and two runs on the same data give the same numbers (see the tests).
//
// This answers three questions, in the order you should ask them:
//
//   1. Is each band line where it claims to be? Floor/Median/Ceiling are the
//      25th/50th/75th percentiles, so the share of actuals at or below each
//      should be 25 / 50 / 75%. Anything else is a calibration miss, and the
//      z-score says whether the miss is real or sample noise.
//
//   2. If it isn't, how far would the line have to move? The multiplier that
//      puts a line exactly on target is the matching quantile of
//      (actual / projected line): P(a <= k*f) = 0.25 is the same statement as
//      k = the 25th percentile of a/f. Reported with a bootstrap interval,
//      because a point estimate off a few hundred player-weeks is mostly noise
//      and a bare multiplier invites over-fitting.
//
//   3. Would that move actually have helped? Fit on early weeks, score on
//      later ones. In-sample fit proves nothing — it lands on 25/50/75 by
//      construction — so the holdout is the only line in the report that can
//      argue for shipping a change.
//
// Note what this deliberately does NOT do: it never rewrites a projection. The
// dashboard exists to report the upstream feed's calibration, and a band
// corrected in the measurement layer would report our correction instead. Any
// multiplier that survives the holdout belongs in the betting path (see
// calibration.mjs), not here.

// The percentile each band line claims to be.
export const LINES = [
  ["floor", "f", 0.25],
  ["median", "m", 0.5],
  ["ceiling", "c", 0.75],
];

// |z| bands for the plain-English verdict. Deliberately conservative: this
// report runs 3 thresholds x X metrics, so 2-sigma readings turn up by chance.
const SUGGESTIVE_Z = 1.5;
const SOLID_Z = 2.5;

export function verdictFor(z) {
  const a = Math.abs(z);
  if (a < SUGGESTIVE_Z) return "noise";
  if (a < SOLID_Z) return "suggestive";
  return "solid";
}

// Deterministic PRNG so bootstrap intervals are reproducible. A report whose
// confidence intervals wobble between runs can't be diffed or tested.
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Linear-interpolated quantile of an ALREADY SORTED ascending array.
export function quantileSorted(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

// Wilson score interval for a binomial proportion — the same one the dashboard
// uses, so the report and the UI agree.
export function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

// ---- Fantasy relevance ---------------------------------------------------
// Mirrors isFantasyRelevant in lib/aggregate.ts. Duplicated rather than shared
// because the app is TypeScript and these scripts are plain ESM with no build
// step between them — wilson() is already split the same way.
//
// The rank is by PROJECTED PPR (see build-data.mjs), so the cut uses only what
// was known before kickoff. Ranking on actual points would select the players
// who happened to have a good week and inflate every number here. An unranked
// row counts as not relevant, since the filter is opt-in.
export function isFantasyRelevant(pos, pr, ranks) {
  if (pr === null || pr === undefined) return false;
  const cap = ranks?.[pos];
  return cap === null || cap === undefined ? true : pr <= cap;
}

export function filterFantasyRows(rows, ranks) {
  return rows.filter((r) => isFantasyRelevant(r.pos, r.pr, ranks));
}

// ---- 1. Coverage --------------------------------------------------------
// Share of actuals at or below each band line, against the 25/50/75 it should
// be. `cells` are MetricCell objects: { f, m, c, a, ... }.
export function coverage(cells) {
  const n = cells.length;
  if (n === 0) return null;

  const counts = { floor: 0, median: 0, ceiling: 0 };
  for (const cell of cells) {
    for (const [line, field] of LINES) {
      if (cell.a <= cell[field]) counts[line]++;
    }
  }

  const out = { n, within: (counts.ceiling - counts.floor) / n };
  for (const [line, , target] of LINES) {
    const k = counts[line];
    // Binomial sd under the null that the line is correctly placed.
    const sd = Math.sqrt(n * target * (1 - target));
    out[line] = {
      share: k / n,
      target,
      z: sd > 0 ? (k - n * target) / sd : 0,
      ci: wilson(k, n),
      verdict: verdictFor(sd > 0 ? (k - n * target) / sd : 0),
    };
  }
  return out;
}

// ---- 2. Fitted multipliers ----------------------------------------------
// Percentile bootstrap on a quantile of the ratio distribution.
function bootstrapCI(sortedRatios, p, samples, rng) {
  const n = sortedRatios.length;
  if (n < 2) return { lo: NaN, hi: NaN };
  const draws = [];
  for (let b = 0; b < samples; b++) {
    const resample = new Array(n);
    for (let i = 0; i < n; i++) resample[i] = sortedRatios[(rng() * n) | 0];
    resample.sort((x, y) => x - y);
    draws.push(quantileSorted(resample, p));
  }
  draws.sort((x, y) => x - y);
  return {
    lo: quantileSorted(draws, 0.025),
    hi: quantileSorted(draws, 0.975),
  };
}

// Scaling a line by a multiplier can push it past its neighbour where the band
// is already tight — a floor above its own median is nonsense, and silently
// produces garbage downstream. Count it so the report can warn.
export function countInversions(cells, multipliers) {
  const kf = multipliers.floor?.k ?? 1;
  const km = multipliers.median?.k ?? 1;
  const kc = multipliers.ceiling?.k ?? 1;
  const EPS = 1e-9;
  let inverted = 0;
  for (const cell of cells) {
    if (cell.f * kf > cell.m * km + EPS || cell.m * km > cell.c * kc + EPS) inverted++;
  }
  return inverted;
}

export function fitMultipliers(cells, { samples = 4000, seed = 42 } = {}) {
  const rng = mulberry32(seed);
  const out = {};
  for (const [line, field, p] of LINES) {
    // A zero or negative line makes the ratio meaningless (or infinite), so
    // drop those rows and say how many went.
    const usable = cells.filter((c) => c[field] > 0);
    if (usable.length === 0) {
      out[line] = null;
      continue;
    }
    const ratios = usable.map((c) => c.a / c[field]).sort((x, y) => x - y);
    out[line] = {
      k: quantileSorted(ratios, p),
      ci: bootstrapCI(ratios, p, samples, rng),
      n: usable.length,
      dropped: cells.length - usable.length,
    };
  }
  out.inversions = countInversions(cells, out);
  return out;
}

// Coverage after applying multipliers — used to score a fit on held-out data.
export function coverageWith(cells, multipliers) {
  const k = {
    floor: multipliers.floor?.k ?? 1,
    median: multipliers.median?.k ?? 1,
    ceiling: multipliers.ceiling?.k ?? 1,
  };
  const scaled = cells.map((c) => ({
    ...c,
    f: c.f * k.floor,
    m: c.m * k.median,
    c: c.c * k.ceiling,
  }));
  return coverage(scaled);
}

// Total absolute distance from the 25/50/75 ideal, in percentage points. One
// number to compare an adjusted fit against leaving well alone.
export function coverageError(cov) {
  if (!cov) return NaN;
  return LINES.reduce((sum, [line, , target]) => sum + Math.abs(cov[line].share - target) * 100, 0);
}

// ---- 3. Holdout ----------------------------------------------------------
// Fit the multipliers on the earlier weeks and score them on the later ones.
// `byWeek` is a Map of week -> cells. Returns null when there isn't at least
// one week on each side (season scope has a single pseudo-week, so it opts out).
export function holdout(byWeek, opts = {}) {
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  if (weeks.length < 2) return null;
  const split = opts.split ?? Math.ceil(weeks.length / 2);
  const fitWeeks = weeks.slice(0, split);
  const testWeeks = weeks.slice(split);
  if (fitWeeks.length === 0 || testWeeks.length === 0) return null;

  const gather = (ws) => ws.flatMap((w) => byWeek.get(w) ?? []);
  const fitCells = gather(fitWeeks);
  const testCells = gather(testWeeks);
  if (fitCells.length === 0 || testCells.length === 0) return null;

  const fitted = fitMultipliers(fitCells, opts);
  const baseline = coverage(testCells);
  const adjusted = coverageWith(testCells, fitted);

  const baselineError = coverageError(baseline);
  const adjustedError = coverageError(adjusted);
  return {
    fitWeeks,
    testWeeks,
    fitN: fitCells.length,
    testN: testCells.length,
    fitted,
    baseline,
    adjusted,
    baselineError,
    adjustedError,
    // The whole point of the exercise: did the correction survive contact
    // with data it was not fitted on?
    improved: adjustedError < baselineError,
  };
}

// ---- Assembly ------------------------------------------------------------
// Group a dataset's rows into per-metric cell lists, and per-metric-per-week
// for the holdout.
export function cellsByMetric(rows, metrics) {
  const out = new Map();
  for (const meta of metrics) {
    const cells = [];
    const byWeek = new Map();
    for (const row of rows) {
      const cell = row.m[meta.key];
      if (!cell) continue;
      cells.push(cell);
      if (!byWeek.has(row.wk)) byWeek.set(row.wk, []);
      byWeek.get(row.wk).push(cell);
    }
    if (cells.length > 0) out.set(meta.key, { meta, cells, byWeek });
  }
  return out;
}

// One metric's full report.
export function analyzeMetric({ meta, cells, byWeek }, opts = {}) {
  return {
    key: meta.key,
    label: meta.label,
    group: meta.group,
    kind: meta.kind,
    coverage: coverage(cells),
    fit: fitMultipliers(cells, opts),
    holdout: opts.holdout === false ? null : holdout(byWeek, opts),
  };
}

export function analyze(rows, metrics, opts = {}) {
  const grouped = cellsByMetric(rows, metrics);
  const only = opts.only instanceof Set ? opts.only : null;
  const out = [];
  for (const [key, entry] of grouped) {
    if (only && !only.has(key)) continue;
    out.push(analyzeMetric(entry, opts));
  }
  return out;
}
