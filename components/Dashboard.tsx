"use client";

import { useEffect, useMemo, useState } from "react";
import type { Dataset, Position } from "@/lib/types";
import {
  filterRows,
  scatterFor,
  summarizeAll,
  type Filters,
} from "@/lib/aggregate";
import { conditional, deepStats } from "@/lib/stats";
import { filterTd } from "@/lib/td";
import FilterBar from "./FilterBar";
import CalibrationView from "./CalibrationView";
import ScatterView from "./ScatterView";
import ExplorerView from "./ExplorerView";
import CoverageView from "./CoverageView";
import ConditionalView from "./ConditionalView";
import TDView from "./TDView";

type Tab =
  | "calibration"
  | "coverage"
  | "conditional"
  | "touchdowns"
  | "scatter"
  | "explorer";

type Scope = "weekly" | "season";

export default function Dashboard() {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("weekly");
  const [tab, setTab] = useState<Tab>("calibration");
  const [metricKey, setMetricKey] = useState<string>("targets");
  const [tdKey, setTdKey] = useState<string>("recTD");
  const [filters, setFilters] = useState<Filters | null>(null);

  useEffect(() => {
    fetch("/data/dashboard.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Dataset) => {
        setDs(data);
        setFilters({
          weekMin: data.meta.weeks[0],
          weekMax: data.meta.weeks[data.meta.weeks.length - 1],
          positions: new Set<Position>(data.meta.positions),
          teams: new Set<string>(),
          minVolume: 0,
          minProjVolume: 0,
          excludeInjury: false,
        });
      })
      .catch((e) => setErr(String(e)));
  }, []);

  const byWeek = scope === "weekly";

  // The active dataset (rows / TD / metric+type metadata / teams) for the scope.
  const active = useMemo(() => {
    if (!ds) return null;
    return scope === "weekly"
      ? {
          rows: ds.rows,
          td: ds.td,
          metrics: ds.meta.metrics,
          tdTypes: ds.meta.tdTypes,
          teams: ds.meta.teams,
        }
      : {
          rows: ds.season.rows,
          td: ds.season.td,
          metrics: ds.season.metrics,
          tdTypes: ds.season.tdTypes,
          teams: ds.season.teams,
        };
  }, [ds, scope]);

  const filteredRows = useMemo(
    () => (active && filters ? filterRows(active.rows, filters, byWeek) : []),
    [active, filters, byWeek]
  );

  // Metrics available given the selected positions.
  const availableMetrics = useMemo(() => {
    if (!active || !filters) return [];
    return active.metrics.filter((m) =>
      m.positions.some((p) => filters.positions.has(p))
    );
  }, [active, filters]);

  const summaries = useMemo(
    () =>
      ds && filters
        ? summarizeAll(filteredRows, availableMetrics, filters.minVolume)
        : [],
    [ds, filters, filteredRows, availableMetrics]
  );

  const selectedMetric = useMemo(
    () => availableMetrics.find((m) => m.key === metricKey) ?? availableMetrics[0],
    [availableMetrics, metricKey]
  );

  const scatterPts = useMemo(
    () =>
      ds && filters && selectedMetric
        ? scatterFor(filteredRows, selectedMetric, filters.minVolume, filters.minProjVolume)
        : [],
    [ds, filters, filteredRows, selectedMetric]
  );

  const deepAll = useMemo(
    () =>
      ds && filters
        ? availableMetrics
            .map((m) => deepStats(filteredRows, m, filters.minVolume, filters.minProjVolume))
            .filter((s): s is NonNullable<typeof s> => s !== null)
        : [],
    [ds, filters, filteredRows, availableMetrics]
  );

  const selectedDeep = useMemo(
    () =>
      ds && filters && selectedMetric
        ? deepStats(filteredRows, selectedMetric, filters.minVolume, filters.minProjVolume)
        : null,
    [ds, filters, filteredRows, selectedMetric]
  );

  const cond = useMemo(
    () =>
      ds && filters && selectedMetric
        ? conditional(filteredRows, selectedMetric, filters.minVolume, filters.minProjVolume)
        : null,
    [ds, filters, filteredRows, selectedMetric]
  );

  // Touchdown types available for the selected positions.
  const availableTdTypes = useMemo(() => {
    if (!active || !filters) return [];
    return active.tdTypes.filter((t) =>
      t.positions.some((p) => filters.positions.has(p))
    );
  }, [active, filters]);

  const selectedTdType = useMemo(
    () => availableTdTypes.find((t) => t.key === tdKey) ?? availableTdTypes[0],
    [availableTdTypes, tdKey]
  );

  const tdRows = useMemo(
    () =>
      active && filters && selectedTdType
        ? filterTd(active.td, selectedTdType.key, filters, byWeek)
        : [],
    [active, filters, selectedTdType, byWeek]
  );

  if (err)
    return (
      <main className="p-8 text-red-400">
        Failed to load data: {err}. Run <code>npm run build:data</code>.
      </main>
    );
  if (!ds || !filters)
    return <main className="p-8 text-slate-400">Loading projections…</main>;

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">
              NFL Projection Accuracy Dashboard
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {ds.meta.season} season · comparing projected Floor/Median/Ceiling
              ranges to actual results. Floor &amp; Ceiling = 25th / 75th
              percentile.
            </p>
          </div>
          {/* Scope toggle: weekly per-game projections vs. full-season projections. */}
          <div className="flex overflow-hidden rounded-lg border border-slate-700">
            {(
              [
                ["weekly", "Weekly"],
                ["season", "Season-long"],
              ] as [Scope, string][]
            ).map(([s, label]) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-4 py-2 text-sm font-semibold transition ${
                  scope === s
                    ? "bg-blue-600 text-white"
                    : "bg-slate-900 text-slate-400 hover:bg-slate-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-400">
          {byWeek ? (
            <>
              <Stat label="Player-weeks" value={ds.meta.counts.emittedRows.toLocaleString()} />
              <Stat label="Matched" value={ds.meta.counts.matchedPlayerWeeks.toLocaleString()} />
              <Stat label="Injury-suspect" value={ds.meta.counts.injurySuspect.toString()} />
            </>
          ) : (
            <>
              <Stat label="Players" value={ds.season.counts.emittedRows.toLocaleString()} />
              <Stat label="Matched" value={ds.season.counts.matchedPlayers.toLocaleString()} />
            </>
          )}
          <Stat label="Metrics" value={availableMetrics.length.toString()} />
        </div>
      </header>

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        weeks={ds.meta.weeks}
        teams={active?.teams ?? []}
        byWeek={byWeek}
      />

      <div className="flex gap-1 border-b border-slate-800">
        {(
          [
            ["calibration", "Calibration"],
            ["coverage", "Coverage & Intervals"],
            ["conditional", "Conditional"],
            ["touchdowns", "Touchdowns"],
            ["scatter", "Projected vs Actual"],
            ["explorer", byWeek ? "Player-week detail" : "Player detail"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === t
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== "calibration" && tab !== "touchdowns" && selectedMetric && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-400">Metric:</span>
          {availableMetrics.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetricKey(m.key)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                selectedMetric.key === m.key
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {tab === "touchdowns" && selectedTdType && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-400">TD type:</span>
          {availableTdTypes.map((t) => (
            <button
              key={t.key}
              onClick={() => setTdKey(t.key)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                selectedTdType.key === t.key
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "calibration" && <CalibrationView summaries={summaries} />}
      {tab === "coverage" && selectedMetric && (
        <CoverageView all={deepAll} selected={selectedDeep} metric={selectedMetric} />
      )}
      {tab === "conditional" && selectedMetric && cond && (
        <ConditionalView data={cond} metric={selectedMetric} showByWeek={byWeek} />
      )}
      {tab === "touchdowns" && selectedTdType && (
        <TDView rows={tdRows} type={selectedTdType} byWeek={byWeek} />
      )}
      {tab === "scatter" && selectedMetric && (
        <ScatterView points={scatterPts} metric={selectedMetric} />
      )}
      {tab === "explorer" && selectedMetric && (
        <ExplorerView
          rows={filteredRows}
          metric={selectedMetric}
          minVolume={filters.minVolume}
          minProjVolume={filters.minProjVolume}
        />
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-1.5">
      <span className="font-semibold text-slate-200">{value}</span>{" "}
      <span className="text-slate-500">{label}</span>
    </span>
  );
}
