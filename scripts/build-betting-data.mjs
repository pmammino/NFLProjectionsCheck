// Aggregates the per-persona ledgers (data/bets/{persona}/{season}/week-NN.csv)
// into public/data/betting.json for the dashboard's Paper Trading tab. Runs on
// predev/prebuild alongside build-data.mjs; the generated JSON is not committed.
//
// ---------------------------------------------------------------------------
// Two kinds of number live in here, and they are not equivalent
// ---------------------------------------------------------------------------
// The `firehose` persona takes every qualifying edge, so its sample is large
// enough for ROI to mean something: a few thousand bets a season puts the
// 2-sigma band around +/-1.5%. It is the statistical instrument.
//
// Every other persona is a realism instrument. Ten bets a week is ~180 a
// season, where the same band is roughly +/-14% — wide enough to swallow any
// edge a real model could have. Those ROIs show what a strategy would have
// FELT like; they cannot establish whether the projections work.
//
// So the dataset ships `evidence` alongside each rollup, carrying the sample
// size and a rough confidence band, and the dashboard is expected to present
// the firehose differently from the rest. Putting them in one sorted table
// would invite exactly the misreading this comment exists to prevent.
//
// Season resolution mirrors build-data.mjs: env SEASON if given and present,
// else the latest season present. If no ledgers exist, writes an "empty"
// dataset rather than failing the build.

import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { EDGE_BUCKETS } from "./lib/edge.mjs";
import { PERSONAS, PERSONA_BY_ID, STARTING_BANKROLL_UNITS } from "./lib/personas.mjs";
import { summarizeClv } from "./lib/clv.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_PATH = join(ROOT, "public", "data", "betting.json");

// Persona directories under data/bets/. A directory is a persona only if
// personas.mjs declares it — a stray season folder (the pre-rework layout put
// data/bets/2026/ here) must not be read as a persona named "2026".
function personaDirs(dataDir) {
  const base = join(ROOT, dataDir, "bets");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => PERSONA_BY_ID.has(d));
}

function resolveSeason(dataDir) {
  const seasons = new Set();
  for (const p of personaDirs(dataDir)) {
    const dir = join(ROOT, dataDir, "bets", p);
    for (const s of readdirSync(dir)) if (/^\d{4}$/.test(s)) seasons.add(s);
  }
  if (seasons.size === 0) return null;
  const sorted = [...seasons].sort();
  if (process.env.SEASON && seasons.has(process.env.SEASON)) return process.env.SEASON;
  return sorted.at(-1);
}

function loadPersonaWeeks(dataDir, persona, season) {
  const dir = join(ROOT, dataDir, "bets", persona, season);
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const f of readdirSync(dir).filter((f) => /^week-\d+\.csv$/.test(f)).sort()) {
    rows.push(...readCsv(join(dir, f)));
  }
  return rows;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function round(n, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Mean of the values actually present. A blank is "unknown", not zero —
// averaging a missing Hold as zero would understate the real market margin.
function avgOf(values) {
  const nums = values.map(numOrNull).filter((n) => n !== null);
  return nums.length ? round(nums.reduce((s, n) => s + n, 0) / nums.length) : null;
}

const SETTLED = new Set(["won", "lost", "push"]);

// How much a return figure can actually be trusted.
//
// ROI here is the mean return per unit staked, so its standard error is just
// the spread of per-bet returns over sqrt(n). Reporting that band alongside the
// number is the difference between "this strategy made 4%" and "this strategy
// made 4% ± 14%, which is to say we have no idea yet".
//
// This is the guard against the main way this analysis could mislead: a
// persona's headline ROI is mostly noise until it has hundreds of bets, and a
// dashboard that shows it to three decimal places invites belief it hasn't
// earned.
function evidence(returns) {
  const n = returns.length;
  if (n < 2) return { n, roiStdErr: null, roiBand95: null, sufficient: false };
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdErr = Math.sqrt(variance / n);
  return {
    n,
    roiStdErr: round(stdErr),
    // Two standard errors either side — the width within which the true ROI
    // plausibly sits.
    roiBand95: round(2 * stdErr),
    // A band tighter than 5 points is roughly where a 3-5% edge becomes
    // distinguishable from zero. Below that, treat the ROI as illustrative.
    sufficient: 2 * stdErr < 0.05,
  };
}

// Roll a set of ledger rows into counts, win rate, ROI, CLV and an evidence
// band.
function rollup(rows) {
  const graded = rows.filter((r) => SETTLED.has(r.Status));
  const wins = graded.filter((r) => r.Status === "won").length;
  const pushes = graded.filter((r) => r.Status === "push").length;
  // Win rate is wins over DECIDED bets: a push returns the stake and is
  // neither a win nor a loss, so counting it in the denominator would drag the
  // rate down as though it were a loss.
  const decided = graded.length - pushes;

  const staked = graded.reduce((s, r) => s + num(r.StakeUnits), 0);
  const pnl = graded.reduce((s, r) => s + num(r.PnlUnits), 0);
  // Per-bet return on stake, for the confidence band.
  const returns = graded
    .filter((r) => num(r.StakeUnits) > 0)
    .map((r) => num(r.PnlUnits) / num(r.StakeUnits));

  const clv = summarizeClv(
    rows
      .filter((r) => r.ClvStatus)
      .map((r) => ({
        status: r.ClvStatus,
        clvProb: numOrNull(r.ClvProb),
        clvPct: numOrNull(r.ClvPct),
        lineMove: r.LineMove,
      }))
  );

  return {
    nTotal: rows.length,
    nGraded: graded.length,
    nPending: rows.length - graded.length,
    nPush: pushes,
    winRate: decided > 0 ? round(wins / decided) : null,
    avgEdge: avgOf(rows.map((r) => r.Edge)),
    // Structurally larger than avgEdge by about half the hold; the gap between
    // them is the margin being paid to play.
    avgModelEdge: avgOf(rows.map((r) => r.ModelEdge)),
    avgHold: avgOf(rows.map((r) => r.Hold)),
    staked: round(staked),
    pnl: round(pnl),
    roi: staked > 0 ? round(pnl / staked) : null,
    evidence: evidence(returns),
    clv: clv.nMatched > 0 ? clv : null,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// Bankroll trajectory, week by week. Only meaningful for a compounding
// persona, but harmless to compute for the rest — it shows cumulative P&L.
function bankrollPath(rows) {
  const byWeek = [...groupBy(rows, (r) => num(r.Week))].sort((a, b) => a[0] - b[0]);
  let cumulative = STARTING_BANKROLL_UNITS;
  return byWeek.map(([week, weekRows]) => {
    const pnl = weekRows.reduce((s, r) => s + num(r.PnlUnits), 0);
    cumulative = round(cumulative + pnl);
    return { week, bets: weekRows.length, pnl: round(pnl), bankroll: cumulative };
  });
}

function build() {
  const dataDir = "data";
  const season = resolveSeason(dataDir);

  const personas = [];
  for (const def of PERSONAS) {
    const rows = season ? loadPersonaWeeks(dataDir, def.id, season) : [];
    const edgeBucketOrder = EDGE_BUCKETS.map((b) => b.label);

    personas.push({
      id: def.id,
      label: def.label,
      description: def.description,
      // The rules, surfaced so the dashboard can explain WHY two personas
      // differ rather than just showing that they do.
      rules: {
        books: def.books ?? "all",
        minEdge: def.minEdge ?? 0,
        maxBetsPerWeek: def.maxBetsPerWeek ?? null,
        select: def.select ?? "top-edge",
        staking: def.staking,
        bankroll: def.bankroll,
        requireTwoSided: def.requireTwoSided ?? false,
        edgeBasis: def.edgeBasis ?? "ev",
      },
      // The firehose is the only persona whose sample is meant to carry
      // statistical weight; the rest illustrate experience. The dashboard is
      // expected to present them differently.
      isBenchmark: def.id === "firehose",
      overall: rollup(rows),
      byStat: [...groupBy(rows, (r) => r.Stat)]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([stat, g]) => ({ stat, ...rollup(g) })),
      byEdgeBucket: [...groupBy(rows, (r) => r.EdgeBucket)]
        .sort((a, b) => edgeBucketOrder.indexOf(a[0]) - edgeBucketOrder.indexOf(b[0]))
        .map(([bucket, g]) => ({ bucket, ...rollup(g) })),
      bySide: [...groupBy(rows, (r) => r.Side || "over")]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([side, g]) => ({ side, ...rollup(g) })),
      byWeek: bankrollPath(rows),
      bets: rows
        .map((r) => ({
          season: num(r.Season),
          week: num(r.Week),
          playerId: r.PlayerID,
          name: r.Name,
          team: r.Team,
          pos: r.Pos,
          opp: r.Opp,
          stat: r.Stat,
          book: r.Book,
          line: num(r.Line),
          side: r.Side || "over",
          odds: num(r.Odds),
          impliedProb: numOrNull(r.ImpliedProb),
          fairProb: numOrNull(r.FairProb),
          hold: numOrNull(r.Hold),
          oneSided: r.OneSided === "1",
          ourProb: numOrNull(r.OurProb),
          edge: numOrNull(r.Edge),
          modelEdge: numOrNull(r.ModelEdge),
          edgeBucket: r.EdgeBucket,
          stakeUnits: num(r.StakeUnits),
          status: r.Status,
          actual: r.Actual === "" ? null : num(r.Actual),
          pnlUnits: r.PnlUnits === "" ? null : num(r.PnlUnits),
          clvStatus: r.ClvStatus || null,
          clvProb: numOrNull(r.ClvProb),
          source: r.Source || "",
        }))
        .sort((a, b) => b.week - a.week || (b.edge ?? 0) - (a.edge ?? 0)),
    });
  }

  const benchmark = personas.find((p) => p.isBenchmark);

  const dataset = {
    meta: {
      generatedAt: new Date().toISOString(),
      season: season ? Number(season) : null,
      startingBankrollUnits: STARTING_BANKROLL_UNITS,
      // Stated in the data so the dashboard doesn't have to hardcode the
      // caveat, and so it travels with any export of this file.
      note:
        "The firehose takes every qualifying edge and is the statistical benchmark. " +
        "Other personas take a realistic handful of bets a week; their ROI carries a " +
        "wide confidence band and illustrates experience rather than establishing edge. " +
        "Each rollup reports its own band under `evidence`.",
      counts: {
        personas: personas.length,
        bets: personas.reduce((s, p) => s + p.overall.nTotal, 0),
        benchmarkBets: benchmark ? benchmark.overall.nTotal : 0,
      },
    },
    personas,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(dataset));

  console.log(`Wrote ${OUT_PATH}: season=${dataset.meta.season}`);
  for (const p of personas) {
    const o = p.overall;
    const roi = o.roi === null ? "—" : `${(o.roi * 100).toFixed(1)}%`;
    const band = o.evidence.roiBand95 === null ? "" : ` ±${(o.evidence.roiBand95 * 100).toFixed(1)}%`;
    console.log(
      `  ${p.id.padEnd(12)} ${String(o.nTotal).padStart(5)} bets  roi ${roi}${band}` +
        (o.evidence.sufficient ? "" : "  (illustrative)")
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) build();
