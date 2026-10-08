// Re-centring the projected Floor/Median/Ceiling for the stats where the
// "Median" is not one. The maths is pure; the only I/O is loadTrainingPairs()
// at the bottom, isolated so everything above it is unit tested directly
// (see median-correction.test.mjs).
//
// ---------------------------------------------------------------------------
// The finding this exists for
// ---------------------------------------------------------------------------
// probability.mjs treats Floor/Median/Ceiling as the 25th/50th/75th
// percentiles. For rushing and receiving YARDAGE the middle one is not the
// 50th percentile. Across every player-week in 2026 weeks 1-4 the share of
// actuals landing at or below the projected "Median" was
//
//     rushYds   63-64%   (z = 5.2)       median(actual / M) = 0.80
//     recYds    56%      (z = 2.9)       median(actual / M) = 0.88
//     passYds   50.4%                    median(actual / M) = 0.99
//
// against a 50% target — while the TOTALS are about right (sum actual / sum M
// is 0.95 for rushYds, 1.05 for recYds, 1.00 for passYds). A middle value
// that is roughly right on average but too high as a median is what an
// expected value of a right-skewed stat looks like, which is the working
// explanation. It has not been checked against RotoWire's own definition.
//
// It is NOT the low-volume problem calibration.mjs already guards. Only 6-9%
// of those rows are zeros, and rushYds sits at 60-65% below its median in
// every third of projected volume.
//
// The effect on pricing is a tilt in P(over), concentrated in exactly those
// stats: against the book, the projection prices recYds overs +5.7 +/- 0.6
// points high and rushYds overs +5.0 +/- 1.1, and passing not at all.
//
// ---------------------------------------------------------------------------
// The correction, and the three rules that keep it honest
// ---------------------------------------------------------------------------
// Each of the three points is rescaled by the multiplier that puts it on its
// target quantile: kF is the 25th percentile of actual/F, kM the 50th of
// actual/M, kC the 75th of actual/C. That is the same fit calibration-report
// section 2 prints, so the two cannot disagree about what a multiplier is.
//
//  1. ALLOWLIST. Only stats with a mechanism are eligible (CORRECTABLE_STATS).
//     A data-driven gate alone is not enough, and the data showed why: on
//     the week-3 refit passAtt cleared the z bar (z = 2.5), and applying it
//     took near-the-money Brier from 0.2332 to 0.2472 — worse, because
//     there was no bias, only a noisy week. The repo's own holdout says the
//     same for every passing metric: the correction made held-out weeks
//     worse for passAtt, passYards and compPct.
//
//  2. SIGNIFICANCE. Within the allowlist a correction applies only when the
//     misplacement of the median is solid (|z| >= SOLID_Z) on at least
//     MIN_TRAIN_N player-weeks. Below that it is noise, and fitting noise is
//     how the sigma multiplier was rejected in the first place.
//
//  3. NO LOOK-AHEAD. A fit is always "as of" a week and uses only weeks
//     strictly before it. Pricing week W with a multiplier that saw week W's
//     result would be the same mistake as grading a bet with the answer in
//     hand, and a backfill of an old week is exactly where it would sneak in.
//
// What this is NOT: it does not create an edge. It removes a tilt, which
// removes spurious over edges on two stats. Measured walk-forward near the
// money it closes about a fifth of the projection's gap to the market (more
// for recYds and rushYds, nothing for passing); the rest is that the
// projection carries less information than the book. Treat it as hygiene.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./csv.mjs";
import { STAT_DEFS } from "./markets.mjs";
import { MIN_PROJECTION } from "./calibration.mjs";

// Stats whose "Median" is plausibly a mean of a right-skewed outcome. Adding
// one is a claim about mechanism, and should come with the evidence above.
export const CORRECTABLE_STATS = ["rushYds", "recYds"];

// |z| of P(actual <= M) against 0.5 that counts as solid. The calibration
// report calls 2.5 "solid" and is deliberately conservative because it runs
// three thresholds across many metrics; the same bar is reused so the two
// agree about what is real.
export const SOLID_Z = 2.5;

// Fewest player-weeks a fit may rest on. Early in a season a stat has a few
// dozen rows and a z of 2.5 is easy to hit by luck; this is the floor under
// that.
export const MIN_TRAIN_N = 100;

// A multiplier outside its range is not a correction, it is a malfunction (a
// unit mismatch, a corrupt snapshot). It is refused rather than clamped: a
// clamped number looks like a result.
//
// The ranges differ on purpose. The MEDIAN multiplier is the thing being
// corrected and is tightly bounded. The FLOOR and CEILING multipliers shape
// the tails and are far noisier: 25th percentile of actual/F is dragged down by
// every near-zero receiving game, and on the 2026 data recYds' kF sat at
// 0.59, 0.57, 0.55 and, fitted on week 1 alone, 0.48. A single shared bound of
// [0.5, 1.5] refused the whole recYds correction on that last fit, even though
// its median multiplier was a stable 0.83-0.86 with z up to 3.7 — the noisiest
// of three numbers vetoing the most reliable one.
export const MEDIAN_BOUNDS = [0.5, 1.5];
export const TAIL_BOUNDS = [0.25, 2.0];

// --- numerics -----------------------------------------------------------------

// Linear-interpolated quantile of an unsorted array.
export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// --- the fit -------------------------------------------------------------------

// `pairs` are { F, M, C, actual } for ONE stat. Rows with a non-positive point
// are skipped: a ratio against zero is undefined, and those are the rows the
// support floor already refuses to price.
//
// Returns null when there is nothing to fit.
export function fitStat(pairs) {
  const usable = (pairs ?? []).filter(
    (p) =>
      Number.isFinite(p.actual) &&
      p.F > 0 &&
      p.M > 0 &&
      p.C > 0 &&
      Number.isFinite(p.F) &&
      Number.isFinite(p.M) &&
      Number.isFinite(p.C)
  );
  const n = usable.length;
  if (n === 0) return null;

  const belowM = usable.filter((p) => p.actual <= p.M).length;
  const pBelowM = belowM / n;
  return {
    n,
    pBelowM,
    // How many standard errors P(actual <= M) sits from the 50% it should be.
    z: (pBelowM - 0.5) / Math.sqrt(0.25 / n),
    kF: quantile(usable.map((p) => p.actual / p.F), 0.25),
    kM: quantile(usable.map((p) => p.actual / p.M), 0.5),
    kC: quantile(usable.map((p) => p.actual / p.C), 0.75),
  };
}

// Should this fit be applied? Returns { applied, reason } — the reason is part
// of the result because "not applied" has four different causes and a report
// that cannot say which is useless.
export function assess(stat, fit, { correctable = CORRECTABLE_STATS } = {}) {
  if (!correctable.includes(stat)) return { applied: false, reason: "not-correctable" };
  if (!fit || fit.n < MIN_TRAIN_N) return { applied: false, reason: "too-few-rows" };
  const within = (k, [lo, hi]) => Number.isFinite(k) && k >= lo && k <= hi;
  if (!within(fit.kM, MEDIAN_BOUNDS) || !within(fit.kF, TAIL_BOUNDS) || !within(fit.kC, TAIL_BOUNDS)) {
    return { applied: false, reason: "implausible" };
  }
  if (!(Math.abs(fit.z) >= SOLID_Z)) return { applied: false, reason: "not-solid" };
  return { applied: true, reason: "applied" };
}

// Fit every stat in `pairsByStat` (a Map or object of stat -> pairs) and decide
// each. Returns { [stat]: { ...fit, applied, reason } }; a stat with no usable
// rows is reported, not omitted, so a report never silently loses a row.
export function fitCorrection(pairsByStat, opts = {}) {
  const entries = pairsByStat instanceof Map ? [...pairsByStat] : Object.entries(pairsByStat ?? {});
  const out = {};
  for (const [stat, pairs] of entries) {
    const fit = fitStat(pairs);
    out[stat] = { n: 0, ...(fit ?? {}), ...assess(stat, fit, opts) };
  }
  return out;
}

// --- applying it -----------------------------------------------------------------

// The multiplier on the median actually in force for a stat, or null. This is
// what a ledger row records, so "was this priced with a correction, and by how
// much" is answerable without re-running anything.
export function multiplierFor(correction, stat) {
  const c = correction?.[stat];
  return c?.applied ? c.kM : null;
}

// Rescaled F/M/C for one player-week. Returns the input unchanged when no
// correction applies, so callers need no branch.
//
// The three multipliers are fitted independently and can disagree about
// ORDER on a thin sample (the report counts those as "inversions"). A
// distribution whose floor sits above its median is not one, so the points
// are re-sorted rather than trusted.
export function adjustedPoints({ F, M, C }, correction, stat) {
  const c = correction?.[stat];
  if (!c?.applied) return { F, M, C };
  const [f, m, cc] = [F * c.kF, M * c.kM, C * c.kC].sort((a, b) => a - b);
  return { F: f, M: m, C: cc };
}

// --- presentation ------------------------------------------------------------------

const REASON_TEXT = {
  applied: "APPLIED",
  "not-correctable": "not eligible (no mechanism for a skewed median)",
  "too-few-rows": `too few rows (< ${MIN_TRAIN_N})`,
  "not-solid": `not significant (|z| < ${SOLID_Z})`,
  implausible: "implausible multiplier — refused",
};

// One line per stat, shared by the capture log and the report so the two cannot
// drift. `fits` is fitCorrection()'s result.
export function formatFits(fits) {
  const rows = Object.entries(fits ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return rows.map(([stat, f]) => {
    const body = f.n
      ? `n=${String(f.n).padStart(5)}  P(<=M) ${(f.pBelowM * 100).toFixed(1).padStart(5)}%  z ${f.z.toFixed(1).padStart(5)}  ` +
        `kF/kM/kC ${[f.kF, f.kM, f.kC].map((k) => (Number.isFinite(k) ? k.toFixed(2) : "  ? ")).join("/")}`
      : `n=    0  ${" ".repeat(48)}`;
    return `${stat.padEnd(12)} ${body}  ${REASON_TEXT[f.reason] ?? f.reason}`;
  });
}

// --- evaluation --------------------------------------------------------------------

// Walk-forward: for each test week, fit on strictly earlier weeks only and
// re-price that week's markets.
//
// `samples`  { week, playerId, stat, line, pProj, ... } — one per market.
// `pairsByWeek`  Map week -> Map stat -> pairs, from loadTrainingPairs.
// `fmcOf(sample)`  the sample's own { F, M, C }, or null.
// `priceFn(line, f, m, c)`  P(over); injected so this stays free of the model.
//
// Returns the samples with `pCorrected`, `applied` and `multiplier` added.
// `pRecomputed` is the probability rebuilt from F/M/C with NO correction; it
// should equal `pProj` to storage precision, and a row where it does not is a
// row whose stored price came from a different projection — flagged
// `consistent: false` so a report can exclude it rather than blend two
// projections into one comparison.
export function evaluateWalkForward(samples, { pairsByWeek, fmcOf, priceFn, tolerance = 1e-3, correctable }) {
  const weeks = [...new Set(samples.map((s) => s.week))].sort((a, b) => a - b);
  const fitsByWeek = new Map();
  for (const w of weeks) {
    const pooled = new Map();
    for (const [pw, byStat] of pairsByWeek) {
      if (pw >= w) continue; // strictly before: no look-ahead
      for (const [stat, pairs] of byStat) {
        if (!pooled.has(stat)) pooled.set(stat, []);
        pooled.get(stat).push(...pairs);
      }
    }
    fitsByWeek.set(w, fitCorrection(pooled, { correctable }));
  }

  return samples.map((s) => {
    const fmc = fmcOf(s);
    const fits = fitsByWeek.get(s.week);
    if (!fmc) return { ...s, pCorrected: s.pProj, pRecomputed: null, applied: false, multiplier: null, consistent: false };
    const pRecomputed = priceFn(s.line, fmc.F, fmc.M, fmc.C);
    const adj = adjustedPoints(fmc, fits, s.stat);
    const applied = !!fits?.[s.stat]?.applied;
    return {
      ...s,
      pRecomputed,
      pCorrected: applied ? priceFn(s.line, adj.F, adj.M, adj.C) : s.pProj,
      applied,
      multiplier: multiplierFor(fits, s.stat),
      consistent: Math.abs(pRecomputed - s.pProj) <= tolerance,
    };
  });
}

// --- I/O (isolated) ------------------------------------------------------------------

const sumCols = (row, cols) => cols.reduce((s, c) => s + (Number(row?.[c]) || 0), 0);

// Stats this module can fit: continuous ones with an actuals column, since the
// pair needs an outcome to compare against.
export function fittableStats() {
  return Object.keys(STAT_DEFS).filter(
    (k) => STAT_DEFS[k].kind === "continuous" && STAT_DEFS[k].actualCols.length > 0
  );
}

export function actualFor(actualsRow, stat) {
  const cols = STAT_DEFS[stat]?.actualCols;
  if (!cols?.length || !actualsRow) return null;
  let total = 0;
  for (const c of cols) {
    const raw = actualsRow[c];
    if (raw === undefined || raw === null || String(raw).trim() === "") return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    total += v;
  }
  return total;
}

const weekFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .map((f) => f.match(/^week-(\d+)\.csv$/))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b)
    : [];

// The F/M/C snapshot of one week, as Map playerId -> { F, M, C } rows.
export function loadSnapshot(dataDir, season, week) {
  const path = join(dataDir, "projections", String(season), `week-${String(week).padStart(2, "0")}.csv`);
  if (!existsSync(path)) return null;
  const by = new Map();
  for (const r of readCsv(path)) {
    if (!by.has(r.PlayerID)) by.set(r.PlayerID, {});
    by.get(r.PlayerID)[r.Split] = r;
  }
  return by;
}

// Every (projection, actual) pair for weeks STRICTLY BEFORE `beforeWeek` that
// have both a snapshot and actuals. Returns { pairsByWeek, weeksUsed } with
// pairsByWeek: Map week -> Map stat -> pairs.
//
// Built from the projection snapshots and the actuals directly — not from the
// odds captures — so the fit depends on neither which books quoted a player
// nor on a capture having run. Rows below the stat's support floor
// (MIN_PROJECTION) are excluded: they are the ones the pricing path declines
// to price, and their point mass at zero is a different problem that a
// multiplier cannot fix.
export function loadTrainingPairs({ dataDir = "data", season, beforeWeek, stats = fittableStats() }) {
  const actualsWeeks = new Set(weekFiles(join(dataDir, "actuals", String(season))));
  const pairsByWeek = new Map();
  const weeksUsed = [];

  for (const week of weekFiles(join(dataDir, "projections", String(season)))) {
    if (beforeWeek !== undefined && week >= beforeWeek) continue;
    if (!actualsWeeks.has(week)) continue;
    const snap = loadSnapshot(dataDir, season, week);
    if (!snap) continue;
    const actuals = new Map(
      readCsv(join(dataDir, "actuals", String(season), `week-${String(week).padStart(2, "0")}.csv`)).map((r) => [
        String(r.PlayerID),
        r,
      ])
    );

    const byStat = new Map(stats.map((s) => [s, []]));
    for (const [playerId, splits] of snap) {
      if (!splits.F || !splits.M || !splits.C) continue;
      const row = actuals.get(String(playerId));
      if (!row) continue; // see README: absent from the feed is NOT the same as zero
      for (const stat of stats) {
        const actual = actualFor(row, stat);
        if (actual === null) continue;
        const cols = STAT_DEFS[stat].projCols;
        const M = sumCols(splits.M, cols);
        if (M < (MIN_PROJECTION[stat] ?? 0)) continue;
        byStat.get(stat).push({
          week,
          playerId: String(playerId),
          F: sumCols(splits.F, cols),
          M,
          C: sumCols(splits.C, cols),
          actual,
        });
      }
    }
    pairsByWeek.set(week, byStat);
    weeksUsed.push(week);
  }
  return { pairsByWeek, weeksUsed };
}

// The decision the capture path actually uses: fit on every completed week
// before `beforeWeek`. { fits, weeksUsed }.
export function fitFromData({ dataDir = "data", season, beforeWeek, correctable } = {}) {
  const { pairsByWeek, weeksUsed } = loadTrainingPairs({ dataDir, season, beforeWeek });
  const pooled = new Map();
  for (const byStat of pairsByWeek.values()) {
    for (const [stat, pairs] of byStat) {
      if (!pooled.has(stat)) pooled.set(stat, []);
      pooled.get(stat).push(...pairs);
    }
  }
  return { fits: fitCorrection(pooled, { correctable }), weeksUsed };
}
