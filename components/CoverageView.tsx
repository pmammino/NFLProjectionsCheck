"use client";

import {
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ComposedChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DeepStats } from "@/lib/stats";
import type { MetricMeta } from "@/lib/types";
import { fmtValue } from "@/lib/format";

function devColor(value: number, target: number, warn: number, bad: number) {
  const d = Math.abs(value - target);
  return d <= warn ? "text-green-400" : d <= bad ? "text-yellow-400" : "text-red-400";
}

export default function CoverageView({
  all,
  selected,
  metric,
}: {
  all: DeepStats[];
  selected: DeepStats | null;
  metric: MetricMeta;
}) {
  const reliability = selected
    ? [
        { nominal: 25, empirical: selected.covFloor * 100, label: "Floor" },
        { nominal: 50, empirical: selected.covMedian * 100, label: "Median" },
        { nominal: 75, empirical: selected.covCeiling * 100, label: "Ceiling" },
      ]
    : [];

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-200">
          Reliability diagram — {metric.label}
        </h3>
        <p className="mb-4 text-xs text-slate-400">
          Empirical share of actuals at or below each projected quantile vs. the
          nominal target. Points on the dashed diagonal are perfectly
          calibrated. A point above the line means actuals fall below that
          quantile too often (projection too high there); below means too low.
        </p>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={reliability}
              margin={{ top: 8, right: 24, bottom: 24, left: 0 }}
            >
              <CartesianGrid stroke="#1e293b" />
              <XAxis
                type="number"
                dataKey="nominal"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                unit="%"
                label={{
                  value: "Nominal quantile",
                  position: "insideBottom",
                  offset: -12,
                  fill: "#94a3b8",
                  fontSize: 12,
                }}
              />
              <YAxis
                type="number"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                unit="%"
                label={{
                  value: "Empirical coverage",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#94a3b8",
                  fontSize: 12,
                }}
              />
              <Tooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number) => `${v.toFixed(1)}%`}
                labelFormatter={(l) => `Nominal ${l}%`}
              />
              <ReferenceLine
                segment={[
                  { x: 0, y: 0 },
                  { x: 100, y: 100 },
                ]}
                stroke="#eab308"
                strokeDasharray="5 5"
              />
              <Line
                type="linear"
                dataKey="empirical"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={{ r: 5, fill: "#38bdf8" }}
              />
              <Scatter dataKey="empirical" fill="#38bdf8" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
        <table className="w-full whitespace-nowrap text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-3 py-3">Metric</th>
              <th className="px-3 py-3 text-right">N</th>
              <th className="px-3 py-3 text-right" title="Target 25%">
                P≤Floor
              </th>
              <th className="px-3 py-3 text-right" title="Target 50%">
                P≤Median
              </th>
              <th className="px-3 py-3 text-right" title="Target 75%">
                P≤Ceiling
              </th>
              <th className="px-3 py-3 text-right" title="Mean band width">
                Sharpness
              </th>
              <th className="px-3 py-3 text-right" title="Winkler interval score (lower better)">
                Winkler
              </th>
              <th className="px-3 py-3 text-right" title="Mean pinball loss (lower better)">
                Pinball
              </th>
              <th className="px-3 py-3 text-right">RMSE</th>
              <th className="px-3 py-3 text-right">MAE</th>
              <th className="px-3 py-3 text-right" title="Σ|actual-median| / Σ|actual|">
                WAPE
              </th>
              <th className="px-3 py-3 text-right" title="Spearman rank correlation">
                Rank ρ
              </th>
              <th className="px-3 py-3 text-right" title="OLS slope of actual~median (target 1.0)">
                Slope
              </th>
            </tr>
          </thead>
          <tbody>
            {all.map((s) => (
              <tr
                key={s.key}
                className={`border-b border-slate-800/40 hover:bg-slate-800/40 ${
                  s.key === metric.key ? "bg-slate-800/30" : ""
                }`}
              >
                <td className="px-3 py-2 font-medium text-slate-200">
                  {s.meta.label}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                  {s.n}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${devColor(s.covFloor * 100, 25, 5, 12)}`}
                >
                  {(s.covFloor * 100).toFixed(1)}%
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${devColor(s.covMedian * 100, 50, 5, 12)}`}
                >
                  {(s.covMedian * 100).toFixed(1)}%
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${devColor(s.covCeiling * 100, 75, 5, 12)}`}
                >
                  {(s.covCeiling * 100).toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {fmtValue(s.sharpness, s.meta.unit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {fmtValue(s.winkler, s.meta.unit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {fmtValue(s.pinball, s.meta.unit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {fmtValue(s.rmse, s.meta.unit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {fmtValue(s.mae, s.meta.unit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {Number.isFinite(s.wape) ? (s.wape * 100).toFixed(1) + "%" : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {Number.isFinite(s.spearman) ? s.spearman.toFixed(2) : "—"}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    Number.isFinite(s.slope) ? devColor(s.slope, 1, 0.15, 0.4) : "text-slate-500"
                  }`}
                >
                  {Number.isFinite(s.slope) ? s.slope.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-slate-500">
        Coverage cells are green within ±5 pts of target, red beyond ±12.
        <span className="text-slate-400"> Sharpness</span> = mean
        Ceiling−Floor width (narrower is better only if coverage holds).
        <span className="text-slate-400"> Winkler</span> &amp;
        <span className="text-slate-400"> Pinball</span> are proper interval/quantile
        scores (lower is better). <span className="text-slate-400">Slope</span>{" "}
        &lt;1 ⇒ projections too extreme; &gt;1 ⇒ too conservative.
      </p>
    </div>
  );
}
