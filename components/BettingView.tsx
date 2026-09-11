"use client";

import { useEffect, useMemo, useState } from "react";
import Explainer from "./Explainer";

interface Bet {
  season: number;
  week: number;
  playerId: string;
  name: string;
  team: string;
  pos: string;
  opp: string;
  stat: string;
  book: string;
  line: number;
  odds: number;
  impliedProb: number;
  ourProb: number;
  edge: number;
  edgeBucket: string;
  flatStakeUnits: number;
  kellyStakeUnits: number;
  status: "pending" | "won" | "lost" | string;
  actual: number | null;
  pnlFlatUnits: number | null;
  pnlKellyUnits: number | null;
}

interface Rollup {
  nTotal: number;
  nGraded: number;
  nPending: number;
  winRate: number | null;
  avgEdge: number | null;
  flatStaked: number;
  flatPnl: number;
  flatRoi: number | null;
  kellyStaked: number;
  kellyPnl: number;
  kellyRoi: number | null;
}

interface BettingDataset {
  meta: { generatedAt: string; season: number | null; minEdgeAssumed: number; counts: { bets: number } };
  overall: Rollup;
  byStat: (Rollup & { stat: string })[];
  byEdgeBucket: (Rollup & { bucket: string })[];
  bets: Bet[];
}

const STAT_LABELS: Record<string, string> = {
  anytimeTD: "Anytime TD",
  passYds: "Pass Yards",
  passAtt: "Pass Attempts",
  completions: "Completions",
  passTD: "Pass TD",
  int: "Interceptions",
  rushYds: "Rush Yards",
  rushAtt: "Rush Attempts",
  rushTD: "Rush TD",
  receptions: "Receptions",
  recYds: "Rec Yards",
  recTD: "Rec TD",
};

const pct = (n: number | null, d = 1) => (n === null ? "—" : `${(n * 100).toFixed(d)}%`);
const units = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}u`;

export default function BettingView() {
  const [ds, setDs] = useState<BettingDataset | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [statFilter, setStatFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  useEffect(() => {
    fetch("/data/betting.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: BettingDataset) => setDs(data))
      .catch((e) => setErr(String(e)));
  }, []);

  const filteredBets = useMemo(() => {
    if (!ds) return [];
    return ds.bets.filter(
      (b) => (statFilter === "all" || b.stat === statFilter) && (statusFilter === "all" || b.status === statusFilter)
    );
  }, [ds, statFilter, statusFilter]);

  if (err)
    return (
      <main className="p-4 text-red-400">
        Failed to load betting data: {err}. Run <code>npm run build:betting</code>.
      </main>
    );
  if (!ds) return <div className="p-4 text-slate-400">Loading paper-trading data…</div>;

  if (ds.meta.counts.bets === 0) {
    return (
      <div className="space-y-6">
        <PaperTradingExplainer />
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-center text-sm text-slate-400">
          No bets captured yet. Run <code className="text-slate-300">npm run capture-props</code> for a week with a
          projections snapshot already ingested.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PaperTradingExplainer />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card title="Bets" value={ds.overall.nTotal.toString()} sub={`${ds.overall.nGraded} graded, ${ds.overall.nPending} pending`} />
        <Card title="Win rate" value={pct(ds.overall.winRate)} sub="of graded bets" />
        <Card title="Avg edge" value={pct(ds.overall.avgEdge, 1)} sub="model vs. best price" />
        <Card
          title="Flat ROI"
          value={pct(ds.overall.flatRoi)}
          sub={`${units(ds.overall.flatPnl)} on ${ds.overall.flatStaked.toFixed(1)}u staked`}
          tone={ds.overall.flatPnl}
        />
        <Card
          title="Kelly ROI"
          value={pct(ds.overall.kellyRoi)}
          sub={`${units(ds.overall.kellyPnl)} on ${ds.overall.kellyStaked.toFixed(1)}u staked`}
          tone={ds.overall.kellyPnl}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RollupTable title="By stat" rows={ds.byStat.map((r) => ({ label: STAT_LABELS[r.stat] ?? r.stat, ...r }))} />
        <RollupTable title="By edge size" rows={ds.byEdgeBucket.map((r) => ({ label: r.bucket, ...r }))} />
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900/60">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-200">Bet log</h3>
          <div className="flex flex-wrap gap-2">
            <select
              value={statFilter}
              onChange={(e) => setStatFilter(e.target.value)}
              className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300"
            >
              <option value="all">All stats</option>
              {ds.byStat.map((r) => (
                <option key={r.stat} value={r.stat}>
                  {STAT_LABELS[r.stat] ?? r.stat}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
          </div>
        </div>
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-900">
              <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2">Wk</th>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2">Stat</th>
                <th className="px-3 py-2 text-right">Line</th>
                <th className="px-3 py-2">Book</th>
                <th className="px-3 py-2 text-right">Odds</th>
                <th className="px-3 py-2 text-right">Our %</th>
                <th className="px-3 py-2 text-right">Mkt %</th>
                <th className="px-3 py-2 text-right">Edge</th>
                <th className="px-3 py-2 text-right">Actual</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">PnL (flat/Kelly)</th>
              </tr>
            </thead>
            <tbody>
              {filteredBets.map((b, i) => (
                <tr key={`${b.playerId}-${b.stat}-${b.week}-${i}`} className="border-b border-slate-800/40 hover:bg-slate-800/40">
                  <td className="px-3 py-2 tabular-nums text-slate-400">{b.week}</td>
                  <td className="px-3 py-2 text-slate-200">
                    {b.name} <span className="text-slate-500">({b.team})</span>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{STAT_LABELS[b.stat] ?? b.stat}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{b.line}</td>
                  <td className="px-3 py-2 text-slate-400">{b.book}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                    {b.odds > 0 ? `+${b.odds}` : b.odds}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-blue-300">{pct(b.ourProb)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">{pct(b.impliedProb)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-300">{pct(b.edge)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{b.actual ?? "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {b.pnlFlatUnits === null ? (
                      "—"
                    ) : (
                      <>
                        <span className={b.pnlFlatUnits >= 0 ? "text-green-400" : "text-red-400"}>
                          {units(b.pnlFlatUnits)}
                        </span>
                        {" / "}
                        <span className={b.pnlKellyUnits! >= 0 ? "text-green-400" : "text-red-400"}>
                          {units(b.pnlKellyUnits!)}
                        </span>
                      </>
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

function PaperTradingExplainer() {
  return (
    <Explainer title="Paper trading: methodology & caveats">
      <p>
        Every Wednesday morning, prop lines are pulled from RotoWire across ~9
        books for the tracked stats (Anytime TD, Pass/Rush Yards &amp;
        Attempts, Completions, Receptions, Rec Yards, and each TD/turnover
        count). Each price is compared against a probability derived from{" "}
        <b>our own Floor/Median/Ceiling projection</b> for that player-week —
        not RotoWire&apos;s own point projection, which is captured only for
        reference.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>Yardage/attempt/completion/reception props</b> use a two-piece
          normal fit through the Floor (25th pct), Median (50th), and Ceiling
          (75th) — preserving whatever skew the projection already implies.
        </li>
        <li>
          <b>TD &amp; turnover-count props</b> use a Poisson model off the
          projected count (same approach as the Touchdowns tab), but a raw
          median count has no Floor/Ceiling of its own to guard against a
          backup&apos;s tiny, volatile role — below 3 projected touches the
          prop isn&apos;t priced at all, and up to 8 touches the count is
          shrunk toward the more conservative Floor estimate.
        </li>
        <li>
          <b>Edge</b> = our probability − the best available price&apos;s
          implied probability. Every market here is single-sided (the feed
          only ever surfaces one price, no opposing side), so this is edge
          against a vig-included market price, not a de-vigged fair line. TD
          picks additionally need our probability at least 1.3x the
          market&apos;s — a fixed point gap is too easy to clear from noise
          alone at the long odds backups get quoted.
        </li>
        <li>
          <b>Sizing</b>: bets clearing a 3% edge are staked two ways — a flat 1
          unit (clean for judging whether edge size predicts win rate) and a
          quarter-Kelly stake capped at 3 units. 1 unit = 1% of bankroll.
        </li>
      </ul>
    </Explainer>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "won"
      ? "bg-green-900/60 text-green-300"
      : status === "lost"
      ? "bg-red-900/60 text-red-300"
      : "bg-slate-800 text-slate-400";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{status}</span>;
}

function Card({ title, value, sub, tone }: { title: string; value: string; sub: string; tone?: number }) {
  const toneClass = tone === undefined ? "text-slate-100" : tone >= 0 ? "text-green-300" : "text-red-300";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="text-xs font-medium text-slate-400">{title}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}

function RollupTable({ title, rows }: { title: string; rows: (Rollup & { label: string })[] }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-2 py-1.5">{title === "By stat" ? "Stat" : "Edge"}</th>
              <th className="px-2 py-1.5 text-right">N</th>
              <th className="px-2 py-1.5 text-right">Win%</th>
              <th className="px-2 py-1.5 text-right">Flat ROI</th>
              <th className="px-2 py-1.5 text-right">Kelly ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-slate-800/40">
                <td className="px-2 py-1.5 text-slate-300">{r.label}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{r.nTotal}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">{pct(r.winRate)}</td>
                <td
                  className={`px-2 py-1.5 text-right tabular-nums ${
                    r.flatRoi === null ? "text-slate-500" : r.flatRoi >= 0 ? "text-green-300" : "text-red-300"
                  }`}
                >
                  {pct(r.flatRoi)}
                </td>
                <td
                  className={`px-2 py-1.5 text-right tabular-nums ${
                    r.kellyRoi === null ? "text-slate-500" : r.kellyRoi >= 0 ? "text-green-300" : "text-red-300"
                  }`}
                >
                  {pct(r.kellyRoi)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2 py-3 text-center text-slate-500">
                  No data yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
