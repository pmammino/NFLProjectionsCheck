// Aggregates the paper-trading bet ledgers (data/bets/{season}/week-NN.csv)
// into public/data/betting.json for the dashboard's Paper Trading tab. Runs
// on predev/prebuild alongside build-data.mjs; the generated JSON is not
// committed.
//
// Season resolution mirrors build-data.mjs: env SEASON if given and present,
// else the latest season with a bets/ directory. If no bets have ever been
// captured, writes an "empty" dataset rather than failing the build.

import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { EDGE_BUCKETS } from "./lib/edge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_PATH = join(ROOT, "public", "data", "betting.json");

function resolveSeason(dataDir) {
  const base = join(ROOT, dataDir, "bets");
  if (!existsSync(base)) return null;
  const seasons = readdirSync(base).filter((s) => /^\d{4}$/.test(s));
  if (seasons.length === 0) return null;
  if (process.env.SEASON && seasons.includes(process.env.SEASON)) return process.env.SEASON;
  return seasons.sort().at(-1);
}

function loadAllWeeks(dataDir, season) {
  const dir = join(ROOT, dataDir, "bets", season);
  if (!existsSync(dir)) return [];
  const weekFiles = readdirSync(dir)
    .filter((f) => /^week-\d+\.csv$/.test(f))
    .sort();
  const rows = [];
  for (const f of weekFiles) rows.push(...readCsv(join(dir, f)));
  return rows;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const SETTLED = new Set(["won", "lost", "push"]);

// Roll a set of bet rows up into count/win-rate/ROI, for both stake methods.
function rollup(rows) {
  const graded = rows.filter((r) => SETTLED.has(r.Status));
  const wins = graded.filter((r) => r.Status === "won").length;
  const pushes = graded.filter((r) => r.Status === "push").length;
  // Win rate is wins over DECIDED bets: a push returns the stake and is
  // neither a win nor a loss, so counting it in the denominator would drag
  // the rate down as if it were a loss.
  const decided = graded.length - pushes;
  // ROI keeps pushes in the denominator — the stake was still committed, it
  // just came back — so a book of pushes correctly reads as 0% ROI.
  const flatStaked = graded.reduce((s, r) => s + num(r.FlatStakeUnits), 0);
  const flatPnl = graded.reduce((s, r) => s + num(r.PnlFlatUnits), 0);
  const kellyStaked = graded.reduce((s, r) => s + num(r.KellyStakeUnits), 0);
  const kellyPnl = graded.reduce((s, r) => s + num(r.PnlKellyUnits), 0);
  return {
    nTotal: rows.length,
    nGraded: graded.length,
    nPending: rows.length - graded.length,
    nPush: pushes,
    winRate: decided > 0 ? wins / decided : null,
    avgEdge: rows.length ? rows.reduce((s, r) => s + num(r.Edge), 0) / rows.length : null,
    // How far our model sits from the market's DE-VIGGED belief, averaged over
    // the same bets. Structurally larger than avgEdge by about half the hold;
    // the gap between the two is the margin we are paying to play.
    // avgOf, not a plain mean: ledgers written before the OpticOdds migration
    // have no ModelEdge at all, and counting those blanks as zero would drag
    // the average toward nothing rather than reporting on the rows that have it.
    avgModelEdge: avgOf(rows.map((r) => r.ModelEdge)),
    avgHold: avgOf(rows.map((r) => r.Hold)),
    flatStaked: round(flatStaked),
    flatPnl: round(flatPnl),
    flatRoi: flatStaked > 0 ? round(flatPnl / flatStaked) : null,
    kellyStaked: round(kellyStaked),
    kellyPnl: round(kellyPnl),
    kellyRoi: kellyStaked > 0 ? round(kellyPnl / kellyStaked) : null,
  };
}

// Mean of the values that are actually present — a blank Hold (a one-sided
// market) is "unknown", not zero, and averaging it in as zero would understate
// the real market margin.
function avgOf(values) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? round(nums.reduce((s, n) => s + n, 0) / nums.length) : null;
}

function round(n, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
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

function build() {
  const dataDir = "data";
  const season = resolveSeason(dataDir);
  const bets = season ? loadAllWeeks(dataDir, season) : [];

  const byStat = [...groupBy(bets, (r) => r.Stat)]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([stat, rows]) => ({ stat, ...rollup(rows) }));

  const edgeBucketOrder = EDGE_BUCKETS.map((b) => b.label);
  const byEdgeBucket = [...groupBy(bets, (r) => r.EdgeBucket)]
    .sort((a, b) => edgeBucketOrder.indexOf(a[0]) - edgeBucketOrder.indexOf(b[0]))
    .map(([bucket, rows]) => ({ bucket, ...rollup(rows) }));

  // Which line each bet was priced at. A backfilled week uses whatever
  // historical value exists, and for PLAYER props that is always the OPENING
  // line — OpticOdds populates `clv` on game markets but leaves it null on
  // every player market (0 of 122 in a real week-1 pull). An opening line is
  // softer than the closing price a real bet would have taken, so pooling
  // backfilled rows with live-captured ones would overstate the strategy.
  // Keeping the cohorts separate is what makes the comparison honest.
  const byLineSource = [...groupBy(bets, (r) => r.LineSource || "live")]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([lineSource, rows]) => ({ lineSource, ...rollup(rows) }));

  // Overs vs unders. Unders only became bettable with the move to OpticOdds
  // (a one-sided feed can't price them), so tracking them separately is how
  // we find out whether the model is equally good in both directions — a
  // model that only beats the market on overs is usually one with a
  // systematic upward bias rather than real edge.
  const bySide = [...groupBy(bets, (r) => r.Side || "over")]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([side, rows]) => ({ side, ...rollup(rows) }));

  const overall = rollup(bets);

  const dataset = {
    meta: {
      generatedAt: new Date().toISOString(),
      season: season ? Number(season) : null,
      minEdgeAssumed: 0.03,
      counts: { bets: bets.length },
    },
    overall,
    byStat,
    bySide,
    byLineSource,
    byEdgeBucket,
    bets: bets
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
        oppositeOdds: r.OppositeOdds === "" || r.OppositeOdds === undefined ? null : num(r.OppositeOdds),
        impliedProb: num(r.ImpliedProb),
        fairProb: r.FairProb === "" || r.FairProb === undefined ? null : num(r.FairProb),
        hold: r.Hold === "" || r.Hold === undefined ? null : num(r.Hold),
        oneSided: r.OneSided === "1",
        ourProb: num(r.OurProb),
        edge: num(r.Edge),
        modelEdge: r.ModelEdge === "" || r.ModelEdge === undefined ? null : num(r.ModelEdge),
        edgeBucket: r.EdgeBucket,
        lineSource: r.LineSource || "live",
        flatStakeUnits: num(r.FlatStakeUnits),
        kellyStakeUnits: num(r.KellyStakeUnits),
        status: r.Status,
        actual: r.Actual === "" ? null : num(r.Actual),
        pnlFlatUnits: r.PnlFlatUnits === "" ? null : num(r.PnlFlatUnits),
        pnlKellyUnits: r.PnlKellyUnits === "" ? null : num(r.PnlKellyUnits),
      }))
      .sort((a, b) => b.week - a.week || b.edge - a.edge),
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(dataset));
  console.log(
    `Wrote ${OUT_PATH}: season=${dataset.meta.season} bets=${bets.length} ` +
      `(${overall.nGraded} graded, ${overall.nPending} pending)`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) build();
