// Weekly prop-line capture: fetch RotoWire's props-plus-proj feed for every
// tracked stat, join each price to that week's already-ingested Floor/Median/
// Ceiling projection snapshot, price our own model probability, and write:
//
//   data/props/{season}/week-NN.csv   every (player, stat, book) price seen,
//                                      with our probability + edge computed
//                                      against it — the full scouted market.
//   data/bets/{season}/week-NN.csv    the subset that clears --min-edge: one
//                                      row per (player, stat), the single
//                                      best-edge (book, line) combination,
//                                      sized two ways (flat + Kelly). This is
//                                      the paper-trading ledger; grade-bets.mjs
//                                      fills in the result once actuals land.
//
// Why re-fetch every book's price rather than one consensus line: this feed
// only ever surfaces one side (see scripts/lib/props.mjs), so there's no
// within-book de-vig available. Different books post different lines for the
// same player/stat, so scanning all of them and taking the single (book,
// line) pair with the largest edge against our model is strictly better than
// picking one book's line arbitrarily.
//
// Sizing: stakes are tracked in "units", where 1 unit = 1% of bankroll — that
// makes flat and Kelly stakes directly comparable/summable regardless of
// actual bankroll size, which is never needed since a Kelly fraction is
// bankroll-size-independent by construction.
//
// TD/turnover-count props (Poisson) get two extra guards a plain median
// count doesn't otherwise have (unlike continuous stats, whose Floor/Ceiling
// spread already reflects role/volume uncertainty):
//   --min-td-volume    below this many projected "touches" (see STAT_DEFS'
//                      volumeCols), the prop isn't priced at all — a backup's
//                      tiny median TD projection is too volatile to trust.
//   --stable-td-volume at/above this many touches, the Median TD count is
//                      used as-is; between the two thresholds, lambda is
//                      linearly shrunk toward the more conservative Floor
//                      count (see lib/probability.mjs's blendLambda).
//   --min-edge-ratio   Poisson picks additionally need
//                      ourProb >= impliedProb * ratio, since a fixed
//                      absolute edge is trivial to clear by noise alone at
//                      the long-odds prices backups get quoted at.
//
// Usage:
//   node scripts/capture-props.mjs [--season 2025] [--week 1]
//                                  [--min-edge 0.03] [--min-edge-ratio 1.3]
//                                  [--min-td-volume 3] [--stable-td-volume 8]
//                                  [--kelly-fraction 0.25] [--kelly-cap 0.03]
//                                  [--data-dir data] [--dry-run]
//
// Env: ROTOWIRE_COOKIE (optional Cookie header, same as ingest.mjs).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAT_DEFS, normalizePropsFeed } from "./lib/props.mjs";
import { probOverContinuous, probOverPoisson, blendLambda } from "./lib/probability.mjs";
import { americanToProb, americanToDecimal, kellyFraction } from "./lib/odds.mjs";
import { readCsv, toCsv } from "./lib/csv.mjs";
import { seasonForDate, projectionWeek } from "./lib/schedule.mjs";
import { edgeBucket } from "./lib/edge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASE = "https://www.rotowire.com/betting/nfl/tables/all-bets-props-plus-proj.php";

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
  "Odds",
  "ImpliedProb",
  "OurProb",
  "Edge",
  "RwProj",
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
  "Odds",
  "ImpliedProb",
  "OurProb",
  "Edge",
  "EdgeBucket",
  "FlatStakeUnits",
  "KellyStakeUnits",
  "KellyFractionUsed",
  "CapturedAt",
  "Status", // pending | won | lost | void
  "Actual",
  "PnlFlatUnits",
  "PnlKellyUnits",
];

function parseArgs(argv) {
  const a = {
    dataDir: "data",
    minEdge: 0.03,
    minEdgeRatio: 1.3,
    minTdVolume: 3,
    stableTdVolume: 8,
    kellyFraction: 0.25,
    kellyCap: 0.03,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--week": a.week = Number(next()); break;
      case "--min-edge": a.minEdge = Number(next()); break;
      case "--min-edge-ratio": a.minEdgeRatio = Number(next()); break;
      case "--min-td-volume": a.minTdVolume = Number(next()); break;
      case "--stable-td-volume": a.stableTdVolume = Number(next()); break;
      case "--kelly-fraction": a.kellyFraction = Number(next()); break;
      case "--kelly-cap": a.kellyCap = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--dry-run": a.dryRun = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  return a;
}

async function fetchJson(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: "https://www.rotowire.com/betting/nfl/",
  };
  if (process.env.ROTOWIRE_COOKIE) headers.Cookie = process.env.ROTOWIRE_COOKIE;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url} (first 200 chars): ${text.slice(0, 200)}`);
  }
}

const pad2 = (n) => String(n).padStart(2, "0");
const projPath = (dir, season, week) => join(ROOT, dir, "projections", String(season), `week-${pad2(week)}.csv`);
const propsPath = (dir, season, week) => join(ROOT, dir, "props", String(season), `week-${pad2(week)}.csv`);
const betsPath = (dir, season, week) => join(ROOT, dir, "bets", String(season), `week-${pad2(week)}.csv`);

// Load this week's Floor/Median/Ceiling projection snapshot into a map keyed
// by playerid, each value { F: {...cols}, M: {...cols}, C: {...cols} }.
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

function sumCols(row, cols) {
  return cols.reduce((s, c) => s + (Number(row?.[c]) || 0), 0);
}

// Our model's P(actual > line) for one candidate, using that player's F/M/C.
// `tdVolume` configures the Poisson volume gate/shrinkage (see the header
// comment) — defaulted here so ad-hoc callers (tests) don't need to pass it.
export function ourProbability(
  candidate,
  statDef,
  splits,
  { minTdVolume = 3, stableTdVolume = 8 } = {}
) {
  if (!splits || !splits.M) return null;
  if (statDef.kind === "poisson") {
    const touches = sumCols(splits.M, statDef.volumeCols);
    if (touches < minTdVolume) return null; // too thin a role to trust the count at all
    const median = sumCols(splits.M, statDef.projCols);
    const floor = splits.F ? sumCols(splits.F, statDef.projCols) : median;
    const lambda = blendLambda(median, floor, touches, minTdVolume, stableTdVolume);
    return probOverPoisson(candidate.line, lambda);
  }
  if (!splits.F || !splits.C) return null;
  const f = sumCols(splits.F, statDef.projCols);
  const m = sumCols(splits.M, statDef.projCols);
  const c = sumCols(splits.C, statDef.projCols);
  return probOverContinuous(candidate.line, f, m, c);
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

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(
      "node scripts/capture-props.mjs [--season Y] [--week N] [--min-edge 0.03]\n" +
        "  [--min-edge-ratio 1.3] [--min-td-volume 3] [--stable-td-volume 8]\n" +
        "  [--kelly-fraction 0.25] [--kelly-cap 0.03] [--data-dir data] [--dry-run]"
    );
    return;
  }
  const now = new Date();
  if (a.season === undefined) a.season = seasonForDate(now);
  if (a.week === undefined) a.week = projectionWeek(a.season, now);

  console.log(
    `Capturing props for season=${a.season} week=${a.week} minEdge=${a.minEdge} ` +
      `minEdgeRatio=${a.minEdgeRatio} minTdVolume=${a.minTdVolume} stableTdVolume=${a.stableTdVolume}` +
      (a.dryRun ? " (dry-run)" : "")
  );

  const projections = loadProjections(a.dataDir, a.season, a.week);
  const capturedAt = now.toISOString();

  const allCandidates = [];
  for (const [statKey, statDef] of Object.entries(STAT_DEFS)) {
    const url = statDef.queryProp ? `${BASE}?prop=${statDef.queryProp}` : BASE;
    console.log(`  fetching ${statKey} (${url})…`);
    let payload;
    try {
      payload = await fetchJson(url);
    } catch (err) {
      console.warn(`  ${statKey}: fetch failed (${err.message}) — skipping this stat.`);
      continue;
    }
    let rows;
    try {
      rows = normalizePropsFeed(payload, statKey);
    } catch (err) {
      console.warn(`  ${statKey}: normalize failed (${err.message}) — skipping this stat.`);
      continue;
    }
    if (rows.length === 0) {
      console.warn(`  ${statKey}: 0 rows returned — RotoWire may not offer this prop. Skipping.`);
      continue;
    }
    console.log(`  ${statKey}: ${rows.length} (player, book) prices.`);
    allCandidates.push(...rows);
  }

  // Price every candidate against our model.
  const priced = [];
  for (const cand of allCandidates) {
    const statDef = STAT_DEFS[cand.statKey];
    const splits = projections.get(cand.playerId);
    const ourProb = ourProbability(cand, statDef, splits, {
      minTdVolume: a.minTdVolume,
      stableTdVolume: a.stableTdVolume,
    });
    if (ourProb === null) continue; // no matching projection, or too thin a role to price (TD props)
    const impliedProb = americanToProb(cand.odds);
    if (impliedProb === null) continue;
    priced.push({
      ...cand,
      ourProb,
      impliedProb,
      edge: ourProb - impliedProb,
    });
  }

  // ---- data/props snapshot: every priced candidate ----
  const propsRows = priced.map((p) => ({
    Season: a.season,
    Week: a.week,
    PlayerID: p.playerId,
    Name: p.name,
    Team: p.team,
    Pos: p.pos,
    Opp: p.opp,
    Stat: p.statKey,
    Book: p.book,
    Line: p.line,
    Odds: p.odds,
    ImpliedProb: p.impliedProb.toFixed(4),
    OurProb: p.ourProb.toFixed(4),
    Edge: p.edge.toFixed(4),
    RwProj: p.rwProj ?? "",
    CapturedAt: capturedAt,
  }));
  writeCsvIfChanged(propsPath(a.dataDir, a.season, a.week), toCsv(PROPS_COLUMNS, propsRows), a);

  // ---- data/bets ledger: best (book, line) per (player, stat), if it clears the edge bar ----
  const bestByKey = new Map();
  for (const p of priced) {
    const key = `${p.playerId}|${p.statKey}`;
    const cur = bestByKey.get(key);
    if (!cur || p.edge > cur.edge) bestByKey.set(key, p);
  }

  const existingBets = existsSync(betsPath(a.dataDir, a.season, a.week))
    ? readCsv(betsPath(a.dataDir, a.season, a.week))
    : [];
  const existingByKey = new Map(existingBets.map((r) => [`${r.PlayerID}|${r.Stat}`, r]));

  const betRows = [];
  for (const [key, p] of bestByKey) {
    if (p.edge < a.minEdge) continue;
    // Poisson (TD/turnover) picks additionally need a minimum *relative*
    // edge: at the long odds backups get quoted, a fixed absolute edge is
    // trivial to clear from projection noise alone (see capture-props.mjs
    // header + README's "Paper trading" section for the full rationale).
    if (STAT_DEFS[p.statKey].kind === "poisson" && p.ourProb < p.impliedProb * a.minEdgeRatio) continue;
    const decimalOdds = americanToDecimal(p.odds);
    const kf = Math.min(a.kellyFraction * kellyFraction(p.ourProb, decimalOdds), a.kellyCap);
    const prior = existingByKey.get(key);
    // Preserve grading if this player/stat/week was already graded by an
    // earlier capture this week; a re-run before kickoff just refreshes price/edge.
    const alreadyGraded = prior && prior.Status && prior.Status !== "pending";
    betRows.push({
      Season: a.season,
      Week: a.week,
      PlayerID: p.playerId,
      Name: p.name,
      Team: p.team,
      Pos: p.pos,
      Opp: p.opp,
      Stat: p.statKey,
      Book: p.book,
      Line: p.line,
      Odds: p.odds,
      ImpliedProb: p.impliedProb.toFixed(4),
      OurProb: p.ourProb.toFixed(4),
      Edge: p.edge.toFixed(4),
      EdgeBucket: edgeBucket(p.edge),
      FlatStakeUnits: 1,
      KellyStakeUnits: (kf * 100).toFixed(4), // kf is a fraction of bankroll; 1 unit = 1% of bankroll
      KellyFractionUsed: kf.toFixed(4),
      CapturedAt: capturedAt,
      Status: alreadyGraded ? prior.Status : "pending",
      Actual: alreadyGraded ? prior.Actual : "",
      PnlFlatUnits: alreadyGraded ? prior.PnlFlatUnits : "",
      PnlKellyUnits: alreadyGraded ? prior.PnlKellyUnits : "",
    });
  }
  betRows.sort((x, y) => y.Edge - x.Edge);
  console.log(`  ${betRows.length} bets clear the ${(a.minEdge * 100).toFixed(1)}% edge bar.`);
  writeCsvIfChanged(betsPath(a.dataDir, a.season, a.week), toCsv(BETS_COLUMNS, betRows), a);

  console.log("Done.");
}

// Only run when executed directly — grade-bets.mjs and the test suite import
// this module purely for its column constants / ourProbability, and must not
// trigger a live capture as a side effect of that import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("capture-props failed:", err.message);
    process.exit(1);
  });
}
