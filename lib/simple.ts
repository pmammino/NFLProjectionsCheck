import type { MetricMeta, Position, Row } from "./types";
import type { MetricSummary } from "./aggregate";
import { passesVol } from "./aggregate";
import type { DeepStats } from "./stats";

const POSITION_ORDER: Position[] = ["QB", "RB", "WR", "TE"];

export interface PositionGrade {
  pos: Position;
  n: number;
  withinRate: number; // pooled across every applicable metric
}

export interface RankedMetric {
  key: string;
  label: string;
  group: string;
  accuracy: number; // 1 - WAPE, clamped to [0, 1]
  n: number;
}

export interface SimpleSummary {
  n: number; // total metric readings behind the averages below
  avgWithin: number; // weighted avg within-band rate (target ~50%)
  avgMiss: number; // weighted avg WAPE — typical size of the miss, as a share
  avgBias: number | null; // weighted avg signed median bias (+ = under-projected, - = over-projected)
  avgRank: number | null; // weighted avg rank correlation (did we order players correctly?)
  byPosition: PositionGrade[];
  best: RankedMetric[];
  toughest: RankedMetric[];
}

// A plain-language, single-screen rollup of how the projections did, built on
// top of the same per-metric stats the other tabs already compute. Nothing
// here is a new statistic — it's the existing numbers pooled and simplified.
export function buildSimpleSummary(
  summaries: MetricSummary[],
  deep: DeepStats[],
  rows: Row[],
  metrics: MetricMeta[],
  minVolume: number,
  minProjVolume: number,
  positions: Position[]
): SimpleSummary {
  let withinSum = 0;
  let totalN = 0;
  for (const s of summaries) {
    withinSum += s.withinRate * s.n;
    totalN += s.n;
  }

  let missWeighted = 0;
  let missN = 0;
  let rankWeighted = 0;
  let rankN = 0;
  for (const d of deep) {
    if (Number.isFinite(d.wape)) {
      missWeighted += d.wape * d.n;
      missN += d.n;
    }
    if (Number.isFinite(d.spearman)) {
      rankWeighted += d.spearman * d.n;
      rankN += d.n;
    }
  }

  let biasWeighted = 0;
  let biasN = 0;
  for (const s of summaries) {
    if (s.medianBias !== null) {
      biasWeighted += s.medianBias * s.n;
      biasN += s.n;
    }
  }

  const byPosition: PositionGrade[] = POSITION_ORDER.filter((p) =>
    positions.includes(p)
  )
    .map((pos) => {
      let within = 0;
      let n = 0;
      for (const r of rows) {
        if (r.pos !== pos) continue;
        for (const m of metrics) {
          if (!m.positions.includes(pos)) continue;
          const cell = r.m[m.key];
          if (!cell || !passesVol(cell, minVolume, minProjVolume)) continue;
          n++;
          if (cell.in) within++;
        }
      }
      return { pos, n, withinRate: n ? within / n : 0 };
    })
    .filter((p) => p.n > 0);

  const ranked: RankedMetric[] = deep
    .filter((d) => d.n >= 15 && Number.isFinite(d.wape))
    .map((d) => ({
      key: d.key,
      label: d.meta.label,
      group: d.meta.group,
      accuracy: Math.max(0, Math.min(1, 1 - d.wape)),
      n: d.n,
    }));
  const byAccuracyDesc = [...ranked].sort((a, b) => b.accuracy - a.accuracy);
  const best = byAccuracyDesc.slice(0, 3);
  const toughest = [...byAccuracyDesc].reverse().slice(0, 3);

  return {
    n: totalN,
    avgWithin: totalN ? withinSum / totalN : 0,
    avgMiss: missN ? missWeighted / missN : 0,
    avgBias: biasN ? biasWeighted / biasN : null,
    avgRank: rankN ? rankWeighted / rankN : null,
    byPosition,
    best,
    toughest,
  };
}
