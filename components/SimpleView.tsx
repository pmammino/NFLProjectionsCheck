"use client";

import { useMemo } from "react";
import type { MetricMeta, Position, Row } from "@/lib/types";
import type { MetricSummary } from "@/lib/aggregate";
import type { DeepStats } from "@/lib/stats";
import { buildSimpleSummary } from "@/lib/simple";
import { tdSummary, tdCountAccuracy, type TDRow } from "@/lib/td";
import Explainer from "./Explainer";

type Grade = "Excellent" | "Good" | "Fair" | "Needs Work";

const GRADE_STYLE: Record<Grade, string> = {
  Excellent: "bg-green-900/40 border-green-700/60 text-green-300",
  Good: "bg-teal-900/40 border-teal-700/60 text-teal-300",
  Fair: "bg-yellow-900/40 border-yellow-700/60 text-yellow-300",
  "Needs Work": "bg-red-900/40 border-red-700/60 text-red-300",
};

const GRADE_SCORE: Record<Grade, number> = {
  Excellent: 3,
  Good: 2,
  Fair: 1,
  "Needs Work": 0,
};

function accuracyGrade(avgMiss: number): Grade {
  if (avgMiss <= 0.15) return "Excellent";
  if (avgMiss <= 0.3) return "Good";
  if (avgMiss <= 0.5) return "Fair";
  return "Needs Work";
}

function reliabilityGrade(avgWithin: number): Grade {
  const dev = Math.abs(avgWithin - 0.5);
  if (dev <= 0.05) return "Excellent";
  if (dev <= 0.1) return "Good";
  if (dev <= 0.2) return "Fair";
  return "Needs Work";
}

function biasGrade(avgBias: number | null): Grade {
  if (avgBias === null) return "Fair";
  const a = Math.abs(avgBias);
  if (a <= 0.05) return "Excellent";
  if (a <= 0.15) return "Good";
  if (a <= 0.3) return "Fair";
  return "Needs Work";
}

function rankGrade(avgRank: number | null): Grade {
  if (avgRank === null) return "Fair";
  if (avgRank >= 0.7) return "Excellent";
  if (avgRank >= 0.5) return "Good";
  if (avgRank >= 0.3) return "Fair";
  return "Needs Work";
}

function overallGrade(grades: Grade[]): Grade {
  const avg = grades.reduce((s, g) => s + GRADE_SCORE[g], 0) / grades.length;
  if (avg >= 2.5) return "Excellent";
  if (avg >= 1.5) return "Good";
  if (avg >= 0.5) return "Fair";
  return "Needs Work";
}

const OVERALL_SENTENCE: Record<Grade, string> = {
  Excellent:
    "Across the board, the projections tracked reality closely — a trustworthy guide to how players actually performed.",
  Good: "Overall the projections were solid — mostly accurate, with some rough edges worth watching.",
  Fair: "The projections were in the right neighborhood, but missed by a meaningful amount often enough to use with some caution.",
  "Needs Work":
    "The projections struggled — treat the numbers as a rough starting point rather than a forecast.",
};

function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <span
      className={`inline-block rounded-full border px-3 py-1 text-sm font-bold ${GRADE_STYLE[grade]}`}
    >
      {grade}
    </span>
  );
}

function GradeCard({
  title,
  grade,
  children,
}: {
  title: string;
  grade: Grade;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <GradeBadge grade={grade} />
      </div>
      <p className="text-sm leading-relaxed text-slate-400">{children}</p>
    </div>
  );
}

function positionBarColor(dev: number): string {
  if (dev <= 0.1) return "bg-green-600";
  if (dev <= 0.2) return "bg-yellow-500";
  return "bg-red-600";
}

export default function SimpleView({
  summaries,
  deep,
  rows,
  metrics,
  minVolume,
  minProjVolume,
  positions,
  tdRows,
  byWeek,
}: {
  summaries: MetricSummary[];
  deep: DeepStats[];
  rows: Row[];
  metrics: MetricMeta[];
  minVolume: number;
  minProjVolume: number;
  positions: Position[];
  tdRows: TDRow[];
  byWeek: boolean;
}) {
  const s = useMemo(
    () =>
      buildSimpleSummary(
        summaries,
        deep,
        rows,
        metrics,
        minVolume,
        minProjVolume,
        positions
      ),
    [summaries, deep, rows, metrics, minVolume, minProjVolume, positions]
  );

  const gAccuracy = accuracyGrade(s.avgMiss);
  const gReliability = reliabilityGrade(s.avgWithin);
  const gBias = biasGrade(s.avgBias);
  const gRank = rankGrade(s.avgRank);
  const gOverall = overallGrade([gAccuracy, gReliability, gBias, gRank]);

  const missPct = Math.round(s.avgMiss * 100);
  const withinPct = Math.round(s.avgWithin * 100);
  const biasPct = s.avgBias === null ? null : Math.round(Math.abs(s.avgBias) * 100);

  const reliabilityDesc =
    s.avgWithin > 0.6
      ? "That's wider than the 50% target — the predicted ranges are more generous than they need to be, so they rarely get caught out, but they're also less precise."
      : s.avgWithin < 0.4
        ? "That's below the 50% target — the predicted ranges are too narrow, so real results surprise them more often than they should."
        : "That's right around the 50% target, which means the width of the predicted ranges is well matched to how much players' results actually vary.";

  const biasDesc =
    biasPct === null
      ? "There isn't enough data yet to tell whether projections lean high or low."
      : biasPct <= 5
        ? "Actual results matched the projected numbers almost exactly, on average — no real lean up or down."
        : s.avgBias! > 0
          ? `Actual results came in about ${biasPct}% higher than projected, on average — the projections leaned a bit low.`
          : `Actual results came in about ${biasPct}% lower than projected, on average — the projections leaned a bit high.`;

  const rankDesc =
    s.avgRank === null
      ? "There isn't enough data yet to judge this."
      : gRank === "Excellent"
        ? "The projections reliably separated the stars from the scrubs — the players projected for big games mostly had them."
        : gRank === "Good"
          ? "The projections generally separated the stars from the scrubs, with a fair number of upsets."
          : gRank === "Fair"
            ? "The projections got the general shape right, but plenty of upsets slipped through."
            : "The projections struggled to separate top performers from everyone else.";

  const td = byWeek ? tdSummary(tdRows) : null;
  const tdCount = byWeek ? null : tdCountAccuracy(tdRows);

  return (
    <div className="space-y-6">
      <Explainer title="What this tab shows" defaultOpen={false}>
        <p>
          Every other tab in this dashboard is built for someone comfortable
          with statistics — calibration curves, Brier scores, confidence
          intervals. This tab is the plain-English version: the same
          underlying numbers, translated into everyday language, for anyone
          who just wants to know <b>&ldquo;were the projections any
          good?&rdquo;</b>
        </p>
        <p className="text-slate-400">
          It reflects whatever filters (position, week range, team, etc.) are
          currently set above — the story here should match the detail in the
          other tabs, just told more simply.
        </p>
      </Explainer>

      {s.n === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
          Not enough matched data yet with the current filters to summarize.
        </p>
      ) : (
        <>
          <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <GradeBadge grade={gOverall} />
              <h2 className="text-lg font-semibold text-slate-100">
                The bottom line
              </h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-300">
              {OVERALL_SENTENCE[gOverall]}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Based on {s.n.toLocaleString()} player-{byWeek ? "week" : "season"}{" "}
              stat readings that matched the current filters.
            </p>
          </section>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <GradeCard title="Accuracy" grade={gAccuracy}>
              On average, our projected numbers were off from what actually
              happened by about <b>{missPct}%</b>.
            </GradeCard>
            <GradeCard title="Range Reliability" grade={gReliability}>
              Actual results landed inside our predicted range{" "}
              <b>{withinPct}%</b> of the time. {reliabilityDesc}
            </GradeCard>
            <GradeCard title="Bias" grade={gBias}>
              {biasDesc}
            </GradeCard>
            <GradeCard title="Ranking Skill" grade={gRank}>
              {s.avgRank !== null && (
                <>
                  A correlation of <b>{s.avgRank.toFixed(2)}</b> (out of a
                  perfect 1.00) between projected and actual production.{" "}
                </>
              )}
              {rankDesc}
            </GradeCard>
          </section>

          {(s.best.length > 0 || s.toughest.length > 0) && (
            <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-200">
                  Most reliable stats to project
                </h3>
                <ul className="space-y-2 text-sm">
                  {s.best.map((m) => (
                    <li key={m.key} className="flex items-baseline justify-between gap-2">
                      <span className="text-slate-300">{m.label}</span>
                      <span className="whitespace-nowrap text-xs text-green-400">
                        typically within {Math.round((1 - m.accuracy) * 100)}% of actual
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-200">
                  Hardest stats to call
                </h3>
                <ul className="space-y-2 text-sm">
                  {s.toughest.map((m) => (
                    <li key={m.key} className="flex items-baseline justify-between gap-2">
                      <span className="text-slate-300">{m.label}</span>
                      <span className="whitespace-nowrap text-xs text-red-400">
                        typically off by {Math.round((1 - m.accuracy) * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {s.byPosition.length > 0 && (
            <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-200">
                How each position graded out
              </h3>
              <p className="mb-4 text-xs text-slate-400">
                Share of the time actual results fell inside the predicted
                range (aiming for ~50%).
              </p>
              <div className="space-y-3">
                {s.byPosition.map((p) => {
                  const pct = Math.round(p.withinRate * 100);
                  const dev = Math.abs(p.withinRate - 0.5);
                  return (
                    <div key={p.pos}>
                      <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                        <span className="font-semibold text-slate-200">{p.pos}</span>
                        <span>
                          {pct}% <span className="text-slate-500">(n={p.n.toLocaleString()})</span>
                        </span>
                      </div>
                      <div className="h-2.5 w-full overflow-hidden rounded bg-slate-800">
                        <div
                          className={`h-full ${positionBarColor(dev)}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {byWeek && td && td.n > 0 && (
            <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-200">
                Touchdowns: did we call it right?
              </h3>
              <p className="text-sm text-slate-300">
                Across {td.n.toLocaleString()} scoring chances, we predicted a
                player would score in about{" "}
                <b>{(td.predictedScoreRate * 100).toFixed(0)}%</b> of them; in
                reality it happened{" "}
                <b>{(td.actualScoreRate * 100).toFixed(0)}%</b> of the time.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {Math.abs(td.predictedScoreRate - td.actualScoreRate) <= 0.05
                  ? "Those two numbers are close — the touchdown odds were well calibrated."
                  : "Those two numbers are noticeably apart — touchdown odds are the hardest thing here to call, since scoring is mostly luck game-to-game."}
              </p>
            </section>
          )}

          {!byWeek && tdCount && tdCount.n > 0 && (
            <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-200">
                Touchdowns: did we call it right?
              </h3>
              <p className="text-sm text-slate-300">
                Over the season, our touchdown counts were typically off by
                about <b>{tdCount.mae.toFixed(1)}</b> touchdown per player, and{" "}
                {Number.isFinite(tdCount.spearman)
                  ? `ranked the league's top scorers with a ${tdCount.spearman.toFixed(
                      2
                    )} correlation to what actually happened.`
                  : "there wasn't enough spread in the data to judge the ranking."}
              </p>
            </section>
          )}

          <p className="text-xs text-slate-500">
            Want the full statistical detail behind these numbers? See the{" "}
            <b>Calibration</b>, <b>Coverage &amp; Intervals</b>, and{" "}
            <b>Conditional</b> tabs.
          </p>
        </>
      )}
    </div>
  );
}
