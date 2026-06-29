"use client";

import { useMemo, useState } from "react";
import type { MetricMeta, Row } from "@/lib/types";
import { fmtValue } from "@/lib/format";
import Explainer from "./Explainer";

type SortKey = "wk" | "pid" | "miss" | "actual";

interface RowVM {
  pid: string;
  team: string;
  pos: string;
  wk: number;
  inj: boolean;
  f: number;
  m: number;
  c: number;
  a: number;
  within: boolean;
  miss: number; // signed distance outside band (0 if inside)
}

function BandBar({ vm }: { vm: RowVM }) {
  const lo = Math.min(vm.f, vm.c);
  const hi = Math.max(vm.f, vm.c);
  const span = Math.max(hi, vm.a, vm.m) * 1.1 || 1;
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / span) * 100))}%`;
  return (
    <div className="relative h-4 w-44 rounded bg-slate-800">
      {/* floor-ceiling band */}
      <div
        className="absolute top-0 h-full rounded bg-slate-600/70"
        style={{ left: pct(lo), width: pct(hi - lo) }}
      />
      {/* median tick */}
      <div
        className="absolute top-0 h-full w-0.5 bg-blue-400"
        style={{ left: pct(vm.m) }}
        title={`Median ${vm.m}`}
      />
      {/* actual marker */}
      <div
        className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
          vm.within ? "bg-green-400" : "bg-red-400"
        }`}
        style={{ left: pct(vm.a) }}
        title={`Actual ${vm.a}`}
      />
    </div>
  );
}

export default function ExplorerView({
  rows,
  metric,
  minVolume,
}: {
  rows: Row[];
  metric: MetricMeta;
  minVolume: number;
}) {
  const [sort, setSort] = useState<SortKey>("miss");
  const [asc, setAsc] = useState(false);

  const vms = useMemo<RowVM[]>(() => {
    const out: RowVM[] = [];
    for (const r of rows) {
      if (!metric.positions.includes(r.pos)) continue;
      const c = r.m[metric.key];
      if (!c || c.av < minVolume) continue;
      const lo = Math.min(c.f, c.c);
      const hi = Math.max(c.f, c.c);
      const miss = c.a < lo ? c.a - lo : c.a > hi ? c.a - hi : 0;
      out.push({
        pid: r.pid,
        team: r.team,
        pos: r.pos,
        wk: r.wk,
        inj: r.inj,
        f: lo,
        m: c.m,
        c: hi,
        a: c.a,
        within: c.in,
        miss,
      });
    }
    out.sort((x, y) => {
      let d = 0;
      if (sort === "miss") d = Math.abs(x.miss) - Math.abs(y.miss);
      else if (sort === "actual") d = x.a - y.a;
      else if (sort === "wk") d = x.wk - y.wk || x.pid.localeCompare(y.pid);
      else d = x.pid.localeCompare(y.pid);
      return asc ? d : -d;
    });
    return out.slice(0, 300);
  }, [rows, metric, minVolume, sort, asc]);

  const setSortKey = (k: SortKey) => {
    if (k === sort) setAsc(!asc);
    else {
      setSort(k);
      setAsc(false);
    }
  };

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th
      onClick={() => setSortKey(k)}
      className="cursor-pointer select-none px-3 py-2 hover:text-slate-200"
    >
      {children}
      {sort === k ? (asc ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <div className="space-y-6">
      <Explainer title="What this shows & how to read it" defaultOpen={false}>
        <p>
          The raw detail behind every chart. Each row is one player-week for{" "}
          <b>{metric.label}</b>, showing the projected Floor / Median / Ceiling
          and what actually happened. The <b>Band</b> column draws it: the grey
          bar is the Floor–Ceiling range, the blue tick is the Median, and the
          dot is the actual — <b>green</b> inside the band, <b>red</b> outside.
        </p>
        <p className="text-slate-400">
          Sort by <b>Result</b> to surface the biggest misses, or by Week /
          Actual. <span className="text-amber-300">inj?</span> flags a likely
          in-game injury or benching (played far less than projected). Use it to
          find specific players or weeks worth investigating.
        </p>
      </Explainer>

      <div className="rounded-lg border border-slate-800 bg-slate-900/60">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-200">
          Player-week detail — {metric.label}
        </h3>
        <span className="text-xs text-slate-400">
          {vms.length} shown {vms.length === 300 ? "(capped at 300)" : ""}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-400">
              <Th k="pid">Player</Th>
              <th className="px-3 py-2">Tm</th>
              <Th k="wk">Wk</Th>
              <th className="px-3 py-2 text-right">Floor</th>
              <th className="px-3 py-2 text-right">Median</th>
              <th className="px-3 py-2 text-right">Ceiling</th>
              <Th k="actual">Actual</Th>
              <th className="px-3 py-2">Band</th>
              <Th k="miss">Result</Th>
            </tr>
          </thead>
          <tbody>
            {vms.map((vm, i) => (
              <tr
                key={`${vm.pid}-${vm.wk}-${i}`}
                className="border-b border-slate-800/40 hover:bg-slate-800/40"
              >
                <td className="px-3 py-2 font-mono text-xs text-slate-300">
                  #{vm.pid}{" "}
                  {vm.inj && (
                    <span
                      title="Low-usage / possible in-game injury"
                      className="ml-1 rounded bg-amber-900/60 px-1 text-[10px] text-amber-300"
                    >
                      inj?
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-400">{vm.team}</td>
                <td className="px-3 py-2 tabular-nums text-slate-400">
                  {vm.wk}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                  {fmtValue(vm.f, metric.unit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-blue-300">
                  {fmtValue(vm.m, metric.unit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                  {fmtValue(vm.c, metric.unit)}
                </td>
                <td
                  className={`px-3 py-2 text-right font-semibold tabular-nums ${
                    vm.within ? "text-green-300" : "text-red-300"
                  }`}
                >
                  {fmtValue(vm.a, metric.unit)}
                </td>
                <td className="px-3 py-2">
                  <BandBar vm={vm} />
                </td>
                <td className="px-3 py-2 text-xs">
                  {vm.within ? (
                    <span className="text-green-400">in band</span>
                  ) : vm.miss < 0 ? (
                    <span className="text-red-400">below floor</span>
                  ) : (
                    <span className="text-blue-400">above ceiling</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}
