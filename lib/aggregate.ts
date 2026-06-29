import type { Dataset, MetricCell, MetricMeta, Position, Row } from "./types";

export interface Filters {
  weekMin: number;
  weekMax: number;
  positions: Set<Position>;
  teams: Set<string>; // empty = all
  minVolume: number; // min actual volume
  minProjVolume: number; // min projected (median) volume
  excludeInjury: boolean;
}

// A cell qualifies when both its actual and projected volume clear the gates.
export function passesVol(
  c: MetricCell,
  minVolume: number,
  minProjVolume: number
): boolean {
  return c.av >= minVolume && c.pv >= minProjVolume;
}

export function filterRows(ds: Dataset, f: Filters): Row[] {
  return ds.rows.filter((r) => {
    if (r.wk < f.weekMin || r.wk > f.weekMax) return false;
    if (!f.positions.has(r.pos)) return false;
    if (f.teams.size > 0 && !f.teams.has(r.team)) return false;
    if (f.excludeInjury && r.inj) return false;
    return true;
  });
}

export interface MetricSummary {
  key: string;
  meta: MetricMeta;
  n: number;
  withinRate: number; // share of actuals inside [floor, ceiling]
  belowRate: number; // actual below floor
  aboveRate: number; // actual above ceiling
  meanErr: number; // mean(actual - median), raw units
  medianBias: number | null; // median of % error vs projection median (robust)
  mae: number; // mean abs(actual - median), raw units
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarize(
  rows: Row[],
  metric: MetricMeta,
  minVolume: number,
  minProjVolume = 0
): MetricSummary {
  let n = 0;
  let within = 0;
  let below = 0;
  let above = 0;
  let errSum = 0;
  let absSum = 0;
  const pes: number[] = [];

  for (const r of rows) {
    if (!metric.positions.includes(r.pos)) continue;
    const c = r.m[metric.key];
    if (!c) continue;
    if (!passesVol(c, minVolume, minProjVolume)) continue;
    n++;
    if (c.in) within++;
    else if (c.a < Math.min(c.f, c.c)) below++;
    else above++;
    errSum += c.err;
    absSum += Math.abs(c.err);
    if (c.pe !== null) pes.push(c.pe);
  }

  return {
    key: metric.key,
    meta: metric,
    n,
    withinRate: n ? within / n : 0,
    belowRate: n ? below / n : 0,
    aboveRate: n ? above / n : 0,
    meanErr: n ? errSum / n : 0,
    medianBias: median(pes),
    mae: n ? absSum / n : 0,
  };
}

export function summarizeAll(
  rows: Row[],
  metrics: MetricMeta[],
  minVolume: number,
  minProjVolume = 0
): MetricSummary[] {
  return metrics
    .map((m) => summarize(rows, m, minVolume, minProjVolume))
    .filter((s) => s.n > 0);
}

// Scatter points (projected median vs actual) for one metric.
export interface ScatterPoint {
  pid: string;
  wk: number;
  team: string;
  median: number;
  actual: number;
  floor: number;
  ceiling: number;
  within: boolean;
  inj: boolean;
}

export function scatterFor(
  rows: Row[],
  metric: MetricMeta,
  minVolume: number,
  minProjVolume = 0
): ScatterPoint[] {
  const pts: ScatterPoint[] = [];
  for (const r of rows) {
    if (!metric.positions.includes(r.pos)) continue;
    const c = r.m[metric.key];
    if (!c || !passesVol(c, minVolume, minProjVolume)) continue;
    pts.push({
      pid: r.pid,
      wk: r.wk,
      team: r.team,
      median: c.m,
      actual: c.a,
      floor: Math.min(c.f, c.c),
      ceiling: Math.max(c.f, c.c),
      within: c.in,
      inj: r.inj,
    });
  }
  return pts;
}
