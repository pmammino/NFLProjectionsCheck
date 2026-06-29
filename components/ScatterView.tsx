"use client";

import {
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { ScatterPoint } from "@/lib/aggregate";
import type { MetricMeta } from "@/lib/types";
import { fmtValue } from "@/lib/format";
import Explainer from "./Explainer";

export default function ScatterView({
  points,
  metric,
}: {
  points: ScatterPoint[];
  metric: MetricMeta;
}) {
  const rawMax = Math.max(
    0.01,
    ...points.map((p) => Math.max(p.actual, p.ceiling, p.median))
  );
  // Round up to a clean axis bound (avoids 24.1500000002-style tick labels).
  // Use a finer step for small-valued rate/percentage metrics.
  const niceCeil = (x: number) => {
    const step = x <= 2 ? 0.1 : x <= 20 ? 1 : 5;
    return Math.ceil((x * 1.05) / step) * step;
  };
  const max = Math.round(niceCeil(rawMax) * 1000) / 1000;

  return (
    <div className="space-y-6">
      <Explainer title="What this shows & how to read it">
        <p>
          A direct picture of projection vs. reality. Each dot is one
          player-week: <b>X = what was projected</b> (the Median),{" "}
          <b>Y = what actually happened</b>. The dashed line is a perfect
          prediction. Dots above the line beat their projection; dots below fell
          short. <b>Green</b> dots landed inside the Floor–Ceiling band,{" "}
          <b>red</b> fell outside.
        </p>
        <p className="text-slate-400">
          <b>What you learn:</b> if the cloud tilts off the diagonal the input is
          biased; if it fans out widely the projection has limited predictive
          power for that stat; a tight cloud hugging the line is the goal.
        </p>
      </Explainer>

      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-1 text-sm font-semibold text-slate-200">
        Projected Median vs. Actual — {metric.label}
      </h3>
      <p className="mb-4 text-xs text-slate-400">
        Each dot is a player-week. The dashed line is perfect prediction
        (actual = median). Green dots landed inside the Floor–Ceiling band; red
        dots fell outside it. Systematic offset from the line reveals input
        bias.
      </p>
      <div className="h-[420px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 30, left: 8 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis
              type="number"
              dataKey="median"
              name="Projected median"
              domain={[0, max]}
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              label={{
                value: "Projected median",
                position: "insideBottom",
                offset: -15,
                fill: "#94a3b8",
                fontSize: 12,
              }}
            />
            <YAxis
              type="number"
              dataKey="actual"
              name="Actual"
              domain={[0, max]}
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              label={{
                value: "Actual",
                angle: -90,
                position: "insideLeft",
                fill: "#94a3b8",
                fontSize: 12,
              }}
            />
            <ZAxis range={[28, 28]} />
            <ReferenceLine
              segment={[
                { x: 0, y: 0 },
                { x: max, y: max },
              ]}
              stroke="#eab308"
              strokeDasharray="5 5"
            />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              contentStyle={{
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(v: number, name: string) => [
                fmtValue(v, metric.unit),
                name,
              ]}
              labelFormatter={() => ""}
            />
            <Scatter data={points} fillOpacity={0.6}>
              {points.map((p, i) => (
                <Cell key={i} fill={p.within ? "#22c55e" : "#ef4444"} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      </div>
    </div>
  );
}
