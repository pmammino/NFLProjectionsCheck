// How wide the projection's Floor-to-Ceiling band should be.
//
// probability.mjs treats Floor/Median/Ceiling as the 25th/50th/75th percentiles
// and splines two normal halves through them. Two things go wrong with the
// tails of that distribution, and neither is the centre (median-correction.mjs
// handles the centre for the two stats where it is biased):
//
//   - the band is too NARROW. On the 2026 live boards the projection priced
//     recYds overs it called 1% at about 4% and 9% at about 17%, and the
//     alternate-line ladders (lines out to 240 yards) make that visible in a
//     way a single near-the-money line never could. Fitted weeks 1-5, the best
//     single multiplier on the floor and ceiling distances from the median was
//     about 1.6 for yardage and 1.2 for counts, above 1 in every stat and in
//     every week that had enough ladder to measure.
//   - it is NOT a fixed multiple. The same fit by week ranged 1.3 to 2.5, and a
//     per-stat fit on weeks 1-4 (2.5 for passYds and recYds) priced week 5
//     WORSE than not fitting at all. So the fit below is deliberately cautious:
//     pooled across a group of stats, marked down by its own standard error,
//     capped, gated on a clustered improvement, and always "as of" a week.
//
// What it is for: the projection's own probability, on every rung. What it is
// NOT: evidence that the projection beats the book. The projection's share of
// the price is fitted against outcomes separately (source-weights.mjs) and
// stays zero near 50/50 whatever the spread; this module only makes the
// projection a better-calibrated source for that fit to judge.
//
// Pure, no I/O. Tested in spread-fit.test.mjs.

import { probOverContinuous } from "./probability.mjs";

// Yardage stats share a skew problem; counts (attempts, receptions, completions)
// share a milder one. A per-stat fit is too noisy at this sample size.
export const SPREAD_GROUPS = {
  yards: ["passYds", "rushYds", "recYds"],
  counts: ["passAtt", "completions", "rushAtt", "receptions"],
};
export const groupOf = (stat) => Object.keys(SPREAD_GROUPS).find((g) => SPREAD_GROUPS[g].includes(stat)) ?? null;

// A multiplier on (median - floor) and (ceiling - median). 1 = as projected.
export const SPREAD_GRID = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2, 2.25, 2.5];
// Never widen past this, whatever a thin sample says (week 4 alone said 2.5).
export const MAX_SPREAD = 1.6;
// Player-weeks a fit may rest on, and the clustered z its log-loss gain must clear.
export const MIN_SPREAD_CLUSTERS = 150;
export const SPREAD_SOLID_Z = 2;
// A fit is marked down by this many bootstrap standard errors (the share fit
// does the same with SHARE_CAUTION).
export const SPREAD_CAUTION = 1;
export const BOOTSTRAP_DRAWS = 100;

const clampP = (p) => Math.min(0.999, Math.max(0.001, p));

// F/M/C with the band widened about the median.
export function widenPoints({ F, M, C }, w) {
  if (!(w > 0) || w === 1) return { F, M, C };
  return { F: M - w * (M - F), M, C: M + w * (C - M) };
}

// P(over) under a widened band.
export function widenedProb(line, pts, w) {
  const p = widenPoints(pts, w);
  return probOverContinuous(line, p.F, p.M, p.C);
}

// A row is { line, F, M, C, y, cluster } with y in {0, 1}; rows with a
// non-positive point are not priced and are skipped.
const usable = (rows) =>
  rows.filter((r) => (r.y === 0 || r.y === 1) && r.F > 0 && r.M > 0 && r.C > 0 && Number.isFinite(r.line));

function logLossAt(rows, w) {
  let s = 0;
  for (const r of rows) {
    const p = clampP(widenedProb(r.line, r, w));
    s -= r.y ? Math.log(p) : Math.log(1 - p);
  }
  return s / rows.length;
}

// Best multiplier on the grid by log-loss (ties go to the narrower).
export function bestSpread(rows, grid = SPREAD_GRID) {
  let best = null;
  for (const w of grid) {
    const l = logLossAt(rows, w);
    if (!best || l < best.ll - 1e-12) best = { w, ll: l };
  }
  return best;
}

// A deterministic draw, so a report is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Clustered (player-week) paired log-loss difference of `w` against 1, as a
// per-row mean and a z. Negative mean = widening is better.
export function logLossGain(rows, w) {
  const by = new Map();
  let n = 0;
  let total = 0;
  for (const r of rows) {
    const p0 = clampP(widenedProb(r.line, r, 1));
    const p1 = clampP(widenedProb(r.line, r, w));
    const d = (r.y ? -Math.log(p1) : -Math.log(1 - p1)) - (r.y ? -Math.log(p0) : -Math.log(1 - p0));
    by.set(r.cluster, (by.get(r.cluster) ?? 0) + d);
    total += d;
    n++;
  }
  if (n < 2) return { n, mean: null, z: null };
  const mean = total / n;
  const G = by.size;
  if (G < 2) return { n, mean, z: null };
  let ss = 0;
  for (const v of by.values()) ss += (v - (mean * n) / G) ** 2;
  const se = Math.sqrt((ss * G) / (G - 1)) / n;
  return { n, mean, z: se > 0 ? mean / se : null };
}

// Fit one group's multiplier. Returns the raw best, its bootstrap spread, the
// cautious number actually used, and why it was or was not applied.
//
//   w      the multiplier to use (1 when not applied)
//   raw    the best multiplier on the grid, before any caution
//   se     bootstrap standard error of `raw`, resampling whole player-weeks
export function fitSpread(rows, { grid = SPREAD_GRID, cap = MAX_SPREAD, caution = SPREAD_CAUTION, minClusters = MIN_SPREAD_CLUSTERS, solidZ = SPREAD_SOLID_Z, draws = BOOTSTRAP_DRAWS, seed = 17 } = {}) {
  const data = usable(rows);
  const clusters = new Set(data.map((r) => r.cluster)).size;
  const none = (reason) => ({ n: data.length, clusters, raw: null, se: null, w: 1, applied: false, reason, gain: null, z: null });
  if (clusters < minClusters) return none("too-few-player-weeks");

  const best = bestSpread(data, grid);
  const gain = logLossGain(data, best.w);
  if (best.w <= 1) return { ...none("no-widening-wanted"), raw: best.w, gain: gain.mean, z: gain.z };

  const by = new Map();
  for (const r of data) {
    if (!by.has(r.cluster)) by.set(r.cluster, []);
    by.get(r.cluster).push(r);
  }
  const keys = [...by.keys()];
  const rnd = lcg(seed);
  const ws = [];
  for (let b = 0; b < draws; b++) {
    const sample = [];
    for (let i = 0; i < keys.length; i++) sample.push(...by.get(keys[Math.floor(rnd() * keys.length)]));
    ws.push(bestSpread(sample, grid).w);
  }
  const m = ws.reduce((a, x) => a + x, 0) / ws.length;
  const se = Math.sqrt(ws.reduce((a, x) => a + (x - m) ** 2, 0) / (ws.length - 1));

  const out = { n: data.length, clusters, raw: best.w, se, gain: gain.mean, z: gain.z };
  if (!(gain.z !== null && gain.z <= -solidZ)) return { ...out, w: 1, applied: false, reason: "not-solid" };
  const w = Math.min(cap, Math.max(1, best.w - caution * se));
  return { ...out, w, applied: w > 1, reason: w > 1 ? "applied" : "no-widening-wanted" };
}

// Fit every group: { [group]: fit }. `rowsByStat` is a Map or object of stat -> rows.
export function fitSpreads(rowsByStat, opts = {}) {
  const entries = rowsByStat instanceof Map ? [...rowsByStat] : Object.entries(rowsByStat ?? {});
  const out = {};
  for (const g of Object.keys(SPREAD_GROUPS)) {
    const rows = entries.filter(([stat]) => SPREAD_GROUPS[g].includes(stat)).flatMap(([, r]) => r);
    out[g] = fitSpread(rows, opts);
  }
  return out;
}

// The multiplier in force for a stat under a set of fits, or 1.
export function spreadFor(fits, stat) {
  const g = groupOf(stat);
  const f = g ? fits?.[g] : null;
  return f?.applied ? f.w : 1;
}

// F/M/C widened for one stat. Unchanged when no fit applies, so callers need no
// branch.
export function spreadAdjustedPoints(pts, fits, stat) {
  return widenPoints(pts, spreadFor(fits, stat));
}

// "As of a week": fit only on rows from strictly earlier weeks.
export function spreadsAsOf(rows, week, opts = {}) {
  const byStat = new Map();
  for (const r of rows) {
    if (!(r.week < week)) continue;
    if (!byStat.has(r.stat)) byStat.set(r.stat, []);
    byStat.get(r.stat).push(r);
  }
  return fitSpreads(byStat, opts);
}
