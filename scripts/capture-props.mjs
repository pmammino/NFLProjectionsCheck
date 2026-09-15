// Weekly prop-line capture, sourced from OpticOdds.
//
// Pulls every sportsbook's price on every market we model for a given NFL
// week, pairs the two sides of each market, removes the book's margin, prices
// the result against our own Floor/Median/Ceiling projections, and writes:
//
//   data/props/{season}/week-NN.csv   every (player, stat, book, line, side)
//                                      price seen, with our probability and
//                                      edge against it — the full scouted
//                                      market.
//   data/bets/{season}/week-NN.csv    the subset that clears --min-edge: one
//                                      row per (player, stat), the single
//                                      best-edge (book, line, side) combination,
//                                      sized two ways (flat + Kelly). This is
//                                      the paper-trading ledger; grade-bets.mjs
//                                      fills in the result once actuals land.
//
// ---------------------------------------------------------------------------
// What changed when this moved off RotoWire
// ---------------------------------------------------------------------------
// 1. WE NOW MEASURE TWO DIFFERENT EDGES, AND THEY ANSWER DIFFERENT QUESTIONS.
//
//    Edge      = OurProb - ImpliedProb   "does this bet make money?"
//    ModelEdge = OurProb - FairProb      "does our model know something the
//                                         market doesn't?"
//
//    `Edge` is the profitability test and drives bet selection, because the
//    break-even probability at a price is its RAW implied probability — at
//    -110 you must win 52.38%, not 50%. The vig is a cost actually paid. This
//    matches what the old RotoWire pipeline computed, so the ledger stays
//    comparable across the migration.
//
//    `ModelEdge` is new, and only possible now that both sides of each market
//    are available. De-vigging recovers what the market actually believes, so
//    comparing our projection to THAT says whether we hold real information.
//    It is always the larger of the two (de-vigging pushes market probability
//    down, by about half the hold), which is exactly why it must not be used
//    to pick bets: on its own it would clear a 3% bar on markets carrying no
//    EV whatsoever and then size them with Kelly as though they did.
//
//    `--edge-basis novig` switches selection to ModelEdge for experimentation.
//    Treat its output as a research question, not a betting ledger.
//
// 2. WE CAN BET UNDERS. A one-sided feed can only ever offer overs. With both
//    prices in hand, a projection that sits well BELOW the line is just as
//    actionable as one above it, so each market is now evaluated from both
//    directions and the ledger carries a Side column. `--sides over` restores
//    the old overs-only behaviour.
//
// 3. PRICES COME FROM A CURATED BOOK ROSTER. The capture takes the BEST price
//    across every book it pulls, which is only meaningful among books you can
//    actually bet at — a best price at a book with no account behind it is a
//    return nobody could have earned, and best-of-N finds the most generous
//    outlier by construction. The roster lives in lib/books.mjs; --all-books
//    restores the old "every onshore book" behaviour for research.
//
// 4. PLAYERS ARE JOINED BY NAME, NOT ID. RotoWire's feed handed us its own
//    player id; OpticOdds has a separate id space. The join now runs through
//    data/players/{season}.csv (written by ingest.mjs) and refuses to guess
//    when a name is ambiguous — see lib/crosswalk.mjs. Unmatched players are
//    reported at the end of every run; a rising count there means the roster
//    snapshot is stale.
//
// Sizing is unchanged: stakes are in "units" where 1 unit = 1% of bankroll,
// which makes flat and Kelly stakes directly comparable regardless of bankroll
// size.
//
// Usage:
//   node scripts/capture-props.mjs [--season 2026] [--week 1]
//                                  [--min-edge 0.03]
//                                  [--kelly-fraction 0.25] [--kelly-cap 0.03]
//                                  [--devig-method multiplicative]
//                                  [--edge-basis ev|novig]
//                                  [--sides both|over|under]
//                                  [--books "DraftKings,FanDuel"] (default: lib/books.mjs)
//                                  [--all-books] [--include-offshore]
//                                  [--historical]   closing lines for a played week
//                                  [--data-dir data] [--dry-run]
//
// Env: OPTICODDS_API_KEY (required).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAT_DEFS, allOpticMarketNames } from "./lib/markets.mjs";
import { probOverContinuous, probOverPoisson } from "./lib/probability.mjs";
import { americanToProb, americanToDecimal, kellyFraction } from "./lib/odds.mjs";
import { devigTwoWay, DEFAULT_DEVIG_METHOD, DEVIG_METHODS } from "./lib/devig.mjs";
import { OpticOddsClient } from "./lib/opticodds.mjs";
import {
  normalizeOddsPayloads,
  flattenHistoricalPayloads,
  historicalLineValue,
  pairOdds,
} from "./lib/optic-normalize.mjs";
import { buildPlayerIndex, matchPlayer, canonicalTeam } from "./lib/crosswalk.mjs";
import { DEFAULT_BOOKS, resolveBookIds } from "./lib/books.mjs";
import { readCsv, toCsv } from "./lib/csv.mjs";
import { seasonForDate, projectionWeek } from "./lib/schedule.mjs";
import { edgeBucket } from "./lib/edge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export const PROPS_COLUMNS = [
  "Season",
  "Week",
  "PlayerID",
  "Name",
  "Team",
  "Pos",
  "Opp",
  "Stat",
  "Book",
  "Line",
  "Side",
  "Odds",
  "OppositeOdds",
  "ImpliedProb", // raw, vig-inclusive — the old methodology's denominator
  "FairProb", // de-vigged; equals ImpliedProb when the market was one-sided
  "Hold", // the book's overround on this market
  "OneSided", // 1 = no opposing price, so FairProb could not be computed
  "OurProb",
  "Edge", // OurProb - ImpliedProb : the EV / profitability edge
  "ModelEdge", // OurProb - FairProb : disagreement with the market's true belief
  "EdgeBasis", // which of the two the --min-edge filter was applied to
  "DevigMethod",
  "LineSource", // live | closing | opening — see historicalToMarkets
  "FixtureID",
  "CapturedAt",
];

export const BETS_COLUMNS = [
  "Season",
  "Week",
  "PlayerID",
  "Name",
  "Team",
  "Pos",
  "Opp",
  "Stat",
  "Book",
  "Line",
  "Side",
  "Odds",
  "OppositeOdds",
  "ImpliedProb",
  "FairProb",
  "Hold",
  "OneSided",
  "OurProb",
  "Edge",
  "ModelEdge",
  "EdgeBasis",
  "EdgeBucket",
  "DevigMethod",
  "LineSource",
  "FlatStakeUnits",
  "KellyStakeUnits",
  "KellyFractionUsed",
  "CapturedAt",
  "Status", // pending | won | lost | push | void
  "Actual",
  "PnlFlatUnits",
  "PnlKellyUnits",
];

function parseArgs(argv) {
  const a = {
    dataDir: "data",
    minEdge: 0.03,
    kellyFraction: 0.25,
    kellyCap: 0.03,
    devigMethod: DEFAULT_DEVIG_METHOD,
    edgeBasis: "ev",
    sides: "both",
    historical: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--week": a.week = Number(next()); break;
      case "--min-edge": a.minEdge = Number(next()); break;
      case "--kelly-fraction": a.kellyFraction = Number(next()); break;
      case "--kelly-cap": a.kellyCap = Number(next()); break;
      case "--devig-method": a.devigMethod = next(); break;
      case "--edge-basis": a.edgeBasis = next(); break;
      case "--sides": a.sides = next(); break;
      case "--books": a.books = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--historical": a.historical = true; break;
      case "--use-opening": a.useOpening = true; break;
      case "--allow-empty": a.allowEmpty = true; break;
      case "--include-offshore": a.includeOffshore = true; break;
      case "--all-books": a.allBooks = true; break;
      case "--data-dir": a.dataDir = next(); break;
      case "--dry-run": a.dryRun = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  if (!DEVIG_METHODS.includes(a.devigMethod)) {
    throw new Error(`--devig-method must be one of: ${DEVIG_METHODS.join(", ")}`);
  }
  if (!["both", "over", "under"].includes(a.sides)) {
    throw new Error("--sides must be one of: both, over, under");
  }
  if (!["ev", "novig"].includes(a.edgeBasis)) {
    throw new Error("--edge-basis must be one of: ev, novig");
  }
  return a;
}

// The number --min-edge is compared against. See the header: `ev` is the
// profitability test and the default; `novig` measures disagreement with the
// market and will select many more bets, most of them not +EV.
const selectionEdge = (cand, basis) => (basis === "novig" ? cand.modelEdge : cand.edge);

const pad2 = (n) => String(n).padStart(2, "0");
const projPath = (dir, season, week) => join(ROOT, dir, "projections", String(season), `week-${pad2(week)}.csv`);
const propsPath = (dir, season, week) => join(ROOT, dir, "props", String(season), `week-${pad2(week)}.csv`);
const betsPath = (dir, season, week) => join(ROOT, dir, "bets", String(season), `week-${pad2(week)}.csv`);
const rosterPath = (dir, season) => join(ROOT, dir, "players", `${season}.csv`);

// Load this week's Floor/Median/Ceiling projection snapshot into a map keyed
// by RotoWire playerid, each value { F: {...cols}, M: {...cols}, C: {...cols} }.
function loadProjections(dir, season, week) {
  const path = projPath(dir, season, week);
  if (!existsSync(path)) {
    throw new Error(
      `No projections snapshot at ${path} — run "npm run ingest" for this week first.`
    );
  }
  const rows = readCsv(path);
  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.PlayerID)) byPlayer.set(r.PlayerID, {});
    byPlayer.get(r.PlayerID)[r.Split] = r;
  }
  return byPlayer;
}

function loadRoster(dir, season) {
  const path = rosterPath(dir, season);
  if (!existsSync(path)) {
    throw new Error(
      `No player roster at ${path} — run "npm run ingest" for this season first. ` +
        `OpticOdds identifies players by name, so this crosswalk is required to join ` +
        `prices to projections.`
    );
  }
  return readCsv(path);
}

function sumCols(row, cols) {
  return cols.reduce((s, c) => s + (Number(row?.[c]) || 0), 0);
}

// Our model's P(actual > line) for one market, using that player's F/M/C.
export function ourProbability({ line, statKey }, splits) {
  const statDef = STAT_DEFS[statKey];
  if (!statDef || !splits || !splits.M) return null;
  if (statDef.kind === "poisson") {
    const lambda = sumCols(splits.M, statDef.projCols);
    return probOverPoisson(line, lambda);
  }
  if (!splits.F || !splits.C) return null;
  const f = sumCols(splits.F, statDef.projCols);
  const m = sumCols(splits.M, statDef.projCols);
  const c = sumCols(splits.C, statDef.projCols);
  return probOverContinuous(line, f, m, c);
}

const csvRowCount = (csv) => Math.max(0, csv.trim().split("\n").length - 1);

// Write only when the content changed, and NEVER let an empty result destroy a
// populated snapshot.
//
// That guard is not hypothetical. A historical pull can legitimately return a
// fixture with `"odds": []` — an unauthorized key, a book with no archived
// data, or a week past the 2-month retention window all look identical to "no
// odds". Without this, re-running `--historical` over an already-captured week
// would replace a full ledger with a header row and call it an update. The
// snapshots under data/ are the durable record of what we actually saw; they
// are not reconstructible once overwritten.
//
// --allow-empty is the deliberate override, for genuinely wiping a week.
function writeCsvIfChanged(path, csv, a) {
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prev === csv) {
    console.log(`  unchanged: ${path} — no rewrite.`);
    return;
  }

  const rows = csvRowCount(csv);
  const prevRows = prev === null ? 0 : csvRowCount(prev);
  if (rows === 0 && prevRows > 0 && !a.allowEmpty) {
    console.error(
      `  REFUSING to overwrite ${path}: this run produced 0 rows but the file ` +
        `holds ${prevRows}. Nothing was written.\n` +
        `    This usually means the pull came back empty (no odds returned), not ` +
        `that the week has no bets.\n` +
        `    Re-run with --allow-empty if you really mean to clear it.`
    );
    return;
  }

  if (a.dryRun) {
    console.log(`  [dry-run] would ${prev === null ? "write" : "update"} ${path} (${rows} rows)`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
  console.log(`  ${prev === null ? "wrote" : "updated"} ${path} (${rows} rows)`);
}

// Turn a paired market row into zero, one or two priced candidates — one per
// side we're willing to bet.
//
// The two sides are NOT mirror images of each other once vig is involved:
// P(over) and P(under) sum to 1 after de-vigging, but the PRICES do not, so a
// market can carry an edge on one side, both, or neither.
function priceMarket(market, splits, a) {
  const probOver = ourProbability(market, splits);
  if (probOver === null) return [];

  const rawOver = americanToProb(market.overOdds);
  const rawUnder = market.underOdds === null ? null : americanToProb(market.underOdds);
  if (rawOver === null) return [];

  const devigged = market.oneSided
    ? null
    : devigTwoWay(market.overOdds, market.underOdds, a.devigMethod);

  const out = [];
  const wantOver = a.sides === "both" || a.sides === "over";
  const wantUnder = a.sides === "both" || a.sides === "under";

  if (wantOver) {
    // With no opposing price there is nothing to de-vig against, so the fair
    // probability falls back to the raw one and the row is flagged. That makes
    // ModelEdge equal Edge on one-sided rows — honest, since we genuinely
    // cannot tell what the market believes from a single price.
    const fair = devigged ? devigged.fairProbOver : rawOver;
    out.push({
      ...market,
      side: "over",
      odds: market.overOdds,
      oppositeOdds: market.underOdds,
      ourProb: probOver,
      impliedProb: rawOver,
      fairProb: fair,
      hold: devigged ? devigged.hold : null,
      edge: probOver - rawOver, // EV: break-even is the raw implied price
      modelEdge: probOver - fair, // disagreement with the market's belief
    });
  }

  // The under is only bettable when the book actually quotes it.
  if (wantUnder && rawUnder !== null && devigged) {
    const probUnder = 1 - probOver;
    out.push({
      ...market,
      side: "under",
      odds: market.underOdds,
      oppositeOdds: market.overOdds,
      ourProb: probUnder,
      impliedProb: rawUnder,
      fairProb: devigged.fairProbUnder,
      hold: devigged.hold,
      edge: probUnder - rawUnder,
      modelEdge: probUnder - devigged.fairProbUnder,
    });
  }

  return out;
}

// Decide which sportsbooks to pull, narrowing in three steps.
//
// 1. Books that actually price NFL, derived from /markets. The /sportsbooks
//    endpoint takes no league filter and returns several hundred books
//    globally; pulling all of them would cost a request per 5 books per
//    fixture batch, almost all of it wasted on books that never quote an NFL
//    game.
// 2. Active only — an inactive book returns nothing but still costs requests.
// 3. Onshore only (unless --include-offshore).
//
// ON "ONSHORE": this is OpticOdds' own flag, and it means a regulated book
// rather than specifically a US one — "888sport (Canada)" is flagged onshore
// too. If the intent is strictly the books you can personally bet at, `--books`
// with an explicit list is the exact control; this flag is the broad one.
//
// Worth knowing what the filter costs: the sharpest books (Pinnacle above all)
// are offshore, and a sharp book's de-vigged price is the best available
// estimate of a true probability. Excluding them doesn't affect `Edge` — you
// can only bet what you can reach — but it does make `ModelEdge` a comparison
// against softer books, so "we disagree with the market" becomes a weaker
// claim than it would be against Pinnacle.
async function resolveBooks(client, a) {
  const all = await client.getSportsbooks();

  // --all-books: the old behaviour, every active book that prices NFL. Kept
  // for research, not for a ledger — see the note in lib/books.mjs on why
  // best-of-86 produces returns nobody could have earned.
  if (a.allBooks) {
    const nflBooks = await client.sportsbooksForLeague({
      sport: "football",
      league: "nfl",
      marketNames: allOpticMarketNames(),
    });
    const nflIds = new Set(nflBooks.map((b) => b.id.toLowerCase()));
    if (nflIds.size === 0) {
      console.warn(
        "  could not derive the NFL book list from /markets — falling back to every " +
          "active book, which will be slow."
      );
    }

    const keep = [];
    const dropped = { notNfl: 0, inactive: 0, offshore: 0 };
    for (const b of all) {
      const row = typeof b === "string" ? { id: b, is_active: true, is_onshore: true } : b;
      const id = String(row?.id ?? row?.name ?? "");
      if (!id) continue;
      if (nflIds.size > 0 && !nflIds.has(id.toLowerCase())) { dropped.notNfl++; continue; }
      if (row?.is_active === false) { dropped.inactive++; continue; }
      if (!a.includeOffshore && row?.is_onshore === false) { dropped.offshore++; continue; }
      keep.push(id);
    }
    console.log(
      `  books: ${keep.length} kept (--all-books)` +
        ` — dropped ${dropped.notNfl} non-NFL, ${dropped.inactive} inactive` +
        `, ${dropped.offshore} offshore${a.includeOffshore ? " (included)" : ""}`
    );
    if (keep.length === 0) throw new Error("No sportsbooks left after filtering.");
    return keep;
  }

  // The normal path: a curated roster, resolved against the live list so a
  // shorthand like "hardrock" finds whatever id the API actually uses.
  const requested = a.books ?? DEFAULT_BOOKS;
  const { ids, matched, missing, ambiguous } = resolveBookIds(requested, all);

  console.log(`  books: ${ids.length} of ${requested.length} requested, resolved against ${all.length} live books`);
  for (const [want, id] of matched) {
    console.log(`    ${want}${want === id ? "" : ` -> ${id}`}`);
  }

  // A book that fails to resolve is NOT an API error — it just returns no odds,
  // which is indistinguishable from the book not pricing that week. Say so.
  if (missing.length) {
    console.warn(
      `  ${missing.length} requested book(s) matched nothing live and will contribute ` +
        `NO odds: ${missing.join(", ")}\n` +
        `    Run \`npm run optic-discover -- --sportsbooks\` to see the real names.`
    );
  }
  for (const [want, candidates] of ambiguous) {
    console.warn(`  "${want}" is ambiguous (${candidates.join(", ")}) — skipped. Name one exactly.`);
  }

  if (ids.length === 0) {
    throw new Error(
      `None of the requested books resolved: ${requested.join(", ")}. ` +
        "Run `npm run optic-discover -- --sportsbooks` to see what is available."
    );
  }
  return ids;
}

// Opponent label matching the existing snapshot format ("vs TB" / "at TB").
function opponentLabel(team, fixture) {
  if (!fixture) return "";
  const home = canonicalTeam(fixture.homeTeam);
  const away = canonicalTeam(fixture.awayTeam);
  const t = canonicalTeam(team);
  if (!home || !away || !t) return "";
  if (t === home) return `vs ${away}`;
  if (t === away) return `at ${home}`;
  return "";
}

async function fetchWeekOdds(client, a, fixtures) {
  const fixtureIds = fixtures.map((f) => f.id).filter(Boolean);
  if (fixtureIds.length === 0) return { rows: [], diagnostics: null };

  // Narrow to the markets we model rather than pulling every market the book
  // offers — the 5-fixture/5-book batching already makes a week dozens of
  // requests, and unmodelled markets would only be discarded downstream.
  const markets = allOpticMarketNames();
  const sportsbooks = a.resolvedBooks;

  const onProgress = ({ done, total }) => {
    if (done === total || done % 5 === 0) console.log(`    ${done}/${total} odds requests…`);
  };

  if (a.historical) {
    console.log(
      `  fetching ${a.useOpening ? "OPENING" : "CLOSING"} lines (historical) for ` +
        `${fixtureIds.length} fixtures — one request per fixture per 5 books, so this is slow…`
    );
    const payloads = await client.getHistoricalOdds({ fixtureIds, sportsbooks, markets, onProgress });
    return historicalToMarkets(payloads, a);
  }

  console.log(`  fetching current odds for ${fixtureIds.length} fixtures…`);
  const payloads = await client.getOddsForFixtures({ fixtureIds, sportsbooks, markets, onProgress });
  return normalizeOddsPayloads(payloads, { statDefs: STAT_DEFS });
}

// Historical payloads carry `olv` (opening) and `clv` (closing) per odd rather
// than a single live price. Collapse each to the chosen line value, then pair
// the sides exactly as a live pull would.
//
// Closing is the default: it is the most informed price the market produced and
// the one we could realistically have taken. The endpoint only ever covers up
// to kickoff, so there is no look-ahead to filter out on our side.
function historicalToMarkets(payloads, a) {
  const records = flattenHistoricalPayloads(payloads);

  const collapsed = [];
  let noPrice = 0;
  const bySource = { closing: 0, opening: 0, fallback: 0, timeseries: 0 };
  for (const rec of records) {
    const lv = historicalLineValue(rec, { prefer: a.useOpening ? "opening" : "closing" });
    if (!lv) {
      noPrice++;
      continue;
    }
    bySource[lv.source] = (bySource[lv.source] ?? 0) + 1;
    // NOTE: on a historical odd the line lives inside olv/clv, not on the odd
    // itself — `points` at the top level is null even for an over/under market.
    // Record WHICH line this price is. A prop backfilled from an opening line
    // is not the same instrument as one captured live near close, and mixing
    // them unlabelled would quietly flatter the backtest — opening lines are
    // softer, before the book has absorbed sharp action.
    const lineSource = lv.source === "fallback" ? (a.useOpening ? "closing" : "opening") : lv.source;
    collapsed.push({ ...rec, price: lv.price, points: lv.points ?? rec.points, lineSource });
  }

  // Re-pair using the same grouping logic the live path uses.
  const { rows, diagnostics } = pairOdds(collapsed, { statDefs: STAT_DEFS });
  return {
    rows,
    diagnostics: { ...diagnostics, noHistoricalPrice: noPrice, lineValueSources: bySource },
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }
  const now = new Date();
  if (a.season === undefined) a.season = seasonForDate(now);
  if (a.week === undefined) a.week = projectionWeek(a.season, now);

  console.log(
    `Capturing props from OpticOdds for season=${a.season} week=${a.week} ` +
      `minEdge=${a.minEdge} basis=${a.edgeBasis} devig=${a.devigMethod} sides=${a.sides}` +
      (a.historical ? " (historical closing lines)" : "") +
      (a.dryRun ? " (dry-run)" : "")
  );

  const projections = loadProjections(a.dataDir, a.season, a.week);
  const playerIndex = buildPlayerIndex(loadRoster(a.dataDir, a.season));
  console.log(`  roster: ${playerIndex.size} players available to join against.`);

  const client = new OpticOddsClient();

  // Books: a curated roster by default (lib/books.mjs), or whatever --books
  // names. Either way the names go through resolveBooks, which matches them
  // against the live list — a name the API doesn't recognise returns no odds
  // rather than erroring, so it has to be caught here or not at all.
  a.resolvedBooks = await resolveBooks(client, a);
  // Printed in full, not truncated: this list decides which prices the ledger
  // is allowed to claim, and a book you cannot actually bet at makes a paper
  // return you could never have earned. Seeing all of them is the point.
  console.log(`  using (${a.resolvedBooks.length}): ${a.resolvedBooks.join(", ")}`);

  // Fixtures for the week.
  const fixtureRows = await client.getFixtures({
    league: "nfl",
    seasonYear: a.season,
    seasonWeek: a.week,
  });
  const fixtures = fixtureRows
    .map((f) => ({
      id: String(f?.id ?? ""),
      // Prefer the competitor abbreviation ("CIN") over the display name
      // ("Cincinnati Bengals") — both resolve, but one is already the code the
      // rest of this project is keyed on.
      homeTeam: f?.home_competitors?.[0]?.abbreviation ?? f?.home_team_display ?? f?.home_team,
      awayTeam: f?.away_competitors?.[0]?.abbreviation ?? f?.away_team_display ?? f?.away_team,
      startDate: f?.start_date ?? null,
    }))
    .filter((f) => f.id);
  console.log(`  fixtures: ${fixtures.length} games for week ${a.week}.`);
  if (fixtures.length === 0) {
    console.warn("  No fixtures returned — nothing to capture. Check --season/--week.");
    return;
  }
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  const { rows: markets, diagnostics } = await fetchWeekOdds(client, a, fixtures);

  // Fixtures came back but carried no odds at all. This is a distinct failure
  // from "no bets cleared the edge bar", and it has specific causes worth
  // naming rather than leaving the caller to guess from an empty file.
  if (diagnostics && diagnostics.total === 0) {
    console.error(
      `  ${fixtures.length} fixture(s) returned, but ZERO odds records.\n` +
        (a.historical
          ? "    For a historical pull this usually means one of:\n" +
            "      - the API key lacks historical-odds permission (the most common cause);\n" +
            "      - the fixture is outside the rolling 2-month retention window;\n" +
            "      - the requested sportsbooks archived nothing for this game.\n" +
            "    Check with a single known fixture before spending a full week's requests:\n" +
            "      curl -H \"X-Api-Key: $OPTICODDS_API_KEY\" \\\n" +
            "        'https://api.opticodds.com/api/v3/fixtures/odds/historical?fixture_id=<ID>&sportsbook=BetMGM'\n"
          : "    For a live pull this usually means the game has no odds posted yet,\n" +
            "    or the requested markets are not offered by these books.\n" +
            "    Run `npm run optic-discover -- --markets` to check the market names.\n")
    );
  }

  console.log(
    `  ${markets.length} distinct markets after pairing ` +
      `(${markets.filter((m) => m.oneSided).length} one-sided).`
  );
  reportDiagnostics(diagnostics, a.useOpening);

  // Join each market to a RotoWire player, then price it.
  const capturedAt = now.toISOString();
  const priced = [];
  const unmatched = new Map();
  let noProjection = 0;

  for (const market of markets) {
    const fixture = fixtureById.get(market.fixtureId);
    // A prop carries no team of its own (OpticOdds leaves team_id null on
    // player markets), so the fixture's two teams are what disambiguate two
    // players sharing a name. See lib/crosswalk.mjs.
    const match = matchPlayer(playerIndex, {
      name: market.playerName,
      team: market.team,
      fixtureTeams: fixture ? [fixture.homeTeam, fixture.awayTeam] : undefined,
    });
    if (!match.playerId) {
      const where = market.team || [fixture?.awayTeam, fixture?.homeTeam].filter(Boolean).join("/") || "?";
      const key = `${market.playerName} (${where}) — ${match.reason}`;
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
      continue;
    }
    const splits = projections.get(match.playerId);
    if (!splits) {
      noProjection++;
      continue;
    }
    for (const cand of priceMarket(market, splits, a)) {
      priced.push({
        ...cand,
        rotowirePlayerId: match.playerId,
        pos: match.entry?.pos ?? "",
        team: canonicalTeam(market.team) ?? match.entry?.team ?? "",
        opp: opponentLabel(market.team || match.entry?.team, fixture),
      });
    }
  }

  console.log(`  ${priced.length} priced candidates across ${new Set(priced.map((p) => p.rotowirePlayerId)).size} players.`);
  reportUnmatched(unmatched, noProjection);

  // ---- data/props snapshot: every priced candidate ----
  const propsRows = priced.map((p) => ({
    Season: a.season,
    Week: a.week,
    PlayerID: p.rotowirePlayerId,
    Name: p.playerName,
    Team: p.team,
    Pos: p.pos,
    Opp: p.opp,
    Stat: p.statKey,
    Book: p.sportsbook,
    Line: p.line,
    Side: p.side,
    Odds: p.odds,
    OppositeOdds: p.oppositeOdds ?? "",
    ImpliedProb: p.impliedProb.toFixed(4),
    FairProb: p.fairProb.toFixed(4),
    Hold: p.hold === null ? "" : p.hold.toFixed(4),
    OneSided: p.oneSided ? 1 : 0,
    OurProb: p.ourProb.toFixed(4),
    Edge: p.edge.toFixed(4),
    ModelEdge: p.modelEdge.toFixed(4),
    EdgeBasis: a.edgeBasis,
    DevigMethod: p.oneSided ? "none" : a.devigMethod,
    LineSource: p.lineSource ?? "live",
    FixtureID: p.fixtureId,
    CapturedAt: capturedAt,
  }));
  propsRows.sort((x, y) => Number(y.Edge) - Number(x.Edge));
  writeCsvIfChanged(propsPath(a.dataDir, a.season, a.week), toCsv(PROPS_COLUMNS, propsRows), a);

  // ---- data/bets ledger: best (book, line, side) per (player, stat) ----
  const bestByKey = new Map();
  for (const p of priced) {
    const key = `${p.rotowirePlayerId}|${p.statKey}`;
    const cur = bestByKey.get(key);
    if (!cur || selectionEdge(p, a.edgeBasis) > selectionEdge(cur, a.edgeBasis)) {
      bestByKey.set(key, p);
    }
  }

  const existingPath = betsPath(a.dataDir, a.season, a.week);
  const existingBets = existsSync(existingPath) ? readCsv(existingPath) : [];
  const existingByKey = new Map(existingBets.map((r) => [`${r.PlayerID}|${r.Stat}`, r]));

  const betRows = [];
  for (const [key, p] of bestByKey) {
    if (selectionEdge(p, a.edgeBasis) < a.minEdge) continue;
    const decimalOdds = americanToDecimal(p.odds);
    const kf = Math.min(a.kellyFraction * kellyFraction(p.ourProb, decimalOdds), a.kellyCap);
    const prior = existingByKey.get(key);
    // Preserve grading if this player/stat/week was already graded by an
    // earlier capture this week; a re-run before kickoff just refreshes
    // price/edge.
    const alreadyGraded = prior && prior.Status && prior.Status !== "pending";
    betRows.push({
      Season: a.season,
      Week: a.week,
      PlayerID: p.rotowirePlayerId,
      Name: p.playerName,
      Team: p.team,
      Pos: p.pos,
      Opp: p.opp,
      Stat: p.statKey,
      Book: p.sportsbook,
      Line: p.line,
      Side: p.side,
      Odds: p.odds,
      OppositeOdds: p.oppositeOdds ?? "",
      ImpliedProb: p.impliedProb.toFixed(4),
      FairProb: p.fairProb.toFixed(4),
      Hold: p.hold === null ? "" : p.hold.toFixed(4),
      OneSided: p.oneSided ? 1 : 0,
      OurProb: p.ourProb.toFixed(4),
      Edge: p.edge.toFixed(4),
      ModelEdge: p.modelEdge.toFixed(4),
      EdgeBasis: a.edgeBasis,
      EdgeBucket: edgeBucket(selectionEdge(p, a.edgeBasis)),
      DevigMethod: p.oneSided ? "none" : a.devigMethod,
      LineSource: p.lineSource ?? "live",
      FlatStakeUnits: 1,
      KellyStakeUnits: (kf * 100).toFixed(4), // kf is a fraction of bankroll; 1 unit = 1%
      KellyFractionUsed: kf.toFixed(4),
      CapturedAt: capturedAt,
      Status: alreadyGraded ? prior.Status : "pending",
      Actual: alreadyGraded ? prior.Actual : "",
      PnlFlatUnits: alreadyGraded ? prior.PnlFlatUnits : "",
      PnlKellyUnits: alreadyGraded ? prior.PnlKellyUnits : "",
    });
  }
  betRows.sort((x, y) => Number(y.Edge) - Number(x.Edge));

  const overs = betRows.filter((b) => b.Side === "over").length;
  console.log(
    `  ${betRows.length} bets clear the ${(a.minEdge * 100).toFixed(1)}% edge bar ` +
      `(${overs} over, ${betRows.length - overs} under).`
  );
  reportBetComposition(betRows);
  writeCsvIfChanged(existingPath, toCsv(BETS_COLUMNS, betRows), a);

  console.log(`Done. ${client.requestCount} OpticOdds requests.`);
}

function reportDiagnostics(d, a_useOpening = false) {
  if (!d) return;
  if (d.noSide) console.warn(`  ${d.noSide} records had no identifiable side — skipped.`);
  if (d.missingPrice) console.warn(`  ${d.missingPrice} records had no usable price/line — skipped.`);
  if (d.missingPlayer) console.warn(`  ${d.missingPlayer} records had no player — skipped.`);
  if (d.teamEntries) console.log(`  ${d.teamEntries} team entries (D/ST etc.) in player markets — skipped.`);
  if (d.noHistoricalPrice) console.warn(`  ${d.noHistoricalPrice} historical odds carried neither a closing nor an opening price — skipped.`);
  if (d.lineValueSources) {
    const { closing = 0, opening = 0, fallback = 0, timeseries = 0 } = d.lineValueSources;
    const total = closing + opening + fallback + timeseries;
    if (total > 0) {
      console.log(
        `  line values: ${closing} closing, ${opening} opening, ${fallback} fell back, ${timeseries} from timeseries.`
      );
    }
    // `clv` is frequently null — in a real week-1 BetMGM pull only ~26% of odds
    // carried one — and a fallback silently grades against the OPENING price
    // instead. That is a materially different number (the line moved, which is
    // why both exist), so it gets said out loud rather than buried.
    if (fallback > 0) {
      const pct = ((fallback / total) * 100).toFixed(0);
      const got = a_useOpening ? "closing" : "opening";
      console.warn(
        `  ${pct}% of odds had no ${a_useOpening ? "opening" : "closing"} line value and were ` +
          `priced at the ${got} line instead (LineSource="${got}").\n` +
          `    In a real week-1 BetMGM pull this was 100% of PLAYER props — clv is\n` +
          `    populated on game markets but null on every player market.\n` +
          `    An opening line is softer than a closing one: the book has not yet absorbed\n` +
          `    sharp action, so a model backtested against it will look better than it would\n` +
          `    have performed betting at close. Treat these rows as a separate cohort from\n` +
          `    live-captured weeks rather than pooling them.`
      );
    }
  }
  if (d.unmatchedMarkets?.size) {
    // Not necessarily a problem — most are markets we deliberately don't model
    // (moneyline, spreads, kicker props). But a market we DO want showing up
    // here means its alias in lib/markets.mjs is wrong, so list the top few.
    const top = [...d.unmatchedMarkets.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
    console.log(`  ${d.unmatchedMarkets.size} unmodelled market names seen, most common:`);
    for (const [name, n] of top) console.log(`    ${n}× ${name}`);
  }
}

// Where the selected bets actually came from.
//
// The ledger takes the best price across every book pulled, so if that best
// price keeps landing at books you have no account with, the paper return is
// one you could never have earned. This is the line that makes that visible —
// a long tail of unfamiliar books is the signal to narrow --books.
function reportBetComposition(betRows) {
  if (betRows.length === 0) return;

  const oneSided = betRows.filter((b) => b.OneSided === 1).length;
  if (oneSided > 0) {
    console.log(
      `  ${oneSided}/${betRows.length} selected bets are one-sided (no opposing price), ` +
        `so their FairProb falls back to the raw price and ModelEdge equals Edge.`
    );
  }

  const byBook = new Map();
  for (const b of betRows) byBook.set(b.Book, (byBook.get(b.Book) ?? 0) + 1);
  const ranked = [...byBook.entries()].sort((x, y) => y[1] - x[1]);
  console.log(`  best price came from ${byBook.size} distinct book(s):`);
  for (const [book, n] of ranked.slice(0, 12)) {
    console.log(`    ${String(n).padStart(4)}  ${book}`);
  }
  if (ranked.length > 12) {
    const rest = ranked.slice(12).reduce((s, [, n]) => s + n, 0);
    console.log(`    ${String(rest).padStart(4)}  across ${ranked.length - 12} other book(s)`);
  }
}

function reportUnmatched(unmatched, noProjection) {
  if (noProjection) {
    console.log(`  ${noProjection} markets matched a player with no projection this week — skipped.`);
  }
  if (!unmatched.size) return;
  const total = [...unmatched.values()].reduce((s, n) => s + n, 0);
  console.warn(`  ${unmatched.size} players (${total} markets) could not be joined to a RotoWire id:`);
  for (const [key, n] of [...unmatched.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15)) {
    console.warn(`    ${n}× ${key}`);
  }
  if (unmatched.size > 15) console.warn(`    …and ${unmatched.size - 15} more.`);
}

const HELP = `Capture OpticOdds prop lines and price them against our projections.

  node scripts/capture-props.mjs [options]

  --season <year>          Season (default: current by date)
  --week <n>               NFL week (default: upcoming/in-progress by date)
  --min-edge <f>           Minimum edge to place a paper bet (default: 0.03)
  --kelly-fraction <f>     Fraction of full Kelly to stake (default: 0.25)
  --kelly-cap <f>          Max fraction of bankroll per bet (default: 0.03)
  --devig-method <m>       ${DEVIG_METHODS.join(" | ")}
                           (default: ${DEFAULT_DEVIG_METHOD})
  --edge-basis <b>         ev | novig (default: ev)
                           ev    = OurProb - ImpliedProb, the profitability
                                   test; this is the one that makes money.
                           novig = OurProb - FairProb, disagreement with the
                                   market. Always larger, so it selects many
                                   more bets — most of them not +EV. For
                                   research, not for a live ledger.
  --sides <s>              both | over | under (default: both)
  --books <a,b,c>          Sportsbooks to price against. Names are resolved
                           against the live list, so "hardrock" finds whatever
                           id the API uses. Default: the roster in
                           lib/books.mjs (${DEFAULT_BOOKS.join(", ")}).
  --all-books              Ignore the roster and use every active book that
                           prices NFL. The ledger takes the BEST price across
                           whatever is pulled, so this reports returns nobody
                           could have earned — research only.
  --include-offshore       With --all-books, also include offshore books. The
                           sharpest (Pinnacle) give the best fair-price
                           reference for judging ModelEdge.
  --historical             Pull closing lines for a week already played,
                           instead of current odds. OpticOdds retains history
                           on a rolling 2-month window, so older weeks cannot
                           be backfilled at all.
  --use-opening            With --historical, grade against the OPENING line
                           rather than the closing one. The gap between the two
                           measures how far the market moved after posting.
  --data-dir <path>        Data root (default: data)
  --allow-empty            Permit a run that produced 0 rows to overwrite an
                           existing snapshot. Without this, an empty result is
                           refused — an empty pull and a week with no bets look
                           identical on disk, and the snapshots are the durable
                           record.
  --dry-run                Fetch and price but do not write files
  -h, --help               Show this help

Env: OPTICODDS_API_KEY (required).`;

// Only run when executed directly — grade-bets.mjs and the test suite import
// this module for its column constants / ourProbability, and must not trigger
// a live capture as a side effect of that import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("capture-props failed:", err.message);
    process.exit(1);
  });
}
