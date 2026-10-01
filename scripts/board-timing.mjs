// When should the drop be?
//
// The Tuesday drop is one sample of the market per week, taken at one hour,
// and on 2026 week 3 that hour caught 3 of 16 games. This report compares
// every capture of a week side by side — the live drops and any backfilled
// reconstructions — on the things that decide when to source:
//
//   coverage    how much of the board existed yet (fixtures, players, markets)
//   priceable   what share was quoted two-sided, so it can be de-vigged
//   cost        the hold the books were charging
//   accuracy    where actuals exist: how well that slot's prices predicted,
//               and how our projection compared against them
//
// It deliberately does NOT pick a winner. Coverage and price quality pull in
// opposite directions — early is softer and emptier — and which matters more
// depends on how many bets you want to place, which is a business question.
// What this removes is the guessing.
//
// Usage:
//   npm run board-timing
//   node scripts/board-timing.mjs [--season 2026] [--weeks 2,3] [--json]
//
// Reads data/props/{season}/**, data/closing/{season}/ and
// data/actuals/{season}/ directly — the committed record of what the books
// were showing and what happened.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { SLOT_MAIN } from "./lib/slots.mjs";
import { STAT_DEFS, isBettableStat } from "./lib/markets.mjs";
import { gradeOutcome } from "./lib/grading.mjs";
import { scoreProbabilities, clusterKey } from "./lib/pricing.mjs";
import { consensusProb, estimateHoldByStat } from "./lib/consensus.mjs";
import { readPropRow, actualFor } from "./lib/pricing-dataset.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const a = { dataDir: join(ROOT, "data") };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--weeks": a.weeks = new Set(next().split(",").map((s) => Number(s.trim()))); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  return a;
}

const HELP = `Compare every capture of a week — which hour to source at.

  node scripts/board-timing.mjs [options]

  --season <y>     season to read (default: latest with captures)
  --weeks <list>   comma-separated weeks (default: all)
  --data-dir <p>   data directory (default: ./data)
  --json           emit the analysis as JSON instead of tables
  -h, --help       show this help

"closing" is not a slot you can bet — it is the daily near-kickoff capture in
data/closing/, included as the upper bound on what the board ever reaches.

To add a slot, either schedule another live capture
(capture-props --slot thursday) or reconstruct one from price history
(capture-props --historical --at T-48h).`;

const pct = (x, d = 0) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");
const num = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

// Every capture of a season, keyed by slot. `closing` comes from the separate
// daily near-kickoff job rather than from a slot directory, and is labelled
// as the ceiling rather than as an option.
function loadSlots(dataDir, season) {
  const out = new Map();
  const propsDir = join(dataDir, "props", String(season));
  if (existsSync(propsDir)) {
    const dirs = [{ slot: SLOT_MAIN, dir: propsDir }];
    for (const e of readdirSync(propsDir, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push({ slot: e.name, dir: join(propsDir, e.name) });
    }
    for (const { slot, dir } of dirs) {
      for (const f of readdirSync(dir).filter((x) => /^week-\d+\.csv$/.test(x))) {
        const week = Number(f.match(/week-(\d+)\.csv/)[1]);
        push(out, slot, week, readCsv(join(dir, f)));
      }
    }
  }
  const closingDir = join(dataDir, "closing", String(season));
  if (existsSync(closingDir)) {
    for (const f of readdirSync(closingDir).filter((x) => /^week-\d+\.csv$/.test(x))) {
      const week = Number(f.match(/week-(\d+)\.csv/)[1]);
      push(out, "(near kickoff)", week, readCsv(join(closingDir, f)));
    }
  }
  return out;
}

function push(map, slot, week, rows) {
  if (!map.has(slot)) map.set(slot, new Map());
  const byWeek = map.get(slot);
  byWeek.set(week, [...(byWeek.get(week) ?? []), ...rows]);
}

function actualsFor(dataDir, season) {
  const dir = join(dataDir, "actuals", String(season));
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => /^week-\d+\.csv$/.test(x))) {
    const week = Number(f.match(/week-(\d+)\.csv/)[1]);
    const byPlayer = new Map();
    for (const r of readCsv(join(dir, f))) byPlayer.set(String(r.PlayerID), r);
    out.set(week, byPlayer);
  }
  return out;
}

// One slot's numbers for one week.
function describe(rows, actualsByPlayer) {
  const quotes = rows.map((r) => readPropRow(r)).filter(Boolean).filter((q) => isBettableStat(q.stat));
  const byMarket = new Map();
  for (const q of quotes) {
    const key = [q.playerId, q.stat, q.line].join("|");
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(q);
  }

  const holdByStat = estimateHoldByStat(quotes);
  let twoSided = 0;
  const holds = [];
  const graded = [];
  for (const [, group] of byMarket) {
    const paired = group.some((q) => q.overOdds !== null && q.underOdds !== null);
    if (paired) twoSided++;
    for (const q of group) if (Number.isFinite(q.hold) && q.hold > 0) holds.push(q.hold);

    if (!actualsByPlayer) continue;
    const first = group[0];
    const actual = actualFor(actualsByPlayer.get(first.playerId), first.stat);
    if (actual === null) continue;
    const outcome = gradeOutcome(actual, first.line, "over");
    if (outcome === "push") continue;
    const cons = consensusProb(group, { side: "over", setName: "retail", holdByStat, stat: first.stat });
    graded.push({
      week: first.week,
      playerId: first.playerId,
      y: outcome === "won" ? 1 : 0,
      pProj: first.probOver,
      pMarket: cons?.prob ?? null,
    });
  }

  const marketScore = scoreProbabilities(
    graded.filter((g) => g.pMarket !== null).map((g) => ({ p: g.pMarket, y: g.y }))
  );
  const projScore = scoreProbabilities(graded.map((g) => ({ p: g.pProj, y: g.y })));

  return {
    rows: rows.length,
    fixtures: new Set(rows.map((r) => r.FixtureID).filter(Boolean)).size,
    players: new Set(quotes.map((q) => q.playerId)).size,
    markets: byMarket.size,
    twoSidedShare: byMarket.size ? twoSided / byMarket.size : null,
    medianHold: holds.length ? median(holds) : null,
    books: new Set(quotes.map((q) => q.book)).size,
    graded: graded.length,
    clusters: new Set(graded.map(clusterKey)).size,
    marketBrier: marketScore.brier,
    projBrier: projScore.brier,
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
}

function run() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }

  const propsRoot = join(a.dataDir, "props");
  if (!existsSync(propsRoot)) throw new Error(`No prop captures under ${propsRoot}`);
  const seasons = readdirSync(propsRoot).filter((d) => /^\d{4}$/.test(d)).map(Number).sort();
  const season = a.season ?? seasons[seasons.length - 1];
  if (!season) throw new Error(`No seasons under ${propsRoot}`);

  const slots = loadSlots(a.dataDir, season);
  const actuals = actualsFor(a.dataDir, season);

  const weeks = [...new Set([...slots.values()].flatMap((m) => [...m.keys()]))]
    .filter((w) => !a.weeks || a.weeks.has(w))
    .sort((x, y) => x - y);

  const report = [];
  for (const week of weeks) {
    for (const [slot, byWeek] of slots) {
      const rows = byWeek.get(week);
      if (!rows) continue;
      report.push({ week, slot, ...describe(rows, actuals.get(week)) });
    }
  }

  if (a.json) {
    console.log(JSON.stringify({ season, report }, null, 2));
    return;
  }

  console.log(`Board timing — season ${season}\n`);
  if (slots.size <= 2) {
    console.log(
      `Only ${slots.size} capture${slots.size === 1 ? "" : "s"} of each week exist, so there is\n` +
        `little to compare yet. Add slots with:\n` +
        `  node scripts/capture-props.mjs --slot thursday            (live, going forward)\n` +
        `  node scripts/capture-props.mjs --historical --at T-48h    (reconstructed, past weeks)\n`
    );
  }

  for (const week of weeks) {
    const rowsFor = report.filter((r) => r.week === week);
    if (rowsFor.length === 0) continue;
    console.log(`\nWeek ${week}`);
    console.log(
      `  ${pad("slot", 16)}${lpad("fixtures", 9)}${lpad("players", 8)}${lpad("markets", 9)}` +
        `${lpad("two-sided", 11)}${lpad("hold", 7)}${lpad("books", 7)}${lpad("graded", 8)}` +
        `${lpad("clusters", 10)}${lpad("mkt Brier", 11)}${lpad("proj Brier", 12)}`
    );
    console.log(`  ${"-".repeat(108)}`);
    // Biggest board last, so the ceiling reads as the bottom line.
    for (const r of [...rowsFor].sort((x, y) => x.markets - y.markets)) {
      console.log(
        `  ${pad(r.slot, 16)}${lpad(r.fixtures || "—", 9)}${lpad(r.players, 8)}${lpad(r.markets, 9)}` +
          `${lpad(pct(r.twoSidedShare), 11)}${lpad(r.medianHold === null ? "—" : pct(r.medianHold, 1), 7)}` +
          `${lpad(r.books, 7)}${lpad(r.graded, 8)}${lpad(r.clusters, 10)}` +
          `${lpad(num(r.marketBrier), 11)}${lpad(num(r.projBrier), 12)}`
      );
    }
    const best = rowsFor.reduce((m, r) => (r.markets > m.markets ? r : m), rowsFor[0]);
    for (const r of rowsFor) {
      if (r.slot === best.slot || best.markets === 0) continue;
      console.log(
        `  -> "${r.slot}" saw ${pct(r.markets / best.markets)} of the markets and ` +
          `${r.fixtures} of ${best.fixtures} games that "${best.slot}" did.`
      );
    }
  }

  console.log(
    `\n\nHow to read this. "(near kickoff)" is the daily closing capture — the\n` +
      `ceiling on what the board ever reaches, not a slot you can bet, since by\n` +
      `then the games are about to start. A slot is worth moving to when it gains\n` +
      `enough coverage to matter WITHOUT its prices having sharpened away the\n` +
      `edge; the Tuesday drop's measured +5.25% closing-line value is what a\n` +
      `later slot has to be weighed against.\n\n` +
      `Brier columns need actuals, and they are scored only over the markets that\n` +
      `slot actually saw — so a slot with a tiny board is not being judged on the\n` +
      `same bets as a full one. Read them alongside "clusters", not alone.\n`
  );
}

try {
  run();
} catch (err) {
  console.error(`board-timing: ${err.message}`);
  process.exitCode = 1;
}
