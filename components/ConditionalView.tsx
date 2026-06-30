"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Conditional } from "@/lib/stats";
import type { MetricMeta } from "@/lib/types";
import Explainer from "./Explainer";

const tooltipStyle = {
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: 8,
  fontSize: 12,
};

function withinColor(v: number) {
  const d = Math.abs(v - 50);
  return d <= 10 ? "#16a34a" : d <= 20 ? "#eab308" : "#dc2626";
}

export default function ConditionalView({
  data,
  metric,
  showByWeek = true,
}: {
  data: Conditional;
  metric: MetricMeta;
  showByWeek?: boolean;
}) {
  const weekData = data.byWeek.map((b) => ({
    label: b.label,
    within: b.withinRate * 100,
    covMedian: b.covMedian * 100,
    n: b.n,
  }));
  const magData = data.byMagnitude.map((b) => ({
    label: b.label,
    within: b.withinRate * 100,
    err: [
      (b.withinRate - b.withinCI.lo) * 100,
      (b.withinCI.hi - b.withinRate) * 100,
    ],
    meanErr: b.meanErr,
    n: b.n,
  }));

  return (
    <div className="space-y-6">
      <Explainer title="What this shows & how to read it">
        <p>
          A single season-wide average can look fine while hiding real problems.
          This view slices the same calibration three ways for <b>{metric.label}</b>{" "}
          to find where it breaks down:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b>By week</b> — does accuracy drift over the season (e.g. worse
            early before usage settles, or late as backups play)?
          </li>
          <li>
            <b>By projection magnitude</b> — players are split into four groups
            from lowest projected to highest. If within-band climbs from left to
            right, the model handles stars well but is too confident (bands too
            narrow) for low-volume players, or vice-versa.
          </li>
          <li>
            <b>By position</b> — is one position calibrated better than another
            for this stat?
          </li>
        </ul>
        <p className="text-slate-400">
          Error bars / ± are 95% confidence intervals — bars whose intervals
          don&apos;t overlap are genuinely different, not noise.
        </p>
      </Explainer>

      {showByWeek && (
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">
            By week — within-band &amp; median coverage over the season
          </h3>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={weekData} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
                <CartesianGrid stroke="#1e293b" />
                <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={0} angle={-40} textAnchor="end" height={50} />
                <YAxis domain={[0, 100]} unit="%" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v.toFixed(1)}%`} />
                <ReferenceLine y={50} stroke="#eab308" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="within" name="Within band" stroke="#22c55e" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="covMedian" name="P≤Median" stroke="#38bdf8" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Within-band target 50%. P≤Median target 50% (a flat line near 50%
            means the median is unbiased week to week).
          </p>
        </section>
      )}

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">
          By projection magnitude — are studs vs. low-projected players handled
          differently?
        </h3>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={magData} margin={{ top: 8, right: 16, bottom: 40, left: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
              <YAxis domain={[0, 100]} unit="%" tick={{ fill: "#94a3b8", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [n === "within" ? `${v.toFixed(1)}%` : v.toFixed(2), n === "within" ? "Within band" : "Mean error"]} />
              <ReferenceLine y={50} stroke="#eab308" strokeDasharray="4 4" />
              <Bar dataKey="within" name="within" radius={[3, 3, 0, 0]}>
                {magData.map((d, i) => (
                  <Cell key={i} fill={withinColor(d.within)} />
                ))}
                <ErrorBar dataKey="err" width={6} strokeWidth={1.5} stroke="#cbd5e1" direction="y" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">By position</th>
              <th className="px-4 py-3 text-right">N</th>
              <th className="px-4 py-3 text-right">Within band</th>
              <th className="px-4 py-3 text-right">P≤Median</th>
              <th className="px-4 py-3 text-right">Mean error</th>
            </tr>
          </thead>
          <tbody>
            {data.byPosition.map((b) => (
              <tr key={b.label} className="border-b border-slate-800/40">
                <td className="px-4 py-2 font-medium text-slate-200">{b.label}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-400">{b.n}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                  {(b.withinRate * 100).toFixed(1)}%
                  <span className="ml-1 text-[11px] text-slate-500">
                    ±{(((b.withinCI.hi - b.withinCI.lo) / 2) * 100).toFixed(1)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                  {(b.covMedian * 100).toFixed(1)}%
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                  {b.meanErr > 0 ? "+" : ""}
                  {b.meanErr.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
