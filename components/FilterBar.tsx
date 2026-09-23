"use client";

import type { Position } from "@/lib/types";
import type { Filters, FantasyRanks } from "@/lib/aggregate";

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];

export default function FilterBar({
  filters,
  setFilters,
  weeks,
  teams,
  byWeek,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  weeks: number[];
  teams: string[];
  byWeek: boolean;
}) {
  const update = (patch: Partial<Filters>) =>
    setFilters({ ...filters, ...patch });

  const togglePos = (p: Position) => {
    const next = new Set(filters.positions);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    if (next.size === 0) return; // keep at least one
    update({ positions: next });
  };

  const minWeek = weeks[0];
  const maxWeek = weeks[weeks.length - 1];
  // Season volumes are full-year totals, so the sliders need a much larger range.
  const volMax = byWeek ? 20 : 300;

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">
          Position
        </label>
        <div className="flex gap-1">
          {POSITIONS.map((p) => {
            const on = filters.positions.has(p);
            return (
              <button
                key={p}
                onClick={() => togglePos(p)}
                className={`rounded px-3 py-1 text-sm font-medium transition ${
                  on
                    ? "bg-brand-red text-white"
                    : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                }`}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      {byWeek && (
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">
            Week range: {filters.weekMin}–{filters.weekMax}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={minWeek}
              max={maxWeek}
              value={filters.weekMin}
              onChange={(e) =>
                update({
                  weekMin: Math.min(Number(e.target.value), filters.weekMax),
                })
              }
              className="w-28 accent-brand-red"
            />
            <input
              type="range"
              min={minWeek}
              max={maxWeek}
              value={filters.weekMax}
              onChange={(e) =>
                update({
                  weekMax: Math.max(Number(e.target.value), filters.weekMin),
                })
              }
              className="w-28 accent-brand-red"
            />
          </div>
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">
          Team
        </label>
        <select
          value={filters.teams.size === 1 ? [...filters.teams][0] : ""}
          onChange={(e) =>
            update({
              teams: e.target.value ? new Set([e.target.value]) : new Set(),
            })
          }
          className="rounded bg-slate-800 px-2 py-1 text-sm text-slate-200"
        >
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">
          Min actual volume: {filters.minVolume}
        </label>
        <input
          type="range"
          min={0}
          max={volMax}
          value={filters.minVolume}
          onChange={(e) => update({ minVolume: Number(e.target.value) })}
          className="w-40 accent-brand-red"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">
          Min projected volume: {filters.minProjVolume}
        </label>
        <input
          type="range"
          min={0}
          max={volMax}
          value={filters.minProjVolume}
          onChange={(e) => update({ minProjVolume: Number(e.target.value) })}
          className="w-40 accent-brand-red"
        />
      </div>

      {byWeek && (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={filters.excludeInjury}
            onChange={(e) => update({ excludeInjury: e.target.checked })}
            className="h-4 w-4 accent-brand-red"
          />
          Exclude low-usage / injury-suspect games
        </label>
      )}

      <label
        className="flex cursor-pointer items-center gap-2 text-sm text-slate-300"
        title={fantasyRanksLabel(filters.fantasyRanks)}
      >
        <input
          type="checkbox"
          checked={filters.fantasyOnly}
          onChange={(e) => update({ fantasyOnly: e.target.checked })}
          className="h-4 w-4 accent-brand-red"
        />
        Fantasy-relevant players only
        <span className="text-xs text-slate-500">
          ({fantasyRanksLabel(filters.fantasyRanks)})
        </span>
      </label>
    </div>
  );
}

// "all QB, top 50 RB / 60 WR / 40 TE" — reads the thresholds out of the
// dataset rather than restating them, so the label can't drift from the build.
function fantasyRanksLabel(ranks: FantasyRanks): string {
  const order: Position[] = ["QB", "RB", "WR", "TE"];
  const parts = order
    .filter((p) => p in ranks)
    .map((p) => (ranks[p] == null ? `all ${p}` : `top ${ranks[p]} ${p}`));
  return parts.length ? parts.join(" / ") + ", by projected PPR" : "by projected PPR";
}
