"use client";

import {
  CartesianGrid,
  ErrorBar,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  ComposedChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CI, DeepStats } from "@/lib/stats";
import type { MetricMeta } from "@/lib/types";
import { fmtValue } from "@/lib/format";
import Explainer from "./Explainer";

function devColor(value: number, target: number, warn: number, bad: number) {
  const d = Math.abs(value - target);
  return d <= warn ? "text-green-400" : d <= bad ? "text-yellow-400" : "text-red-400";
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
// Is a target value outside the 95% CI? (i.e. significantly miscalibrated)
const sig = (ci: CI, target: number) => target < ci.lo || target > ci.hi;

export default function CoverageView({
  all,
  selected,
  metric,
}: {
  all: DeepStats[];
  selected: DeepStats | null;
  metric: MetricMeta;
}) {
  // Reliability points with asymmetric 95% Wilson error bars (in pct points).
  const reliability = selected
    ? [
        {
          nominal: 25,
          empirical: selected.covFloor * 100,
          err: [
            (selected.covFloor - selected.ciFloor.lo) * 100,
            (selected.ciFloor.hi - selected.covFloor) * 100,
          ],
          label: "Floor",
        },
        {
          nominal: 50,
          empirical: selected.covMedian * 100,
          err: [
            (selected.covMedian - selected.ciMedian.lo) * 100,
            (selected.ciMedian.hi - selected.covMedian) * 100,
          ],
          label: "Median",
        },
        {
          nominal: 75,
          empirical: selected.covCeiling * 100,
          err: [
            (selected.covCeiling - selected.ciCeiling.lo) * 100,
            (selected.ciCeiling.hi - selected.covCeiling) * 100,
          ],
          label: "Ceiling",
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <Explainer title="What this shows & how to read it">
        <p>
          This view goes a level deeper than the headline &ldquo;within
          band&rdquo; number to pinpoint <b>where</b> and <b>how badly</b> a
          projection is off, and whether the miss is real or just small-sample
          noise.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b>Reliability diagram</b> — the actual should fall below the Floor
            25% of the time, below the Median 50%, below the Ceiling 75%. Points
            on the dashed line are perfect. A point above the line means actuals
            come in low too often there (projection set too high); below means
            too high too often.
          </li>
          <li>
            <b>P≤Floor / Median / Ceiling</b> (table) — those three checks as
            numbers, color-coded by distance from 25 / 50 / 75%.
          </li>
          <li>
            <b>Sharpness / Winkler / Pinball</b> — is the range the right{" "}
            <i>width</i>? Sharpness is the average band size; Winkler and Pinball
            are scoring rules that reward bands that are both narrow and
            accurate (lower is better).
          </li>
          <li>
            <b>RMSE / MAE / WAPE</b> — typical error of the Median forecast.{" "}
            <b>Rank ρ</b> — does the projection order players correctly (most
            important for rankings)? <b>Slope</b> — under 1.0 means the
            projections are too spread out (studs over-projected, scrubs
            under-projected); a regression-to-the-mean tell.
          </li>
          <li>
            <b>Confidence intervals</b> — the cards and diagram whiskers show 95%
            ranges. If the 50% target sits outside a card&apos;s interval (flagged{" "}
            <span className="rounded bg-red-900/60 px-1 text-[10px] text-red-300">
              off
            </span>
            ), the miscalibration is statistically real, not luck.
          </li>
        </ul>
      </Explainer>

      {selected && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard
            title="Within band"
            target="target 50%"
            value={pct(selected.within)}
            ci={selected.ciWithin}
            flag={sig(selected.ciWithin, 0.5)}
          />
          <SummaryCard
            title="Actual > Median"
            target="target 50%"
            value={pct(selected.overMedianRate)}
            ci={selected.ciOverMedian}
            flag={sig(selected.ciOverMedian, 0.5)}
          />
          <SummaryCard
            title="Brier (exceedance)"
            target="ideal ≈ 0.208"
            value={selected.brier.toFixed(3)}
            sub={`vs ${selected.n} player-weeks`}
          />
          <SummaryCard
            title="Sample size"
            target="filtered"
            value={selected.n.toLocaleString()}
          />
        </section>
      )}

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-200">
          Reliability diagram — {metric.label}
        </h3>
        <p className="mb-4 text-xs text-slate-400">
          Empirical share of actuals at or below each projected quantile vs. the
          nominal target. Points on the dashed diagonal are perfectly
          calibrated. A point above the line means actuals fall below that
          quantile too often (projection too high there); below means too low.
          Whiskers are 95% Wilson confidence intervals — a target line outside
          the whisker is a statistically significant miscalibration.
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
              >
                <ErrorBar
                  dataKey="err"
                  width={6}
                  strokeWidth={2}
                  stroke="#38bdf8"
                  direction="y"
                />
              </Line>
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
              <th className="px-3 py-3 text-right" title="Brier score over Floor/Median/Ceiling exceedance (ideal ≈ 0.208, lower better)">
                Brier
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
                <td
                  className={`px-3 py-2 text-right tabular-nums ${devColor(s.brier, 0.208, 0.03, 0.08)}`}
                >
                  {s.brier.toFixed(3)}
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
        scores (lower is better). <span className="text-slate-400">Brier</span>{" "}
        scores the Floor/Median/Ceiling exceedance forecasts (ideal ≈ 0.208).
        <span className="text-slate-400"> Slope</span> &lt;1 ⇒ projections too
        extreme; &gt;1 ⇒ too conservative.
      </p>
    </div>
  );
}

function SummaryCard({
  title,
  target,
  value,
  ci,
  flag,
  sub,
}: {
  title: string;
  target: string;
  value: string;
  ci?: CI;
  flag?: boolean;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">{title}</span>
        {flag && (
          <span
            title="Target lies outside the 95% confidence interval"
            className="rounded bg-red-900/60 px-1 text-[10px] font-semibold text-red-300"
          >
            off
          </span>
        )}
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums text-slate-100">
        {value}
      </div>
      {ci ? (
        <div className="text-[11px] tabular-nums text-slate-500">
          95% CI {pct(ci.lo)}–{pct(ci.hi)}
        </div>
      ) : (
        <div className="text-[11px] text-slate-500">{sub ?? target}</div>
      )}
      <div className="text-[10px] uppercase tracking-wide text-slate-600">
        {target}
      </div>
    </div>
  );
}
