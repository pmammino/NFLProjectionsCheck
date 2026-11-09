// The Tweedie spread: how wide a projection's outcomes really are, learned from
// actuals, and the P(over) it gives. The production counterpart of the research
// in dist-lab.mjs (see data/pricing/{season}/dist-lab.md for the evidence).
//
// ---------------------------------------------------------------------------
// What it replaces, and what it keeps
// ---------------------------------------------------------------------------
// probability.mjs splines two normal halves through Floor/Median/Ceiling, so the
// SPREAD of every price is whatever the projection's band says. On the 2026
// boards that band is too narrow (actual outcomes spread 1.2-1.7x as far), and
// no shape fitted to the same three points repairs it.
//
// This keeps the projection's LOCATION and replaces its SPREAD:
//   - the mean is that of a gamma fitted to Floor/Median/Ceiling, so the
//     projection's level and its skew still decide where the mass sits;
//   - the variance is  phi * mean^p , with (phi, p) fitted per stat on the
//     player-weeks BEFORE the week being priced (never the week itself);
//   - the shape is compound Poisson-gamma (Tweedie, 1 < p < 2): a Poisson
//     number of opportunities, each paying a gamma amount, with a point mass at
//     zero that a normal or a gamma lacks.
//
// It is a drop-in for probOverContinuous: where it cannot price (no law fitted
// yet, a degenerate band) it returns the long-standing price, so turning it on
// can only change a number where there is evidence to change it.
//
// Pure apart from fitSpreadLaws(), which reads snapshots and actuals.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./csv.mjs";
import { STAT_DEFS } from "./markets.mjs";
import { MIN_PROJECTION } from "./calibration.mjs";
import { actualFor } from "./pricing-dataset.mjs";
import { loadSnapshot } from "./median-correction.mjs";
import { projectionFor } from "./lines-index.mjs";
import { probOverContinuous } from "./probability.mjs";
import { fitGammaToQuantiles, fitLaw, tweedieCdf, probOver, MIN_LAW_PAIRS } from "./dist-lab.mjs";

// The stats the two-piece normal prices: totals and counts, not the Poisson ones.
export const SPREAD_STATS = ["passYds", "passAtt", "completions", "rushYds", "rushAtt", "receptions", "recYds"];

export const SPREAD_MODELS = ["off", "tweedie"];

// The mean of the gamma through (F, .25), (M, .5), (C, .75), unshifted. Falls
// back to the median when the three points cannot be fitted.
const meanCache = new Map();
export function projectionMean({ F, M, C }) {
  const key = `${F}|${M}|${C}`;
  let v = meanCache.get(key);
  if (v === undefined) {
    const fit = fitGammaToQuantiles([{ x: F, p: 0.25 }, { x: M, p: 0.5 }, { x: C, p: 0.75 }]);
    v = fit && fit.mean > 0 ? fit.mean : M;
    meanCache.set(key, v);
  }
  return v;
}

// P(actual > line) under the Tweedie spread. `law` is { phi, p } for the stat
// or null. Returns the two-piece-normal price when there is no law or the band
// is unusable, so the caller never has to branch.
const cdfCache = new Map();
export function probOverTweedie(line, { F, M, C }, law) {
  if (!law || !(law.phi > 0) || !(law.p > 1 && law.p < 2) || !(F > 0 && M > 0 && C > 0)) {
    return probOverContinuous(line, F, M, C);
  }
  const mu = projectionMean({ F, M, C });
  const key = `${mu}|${law.phi}|${law.p}`;
  let cdf = cdfCache.get(key);
  if (!cdf) {
    cdf = tweedieCdf(mu, law.phi, law.p);
    if (cdfCache.size > 5000) cdfCache.clear();
    cdfCache.set(key, cdf);
  }
  // Same bounds the rest of the price path keeps its probabilities inside.
  return Math.min(0.999, Math.max(0.001, probOver(cdf, line)));
}

// Every (projection, actual) pair for weeks STRICTLY BEFORE `beforeWeek`, per
// stat: one record per player-week-stat with a usable band. Not a market row, so
// a ladder of 20 rungs is still one observation and the fit is not weighted by
// how many lines a book listed.
export function loadSpreadPairs({ dataDir = "data", season, beforeWeek }) {
  const actualsDir = join(dataDir, "actuals", String(season));
  if (!existsSync(actualsDir)) return { pairs: [], weeksUsed: [] };
  const weeks = readdirSync(actualsDir)
    .map((f) => f.match(/^week-(\d+)\.csv$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((w) => beforeWeek === undefined || w < beforeWeek)
    .sort((a, b) => a - b);

  const pairs = [];
  const weeksUsed = [];
  for (const week of weeks) {
    const snap = loadSnapshot(dataDir, season, week);
    if (!snap) continue;
    const byPlayer = new Map(readCsv(join(actualsDir, `week-${String(week).padStart(2, "0")}.csv`)).map((r) => [String(r.PlayerID), r]));
    let any = false;
    for (const playerId of snap.keys()) {
      const row = byPlayer.get(String(playerId));
      if (!row) continue;
      for (const stat of SPREAD_STATS) {
        const a = actualFor(row, stat);
        const pts = projectionFor(snap, playerId, stat);
        if (a === null || !pts || !(pts.F > 0 && pts.M > 0 && pts.C > 0) || pts.M < (MIN_PROJECTION[stat] ?? 0)) continue;
        pairs.push({ week, stat, a, mu: projectionMean(pts) });
        any = true;
      }
    }
    if (any) weeksUsed.push(week);
  }
  return { pairs, weeksUsed };
}

// The law per stat as it stood going INTO `beforeWeek`. A stat with too little
// history is null and prices exactly as before.
//   { laws: { passYds: { phi, p, n } | null, ... }, weeksUsed }
export function fitSpreadLaws({ dataDir = "data", season, beforeWeek }) {
  const { pairs, weeksUsed } = loadSpreadPairs({ dataDir, season, beforeWeek });
  const laws = {};
  for (const stat of SPREAD_STATS) {
    const mine = pairs.filter((p) => p.stat === stat).map((p) => ({ mu: p.mu, a: p.a }));
    const fit = mine.length >= MIN_LAW_PAIRS ? fitLaw(mine, "tweedie") : null;
    laws[stat] = fit ? { phi: fit.phi, p: fit.p, n: fit.n } : null;
  }
  return { laws, weeksUsed };
}

export const lawFor = (laws, stat) => laws?.[stat] ?? null;

// One line per stat for the capture log.
export function formatLaws(laws) {
  return SPREAD_STATS.map((s) => {
    const l = laws?.[s];
    if (!l) return `${s.padEnd(12)} not fitted — priced as before`;
    return `${s.padEnd(12)} Var = ${l.phi.toFixed(2)} * mean^${l.p.toFixed(2)}   (${l.n} player-weeks)`;
  });
}

export const isSpreadStat = (stat) => SPREAD_STATS.includes(stat) && STAT_DEFS[stat]?.kind === "continuous";
