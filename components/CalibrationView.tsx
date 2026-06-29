"use client";

import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricSummary } from "@/lib/aggregate";
import { fmtSignedPct } from "@/lib/format";

// Expected within-band rate for a 25th–75th percentile band.
const TARGET_WITHIN = 0.5;

export default function CalibrationView({
  summaries,
}: {
  summaries: MetricSummary[];
}) {
  const chartData = summaries.map((s) => ({
    label: s.meta.label,
    group: s.meta.group,
    within: s.withinRate * 100,
    below: s.belowRate * 100,
    above: s.aboveRate * 100,
    n: s.n,
  }));

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-200">
          Within-band hit rate vs. 50% target
        </h3>
        <p className="mb-4 text-xs text-slate-400">
          Floor and Ceiling are the 25th / 75th percentile outcomes, so a
          well-calibrated projection should land inside the band ~50% of the
          time. Bars far below 50% mean the range is too narrow (or biased);
          far above means it is too wide.
        </p>
        <div className="h-[340px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 60, left: 0 }}
            >
              <XAxis
                dataKey="label"
                angle={-35}
                textAnchor="end"
                interval={0}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                height={70}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                unit="%"
              />
              <Tooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <ReferenceLine
                y={50}
                stroke="#eab308"
                strokeDasharray="4 4"
                label={{ value: "50% target", fill: "#eab308", fontSize: 11 }}
              />
              <Bar dataKey="within" name="Within band" radius={[3, 3, 0, 0]}>
                {chartData.map((d, i) => (
                  <Cell
                    key={i}
                    fill={
                      Math.abs(d.within - 50) <= 10
                        ? "#16a34a"
                        : Math.abs(d.within - 50) <= 20
                          ? "#eab308"
                          : "#dc2626"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">Metric</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 text-right">N</th>
              <th className="px-4 py-3 text-right">Within band</th>
              <th className="px-4 py-3">Below / Within / Above</th>
              <th className="px-4 py-3 text-right">Median bias vs proj</th>
              <th className="px-4 py-3 text-right">Mean error</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => {
              const dev = Math.abs(s.withinRate - TARGET_WITHIN);
              const color =
                dev <= 0.1
                  ? "text-green-400"
                  : dev <= 0.2
                    ? "text-yellow-400"
                    : "text-red-400";
              return (
                <tr
                  key={s.key}
                  className="border-b border-slate-800/50 hover:bg-slate-800/40"
                >
                  <td className="px-4 py-2 font-medium text-slate-200">
                    {s.meta.label}
                  </td>
                  <td className="px-4 py-2 text-slate-400">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs">
                      {s.meta.group}
                    </span>{" "}
                    <span className="text-xs">{s.meta.kind}</span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                    {s.n}
                  </td>
                  <td
                    className={`px-4 py-2 text-right font-semibold tabular-nums ${color}`}
                  >
                    {(s.withinRate * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex h-3 w-40 overflow-hidden rounded">
                      <div
                        className="bg-red-600"
                        style={{ width: `${s.belowRate * 100}%` }}
                        title={`Below floor: ${(s.belowRate * 100).toFixed(0)}%`}
                      />
                      <div
                        className="bg-green-600"
                        style={{ width: `${s.withinRate * 100}%` }}
                        title={`Within: ${(s.withinRate * 100).toFixed(0)}%`}
                      />
                      <div
                        className="bg-blue-600"
                        style={{ width: `${s.aboveRate * 100}%` }}
                        title={`Above ceiling: ${(s.aboveRate * 100).toFixed(0)}%`}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                    {fmtSignedPct(s.medianBias)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                    {s.meanErr > 0 ? "+" : ""}
                    {s.meanErr.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-slate-500">
        <span className="text-red-400">Below</span> = actual under the Floor
        (projection too high),{" "}
        <span className="text-blue-400">Above</span> = actual over the Ceiling
        (projection too low). &ldquo;Median bias&rdquo; is the median percent
        difference between actual and the projected Median (robust to
        low-volume outliers).
      </p>
    </div>
  );
}
