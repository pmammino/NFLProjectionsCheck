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
//   data/edges/{season}/week-NN.csv   the subset clearing --min-edge, at EVERY
//                                      book quoting it. This is the published
//                                      signal — what a subscriber would see on
//                                      Tuesday morning. Not collapsed to the
//                                      best price, because a bettor who can
//                                      only reach one book needs that book's
//                                      own quote.
//
// scripts/simulate-personas.mjs turns data/edges/ into per-persona ledgers
// under data/bets/{persona}/. Nothing here writes a ledger directly.
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
//                                  [--price-model projection|blend]
//                                  [--median-correction off|auto]
//                                  [--price-model-set retail|sharp|all]
//                                  [--price-model-file data/pricing/…/model.json]
//                                  [--sides both|over|under]
//                                  [--books "DraftKings,FanDuel"] (default: lib/books.mjs)
//                                  [--all-books] [--include-offshore]
//                                  [--historical] [--at opening|closing|T-48h]
//                                  [--slot main|thursday|…]
//                                  [--data-dir data] [--dry-run]
//
// Env: OPTICODDS_API_KEY (required).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAT_DEFS, allOpticMarketNames, projectedValue } from "./lib/markets.mjs";
import {
  meetsSupportFloor,
  marketsExceedingTolerance,
  marketIdentity,
  MAX_MARKET_DISAGREEMENT,
} from "./lib/calibration.mjs";
import { probOverContinuous, probOverPoisson } from "./lib/probability.mjs";
import { americanToProb, americanToDecimal, kellyFraction } from "./lib/odds.mjs";
import { devigTwoWay, DEFAULT_DEVIG_METHOD, DEVIG_METHODS } from "./lib/devig.mjs";
import { OpticOddsClient } from "./lib/opticodds.mjs";
import {
  normalizeOddsPayloads,
  flattenHistoricalPayloads,
  parseAtSpec,
  atSpecLabel,
  historicalPriceAt,
  pairOdds,
} from "./lib/optic-normalize.mjs";
import { buildPlayerIndex, matchPlayer, canonicalTeam } from "./lib/crosswalk.mjs";
import {
  BETTABLE_BOOKS,
  REFERENCE_BOOKS,
  booksToFetch,
  resolveBookIds,
  bookKeySet,
  isBettableBook,
} from "./lib/books.mjs";
import { readCsv, toCsv } from "./lib/csv.mjs";
import { seasonForDate, projectionWeek } from "./lib/schedule.mjs";
import { edgeBucket } from "./lib/edge.mjs";
import { SLOT_MAIN, slotDir, assertValidSlot } from "./lib/slots.mjs";
import { consensusProb, estimateHoldByStat, MARKET_SET_NAMES } from "./lib/consensus.mjs";
import { predict as predictPrice } from "./lib/pricing.mjs";
import { fitFromData, adjustedPoints, multiplierFor, formatFits } from "./lib/median-correction.mjs";

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
  "Proj", // our projected median for this stat — the value the support floor gates on
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
  "PriceModel", // which model produced OurProb: projection | blend
  "MedianAdj", // multiplier applied to the projected median before pricing; blank = none
  "Slot", // which capture of the week this is: main (the Tuesday drop) or a later one
  "Bettable", // 1 = a bet could be placed here; 0 = reference price only, never staked
  "LineSource", // live | closing | opening — see historicalToMarkets
  "FixtureID",
  "CapturedAt",
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
    // The projection-only price stays the default. Switching the live ledger
    // onto a fitted model is a decision for the report to earn, not one to
    // inherit by upgrading.
    priceModel: "projection",
    priceModelSet: "retail",
    // Off by default, like the blend: it changes what the Tuesday drop
    // publishes, so it is switched on deliberately and not by upgrading.
    medianCorrectionMode: "off",
    medianCorrection: null,
    historical: false,
    slot: SLOT_MAIN,
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
      case "--price-model": a.priceModel = next(); break;
      case "--median-correction": a.medianCorrectionMode = next(); break;
      case "--price-model-set": a.priceModelSet = next(); break;
      case "--price-model-file": a.priceModelFile = next(); break;
      case "--edge-basis": a.edgeBasis = next(); break;
      case "--sides": a.sides = next(); break;
      case "--books": a.books = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--historical": a.historical = true; break;
      case "--at": a.at = next(); break;
      case "--slot": a.slot = next(); a.slotExplicit = true; break;
      case "--use-opening": a.useOpening = true; break;
      case "--allow-line-fallback": a.allowLineFallback = true; break;
      case "--allow-empty": a.allowEmpty = true; break;
      case "--include-offshore": a.includeOffshore = true; break;
      case "--reference-books":
        a.referenceBooks = next().split(",").map((x) => x.trim()).filter(Boolean);
        break;
      case "--no-reference-books": a.noReferenceBooks = true; break;
      case "--all-books": a.allBooks = true; break;
      case "--closing": a.closing = true; break;
      case "--closing-window-hours": a.closingWindowHours = Number(next()); break;
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
  if (!["projection", "blend"].includes(a.priceModel)) {
    throw new Error("--price-model must be one of: projection, blend");
  }
  if (!["off", "auto"].includes(a.medianCorrectionMode)) {
    throw new Error("--median-correction must be one of: off, auto");
  }
  // The blend was fitted on projection probabilities that were NOT corrected.
  // Feeding it corrected ones would change its input distribution without
  // refitting it, and the two corrections would be fighting over the same tilt.
  if (a.medianCorrectionMode === "auto" && a.priceModel === "blend") {
    throw new Error(
      "--median-correction auto cannot be combined with --price-model blend: the blend was " +
        "fitted on uncorrected projection probabilities. Use one or the other."
    );
  }
  if (!MARKET_SET_NAMES.includes(a.priceModelSet)) {
    throw new Error(`--price-model-set must be one of: ${MARKET_SET_NAMES.join(", ")}`);
  }

  // --at reconstructs a moment from the price history, so it only means
  // anything on a historical pull. Silently ignoring it on a live one would
  // write a file labelled as a reconstruction that is really just "now".
  if (a.at !== undefined && !a.historical) {
    throw new Error("--at only applies to --historical (it reconstructs a past moment).");
  }
  if (a.historical) {
    a.atSpec = parseAtSpec(a.at ?? (a.useOpening ? "opening" : "closing"));
    if (a.at !== undefined && a.useOpening) {
      throw new Error("--use-opening and --at are two ways to say the same thing; pass one.");
    }
    // A reconstruction defaults into its own slot. Overwriting the Tuesday
    // drop with a backfill would destroy the only record of what was actually
    // published, which no later run can rebuild. Pass --slot main to mean it.
    if (!a.slotExplicit) a.slot = atSpecLabel(a.atSpec);
  }
  assertValidSlot(a.slot);
  return a;
}

// The number --min-edge is compared against. See the header: `ev` is the
// profitability test and the default; `novig` measures disagreement with the
// market and will select many more bets, most of them not +EV.
const selectionEdge = (cand, basis) => (basis === "novig" ? cand.modelEdge : cand.edge);

const pad2 = (n) => String(n).padStart(2, "0");
const projPath = (dir, season, week) => join(ROOT, dir, "projections", String(season), `week-${pad2(week)}.csv`);
// Slot-aware output paths. See lib/slots.mjs for what a slot is and why the
// Tuesday drop keeps the original filenames.
const propsPath = (dir, season, week, slot) =>
  join(ROOT, dir, "props", String(season), slotDir(slot), `week-${pad2(week)}.csv`);
const edgesPath = (dir, season, week, slot) =>
  join(ROOT, dir, "edges", String(season), slotDir(slot), `week-${pad2(week)}.csv`);
const closingPath = (dir, season, week) => join(ROOT, dir, "closing", String(season), `week-${pad2(week)}.csv`);
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
//
// Returns null for a retired market (bet: false) as well as an unknown one. A
// price we will never stake is not worth computing, and refusing here means a
// retired stat cannot reach an edge set even if a row for it arrives from an
// archived snapshot or a market alias we did not expect.
//
// `correction` is an optional median correction (lib/median-correction.mjs):
// for the stats it covers, F/M/C are re-centred before the distribution is
// built. Null — the default — is exactly the long-standing price. Poisson stats
// never take one: they use the projected count, not the F/M/C band.
export function ourProbability({ line, statKey }, splits, correction = null) {
  const statDef = STAT_DEFS[statKey];
  if (!statDef || statDef.bet === false || !splits || !splits.M) return null;
  if (statDef.kind === "poisson") {
    const lambda = sumCols(splits.M, statDef.projCols);
    return probOverPoisson(line, lambda);
  }
  if (!splits.F || !splits.C) return null;
  const f = sumCols(splits.F, statDef.projCols);
  const m = sumCols(splits.M, statDef.projCols);
  const c = sumCols(splits.C, statDef.projCols);
  const pts = adjustedPoints({ F: f, M: m, C: c }, correction, statKey);
  return probOverContinuous(line, pts.F, pts.M, pts.C);
}

// ---------------------------------------------------------------------------
// Optional second pricing pass: the fitted blend
// ---------------------------------------------------------------------------
// priceMarket sees one book at a time and so can only ever produce the
// projection-only price. The blend needs the whole market — a consensus is
// not a property of any single quote — so it runs here, over every candidate,
// exactly as the disagreement cap does.
//
// Two invariants this maintains and a naive implementation would not:
//
//  1. THE TWO SIDES STAY COHERENT. Only the Over is blended; the Under is set
//     to its complement. Blending each side independently would produce a
//     pair that does not sum to 1, which is not a probability and would show
//     up as free arbitrage against ourselves.
//
//  2. A MARKET WITH NO CONSENSUS KEEPS ITS PROJECTION PRICE rather than being
//     dropped or silently defaulted to the book. The blend is an improvement
//     where it applies, not a precondition for pricing, and `PriceModel`
//     records per row which one was used so a ledger stays auditable.
//
// Returns the number of candidates actually re-priced.
export function repriceWithBlend(priced, fit, { marketSet = "retail", devigMethod } = {}) {
  if (!fit) return 0;
  const holdByStat = estimateHoldByStat(priced.map((p) => ({ stat: p.statKey, hold: p.hold })));

  const groups = new Map();
  for (const p of priced) {
    const key = [p.rotowirePlayerId, p.statKey, p.line].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  let changed = 0;
  for (const group of groups.values()) {
    // One quote per candidate, stated from the market's point of view so the
    // consensus does not care which side each row was written from.
    const quotes = group.map((p) => ({
      book: p.sportsbook,
      overOdds: p.side === "over" ? p.odds : p.oppositeOdds,
      underOdds: p.side === "over" ? p.oppositeOdds : p.odds,
    }));
    const stat = group[0].statKey;
    const cons = consensusProb(quotes, { side: "over", setName: marketSet, holdByStat, stat, method: devigMethod });
    if (!cons) continue;

    const over = group.find((p) => p.side === "over");
    const projOver = over ? over.ourProb : 1 - group[0].ourProb;
    const blended = predictPrice(fit, { stat, pProj: projOver, pMarket: cons.prob });
    if (blended === null) continue;

    for (const p of group) {
      p.ourProb = p.side === "under" ? 1 - blended : blended;
      p.edge = p.ourProb - p.impliedProb;
      p.modelEdge = p.ourProb - p.fairProb;
      p.priceModel = "blend";
      changed++;
    }
  }
  return changed;
}

// Load the fit written by `price-model.mjs --write`.
//
// Fails loudly rather than falling back to the projection price: a run asked
// for the blend, and quietly giving it something else would put rows in a
// ledger labelled with a model that never ran.
function loadPriceModel(a) {
  const path = a.priceModelFile ?? join(a.dataDir, "pricing", String(a.season), "model.json");
  if (!existsSync(path)) {
    throw new Error(
      `--price-model blend needs a fitted model at ${path}.\n` +
        `    Run: node scripts/price-model.mjs --season ${a.season} --write`
    );
  }
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const set = payload.sets?.[a.priceModelSet];
  if (!set?.fit) {
    throw new Error(
      `${path} carries no fit for market set "${a.priceModelSet}" ` +
        `(has: ${Object.keys(payload.sets ?? {}).join(", ") || "none"}).`
    );
  }
  return { ...set.fit, trainedOnWeeks: set.trainedOnWeeks };
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
function priceMarket(market, splits, a, reject = null) {
  const probOver = ourProbability(market, splits, a.medianCorrection);
  if (probOver === null) return [];
  // What multiplier priced this row, if any. The support floor below still
  // gates on the RAW projected median: it asks whether the player is projected
  // for a real role, which is a statement about the feed, not about the shape
  // of the outcome.
  const medianAdj = multiplierFor(a.medianCorrection, market.statKey);

  const rawOver = americanToProb(market.overOdds);
  const rawUnder = market.underOdds === null ? null : americanToProb(market.underOdds);
  if (rawOver === null) return [];

  // Guard 1 (support floor) applies to the MARKET, not to a side: if our
  // projection sits where the model has been shown not to work, neither side
  // of it is bettable. Checked before any candidate is built so a rejected
  // market produces no rows at all.
  const proj = projectedValue(splits.M, market.statKey);
  if (!meetsSupportFloor({ stat: market.statKey, projectedMedian: proj, line: market.line })) {
    reject?.("support-floor", market.statKey);
    return [];
  }

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
      bettable: market.bettable,
      medianAdj,
      impliedProb: rawOver,
      fairProb: fair,
      hold: devigged ? devigged.hold : null,
      edge: probOver - rawOver, // EV: break-even is the raw implied price
      modelEdge: probOver - fair, // disagreement with the market's belief
      proj,
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
      bettable: market.bettable,
      medianAdj,
      impliedProb: rawUnder,
      fairProb: devigged.fairProbUnder,
      hold: devigged.hold,
      edge: probUnder - rawUnder,
      modelEdge: probUnder - devigged.fairProbUnder,
      proj,
    });
  }

  // Guard 2 (the market-disagreement cap) is NOT applied here. It needs every
  // book's price for a market before it can judge the consensus, and this
  // function only ever sees one book. It runs as a pass over all candidates
  // once pricing is done — see applyCalibrationGuards.
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
  //
  // TWO rosters, not one. `bettable` are books a bet can be placed at and are
  // the only prices allowed to reach data/edges/ or a ledger. `reference`
  // books are captured for their price and never staked — they exist to
  // sharpen the fair-value consensus. See lib/books.mjs.
  //
  // --books overrides the BETTABLE list only. Naming your own accounts should
  // not silently also discard the sharp reference the model is judged against.
  const bettableWanted = a.books ?? BETTABLE_BOOKS;
  const referenceWanted = a.referenceBooks ?? (a.noReferenceBooks ? [] : REFERENCE_BOOKS);
  const requested = booksToFetch({ bettable: bettableWanted, reference: referenceWanted });
  const { ids, matched, resolved, missing, ambiguous } = resolveBookIds(requested, all);

  // --include-offshore has never done anything on this path: it is read only
  // inside the --all-books branch above. Saying so beats leaving a flag that
  // appears to work — it is part of why the starved `sharp` market set was
  // misdiagnosed as "offshore books were not requested" when the real cause
  // was Circa dropping out of the roster.
  if (a.includeOffshore) {
    console.warn(
      `  --include-offshore has no effect without --all-books. Sharp prices now come\n` +
        `    from the REFERENCE roster, which is pulled by default (${REFERENCE_BOOKS.join(", ") || "none"}).\n` +
        `    Use --reference-books to change it, or --no-reference-books to drop it.`
    );
  }

  const bettableSet = new Set(bettableWanted.map((b) => b.toLowerCase()));
  const bettableResolved = resolved.filter((r) => bettableSet.has(r.requested.toLowerCase()));
  a.bettableKeys = bookKeySet(bettableResolved);

  console.log(`  books: ${ids.length} of ${requested.length} requested, resolved against ${all.length} live books`);
  for (const [want, id] of matched) {
    const role = bettableSet.has(want.toLowerCase()) ? "" : "   [reference only — never staked]";
    console.log(`    ${want}${want === id ? "" : ` -> ${id}`}${role}`);
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
      `  fetching historical odds as of ${atSpecLabel(a.atSpec)} for ` +
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
  const atLabel = atSpecLabel(a.atSpec);
  for (const rec of records) {
    const lv = historicalPriceAt(rec, a.atSpec, { allowFallback: a.allowLineFallback === true });
    if (!lv) {
      // On an offset this is usually not an error: an odd the book had not
      // posted by that hour is ABSENT from the board then, which is the fact
      // the timing question turns on. It is counted, not warned about.
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
    // Record WHICH moment this price is from. On an offset that is the offset
    // itself, so a row backfilled at T-48h can never be read as a live one.
    const lineSource =
      a.atSpec.kind === "opening" || a.atSpec.kind === "closing"
        ? lv.source === "fallback"
          ? a.atSpec.kind === "opening" ? "closing" : "opening"
          : lv.source
        : atLabel;
    collapsed.push({ ...rec, price: lv.price, points: lv.points ?? rec.points, lineSource });
  }

  // Re-pair using the same grouping logic the live path uses.
  const { rows, diagnostics } = pairOdds(collapsed, { statDefs: STAT_DEFS });
  return {
    rows,
    diagnostics: {
      ...diagnostics,
      // How many odds the API actually returned, BEFORE any were dropped for
      // having no price at the requested moment. Without this the caller
      // cannot tell "the key returned nothing" from "the key returned plenty
      // and none of it covered the moment asked for" — two problems with
      // completely different fixes. See the zero-records diagnostic.
      recordsFetched: records.length,
      noHistoricalPrice: noPrice,
      lineValueSources: bySource,
    },
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
      (a.historical ? ` (historical, as of ${atSpecLabel(a.atSpec)})` : "") +
      (a.dryRun ? " (dry-run)" : "")
  );

  const projections = loadProjections(a.dataDir, a.season, a.week);

  // Median correction, fitted AS OF this week. loadTrainingPairs only reads
  // weeks strictly before a.week, so pricing week W never sees W's result —
  // which matters most for a --historical backfill of an old week, where the
  // later results are all sitting on disk.
  if (a.medianCorrectionMode === "auto") {
    const { fits, weeksUsed } = fitFromData({
      dataDir: join(ROOT, a.dataDir),
      season: a.season,
      beforeWeek: a.week,
    });
    a.medianCorrection = fits;
    console.log(
      weeksUsed.length
        ? `  median correction, fitted on weeks ${weeksUsed.join(", ")} (strictly before week ${a.week}):`
        : `  median correction: no completed weeks before week ${a.week} to fit on — nothing applied.`
    );
    for (const line of formatFits(fits)) console.log(`    ${line}`);
  }
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
  let fixtures = fixtureRows
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

  // --closing narrows to fixtures kicking off soon, so a daily run records
  // each game's last pre-kickoff price exactly once. Games start Thursday,
  // Sunday and Monday, so no single weekly pull can catch them all — but a
  // daily pull with a short window catches every one of them close to its own
  // kickoff, which is what a closing line actually means.
  if (a.closing) {
    const windowMs = (a.closingWindowHours ?? 24) * 3600_000;
    const now = Date.now();
    const alreadyRecorded = loadRecordedFixtures(a);
    const due = fixtures.filter((f) => {
      if (alreadyRecorded.has(f.id)) return false;
      const kick = f.startDate ? Date.parse(f.startDate) : NaN;
      if (!Number.isFinite(kick)) return false;
      return kick > now && kick - now <= windowMs;
    });
    console.log(
      `  closing mode: ${due.length} of ${fixtures.length} fixtures kick off within ` +
        `${(windowMs / 3600_000).toFixed(0)}h and are not yet recorded ` +
        `(${alreadyRecorded.size} already captured).`
    );
    if (due.length === 0) {
      console.log("  nothing to record. Done.");
      return;
    }
    fixtures = due;
    fixtureById.clear();
    for (const f of fixtures) fixtureById.set(f.id, f);
  }

  const { rows: markets, diagnostics } = await fetchWeekOdds(client, a, fixtures);

  // Fixtures came back but carried no odds at all. This is a distinct failure
  // from "no bets cleared the edge bar", and it has specific causes worth
  // naming rather than leaving the caller to guess from an empty file.
  if (diagnostics && diagnostics.total === 0) {
    // Two different failures both end in an empty file, and they need
    // opposite fixes. A real 2026 week-3 run printed the permission advice
    // below while the key was working perfectly: 123,464 historical odds came
    // back and every one was dropped because none carried a price at the
    // requested T-48h. Blaming the key there sends you to fix the wrong thing.
    if (a.historical && diagnostics.recordsFetched > 0) {
      console.error(
        `  ${fixtures.length} fixture(s) and ${diagnostics.recordsFetched} historical odds ` +
          `came back, but NONE carried a price as of ${atSpecLabel(a.atSpec)}.\n` +
          `    The key and the retention window are fine — it is the MOMENT that is\n` +
          `    unavailable. See the note below on which moments the key supports.\n`
      );
    } else {
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
  }

  console.log(
    `  ${markets.length} distinct markets after pairing ` +
      `(${markets.filter((m) => m.oneSided).length} one-sided).`
  );
  reportDiagnostics(diagnostics, a.atSpec ?? null);

  // Join each market to a RotoWire player, then price it.
  const capturedAt = now.toISOString();
  const priced = [];
  const unmatched = new Map();
  let noProjection = 0;
  // Calibration guards, counted by reason and stat. A run that silently
  // captured half as much as last week would look like an API problem; these
  // counts make it obvious that it was our own filters instead.
  const rejected = new Map();
  const countRejection = (reason, statKey) => {
    const key = `${reason}|${statKey}`;
    rejected.set(key, (rejected.get(key) ?? 0) + 1);
  };

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
    // Which roster this book is on. Decided here, once, from the resolved
    // roster rather than re-derived downstream — a row whose Bettable flag
    // disagreed with the roster that produced it would be unauditable.
    const taggedMarket = { ...market, bettable: isBettableBook(market.sportsbook, a.bettableKeys) };
    for (const cand of priceMarket(taggedMarket, splits, a, countRejection)) {
      priced.push({
        ...cand,
        rotowirePlayerId: match.playerId,
        pos: match.entry?.pos ?? "",
        team: canonicalTeam(market.team) ?? match.entry?.team ?? "",
        opp: opponentLabel(market.team || match.entry?.team, fixture),
      });
    }
  }

  // Optional: re-price off the fitted blend, now that every book's price for
  // a market is in hand and a consensus can be formed. Runs BEFORE the
  // disagreement cap on purpose — the cap is a judgement about the price we
  // are actually going to bet, so it has to see the final number.
  if (a.priceModel === "blend") {
    const fit = loadPriceModel(a);
    const changed = repriceWithBlend(priced, fit, { marketSet: a.priceModelSet, devigMethod: a.devigMethod });
    const [tilt, mktWeight, disagreeWeight] = fit.global;
    console.log(
      `  re-priced ${changed} of ${priced.length} candidates off the fitted blend ` +
        `(set "${a.priceModelSet}", trained on weeks ${fit.trainedOnWeeks?.join(", ") || "?"}).`
    );
    console.log(
      `    weights: tilt a=${tilt.toFixed(3)}, market c=${mktWeight.toFixed(3)}, ` +
        `disagreement b=${disagreeWeight.toFixed(3)}`
    );
    // The intercept is the dangerous one. It moves EVERY price in the same
    // direction, so a tilt fitted on a sample that over-represents overs
    // silently turns the whole board into over bets. On the 2026 captures
    // that is exactly what it is doing — the actuals feed omits players who
    // recorded nothing, which are the under wins — so it is called out here
    // rather than left to be discovered in a ledger.
    if (Math.abs(tilt) > 0.1) {
      console.warn(
        `    WARNING: a global tilt of ${tilt.toFixed(3)} shifts every price toward ` +
          `${tilt > 0 ? "overs" : "unders"}.\n` +
          `    Check the dataset section of \`npm run price-model\` for how much of that\n` +
          `    is a selection effect before trusting a ledger built on it.`
      );
    }
  }

  // The market-disagreement cap, now that every book's price is in hand.
  // The support floor already ran inside priceMarket, so nothing here can be
  // a market we declined to price.
  const consensusCut = marketsExceedingTolerance(
    priced.map((p) => ({
      marketKey: marketIdentity({ playerId: p.rotowirePlayerId, stat: p.statKey, line: p.line, side: p.side }),
      ourProb: p.ourProb,
      fairProb: p.fairProb,
    }))
  );
  const survived = priced.filter((p) => {
    const key = marketIdentity({ playerId: p.rotowirePlayerId, stat: p.statKey, line: p.line, side: p.side });
    if (!consensusCut.has(key)) return true;
    countRejection("market-disagreement", p.statKey);
    return false;
  });

  console.log(`  ${survived.length} priced candidates across ${new Set(survived.map((p) => p.rotowirePlayerId)).size} players.`);
  reportUnmatched(unmatched, noProjection);
  reportCalibrationRejections(rejected);

  // ---- data/props snapshot: every priced candidate ----
  const propsRows = survived.map((p) => ({
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
    Proj: p.proj ?? "",
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
    PriceModel: p.priceModel ?? "projection",
    MedianAdj: p.medianAdj === null || p.medianAdj === undefined ? "" : p.medianAdj.toFixed(4),
    Slot: a.slot,
    Bettable: p.bettable === false ? 0 : 1,
    LineSource: p.lineSource ?? "live",
    FixtureID: p.fixtureId,
    CapturedAt: capturedAt,
  }));
  propsRows.sort((x, y) => Number(y.Edge) - Number(x.Edge));

  // Closing mode appends to the week's closing file and stops. It never
  // touches props/ or edges/ — those are the Tuesday drop, and overwriting
  // them with Sunday prices would destroy the very comparison CLV exists to
  // make.
  if (a.closing) {
    const path = closingPath(a.dataDir, a.season, a.week);
    const existing = existsSync(path) ? readCsv(path) : [];
    const merged = [...existing, ...propsRows];
    writeCsvIfChanged(path, toCsv(PROPS_COLUMNS, merged), a);
    console.log(
      `  recorded ${propsRows.length} closing prices for ${fixtures.length} fixture(s) ` +
        `(${merged.length} total this week).`
    );
    console.log(`Done. ${client.requestCount} OpticOdds requests.`);
    return;
  }

  writeCsvIfChanged(propsPath(a.dataDir, a.season, a.week, a.slot), toCsv(PROPS_COLUMNS, propsRows), a);

  // ---- data/edges: the published signal ----
  //
  // Every candidate clearing the edge bar, at EVERY book that quotes it —
  // deliberately not collapsed to the best price. A persona that can only
  // reach DraftKings needs DraftKings' own quote, and collapsing here would
  // hand every simulated bettor a price most of them cannot get.
  //
  // This is the file a subscriber would effectively receive on Tuesday
  // morning. scripts/simulate-personas.mjs turns it into per-persona ledgers.
  // Only a price you can actually take becomes an edge. Reference books are
  // captured, priced and kept in data/props — they are what sharpens the
  // consensus — but a bet at one is a return nobody could have earned, which
  // is the whole reason the two rosters are separate.
  const bettableRows = propsRows.filter((r) => Number(r.Bettable) === 1);
  const referenceOnly = propsRows.length - bettableRows.length;
  if (referenceOnly > 0) {
    console.log(
      `  ${referenceOnly} of ${propsRows.length} priced rows are reference-only and cannot ` +
        `become edges (kept in data/props for the consensus).`
    );
  }
  const edgeRows = bettableRows.filter((r) => Number(r[a.edgeBasis === "novig" ? "ModelEdge" : "Edge"]) >= a.minEdge);
  console.log(
    `  ${edgeRows.length} of ${bettableRows.length} bettable candidates clear the ` +
      `${(a.minEdge * 100).toFixed(1)}% bar, across ` +
      `${new Set(edgeRows.map((r) => `${r.PlayerID}|${r.Stat}`)).size} player-stats.`
  );
  writeCsvIfChanged(edgesPath(a.dataDir, a.season, a.week, a.slot), toCsv(PROPS_COLUMNS, edgeRows), a);

  reportBetComposition(edgeRows);

  console.log(`Done. ${client.requestCount} OpticOdds requests.`);
}

function reportDiagnostics(d, atSpec = null) {
  const a_useOpening = atSpec?.kind === "opening";
  if (!d) return;
  if (d.noSide) console.warn(`  ${d.noSide} records had no identifiable side — skipped.`);
  if (d.missingPrice) console.warn(`  ${d.missingPrice} records had no usable price/line — skipped.`);
  if (d.missingPlayer) console.warn(`  ${d.missingPlayer} records had no player — skipped.`);
  if (d.teamEntries) console.log(`  ${d.teamEntries} team entries (D/ST etc.) in player markets — skipped.`);
  if (d.noHistoricalPrice) {
    if (atSpec && atSpec.kind !== "opening" && atSpec.kind !== "closing") {
      console.warn(
        `  ${d.noHistoricalPrice} odds had no price as of ${atSpecLabel(atSpec)} — skipped.`
      );
    } else {
      console.warn(
        `  ${d.noHistoricalPrice} historical odds carried neither a closing nor an opening price — skipped.`
      );
    }
  }
  if (d.lineValueSources) {
    const { closing = 0, opening = 0, fallback = 0, timeseries = 0 } = d.lineValueSources;
    const total = closing + opening + fallback + timeseries;
    if (total > 0) {
      console.log(
        `  line values: ${closing} closing, ${opening} opening, ${fallback} fell back, ${timeseries} from timeseries.`
      );
    }
    // A slot holding two different instruments is worse than a smaller slot.
    // The consensus medians across books within a market, so a mix means some
    // markets get a price blended from two moments — a number belonging to no
    // moment the market ever occupied. Loud, because it is invisible in the
    // file: every row looks fine on its own and only LineSource betrays it.
    const kinds = [closing, opening, fallback, timeseries].filter((n) => n > 0).length;
    if (kinds > 1) {
      console.warn(
        `  WARNING: this capture MIXES ${kinds} kinds of line value in one slot.\n` +
          `    A market's consensus can then blend prices from different moments.\n` +
          `    This is what --allow-line-fallback permits; drop it to get a slot\n` +
          `    holding one instrument, and run each endpoint as its own slot.`
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
  // An offset needs the per-odd `entries` timeseries, which is a separate
  // OpticOdds permission. Without it every offset row resolves to nothing,
  // and the run looks like "the books had posted nothing" rather than "we are
  // not allowed to see when they posted it". Those need telling apart.
  if (atSpec && atSpec.kind === "offset" && (d.lineValueSources?.timeseries ?? 0) === 0) {
    console.warn(
      `\n  NOTHING resolved at ${atSpecLabel(atSpec)}: not one odd carried a price history.\n` +
        `    An offset is reconstructed from each odd's \`entries\` timeseries, which is a\n` +
        `    separate OpticOdds permission (include_timeseries). If your key lacks it, the\n` +
        `    only moments available are --at opening and --at closing.\n` +
        `    Note also that on this project's key clv comes back null for PLAYER props\n` +
        `    (populated on game markets only), so --at closing will in practice fall back\n` +
        `    to the opening line and say so above.`
    );
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

// What the published edge set actually consists of.
//
// Two things a reader needs before trusting the numbers downstream:
// which books the edges live at (a set concentrated in books nobody holds an
// account with is not an actionable signal), and how many are one-sided
// (those carry no de-vigged fair price, so ModelEdge equals Edge on them).
// What the calibration guards threw away, and why.
//
// Worth printing every run even when it is boring. A support-floor count that
// suddenly covers a stat it never used to means the projections shifted; a
// market-disagreement count that climbs above a trickle means the model has
// broken somewhere new and the cap is papering over it. Both are invisible if
// only the surviving candidates are reported.
function reportCalibrationRejections(rejected) {
  if (rejected.size === 0) return;
  const byReason = new Map();
  for (const [key, n] of rejected) {
    const [reason, stat] = key.split("|");
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push([stat, n]);
  }
  for (const [reason, stats] of byReason) {
    const total = stats.reduce((s, [, n]) => s + n, 0);
    const detail = stats
      .sort((x, y) => y[1] - x[1])
      .map(([s, n]) => `${s} ${n}`)
      .join(", ");
    const why =
      reason === "support-floor"
        ? "projection below the level where the model is calibrated"
        : `model disagreed with the market by more than ${(MAX_MARKET_DISAGREEMENT * 100).toFixed(0)} points`;
    console.log(`  skipped ${total} (${reason}): ${why}\n    ${detail}`);
  }
}

function reportBetComposition(edgeRows) {
  if (edgeRows.length === 0) return;

  const oneSided = edgeRows.filter((b) => Number(b.OneSided) === 1).length;
  if (oneSided > 0) {
    const pct = ((oneSided / edgeRows.length) * 100).toFixed(0);
    console.log(
      `  ${pct}% of published edges are one-sided (no opposing price), so their ` +
        `FairProb falls back to the raw price and ModelEdge equals Edge.`
    );
  }

  const byBook = new Map();
  for (const b of edgeRows) byBook.set(b.Book, (byBook.get(b.Book) ?? 0) + 1);
  const ranked = [...byBook.entries()].sort((x, y) => y[1] - x[1]);
  console.log(`  edges available at ${byBook.size} distinct book(s):`);
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

// Fixtures already present in the week's closing file. Recording a fixture
// twice would put two "closing" prices in play for the same market.
function loadRecordedFixtures(a) {
  const path = closingPath(a.dataDir, a.season, a.week);
  if (!existsSync(path)) return new Set();
  return new Set(readCsv(path).map((r) => r.FixtureID).filter(Boolean));
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
  --price-model <m>        projection | blend (default: projection)
                           projection = OurProb from the Floor/Median/Ceiling
                                   distribution alone; the long-standing
                                   behaviour and still the default.
                           blend = re-price off the fitted model written by
                                   price-model.mjs --write, which combines
                                   the projection with the multi-book
                                   consensus. Only turn this on once the
                                   report shows the blend beating the market
                                   out of sample; see README.
  --median-correction <m>  off | auto (default: off)
                           auto = re-centre the projected F/M/C for rushYds
                                   and recYds before pricing. For those stats
                                   the projected "Median" is too high as a
                                   median (about 63% / 56% of actuals land at or
                                   below it, against a 50% target) while the
                                   totals are right. Fitted on weeks strictly
                                   BEFORE the one priced; applied only where
                                   the shortfall is statistically solid. Each
                                   row records the multiplier in MedianAdj.
                                   Cannot be combined with --price-model blend.
                                   See lib/median-correction.mjs.
  --price-model-set <s>    which fitted market set to price off (default: retail)
  --price-model-file <p>   fit to load (default: data/pricing/{season}/model.json)
  --sides <s>              both | over | under (default: both)
  --books <a,b,c>          Sportsbooks to price against. Names are resolved
                           against the live list, so "hardrock" finds whatever
                           id the API uses. Default: the roster in
                           lib/books.mjs (${BETTABLE_BOOKS.join(", ")}).
                           Overrides the BETTABLE roster only; reference books
                           are unaffected.
  --all-books              Ignore the roster and use every active book that
                           prices NFL. The ledger takes the BEST price across
                           whatever is pulled, so this reports returns nobody
                           could have earned — research only.
  --reference-books <l>    Comma-separated books captured for their PRICE but
                           never staked. They sharpen the fair-value consensus
                           the model is judged against and can never reach
                           data/edges/ or a ledger. Default: the reference
                           roster in lib/books.mjs (${REFERENCE_BOOKS.join(", ")}).
  --no-reference-books     Pull only books a bet can be placed at.
  --include-offshore       ONLY affects --all-books. On the normal curated path
                           it does nothing and says so — sharp prices come from
                           --reference-books instead.
  --slot <name>            Which capture of the week this is (default: main).
                           'main' is the Tuesday drop and keeps the original
                           file paths; any other name nests one level deeper,
                           e.g. data/props/2026/thursday/week-03.csv. Use it
                           to capture a week more than once — the Tuesday
                           board is a small fraction of what the books
                           eventually post. See scripts/lib/slots.mjs.
  --at <moment>            With --historical, WHICH moment to reconstruct:
                             opening | closing   the endpoints (olv/clv)
                             T-48h, T-24h, T-3h  that many hours before each
                                                 fixture's OWN kickoff
                             <ISO timestamp>     an absolute moment
                           Offsets need the per-odd price history, which is a
                           separate OpticOdds permission (include_timeseries);
                           without it the run says so rather than silently
                           substituting the opening line. Defaults the slot to
                           the moment reconstructed, so a backfill can never
                           overwrite the record of what was actually published.
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
  --closing                Record CLOSING lines instead of publishing edges.
                           Narrows to fixtures kicking off within the window,
                           skips any already recorded, and appends to
                           data/closing/. Run daily; each game gets captured
                           once, near its own kickoff. Never touches props/ or
                           edges/.
  --closing-window-hours   How close to kickoff counts as closing (default 24)
  --dry-run                Fetch and price but do not write files
  -h, --help               Show this help

Env: OPTICODDS_API_KEY (required).`;

// Only run when executed directly — the test suite imports this module for
// PROPS_COLUMNS and ourProbability, and must not trigger a live capture as a
// side effect of that import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("capture-props failed:", err.message);
    process.exit(1);
  });
}
