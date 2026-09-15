"use client";

import { useEffect, useMemo, useState } from "react";
import Explainer from "./Explainer";

// The Paper Trading tab reads public/data/betting.json, which holds one entry
// per simulated bettor. See scripts/lib/personas.mjs for what the personas are
// and why they exist.
//
// The presentational rule this component exists to enforce: the BENCHMARK
// persona (the firehose, which takes every qualifying edge) is the only one
// whose ROI carries statistical weight. Every other persona places a realistic
// handful of bets a week, which leaves its return dominated by noise. They are
// shown with their confidence band attached and labelled as illustrative,
// because a bare "-18.8%" next to a bare "-4.0%" reads as though the two are
// comparable measurements, and they are not.

interface Evidence {
  n: number;
  roiStdErr: number | null;
  roiBand95: number | null;
  sufficient: boolean;
}

interface Clv {
  n: number;
  nMatched: number;
  nLineMoved: number;
  nNotFound: number;
  beatRate: number | null;
  avgClvProb: number | null;
  avgClvPct: number | null;
  lineMovedToward: number;
  lineMovedAgainst: number;
}

interface Rollup {
  nTotal: number;
  nGraded: number;
  nPending: number;
  nPush: number;
  winRate: number | null;
  avgEdge: number | null;
  avgModelEdge: number | null;
  avgHold: number | null;
  staked: number;
  pnl: number;
  roi: number | null;
  evidence: Evidence;
  clv: Clv | null;
}

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
  side: string;
  odds: number;
  impliedProb: number | null;
  fairProb: number | null;
  hold: number | null;
  oneSided: boolean;
  ourProb: number | null;
  edge: number | null;
  modelEdge: number | null;
  edgeBucket: string;
  stakeUnits: number;
  status: string;
  actual: number | null;
  pnlUnits: number | null;
  clvStatus: string | null;
  clvProb: number | null;
  source: string;
}

interface Persona {
  id: string;
  label: string;
  description: string;
  rules: {
    books: string[] | string;
    minEdge: number;
    maxBetsPerWeek: number | null;
    select: string;
    staking: { kind: string; units?: number; fraction?: number; cap?: number };
    bankroll: { kind: string; units?: number };
    requireTwoSided: boolean;
    edgeBasis: string;
  };
  isBenchmark: boolean;
  overall: Rollup;
  byStat: (Rollup & { stat: string })[];
  byEdgeBucket: (Rollup & { bucket: string })[];
  bySide: (Rollup & { side: string })[];
  byWeek: { week: number; bets: number; pnl: number; bankroll: number }[];
  bets: Bet[];
}

interface BettingDataset {
  meta: {
    generatedAt: string;
    season: number | null;
    startingBankrollUnits: number;
    note: string;
    counts: { personas: number; bets: number; benchmarkBets: number };
  };
  personas: Persona[];
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

const pct = (n: number | null | undefined, d = 1) =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(d)}%`;
const units = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}u`;

export default function BettingView() {
  const [ds, setDs] = useState<BettingDataset | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [statFilter, setStatFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    fetch("/data/betting.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: BettingDataset) => {
        setDs(data);
        // Open on the benchmark: it is the one with enough bets to mean
        // anything, so it should be what a visitor sees first.
        setPersonaId(data.personas.find((p) => p.isBenchmark)?.id ?? data.personas[0]?.id ?? null);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  const persona = useMemo(
    () => ds?.personas.find((p) => p.id === personaId) ?? null,
    [ds, personaId]
  );

  const filteredBets = useMemo(() => {
    if (!persona) return [];
    return persona.bets.filter(
      (b) =>
        (statFilter === "all" || b.stat === statFilter) &&
        (statusFilter === "all" || b.status === statusFilter)
    );
  }, [persona, statFilter, statusFilter]);

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
          No bets yet. Run <code className="text-slate-300">npm run capture-props</code> to publish a
          week&apos;s edges, then <code className="text-slate-300">npm run simulate</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PaperTradingExplainer />

      <PersonaPicker
        personas={ds.personas}
        selected={personaId}
        onSelect={(id) => {
          setPersonaId(id);
          setStatFilter("all");
          setStatusFilter("all");
        }}
      />

      {persona && (
        <>
          <PersonaHeader persona={persona} />
          <Scorecard persona={persona} />
          {persona.byWeek.length > 1 && <WeeklyPath persona={persona} />}

          <div className="grid gap-4 lg:grid-cols-2">
            <RollupTable
              title="By stat"
              firstCol="Stat"
              rows={persona.byStat.map((r) => ({ label: STAT_LABELS[r.stat] ?? r.stat, ...r }))}
            />
            <RollupTable
              title="By edge size"
              firstCol="Edge"
              rows={persona.byEdgeBucket.map((r) => ({ label: r.bucket, ...r }))}
            />
          </div>

          {persona.bets.length > 0 && (
            <BetTable
              bets={filteredBets}
              persona={persona}
              statFilter={statFilter}
              statusFilter={statusFilter}
              onStat={setStatFilter}
              onStatus={setStatusFilter}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---- Persona selection -------------------------------------------------------
function PersonaPicker({
  personas,
  selected,
  onSelect,
}: {
  personas: Persona[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {personas.map((p) => {
        const active = p.id === selected;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
              active
                ? "border-blue-500 bg-blue-500/10 text-slate-100"
                : "border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700"
            }`}
          >
            <div className="flex items-center gap-1.5 font-medium">
              {p.label}
              {p.isBenchmark && (
                <span className="rounded bg-blue-900/70 px-1 py-0.5 text-[10px] text-blue-300">
                  benchmark
                </span>
              )}
            </div>
            <div className="mt-0.5 tabular-nums text-[11px] text-slate-500">
              {p.overall.nTotal} bets · {pct(p.overall.roi)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PersonaHeader({ persona }: { persona: Persona }) {
  const r = persona.rules;
  const chips: string[] = [
    Array.isArray(r.books) ? `${r.books.length} book${r.books.length === 1 ? "" : "s"}` : "all books",
    `min edge ${pct(r.minEdge, 0)}`,
    r.maxBetsPerWeek ? `≤${r.maxBetsPerWeek} bets/wk` : "no bet cap",
    r.staking.kind === "kelly"
      ? `${r.staking.fraction ? r.staking.fraction * 100 : 25}% Kelly`
      : r.staking.kind === "flat"
      ? `flat ${r.staking.units ?? 1}u`
      : r.staking.kind,
    r.bankroll.kind === "weekly-budget" ? `${r.bankroll.units}u/wk budget` : r.bankroll.kind,
  ];
  if (r.requireTwoSided) chips.push("two-sided only");

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="text-sm font-semibold text-slate-200">{persona.label}</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">{persona.description}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span key={c} className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-400">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Headline numbers --------------------------------------------------------
function Scorecard({ persona }: { persona: Persona }) {
  const o = persona.overall;
  const band = o.evidence.roiBand95;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card
          title="Bets"
          value={o.nTotal.toString()}
          sub={`${o.nGraded} graded, ${o.nPending} pending`}
        />
        <Card title="Win rate" value={pct(o.winRate)} sub="of decided bets" />
        <Card
          title="ROI"
          value={pct(o.roi)}
          sub={band === null ? "not enough bets" : `±${pct(band)} at 95%`}
          tone={o.roi}
        />
        <Card title="P&L" value={units(o.pnl)} sub={`on ${o.staked.toFixed(0)}u staked`} tone={o.pnl} />
      </div>

      {/* The confidence band is the most important thing on this screen when
          the sample is small, so it gets its own line rather than a footnote. */}
      {!o.evidence.sufficient && o.evidence.n > 0 && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs leading-relaxed text-amber-200/90">
          <b>Illustrative, not conclusive.</b> {o.evidence.n} graded bets puts the 95% band on this
          ROI at roughly ±{pct(band)}, which is wider than any edge a real model would produce. This
          shows what the strategy would have <i>felt</i> like
          {persona.isBenchmark
            ? ". Even the benchmark needs a few hundred more bets before its return separates from zero."
            : "; the benchmark persona is the one with enough volume to test whether the projections work."}
        </div>
      )}

      {o.clv && (
        <ClvPanel clv={o.clv} />
      )}
    </>
  );
}

// Closing Line Value: the evidence that does NOT depend on bets winning.
function ClvPanel({ clv }: { clv: Clv }) {
  const good = (clv.beatRate ?? 0) > 0.5;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Closing line value</h3>
        <span className={`text-lg font-semibold tabular-nums ${good ? "text-green-300" : "text-red-300"}`}>
          {pct(clv.beatRate)}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        Share of bets whose price beat the closing line, across {clv.nMatched} measurable markets.
        Above 50% sustained means the model is reaching prices before the market does — the strongest
        evidence available that the projections carry real information, and unlike ROI it does not
        depend on whether the bets happened to win. Average movement{" "}
        <span className="tabular-nums text-slate-300">
          {clv.avgClvProb === null ? "—" : `${clv.avgClvProb >= 0 ? "+" : ""}${(clv.avgClvProb * 100).toFixed(2)}pts`}
        </span>
        .
      </p>
      {(clv.nLineMoved > 0 || clv.nNotFound > 0) && (
        <p className="mt-2 text-[11px] text-slate-500">
          {clv.nLineMoved > 0 && (
            <>
              {clv.nLineMoved} markets closed at a different number ({clv.lineMovedToward} moved our
              way, {clv.lineMovedAgainst} against) — direction only, no price comparison.{" "}
            </>
          )}
          {clv.nNotFound > 0 && <>{clv.nNotFound} markets were gone by kickoff.</>}
        </p>
      )}
    </div>
  );
}

function WeeklyPath({ persona }: { persona: Persona }) {
  const compounding = persona.rules.bankroll.kind === "compounding";
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <div className="border-b border-slate-800 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-300">
        {compounding ? "Bankroll by week" : "Cumulative P&L by week"}
      </div>
      <table className="w-full text-xs">
        <thead className="bg-slate-900/60 text-left text-slate-400">
          <tr>
            <th className="px-3 py-1.5">Week</th>
            <th className="px-3 py-1.5 text-right">Bets</th>
            <th className="px-3 py-1.5 text-right">P&amp;L</th>
            <th className="px-3 py-1.5 text-right">{compounding ? "Bankroll" : "Running"}</th>
          </tr>
        </thead>
        <tbody>
          {persona.byWeek.map((w) => (
            <tr key={w.week} className="border-b border-slate-800/40">
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{w.week}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">{w.bets}</td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  w.pnl >= 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                {units(w.pnl)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-300">
                {w.bankroll.toFixed(1)}u
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Tables ------------------------------------------------------------------
function RollupTable({
  title,
  firstCol,
  rows,
}: {
  title: string;
  firstCol: string;
  rows: (Rollup & { label: string })[];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <div className="border-b border-slate-800 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-300">
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-left text-slate-400">
            <tr>
              <th className="px-2 py-1.5">{firstCol}</th>
              <th className="px-2 py-1.5 text-right">N</th>
              <th className="px-2 py-1.5 text-right">Win%</th>
              <th className="px-2 py-1.5 text-right">ROI</th>
              <th className="px-2 py-1.5 text-right">P&amp;L</th>
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
                    r.roi === null ? "text-slate-500" : r.roi >= 0 ? "text-green-400" : "text-red-400"
                  }`}
                  // A per-stat slice is even smaller than the persona's total,
                  // so its band is wider still. Surface it on hover rather than
                  // cluttering every row.
                  title={
                    r.evidence.roiBand95 === null
                      ? "too few bets to estimate"
                      : `95% band ±${pct(r.evidence.roiBand95)} on ${r.evidence.n} graded bets`
                  }
                >
                  {pct(r.roi)}
                </td>
                <td
                  className={`px-2 py-1.5 text-right tabular-nums ${
                    r.pnl >= 0 ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {units(r.pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BetTable({
  bets,
  persona,
  statFilter,
  statusFilter,
  onStat,
  onStatus,
}: {
  bets: Bet[];
  persona: Persona;
  statFilter: string;
  statusFilter: string;
  onStat: (v: string) => void;
  onStatus: (v: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-2">
        <span className="text-xs font-medium text-slate-300">Bet log</span>
        <select
          value={statFilter}
          onChange={(e) => onStat(e.target.value)}
          className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300"
        >
          <option value="all">All stats</option>
          {persona.byStat.map((r) => (
            <option key={r.stat} value={r.stat}>
              {STAT_LABELS[r.stat] ?? r.stat}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => onStatus(e.target.value)}
          className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300"
        >
          <option value="all">All statuses</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
          <option value="push">Push</option>
          <option value="pending">Pending</option>
        </select>
        <span className="ml-auto text-[11px] text-slate-500">{bets.length} shown</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-left text-slate-400">
            <tr>
              <th className="px-3 py-2">Wk</th>
              <th className="px-3 py-2">Player</th>
              <th className="px-3 py-2">Stat</th>
              <th className="px-3 py-2 text-right">Line</th>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2">Book</th>
              <th className="px-3 py-2 text-right">Odds</th>
              <th className="px-3 py-2 text-right">Our %</th>
              <th className="px-3 py-2 text-right">Mkt %</th>
              <th className="px-3 py-2 text-right">Edge</th>
              <th className="px-3 py-2 text-right">Stake</th>
              <th className="px-3 py-2 text-right">Actual</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((b, i) => (
              <tr
                key={`${b.playerId}-${b.stat}-${b.week}-${i}`}
                className="border-b border-slate-800/40 hover:bg-slate-800/40"
              >
                <td className="px-3 py-2 tabular-nums text-slate-400">{b.week}</td>
                <td className="px-3 py-2 text-slate-200">
                  {b.name} <span className="text-slate-500">({b.team})</span>
                </td>
                <td className="px-3 py-2 text-slate-300">{STAT_LABELS[b.stat] ?? b.stat}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">{b.line}</td>
                <td className="px-3 py-2 text-slate-300">{b.side}</td>
                <td className="px-3 py-2 text-slate-400">{b.book}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                  {b.odds > 0 ? `+${b.odds}` : b.odds}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-blue-300">{pct(b.ourProb)}</td>
                <td
                  className="px-3 py-2 text-right tabular-nums text-slate-400"
                  title={
                    b.oneSided
                      ? "one-sided market — no opposing price, so no fair price could be derived"
                      : `raw ${pct(b.impliedProb)} (incl. vig) · no-vig ${pct(b.fairProb)}`
                  }
                >
                  {pct(b.impliedProb)}
                  {b.oneSided ? <span className="ml-1 text-amber-500/70">*</span> : null}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-300">
                  {pct(b.edge)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                  {b.stakeUnits.toFixed(2)}u
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">{b.actual ?? "—"}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={b.status} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {b.pnlUnits === null ? (
                    "—"
                  ) : (
                    <span className={b.pnlUnits >= 0 ? "text-green-400" : "text-red-400"}>
                      {units(b.pnlUnits)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "won"
      ? "bg-green-900/60 text-green-300"
      : status === "lost"
      ? "bg-red-900/60 text-red-300"
      : status === "push"
      ? "bg-amber-900/50 text-amber-300"
      : "bg-slate-800 text-slate-400";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{status}</span>;
}

function Card({
  title,
  value,
  sub,
  tone,
}: {
  title: string;
  value: string;
  sub: string;
  tone?: number | null;
}) {
  const toneClass =
    tone === undefined || tone === null
      ? "text-slate-100"
      : tone >= 0
      ? "text-green-300"
      : "text-red-300";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{title}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}

function PaperTradingExplainer() {
  return (
    <Explainer title="How the paper trading works">
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>The drop.</b> Every Tuesday morning the pipeline publishes every prop where our
          projection disagrees with a sportsbook by more than the edge bar. That published set is the
          product; everything below simulates people acting on it.
        </li>
        <li>
          <b>Our probability</b> comes from the Floor/Median/Ceiling projection — a two-piece normal
          for yardage and volume, a Poisson for touchdown and turnover counts.
        </li>
        <li>
          <b>Edge</b> = our probability − the price&apos;s raw implied probability. The raw number is
          the break-even point: at −110 you need 52.4%, not 50%, because the vig is a real cost.
          Markets marked <span className="text-amber-500/70">*</span> are quoted one-sided, so no
          de-vigged fair price could be derived.
        </li>
        <li>
          <b>The personas</b> exist because nobody tails four hundred edges a week. Each one has a
          book roster, a bet cap, a selection rule and a staking method, so the same signal produces
          very different experiences. Comparing two personas isolates one variable — the Line Shopper
          and the Disciplined Flat Bettor differ only in book access, so the gap between them is what
          line shopping is worth.
        </li>
        <li>
          <b>Read the confidence band, not the ROI.</b> Only the benchmark persona takes enough bets
          for its return to separate from noise. Ten bets a week is ~180 a season, where the 95% band
          on ROI is wider than any edge a real model could produce. A persona&apos;s ROI shows what
          the strategy would have felt like; it cannot establish whether the projections work.
        </li>
        <li>
          <b>Closing line value</b> is the measurement that does not depend on bets winning. If the
          price we took consistently beats where the market closed, the projections are finding
          information before the market does — which is the durable claim, and it converges far
          faster than ROI.
        </li>
      </ul>
    </Explainer>
  );
}
