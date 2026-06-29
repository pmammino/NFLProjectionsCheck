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
  av: number; // opportunity volume (attempts / targets)
}

export interface TDFilters {
  weekMin: number;
  weekMax: number;
  positions: Set<Position>;
  teams: Set<string>;
  minVolume: number;
  excludeInjury: boolean;
}

export function filterTd(
  td: TDRow[],
  type: string,
  f: TDFilters
): TDRow[] {
  return td.filter((r) => {
    if (r.type !== type) return false;
    if (r.wk < f.weekMin || r.wk > f.weekMax) return false;
    if (!f.positions.has(r.pos)) return false;
    if (f.teams.size > 0 && !f.teams.has(r.team)) return false;
    if (f.excludeInjury && r.inj) return false;
    if (r.av < f.minVolume) return false;
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
