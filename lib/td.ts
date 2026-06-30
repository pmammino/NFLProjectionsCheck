import type { Position } from "./types";
import { wilson, type CI } from "./stats";

export interface TDRow {
  type: string; // passTD | rushTD | recTD
  pid: string;
  team: string;
  pos: Position;
  wk: number;
  inj: boolean;
  lf: number; // projected expected TDs — floor
  lm: number; // projected expected TDs — median (the headline forecast)
  lc: number; // projected expected TDs — ceiling
  a: number; // actual TD count
  av: number; // actual opportunity volume (attempts / targets)
  pv: number; // projected median opportunity volume
}

export interface TDFilters {
  weekMin: number;
  weekMax: number;
  positions: Set<Position>;
  teams: Set<string>;
  minVolume: number;
  minProjVolume: number;
  excludeInjury: boolean;
}

export function filterTd(
  td: TDRow[],
  type: string,
  f: TDFilters,
  byWeek = true
): TDRow[] {
  return td.filter((r) => {
    if (r.type !== type) return false;
    if (byWeek && (r.wk < f.weekMin || r.wk > f.weekMax)) return false;
    if (!f.positions.has(r.pos)) return false;
    if (f.teams.size > 0 && !f.teams.has(r.team)) return false;
    if (byWeek && f.excludeInjury && r.inj) return false;
    if (r.av < f.minVolume) return false;
    if (r.pv < f.minProjVolume) return false;
    return true;
  });
}

// Poisson probability of scoring at least one TD given expected count λ.
export const pScore = (lambda: number) => 1 - Math.exp(-Math.max(0, lambda));

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

// Split rows into k groups of (near) equal size by a key, returning the groups
// in ascending key order. Equal-frequency binning keeps every point meaningful.
function quantileBins<T>(rows: T[], key: (r: T) => number, k: number): T[][] {
  const sorted = [...rows].sort((a, b) => key(a) - key(b));
  const bins: T[][] = [];
  const size = Math.ceil(sorted.length / k);
  for (let i = 0; i < sorted.length; i += size) {
    bins.push(sorted.slice(i, i + size));
  }
  return bins.filter((b) => b.length > 0);
}

// ---- Expected-vs-actual TD calibration (assumption-free) ----------------
export interface CountBin {
  meanProjected: number; // mean projected expected TDs in the bin
  meanActual: number; // mean actual TDs observed
  ciLo: number; // 95% CI on mean actual
  ciHi: number;
  n: number;
}

export function countCalibration(rows: TDRow[], k = 8): CountBin[] {
  const bins = quantileBins(rows, (r) => r.lm, k);
  return bins.map((b) => {
    const proj = b.map((r) => r.lm);
    const act = b.map((r) => r.a);
    const m = mean(act);
    // Standard error of the mean for the CI on observed TDs.
    const variance =
      b.length > 1
        ? act.reduce((s, x) => s + (x - m) * (x - m), 0) / (b.length - 1)
        : 0;
    const se = Math.sqrt(variance / b.length);
    return {
      meanProjected: mean(proj),
      meanActual: m,
      ciLo: Math.max(0, m - 1.96 * se),
      ciHi: m + 1.96 * se,
      n: b.length,
    };
  });
}

// ---- Binary "scored a TD" reliability + proper scores -------------------
export interface ProbBin {
  meanPredicted: number; // mean P(>=1 TD) forecast in the bin
  empirical: number; // observed share that scored
  ciLo: number;
  ciHi: number;
  n: number;
}

export interface TDSummary {
  n: number;
  brier: number; // mean (p - y)^2 over scored/not-scored
  brierBaseline: number; // Brier of always predicting the base rate
  brierSkill: number; // 1 - brier/baseline (higher better; 0 = no skill)
  logLoss: number;
  predictedScoreRate: number; // mean forecast P(>=1 TD)
  actualScoreRate: number; // observed share that scored
  projectedTotal: number; // Σ projected expected TDs (median)
  actualTotal: number; // Σ actual TDs
}

export function binaryReliability(rows: TDRow[], k = 8): ProbBin[] {
  const withP = rows.map((r) => ({ p: pScore(r.lm), y: r.a > 0 ? 1 : 0 }));
  const bins = quantileBins(withP, (r) => r.p, k);
  return bins.map((b) => {
    const scored = b.reduce((s, r) => s + r.y, 0);
    const ci: CI = wilson(scored, b.length);
    return {
      meanPredicted: mean(b.map((r) => r.p)),
      empirical: scored / b.length,
      ciLo: ci.lo,
      ciHi: ci.hi,
      n: b.length,
    };
  });
}

// Count-based accuracy for season scope, where "scored >=1 TD" is near-certain
// and the binary framing breaks down. Judges the projected TD *count* directly.
export interface TDCountAccuracy {
  n: number;
  mae: number; // mean |projected median TDs - actual TDs|
  rmse: number;
  spearman: number; // do projections order TD producers correctly?
  projectedTotal: number;
  actualTotal: number;
}

function rankVector(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as [number, number]);
  idx.sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function corr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i];
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  const d = Math.sqrt(vx * vy);
  return d === 0 ? NaN : cov / d;
}

export function tdCountAccuracy(rows: TDRow[]): TDCountAccuracy {
  const n = rows.length;
  if (n === 0)
    return { n: 0, mae: 0, rmse: 0, spearman: NaN, projectedTotal: 0, actualTotal: 0 };
  let ae = 0, se = 0, pt = 0, at = 0;
  for (const r of rows) {
    const d = r.lm - r.a;
    ae += Math.abs(d);
    se += d * d;
    pt += r.lm;
    at += r.a;
  }
  const sp = corr(rankVector(rows.map((r) => r.lm)), rankVector(rows.map((r) => r.a)));
  return {
    n,
    mae: ae / n,
    rmse: Math.sqrt(se / n),
    spearman: sp,
    projectedTotal: pt,
    actualTotal: at,
  };
}

export function tdSummary(rows: TDRow[]): TDSummary {
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0,
      brier: 0,
      brierBaseline: 0,
      brierSkill: 0,
      logLoss: 0,
      predictedScoreRate: 0,
      actualScoreRate: 0,
      projectedTotal: 0,
      actualTotal: 0,
    };
  }
  const eps = 1e-9;
  let brierSum = 0;
  let logSum = 0;
  let pSum = 0;
  let ySum = 0;
  let projTotal = 0;
  let actTotal = 0;
  for (const r of rows) {
    const p = Math.min(1 - eps, Math.max(eps, pScore(r.lm)));
    const y = r.a > 0 ? 1 : 0;
    brierSum += (p - y) ** 2;
    logSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    pSum += p;
    ySum += y;
    projTotal += r.lm;
    actTotal += r.a;
  }
  const baseRate = ySum / n;
  const brier = brierSum / n;
  const brierBaseline = baseRate * (1 - baseRate); // Brier of the no-skill base-rate forecast
  return {
    n,
    brier,
    brierBaseline,
    brierSkill: brierBaseline > 0 ? 1 - brier / brierBaseline : 0,
    logLoss: logSum / n,
    predictedScoreRate: pSum / n,
    actualScoreRate: baseRate,
    projectedTotal: projTotal,
    actualTotal: actTotal,
  };
}
