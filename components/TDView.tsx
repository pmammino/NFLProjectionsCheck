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
import {
  binaryReliability,
  countCalibration,
  tdCountAccuracy,
  tdSummary,
  type TDRow,
} from "@/lib/td";
import type { TDTypeMeta } from "@/lib/types";
import Explainer from "./Explainer";

const tooltipStyle = {
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: 8,
  fontSize: 12,
};

export default function TDView({
  rows,
  type,
  byWeek = true,
}: {
  rows: TDRow[];
  type: TDTypeMeta;
  byWeek?: boolean;
}) {
  const summary = tdSummary(rows);
  const acc = tdCountAccuracy(rows);

  const countPts = countCalibration(rows).map((b) => ({
    x: b.meanProjected,
    y: b.meanActual,
    err: [b.meanActual - b.ciLo, b.ciHi - b.meanActual],
    n: b.n,
  }));
  const countMax =
    Math.max(0.1, ...countPts.flatMap((p) => [p.x, p.y])) * 1.1;

  const relPts = binaryReliability(rows).map((b) => ({
    x: b.meanPredicted * 100,
    y: b.empirical * 100,
    err: [(b.empirical - b.ciLo) * 100, (b.ciHi - b.empirical) * 100],
    n: b.n,
  }));

  const totalBias =
    summary.actualTotal > 0
      ? (summary.projectedTotal - summary.actualTotal) / summary.actualTotal
      : 0;

  return (
    <div className="space-y-6">
      <Explainer title={`Why touchdowns get their own treatment — ${type.label}`}>
        <p>
          Touchdowns are essentially a <b>count</b> outcome — a player scores{" "}
          {byWeek ? "0, 1, or occasionally 2 in a game" : "a handful over a season"}.
          Asking whether that lands inside a continuous &ldquo;TD-rate&rdquo;
          band (e.g. 0.05 TD/target) is the wrong question, so we judge the
          projected TD <b>count</b> directly instead.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b>Expected vs. actual:</b> group players by how many TDs were
            projected, then compare the average projected count to the average
            that actually happened. The lumpy noise averages out — points on the
            diagonal are well-calibrated, above means the projection under-shot,
            below means it over-shot.
          </li>
          {byWeek ? (
            <>
              <li>
                <b>Scoring probability:</b> convert each projection to a chance
                of scoring ≥1 TD that game, then check: of the games we gave a
                ~30% chance, did ~30% actually score?
              </li>
              <li>
                <b>Brier score &amp; log loss</b> grade those probability
                forecasts (lower is better); <b>Brier skill</b> above 0 means
                the projection beats a league-average-rate baseline.
              </li>
            </>
          ) : (
            <li>
              <b>MAE &amp; rank correlation</b> grade the season TD count: how
              far off the projected total typically is, and whether it orders
              the league&apos;s TD producers correctly. (The per-game
              &ldquo;scored ≥1 TD&rdquo; probability isn&apos;t shown for
              seasons — nearly every real player scores at least once, so it
              carries no information.)
            </li>
          )}
        </ul>
      </Explainer>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card
          title="Projected vs actual TDs"
          value={`${summary.projectedTotal.toFixed(0)} / ${summary.actualTotal}`}
          sub={`${totalBias >= 0 ? "+" : ""}${(totalBias * 100).toFixed(1)}% total bias`}
        />
        {byWeek ? (
          <>
            <Card
              title="Predicted vs actual scoring"
              value={`${(summary.predictedScoreRate * 100).toFixed(1)}% / ${(summary.actualScoreRate * 100).toFixed(1)}%`}
              sub="share of games with ≥1 TD (model / real)"
            />
            <Card
              title="Brier / skill"
              value={`${summary.brier.toFixed(3)}`}
              sub={`skill ${summary.brierSkill >= 0 ? "+" : ""}${(summary.brierSkill * 100).toFixed(1)}% vs base rate`}
            />
            <Card
              title="Log loss"
              value={summary.logLoss.toFixed(3)}
              sub={`${summary.n.toLocaleString()} player-weeks`}
            />
          </>
        ) : (
          <>
            <Card
              title="Mean abs error"
              value={acc.mae.toFixed(2)}
              sub="avg |projected − actual| TDs"
            />
            <Card
              title="Rank correlation"
              value={Number.isFinite(acc.spearman) ? acc.spearman.toFixed(2) : "—"}
              sub="orders TD producers correctly?"
            />
            <Card
              title="Players"
              value={acc.n.toLocaleString()}
              sub="with real opportunity"
            />
          </>
        )}
      </section>

      <div className={`grid grid-cols-1 gap-6 ${byWeek ? "lg:grid-cols-2" : ""}`}>
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-200">
            Expected vs. actual TDs (binned)
          </h3>
          <p className="mb-3 text-xs text-slate-400">
            Each dot is a group of player-weeks with similar projected TDs. X =
            average projected, Y = average actual (with 95% CI). On the dashed
            diagonal = calibrated; above = projection under-shot; below =
            over-shot.
          </p>
          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={countPts} margin={{ top: 8, right: 20, bottom: 24, left: 0 }}>
                <CartesianGrid stroke="#1e293b" />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={[0, countMax]}
                  tickFormatter={(v) => v.toFixed(2)}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  label={{ value: "Projected TDs", position: "insideBottom", offset: -12, fill: "#94a3b8", fontSize: 12 }}
                />
                <YAxis
                  type="number"
                  domain={[0, countMax]}
                  tickFormatter={(v) => v.toFixed(2)}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  label={{ value: "Actual TDs", angle: -90, position: "insideLeft", fill: "#94a3b8", fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, n: string) => [Number(v).toFixed(3), n === "y" ? "Actual" : n]}
                  labelFormatter={() => ""}
                />
                <ReferenceLine segment={[{ x: 0, y: 0 }, { x: countMax, y: countMax }]} stroke="#eab308" strokeDasharray="5 5" />
                <Line type="monotone" dataKey="y" stroke="#a855f7" strokeWidth={2} dot={{ r: 4, fill: "#a855f7" }}>
                  <ErrorBar dataKey="err" width={5} strokeWidth={1.5} stroke="#a855f7" direction="y" />
                </Line>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        {byWeek && (
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-200">
            Scoring-probability reliability
          </h3>
          <p className="mb-3 text-xs text-slate-400">
            X = model&apos;s predicted chance of scoring ≥1 TD; Y = share that
            actually did (95% CI). On the diagonal = the probabilities mean what
            they say.
          </p>
          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={relPts} margin={{ top: 8, right: 20, bottom: 24, left: 0 }}>
                <CartesianGrid stroke="#1e293b" />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={[0, 100]}
                  unit="%"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  label={{ value: "Predicted P(≥1 TD)", position: "insideBottom", offset: -12, fill: "#94a3b8", fontSize: 12 }}
                />
                <YAxis
                  type="number"
                  domain={[0, 100]}
                  unit="%"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  label={{ value: "Observed scoring %", angle: -90, position: "insideLeft", fill: "#94a3b8", fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number) => `${Number(v).toFixed(1)}%`}
                  labelFormatter={() => ""}
                />
                <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke="#eab308" strokeDasharray="5 5" />
                <Line type="monotone" dataKey="y" stroke="#38bdf8" strokeWidth={2} dot={{ r: 4, fill: "#38bdf8" }}>
                  <ErrorBar dataKey="err" width={5} strokeWidth={1.5} stroke="#38bdf8" direction="y" />
                </Line>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
        )}
      </div>
    </div>
  );
}

function Card({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="text-xs font-medium text-slate-400">{title}</div>
      <div className="mt-1 text-lg font-bold tabular-nums text-slate-100">
        {value}
      </div>
      <div className="text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}
