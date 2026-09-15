// Replays every simulated bettor over the season's captured edges and writes
// one graded ledger per persona.
//
//   data/edges/{season}/week-NN.csv        the signal: every qualifying edge at
//                                          drop time, across every book
//   data/bets/{persona}/{season}/week-NN.csv   what that persona actually took
//
// ---------------------------------------------------------------------------
// This regenerates everything, every run
// ---------------------------------------------------------------------------
// A persona's ledger is a pure function of (edges, actuals, persona rules). So
// rather than grading incrementally and carrying state, every run rebuilds the
// whole season from the captured edges. That has three consequences worth
// having:
//
//   - Changing a persona's rules, or adding one, is a re-run. No migration, no
//     half-graded ledgers, no drift between what the config says and what the
//     CSV holds.
//   - Replaying over historical weeks is the same operation as running the
//     current week; there is no separate backfill path to keep working.
//   - Bankroll compounding is computed in week order from a known start, so a
//     mid-season correction to an earlier week propagates forward correctly
//     instead of leaving the bankroll permanently wrong.
//
// The cost is that this must never be the only copy of anything. It is derived
// from data/edges/ and data/actuals/, both of which ARE durable captures.
//
// Usage:
//   node scripts/simulate-personas.mjs [--season 2026] [--persona id]
//                                      [--data-dir data] [--dry-run]

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONAS, PERSONA_BY_ID, STARTING_BANKROLL_UNITS, simulateWeek, advanceBankroll } from "./lib/personas.mjs";
import { indexClosing, computeClv, summarizeClv } from "./lib/clv.mjs";
import { STAT_DEFS, isBettableStat, projectedValue } from "./lib/markets.mjs";
import { applyCalibrationGuards } from "./lib/calibration.mjs";
import { americanToDecimal } from "./lib/odds.mjs";
import { gradeOutcome } from "./lib/grading.mjs";
import { readCsv, toCsv } from "./lib/csv.mjs";
import { seasonForDate } from "./lib/schedule.mjs";
import { edgeBucket } from "./lib/edge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const pad2 = (n) => String(n).padStart(2, "0");

export const LEDGER_COLUMNS = [
  "Season", "Week", "Persona",
  "PlayerID", "Name", "Team", "Pos", "Opp", "Stat",
  "Book", "Line", "Side", "Odds", "OppositeOdds",
  "ImpliedProb", "FairProb", "Hold", "OneSided",
  "OurProb", "Edge", "ModelEdge", "EdgeBucket",
  "StakeUnits", "ScaledBy", "BankrollBefore",
  "Status", "Actual", "PnlUnits",
  // Closing Line Value — null until a closing snapshot exists for the week.
  "ClvStatus", "ClvProb", "ClvPct", "ClosingOdds", "ClosingLine", "LineMove",
  "Source", "CapturedAt",
];

function parseArgs(argv) {
  const a = { dataDir: "data", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--persona": a.persona = next(); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--dry-run": a.dryRun = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  return a;
}

const edgesPath = (d, s, w) => join(ROOT, d, "edges", String(s), `week-${pad2(w)}.csv`);
const propsPath = (d, s, w) => join(ROOT, d, "props", String(s), `week-${pad2(w)}.csv`);
const actualPath = (d, s, w) => join(ROOT, d, "actuals", String(s), `week-${pad2(w)}.csv`);
const closingPath = (d, s, w) => join(ROOT, d, "closing", String(s), `week-${pad2(w)}.csv`);
const ledgerPath = (d, p, s, w) => join(ROOT, d, "bets", p, String(s), `week-${pad2(w)}.csv`);
const projPath = (d, s, w) => join(ROOT, d, "projections", String(s), `week-${pad2(w)}.csv`);

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// One CSV row -> the shape the persona engine expects.
//
// Tolerant of the pre-migration schema: week 1 was captured from RotoWire,
// which quoted one side only and carried no de-vigged price. Those rows still
// replay, but `Source` records where they came from so a mixed-methodology
// comparison is visible in the data rather than remembered.
function toEdge(row) {
  const oneSided = row.OneSided === undefined || row.OneSided === "" ? true : row.OneSided === "1";
  return {
    playerId: row.PlayerID,
    name: row.Name,
    team: row.Team,
    pos: row.Pos,
    opp: row.Opp,
    fixtureId: row.FixtureID || "",
    stat: row.Stat,
    book: row.Book,
    line: num(row.Line),
    side: row.Side || "over",
    // Absent on rows captured before the support floor existed; keepEdge falls
    // back to the projections file for those.
    proj: num(row.Proj),
    odds: num(row.Odds),
    oppositeOdds: num(row.OppositeOdds),
    impliedProb: num(row.ImpliedProb),
    fairProb: num(row.FairProb) ?? num(row.ImpliedProb),
    hold: num(row.Hold),
    oneSided,
    ourProb: num(row.OurProb),
    edge: num(row.Edge),
    // Pre-migration rows have no ModelEdge; with only one side quoted there is
    // no fair price to disagree with, so it equals the raw edge by definition.
    modelEdge: num(row.ModelEdge) ?? num(row.Edge),
    maxStake: num(row.MaxStake),
    source: row.Source || (row.OneSided === undefined ? "rotowire" : "opticodds"),
    capturedAt: row.CapturedAt || "",
  };
}

// Our projected median per player for one week, keyed playerId -> stat -> value.
// Used to apply the support floor to archived snapshots.
//
// Read from data/projections/ rather than from the snapshot's own Proj column,
// because that column only exists on rows captured after the support floor was
// introduced and the projections file is durable for every week. Where both
// are available they agree by construction — both go through projectedValue().
function loadProjectedValues(a, season, week) {
  const path = projPath(a.dataDir, season, week);
  if (!existsSync(path)) return null;
  const medians = new Map();
  for (const r of readCsv(path)) {
    if (r.Split !== "M") continue;
    medians.set(r.PlayerID, r);
  }
  return medians;
}

function loadEdges(a, season, week) {
  // Prefer the published edge set; fall back to the full props scan for weeks
  // captured before data/edges/ existed.
  for (const p of [edgesPath(a.dataDir, season, week), propsPath(a.dataDir, season, week)]) {
    if (!existsSync(p)) continue;
    return applyTodaysRules(readCsv(p).map(toEdge), a, season, week);
  }
  return null;
}

// Today's rules, applied to the whole season.
//
// Every one of these filters exists at capture time too, but this replay reads
// archived snapshots that were priced under WHATEVER rules were in force the
// day they were captured. Filtering only at capture would leave already-taken
// weeks betting retired markets and uncalibrated projections forever, and the
// point of a deterministic replay is that one consistent rule set decides the
// entire ledger. So the guards are re-applied on the way in.
//
// A week with no projections file cannot be support-floor checked. It fails
// closed on the floored stats rather than passing them through: an
// unverifiable projection is exactly what the floor exists to refuse.
function applyTodaysRules(rows, a, season, week) {
  const medians = loadProjectedValues(a, season, week);
  const bettable = rows.filter((e) => isBettableStat(e.stat));
  const { kept } = applyCalibrationGuards(
    bettable.map((e) => ({
      ...e,
      projectedMedian: Number.isFinite(e.proj)
        ? e.proj
        : projectedValue(medians?.get(e.playerId), e.stat),
    }))
  );
  return kept;
}

function weeksAvailable(a, season) {
  const weeks = new Set();
  for (const kind of ["edges", "props"]) {
    const dir = join(ROOT, a.dataDir, kind, String(season));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^week-(\d+)\.csv$/);
      if (m) weeks.add(Number(m[1]));
    }
  }
  return [...weeks].sort((x, y) => x - y);
}

// Settle one bet against the week's actuals.
// Returns { status, actual, pnlUnits } — pending when the player's game has
// not produced a stat line yet, or when the stat has no actuals source at all.
function settle(bet, actualsByPlayer) {
  const cols = STAT_DEFS[bet.stat]?.actualCols;
  if (!cols || cols.length === 0) return { status: "pending", actual: "", pnlUnits: "" };

  const row = actualsByPlayer.get(bet.playerId);
  if (!row) return { status: "pending", actual: "", pnlUnits: "" };

  const actual = cols.reduce((s, c) => s + (Number(row[c]) || 0), 0);
  const outcome = gradeOutcome(actual, bet.line, bet.side);
  if (outcome === "push") return { status: "push", actual, pnlUnits: 0 };

  const dec = americanToDecimal(bet.odds);
  const pnl = outcome === "won" ? bet.stakeUnits * (dec - 1) : -bet.stakeUnits;
  return { status: outcome, actual, pnlUnits: Math.round(pnl * 1e4) / 1e4 };
}

function runPersona(a, persona, season, weeks) {
  let bankroll = STARTING_BANKROLL_UNITS;
  const written = [];
  let totals = { bets: 0, graded: 0, staked: 0, pnl: 0 };
  const clvResults = [];

  for (const week of weeks) {
    const edges = loadEdges(a, season, week);
    if (!edges) continue;

    const bets = simulateWeek(edges, persona, bankroll);
    const bankrollBefore = bankroll;

    const aPath = actualPath(a.dataDir, season, week);
    const actualsByPlayer = existsSync(aPath)
      ? new Map(readCsv(aPath).map((r) => [r.PlayerID, r]))
      : new Map();

    // Closing lines for CLV. Absent for any week captured before daily
    // snapshots began — CLV cannot be reconstructed after the fact, so those
    // weeks simply carry no CLV rather than a fabricated one.
    const cPath = closingPath(a.dataDir, season, week);
    const closingRows = existsSync(cPath) ? readCsv(cPath).map(toEdge) : null;
    const closeIdx = closingRows ? indexClosing(closingRows) : null;

    let weekPnl = 0;
    const rows = [];
    for (const bet of bets) {
      const { status, actual, pnlUnits } = settle(bet, actualsByPlayer);
      if (typeof pnlUnits === "number") weekPnl += pnlUnits;

      const clv = closeIdx
        ? computeClv(bet, closeIdx, closeIdx)
        : { status: "", clvProb: null, clvPct: null, closingOdds: null, closingLine: null, lineMove: null };
      if (closeIdx) clvResults.push(clv);

      rows.push({
        Season: season, Week: week, Persona: persona.id,
        PlayerID: bet.playerId, Name: bet.name, Team: bet.team, Pos: bet.pos, Opp: bet.opp,
        Stat: bet.stat, Book: bet.book, Line: bet.line, Side: bet.side,
        Odds: bet.odds, OppositeOdds: bet.oppositeOdds ?? "",
        ImpliedProb: fixed(bet.impliedProb), FairProb: fixed(bet.fairProb),
        Hold: fixed(bet.hold), OneSided: bet.oneSided ? 1 : 0,
        OurProb: fixed(bet.ourProb), Edge: fixed(bet.edge), ModelEdge: fixed(bet.modelEdge),
        EdgeBucket: edgeBucket(persona.edgeBasis === "novig" ? bet.modelEdge : bet.edge),
        StakeUnits: bet.stakeUnits, ScaledBy: bet.scaledBy,
        BankrollBefore: round4(bankrollBefore),
        Status: status, Actual: actual, PnlUnits: pnlUnits,
        ClvStatus: clv.status, ClvProb: fixed(clv.clvProb), ClvPct: fixed(clv.clvPct),
        ClosingOdds: clv.closingOdds ?? "", ClosingLine: clv.closingLine ?? "",
        LineMove: clv.lineMove ?? "",
        Source: bet.source, CapturedAt: bet.capturedAt,
      });

      totals.bets++;
      if (status !== "pending") totals.graded++;
      totals.staked += bet.stakeUnits;
      if (typeof pnlUnits === "number") totals.pnl += pnlUnits;
    }

    const path = ledgerPath(a.dataDir, persona.id, season, week);
    writeIfChanged(path, toCsv(LEDGER_COLUMNS, rows), a);
    written.push({ week, n: rows.length });

    bankroll = advanceBankroll(persona, bankroll, weekPnl);
  }

  return { written, totals, bankroll, clv: summarizeClv(clvResults) };
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const fixed = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "" : n.toFixed(4));

function writeIfChanged(path, csv, a) {
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prev === csv) return;
  if (a.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
}

const HELP = `Replay every simulated bettor over the season's captured edges.

  node scripts/simulate-personas.mjs [options]

  --season <year>     Season to replay (default: current by date)
  --persona <id>      Only this persona (default: all)
  --data-dir <path>   Data root (default: data)
  --dry-run           Compute and report but write nothing
  -h, --help          Show this help

Ledgers are regenerated from scratch every run — they are derived from
data/edges/ and data/actuals/, never the source of truth.

Personas: ${PERSONAS.map((p) => p.id).join(", ")}`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }
  if (a.season === undefined) a.season = seasonForDate(new Date());

  const weeks = weeksAvailable(a, a.season);
  if (weeks.length === 0) {
    console.error(`No captured edges for season ${a.season} — nothing to replay.`);
    process.exit(1);
  }

  const personas = a.persona
    ? [PERSONA_BY_ID.get(a.persona)].filter(Boolean)
    : PERSONAS;
  if (personas.length === 0) {
    console.error(`Unknown persona "${a.persona}". Known: ${PERSONAS.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }

  console.log(
    `Replaying ${personas.length} persona(s) over season ${a.season}, ` +
      `weeks ${weeks.join(", ")}${a.dryRun ? " (dry-run)" : ""}\n`
  );

  for (const persona of personas) {
    const { totals, bankroll, clv } = runPersona(a, persona, a.season, weeks);
    const roi = totals.staked > 0 ? (totals.pnl / totals.staked) * 100 : null;

    console.log(`${persona.label} (${persona.id})`);
    console.log(`  ${persona.description}`);
    console.log(
      `  ${totals.bets} bets, ${totals.graded} graded | ` +
        `staked ${totals.staked.toFixed(1)}u | pnl ${totals.pnl >= 0 ? "+" : ""}${totals.pnl.toFixed(2)}u | ` +
        `roi ${roi === null ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`}`
    );
    if (persona.bankroll.kind === "compounding") {
      console.log(`  bankroll: ${STARTING_BANKROLL_UNITS} -> ${bankroll.toFixed(1)}u`);
    }
    if (clv.nMatched > 0) {
      console.log(
        `  CLV: beat the close on ${(clv.beatRate * 100).toFixed(0)}% of ${clv.nMatched} measurable bets ` +
          `(avg ${clv.avgClvProb >= 0 ? "+" : ""}${(clv.avgClvProb * 100).toFixed(2)}pts)`
      );
    }
    console.log("");
  }

  // With this few bets a persona's ROI is mostly noise, and presenting it
  // beside the full edge set as though they carry equal weight is the main way
  // this analysis could mislead. Say so where it will be read.
  console.log(
    "Note: a persona taking ~10 bets a week accumulates ~180 a season, where the\n" +
      "2-sigma band on ROI is roughly ±14%. Personas show what a strategy would have\n" +
      "FELT like; the firehose (every edge) is what tests whether the model is real."
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("simulate-personas failed:", err.message);
    process.exit(1);
  });
}
