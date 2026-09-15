// Discovery/diagnostic CLI for the OpticOdds integration.
//
// The capture pipeline reads OpticOdds responses through tolerant accessors
// that try several plausible field spellings, because the exact response
// schema was not available when the integration was written. This script is
// how you replace that tolerance with certainty: point it at a live key, see
// what the API actually returns, then tighten lib/optic-normalize.mjs and the
// market aliases in lib/markets.mjs to the real shapes.
//
// It is also the fastest way to answer "why did this week capture nothing?" —
// --markets shows which of our stat aliases actually resolve, and --dump-odds
// shows a real record next to how we parsed it.
//
// Usage:
//   node scripts/optic-discover.mjs --sportsbooks
//   node scripts/optic-discover.mjs --markets
//   node scripts/optic-discover.mjs --fixtures [--season 2026] [--week 1]
//   node scripts/optic-discover.mjs --dump-odds [--season 2026] [--week 1]
//                                   [--books "DraftKings,FanDuel"] [--limit 3]
//   node scripts/optic-discover.mjs --all
//
// Env: OPTICODDS_API_KEY (required).

import { OpticOddsClient } from "./lib/opticodds.mjs";
import { STAT_DEFS, allOpticMarketNames, matchStatKey, normalizeMarketName } from "./lib/markets.mjs";
import { flattenOddsPayloads, readOdd } from "./lib/optic-normalize.mjs";
import { seasonForDate, projectionWeek } from "./lib/schedule.mjs";

function parseArgs(argv) {
  const a = { limit: 3 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--week": a.week = Number(next()); break;
      case "--books": a.books = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--limit": a.limit = Number(next()); break;
      case "--sportsbooks": a.sportsbooks = true; break;
      case "--markets": a.markets = true; break;
      case "--fixtures": a.fixtures = true; break;
      case "--dump-odds": a.dumpOdds = true; break;
      case "--all": a.sportsbooks = a.markets = a.fixtures = a.dumpOdds = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  if (!a.sportsbooks && !a.markets && !a.fixtures && !a.dumpOdds) a.all = a.markets = true;
  return a;
}

const nameOf = (row) => (typeof row === "string" ? row : row?.name ?? row?.id ?? JSON.stringify(row));

function heading(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

async function showSportsbooks(client) {
  heading("SPORTSBOOKS");
  const books = await client.getSportsbooks({ sport: "football", league: "nfl" });
  console.log(`${books.length} returned.\n`);
  console.log("Raw shape of the first row:");
  console.log(JSON.stringify(books[0], null, 2));
  console.log(`\nNames: ${books.map(nameOf).join(", ")}`);
  return books;
}

// The important one. Prints every NFL market OpticOdds offers, flags which of
// our aliases resolved, and — critically — lists the markets we FAILED to map
// so real alias strings can be pasted into lib/markets.mjs.
async function showMarkets(client) {
  heading("MARKETS");
  const markets = await client.getMarkets({ sport: "football", league: "nfl" });
  console.log(`${markets.length} returned.\n`);
  console.log("Raw shape of the first row:");
  console.log(JSON.stringify(markets[0], null, 2));

  const liveNames = markets.map(nameOf).filter(Boolean);
  const liveByNorm = new Map(liveNames.map((n) => [normalizeMarketName(n), n]));

  console.log("\n--- Our stat definitions vs. what the API offers ---");
  const unresolved = [];
  for (const [statKey, def] of Object.entries(STAT_DEFS)) {
    const hits = def.optic.filter((alias) => liveByNorm.has(normalizeMarketName(alias)));
    if (hits.length) {
      console.log(`  OK    ${statKey.padEnd(12)} -> ${hits.map((h) => liveByNorm.get(normalizeMarketName(h))).join(", ")}`);
    } else {
      console.log(`  MISS  ${statKey.padEnd(12)} -> none of: ${def.optic.join(" | ")}`);
      unresolved.push(statKey);
    }
  }

  if (unresolved.length) {
    console.log(
      `\n${unresolved.length} stat(s) did not resolve to any live market: ${unresolved.join(", ")}.\n` +
        `Find the right names in the list below and add them to STAT_DEFS[...].optic ` +
        `in scripts/lib/markets.mjs.`
    );
  }

  // Player markets we don't model — the candidate pool for fixing a MISS.
  const ours = new Set(allOpticMarketNames().map(normalizeMarketName));
  const unmapped = liveNames.filter((n) => !ours.has(normalizeMarketName(n)));
  console.log(`\n--- ${unmapped.length} live markets we do not model ---`);
  for (const n of unmapped.sort()) console.log(`    ${n}`);
  return markets;
}

async function showFixtures(client, a) {
  heading(`FIXTURES (season ${a.season}, week ${a.week})`);
  const fixtures = await client.getFixtures({
    league: "nfl",
    seasonYear: a.season,
    seasonWeek: a.week,
  });
  console.log(`${fixtures.length} returned.\n`);
  if (fixtures.length === 0) {
    console.log(
      "No fixtures. Check that season_year/season_week are the right param names and\n" +
        "values for this league — try --fixtures with a different --week, or drop the\n" +
        "week filter in lib/opticodds.mjs getFixtures() to see the full season."
    );
    return [];
  }
  console.log("Raw shape of the first row:");
  console.log(JSON.stringify(fixtures[0], null, 2));
  return fixtures;
}

// Pull a handful of real odds records and show them beside our parse, so any
// field we're misreading is obvious at a glance.
async function dumpOdds(client, a, fixtures, books) {
  heading("ODDS — RAW RECORD vs. OUR PARSE");
  if (!fixtures?.length) {
    console.log("No fixtures to pull odds for — run with --fixtures first.");
    return;
  }
  const sportsbooks = a.books ?? books?.map(nameOf).filter(Boolean).slice(0, 2) ?? ["DraftKings"];
  const fixtureIds = fixtures.map((f) => String(f?.id ?? f?.fixture_id ?? "")).filter(Boolean).slice(0, 1);

  console.log(`Fixture: ${fixtureIds[0]}   Books: ${sportsbooks.join(", ")}`);
  const payloads = await client.getOddsForFixtures({
    fixtureIds,
    sportsbooks,
    markets: allOpticMarketNames(),
  });

  console.log(`\n${payloads.length} payload(s).`);
  if (payloads.length === 0) return;
  console.log("\nTop-level payload keys:", Object.keys(payloads[0] ?? {}).join(", ") || "(bare array)");

  const flat = flattenOddsPayloads(payloads);
  console.log(`Flattened to ${flat.length} odds records.`);
  if (flat.length === 0) {
    console.log(
      "\nNothing flattened. The payload nests odds somewhere flattenOddsPayloads does\n" +
        "not look — inspect the dump above and extend it."
    );
    console.log(JSON.stringify(payloads[0], null, 2).slice(0, 2000));
    return;
  }

  for (const entry of flat.slice(0, a.limit)) {
    console.log(`\n${"-".repeat(72)}\nRAW:`);
    console.log(JSON.stringify(entry.raw, null, 2));
    console.log("PARSED:");
    console.log(JSON.stringify(readOdd(entry), null, 2));
  }

  // Aggregate health check across everything we pulled.
  const parsed = flat.map(readOdd).filter(Boolean);
  const unmatchedMarkets = new Map();
  let noSide = 0;
  let noPrice = 0;
  let noPlayer = 0;
  for (const p of parsed) {
    if (!p.statKey) unmatchedMarkets.set(p.marketName, (unmatchedMarkets.get(p.marketName) ?? 0) + 1);
    if (!p.side) noSide++;
    if (p.price === null) noPrice++;
    if (!p.playerName && !p.playerId) noPlayer++;
  }
  console.log(`\n${"-".repeat(72)}\nPARSE HEALTH over ${parsed.length} records:`);
  console.log(`  mapped to one of our stats: ${parsed.filter((p) => p.statKey).length}`);
  console.log(`  no side detected:           ${noSide}${noSide ? "   <-- fix detectSide()" : ""}`);
  console.log(`  no price parsed:            ${noPrice}${noPrice ? "   <-- fix the price aliases" : ""}`);
  console.log(`  no player parsed:           ${noPlayer}${noPlayer ? "   <-- fix the player aliases" : ""}`);
  if (unmatchedMarkets.size) {
    console.log(`  unmapped market names (top 10):`);
    for (const [n, c] of [...unmatchedMarkets.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)) {
      console.log(`    ${c}× ${n}   (normalized: "${normalizeMarketName(n)}", matches: ${matchStatKey(n) ?? "none"})`);
    }
  }
}

const HELP = `Inspect what the OpticOdds API actually returns.

  node scripts/optic-discover.mjs [options]

  --sportsbooks     List every sportsbook offered for NFL
  --markets         List every NFL market, and check our stat aliases against it
  --fixtures        List fixtures for a season/week, with the raw row shape
  --dump-odds       Print real odds records beside how we parse them
  --all             All of the above
  --season <year>   Season (default: current by date)
  --week <n>        NFL week (default: upcoming/in-progress by date)
  --books <a,b>     Books to use for --dump-odds (default: first two offered)
  --limit <n>       Records to dump (default: 3)
  -h, --help        Show this help

Env: OPTICODDS_API_KEY (required).`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }
  const now = new Date();
  if (a.season === undefined) a.season = seasonForDate(now);
  if (a.week === undefined) a.week = projectionWeek(a.season, now);

  const client = new OpticOddsClient();

  let books = null;
  let fixtures = null;
  if (a.sportsbooks) books = await showSportsbooks(client);
  if (a.markets) await showMarkets(client);
  if (a.fixtures || a.dumpOdds) fixtures = await showFixtures(client, a);
  if (a.dumpOdds) await dumpOdds(client, a, fixtures, books);

  console.log(`\nDone. ${client.requestCount} OpticOdds requests.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("optic-discover failed:", err.message);
    process.exit(1);
  });
}
