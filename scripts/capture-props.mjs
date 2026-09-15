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
// 3. PLAYERS ARE JOINED BY NAME, NOT ID. RotoWire's feed handed us its own
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
//                                  [--books "DraftKings,FanDuel"]  (default: all)
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
  closingPriceFromHistory,
  pairOdds,
} from "./lib/optic-normalize.mjs";
import { buildPlayerIndex, matchPlayer, canonicalTeam } from "./lib/crosswalk.mjs";
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

function writeCsvIfChanged(path, csv, a) {
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prev === csv) {
    console.log(`  unchanged: ${path} — no rewrite.`);
    return;
  }
  if (a.dryRun) {
    console.log(`  [dry-run] would ${prev === null ? "write" : "update"} ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
  console.log(`  ${prev === null ? "wrote" : "updated"} ${path}`);
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
    console.log(`  fetching CLOSING lines (historical) for ${fixtureIds.length} fixtures…`);
    const payloads = await client.getHistoricalOdds({ fixtureIds, sportsbooks, markets, onProgress });
    return historicalToMarkets(payloads, fixtures);
  }

  console.log(`  fetching current odds for ${fixtureIds.length} fixtures…`);
  const payloads = await client.getOddsForFixtures({ fixtureIds, sportsbooks, markets, onProgress });
  return normalizeOddsPayloads(payloads, { statDefs: STAT_DEFS });
}

// Historical payloads carry a price HISTORY per odd rather than a single
// price. Collapse each series to its closing price (the last one before
// kickoff — see closingPriceFromHistory) and then pair the sides exactly as a
// live pull would.
function historicalToMarkets(payloads, fixtures) {
  const kickoffByFixture = new Map(fixtures.map((f) => [f.id, f.startDate]));
  const series = flattenHistoricalPayloads(payloads);

  const collapsed = [];
  let noClose = 0;
  for (const s of series) {
    if (!s.history) {
      // Already a point-in-time price rather than a series.
      if (s.price !== null) collapsed.push(s);
      else noClose++;
      continue;
    }
    const close = closingPriceFromHistory(s.history, kickoffByFixture.get(s.fixtureId));
    if (!close) {
      noClose++;
      continue;
    }
    collapsed.push({ ...s, price: close.price, points: close.points ?? s.points, timestamp: close.timestamp });
  }

  // Re-pair using the same grouping logic the live path uses.
  const { rows, diagnostics } = pairOdds(collapsed, { statDefs: STAT_DEFS });
  return { rows, diagnostics: { ...diagnostics, noClosingPrice: noClose } };
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

  // Books: every one OpticOdds offers, unless narrowed with --books. Line
  // shopping across the full set is the point — different books post
  // different lines for the same player, and the best of them is what we bet.
  if (a.books?.length) {
    a.resolvedBooks = a.books;
  } else {
    const books = await client.getSportsbooks({ sport: "football", league: "nfl" });
    a.resolvedBooks = books
      .map((b) => (typeof b === "string" ? b : b?.name ?? b?.id))
      .filter(Boolean);
    if (a.resolvedBooks.length === 0) {
      throw new Error("OpticOdds returned no sportsbooks — cannot price anything.");
    }
  }
  console.log(`  books: ${a.resolvedBooks.length} (${a.resolvedBooks.slice(0, 6).join(", ")}…)`);

  // Fixtures for the week.
  const fixtureRows = await client.getFixtures({
    league: "nfl",
    seasonYear: a.season,
    seasonWeek: a.week,
  });
  const fixtures = fixtureRows
    .map((f) => ({
      id: String(f?.id ?? f?.fixture_id ?? ""),
      homeTeam: f?.home_team_display ?? f?.home_team ?? f?.home_competitors?.[0]?.abbreviation,
      awayTeam: f?.away_team_display ?? f?.away_team ?? f?.away_competitors?.[0]?.abbreviation,
      startDate: f?.start_date ?? f?.startDate ?? null,
    }))
    .filter((f) => f.id);
  console.log(`  fixtures: ${fixtures.length} games for week ${a.week}.`);
  if (fixtures.length === 0) {
    console.warn("  No fixtures returned — nothing to capture. Check --season/--week.");
    return;
  }
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  const { rows: markets, diagnostics } = await fetchWeekOdds(client, a, fixtures);
  console.log(
    `  ${markets.length} distinct markets after pairing ` +
      `(${markets.filter((m) => m.oneSided).length} one-sided).`
  );
  reportDiagnostics(diagnostics);

  // Join each market to a RotoWire player, then price it.
  const capturedAt = now.toISOString();
  const priced = [];
  const unmatched = new Map();
  let noProjection = 0;

  for (const market of markets) {
    const match = matchPlayer(playerIndex, { name: market.playerName, team: market.team });
    if (!match.playerId) {
      const key = `${market.playerName} (${market.team || "?"}) — ${match.reason}`;
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
      continue;
    }
    const splits = projections.get(match.playerId);
    if (!splits) {
      noProjection++;
      continue;
    }
    const fixture = fixtureById.get(market.fixtureId);
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
  writeCsvIfChanged(existingPath, toCsv(BETS_COLUMNS, betRows), a);

  console.log(`Done. ${client.requestCount} OpticOdds requests.`);
}

function reportDiagnostics(d) {
  if (!d) return;
  if (d.noSide) console.warn(`  ${d.noSide} records had no identifiable side — skipped.`);
  if (d.missingPrice) console.warn(`  ${d.missingPrice} records had no usable price/line — skipped.`);
  if (d.missingPlayer) console.warn(`  ${d.missingPlayer} records had no player — skipped.`);
  if (d.noClosingPrice) console.warn(`  ${d.noClosingPrice} historical series had no price before kickoff — skipped.`);
  if (d.unmatchedMarkets?.size) {
    // Not necessarily a problem — most are markets we deliberately don't model
    // (moneyline, spreads, kicker props). But a market we DO want showing up
    // here means its alias in lib/markets.mjs is wrong, so list the top few.
    const top = [...d.unmatchedMarkets.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
    console.log(`  ${d.unmatchedMarkets.size} unmodelled market names seen, most common:`);
    for (const [name, n] of top) console.log(`    ${n}× ${name}`);
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
  --books <a,b,c>          Sportsbooks to pull (default: every one offered)
  --historical             Pull closing lines for a week already played,
                           instead of current odds
  --data-dir <path>        Data root (default: data)
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
