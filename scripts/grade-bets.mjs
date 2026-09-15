// Grades pending paper bets against actuals as results land. Run after
// scripts/ingest.mjs (actuals) — daily during the season, same as the
// projections/actuals ingest — so bets resolve incrementally as games finish
// through the week rather than all at once.
//
// For each data/bets/{season}/week-NN.csv with a matching
// data/actuals/{season}/week-NN.csv, every row still Status=pending is
// compared against that player's actual stat line for the week. A player
// with no actual row yet (game not played/completed) is left pending, not
// voided — actuals get re-pulled daily and rewritten as games complete.
//
// Usage:
//   node scripts/grade-bets.mjs [--season 2025] [--week 1] [--data-dir data] [--dry-run]
//   (omit --week to grade every week that has a bets ledger)

import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, toCsv } from "./lib/csv.mjs";
import { americanToDecimal } from "./lib/odds.mjs";
import { seasonForDate } from "./lib/schedule.mjs";
import { STAT_DEFS } from "./lib/markets.mjs";
import { BETS_COLUMNS } from "./capture-props.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const pad2 = (n) => String(n).padStart(2, "0");
const betsPath = (dir, season, week) => join(ROOT, dir, "bets", String(season), `week-${pad2(week)}.csv`);
const actualPath = (dir, season, week) => join(ROOT, dir, "actuals", String(season), `week-${pad2(week)}.csv`);

// Settle one bet: "won", "lost", or "push" when the result lands exactly on a
// whole-number line. Exported for unit testing.
export function gradeOutcome(actual, line, side) {
  if (actual === line) return "push";
  if (side === "under") return actual < line ? "won" : "lost";
  return actual > line ? "won" : "lost";
}

function parseArgs(argv) {
  const a = { dataDir: "data", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--week": a.week = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--dry-run": a.dryRun = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  return a;
}

function weeksWithBets(dataDir, season) {
  const dir = join(ROOT, dataDir, "bets", String(season));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => f.match(/^week-(\d+)\.csv$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((x, y) => x - y);
}

// Grade one week's ledger in place. Returns true if the file changed.
function gradeWeek(a, season, week) {
  const bPath = betsPath(a.dataDir, season, week);
  if (!existsSync(bPath)) {
    console.log(`  no bets ledger for week ${week} — skipping.`);
    return false;
  }
  const bets = readCsv(bPath);
  const pending = bets.filter((b) => b.Status === "pending");
  if (pending.length === 0) {
    console.log(`  week ${week}: nothing pending.`);
    return false;
  }

  const aPath = actualPath(a.dataDir, season, week);
  if (!existsSync(aPath)) {
    console.log(`  week ${week}: no actuals snapshot yet (${pending.length} bets still pending).`);
    return false;
  }
  const actualsByPlayer = new Map(readCsv(aPath).map((r) => [r.PlayerID, r]));

  let changed = false;
  for (const bet of bets) {
    if (bet.Status !== "pending") continue;
    const actualRow = actualsByPlayer.get(bet.PlayerID);
    if (!actualRow) continue; // this player's game hasn't completed yet

    const cols = STAT_DEFS[bet.Stat]?.actualCols;
    if (!cols || cols.length === 0) continue; // stat has no actuals source — stays pending

    const actual = cols.reduce((s, c) => s + (Number(actualRow[c]) || 0), 0);
    const line = Number(bet.Line);
    const flatStake = Number(bet.FlatStakeUnits);
    const kellyStake = Number(bet.KellyStakeUnits);
    const decimalOdds = americanToDecimal(Number(bet.Odds));
    // Ledgers written before the OpticOdds migration have no Side column and
    // were all overs, so an absent Side reads as "over".
    const side = bet.Side || "over";

    const outcome = gradeOutcome(actual, line, side);
    bet.Actual = actual;
    bet.Status = outcome;
    if (outcome === "push") {
      // Stake returned: no profit, no loss. Real over/under markets land here
      // whenever the line is a whole number and the player lands exactly on it
      // (e.g. Over 5.0 receptions, caught 5). The old RotoWire feed's lines
      // were effectively all half-points, so this case never arose.
      bet.PnlFlatUnits = "0.0000";
      bet.PnlKellyUnits = "0.0000";
    } else {
      const won = outcome === "won";
      bet.PnlFlatUnits = (won ? flatStake * (decimalOdds - 1) : -flatStake).toFixed(4);
      bet.PnlKellyUnits = (won ? kellyStake * (decimalOdds - 1) : -kellyStake).toFixed(4);
    }
    changed = true;
  }

  if (!changed) {
    console.log(`  week ${week}: still ${pending.length} pending, no completed games to grade yet.`);
    return false;
  }
  if (a.dryRun) {
    console.log(`  [dry-run] would update ${bPath}`);
    return true;
  }
  writeFileSync(bPath, toCsv(BETS_COLUMNS, bets));
  console.log(`  updated ${bPath}`);
  return true;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log("node scripts/grade-bets.mjs [--season Y] [--week N] [--data-dir data] [--dry-run]");
    return;
  }
  if (a.season === undefined) a.season = seasonForDate(new Date());

  const weeks = a.week !== undefined ? [a.week] : weeksWithBets(a.dataDir, a.season);
  if (weeks.length === 0) {
    console.log(`No bets ledgers found for season ${a.season}.`);
    return;
  }
  console.log(`Grading season=${a.season} weeks=[${weeks.join(", ")}]${a.dryRun ? " (dry-run)" : ""}`);
  for (const week of weeks) gradeWeek(a, a.season, week);
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("grade-bets failed:", err.message);
    process.exit(1);
  });
}
