import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ourProbability, PROPS_COLUMNS, repriceWithBlend, repriceWithPool, loadSourceWeights } from "./capture-props.mjs";
import { LEDGER_COLUMNS } from "./simulate-personas.mjs";
import {
  matchStatKey,
  isBettableStat,
  allOpticMarketNames,
  BETTABLE_STAT_KEYS,
} from "./lib/markets.mjs";

// Joe Burrow, week-1-shaped projection split (F/M/C rows keyed like the real
// weekly_projections snapshot).
const BURROW_SPLITS = {
  F: { PassYards: "230.0" },
  M: { PassYards: "277.9" },
  C: { PassYards: "320.0" },
};

test("ourProbability: continuous stat well below floor is near-certain over", () => {
  const p = ourProbability({ line: 100, statKey: "passYds" }, BURROW_SPLITS);
  assert.ok(p > 0.9);
});

test("ourProbability: continuous stat at the median is ~0.5", () => {
  const p = ourProbability({ line: 277.9, statKey: "passYds" }, BURROW_SPLITS);
  assert.ok(Math.abs(p - 0.5) < 1e-6);
});

test("ourProbability: missing Floor/Ceiling for a continuous stat -> null (can't price)", () => {
  const p = ourProbability({ line: 250, statKey: "passYds" }, { M: { PassYards: "277.9" } });
  assert.equal(p, null);
});

test("ourProbability: poisson stat sums the configured projection columns", () => {
  const splits = { M: { RecTDs: "0.1" } };
  const p = ourProbability({ line: 0.5, statKey: "recTD" }, splits);
  assert.ok(Math.abs(p - (1 - Math.exp(-0.1))) < 1e-9);
});

// Anytime TD is defined but retired (bet: false). It must still MATCH — old
// ledgers carry the stat key and need to label it — while never producing a
// price, because a price is what lets a bet be selected.
test("ourProbability: a retired market never prices, even with a full projection", () => {
  const splits = { M: { RushTDs: "0.4", RecTDs: "0.3" } };
  assert.equal(ourProbability({ line: 0.5, statKey: "anytimeTD" }, splits), null);
});

test("a retired market is still recognised, just not bet", () => {
  assert.equal(matchStatKey("Anytime Touchdown Scorer"), "anytimeTD");
  assert.equal(isBettableStat("anytimeTD"), false);
  assert.equal(isBettableStat("rushYds"), true);
  assert.equal(isBettableStat("notAStat"), false);
});

test("retired markets are never requested from the API", () => {
  const names = allOpticMarketNames();
  assert.ok(!names.includes("Anytime Touchdown Scorer"));
  assert.ok(names.includes("Player Rushing Yards"));
  assert.equal(names.length, BETTABLE_STAT_KEYS.length);
});

test("ourProbability: no projection at all for this player -> null", () => {
  assert.equal(ourProbability({ line: 250, statKey: "passYds" }, undefined), null);
});

test("ourProbability: an unknown stat key -> null rather than a wrong model", () => {
  assert.equal(ourProbability({ line: 250, statKey: "fieldGoals" }, BURROW_SPLITS), null);
});

// The published edge set is what every persona reads, so anything the persona
// engine needs must survive the round-trip to CSV and back.
test("the published edge set carries everything a persona needs", () => {
  for (const col of ["Edge", "ModelEdge", "FairProb", "ImpliedProb", "Hold", "OneSided", "Side", "Proj", "Book", "Line", "Odds", "FixtureID"]) {
    assert.ok(PROPS_COLUMNS.includes(col), `PROPS_COLUMNS missing ${col}`);
  }
});

test("the persona ledger carries its settlement and CLV fields", () => {
  for (const col of ["Status", "Actual", "PnlUnits", "StakeUnits", "BankrollBefore", "ClvStatus", "ClvProb"]) {
    assert.ok(LEDGER_COLUMNS.includes(col), `LEDGER_COLUMNS missing ${col}`);
  }
});

// ---- Empty-result protection -------------------------------------------------
// A historical pull can return a fixture with "odds": [] — an unauthorized key,
// a week past the 2-month retention window, and a book with nothing archived
// all look identical. Verified against a real response for the CIN/TB week-1
// game, which came back with an empty odds array.
//
// The snapshots under data/ are the durable record of what we actually saw, and
// are not reconstructible once overwritten, so an empty run must never replace
// a populated file.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCsv } from "./lib/csv.mjs";

// Exercises the same guard the script applies, against a real file on disk.
function writeGuarded(path, csv, { allowEmpty = false } = {}) {
  const rowCount = (t) => Math.max(0, t.trim().split("\n").length - 1);
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prev === csv) return "unchanged";
  if (rowCount(csv) === 0 && prev !== null && rowCount(prev) > 0 && !allowEmpty) return "refused";
  writeFileSync(path, csv);
  return "written";
}

test("an empty result never overwrites a populated snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-01.csv");
  const populated = toCsv(LEDGER_COLUMNS, [
    { Season: 2026, Week: 1, PlayerID: "1", Stat: "passYds", Edge: "0.05" },
    { Season: 2026, Week: 1, PlayerID: "2", Stat: "rushYds", Edge: "0.04" },
  ]);
  writeFileSync(path, populated);

  const empty = toCsv(LEDGER_COLUMNS, []);
  assert.equal(writeGuarded(path, empty), "refused");
  assert.equal(readFileSync(path, "utf8"), populated, "the ledger must be untouched");
});

test("--allow-empty is the deliberate override", () => {
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-01.csv");
  writeFileSync(path, toCsv(LEDGER_COLUMNS, [{ Season: 2026, Week: 1, PlayerID: "1" }]));
  assert.equal(writeGuarded(path, toCsv(LEDGER_COLUMNS, []), { allowEmpty: true }), "written");
});

test("an empty result is fine when there is nothing to lose", () => {
  // A brand-new week with no odds yet should still write its header.
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-09.csv");
  assert.equal(writeGuarded(path, toCsv(LEDGER_COLUMNS, [])), "written");
});

test("a non-empty result replaces a populated snapshot as normal", () => {
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-01.csv");
  writeFileSync(path, toCsv(LEDGER_COLUMNS, [{ Season: 2026, Week: 1, PlayerID: "1" }]));
  const updated = toCsv(LEDGER_COLUMNS, [
    { Season: 2026, Week: 1, PlayerID: "1" },
    { Season: 2026, Week: 1, PlayerID: "2" },
  ]);
  assert.equal(writeGuarded(path, updated), "written");
  assert.equal(readFileSync(path, "utf8"), updated);
});


// --- repriceWithBlend ------------------------------------------------------
// The optional second pricing pass. `priceMarket` sees one book at a time and
// can only produce the projection-only price; this runs over every candidate
// once the whole market is in hand.

// A fit that simply returns the market consensus: a = 0, c = 1, b = 0. With
// this, a re-priced candidate's OurProb must equal the de-vigged consensus,
// which makes the wiring testable without depending on any fitted numbers.
const MARKET_ONLY_FIT = { model: "blend", global: [0, 1, 0], stats: {} };

const candidate = (over) => ({
  rotowirePlayerId: "1",
  statKey: "rushYds",
  line: 49.5,
  side: over.side ?? "over",
  sportsbook: over.book ?? "DraftKings",
  odds: over.odds,
  oppositeOdds: over.oppositeOdds ?? null,
  impliedProb: 0.5,
  fairProb: 0.5,
  hold: 0.048,
  ourProb: over.ourProb ?? 0.62,
  edge: 0,
  modelEdge: 0,
});

test("repriceWithBlend replaces OurProb with the model's price and relabels the row", () => {
  const rows = [candidate({ odds: -110, oppositeOdds: -110 })];
  const changed = repriceWithBlend(rows, MARKET_ONLY_FIT);
  assert.equal(changed, 1);
  assert.equal(rows[0].priceModel, "blend");
  // Two books at -110 de-vig to exactly 0.5.
  assert.ok(Math.abs(rows[0].ourProb - 0.5) < 1e-6);
  assert.ok(Math.abs(rows[0].edge - (0.5 - 0.5)) < 1e-6);
});

test("repriceWithBlend keeps the two sides of a market complementary", () => {
  // Blending each side independently would produce a pair that does not sum
  // to 1 — free arbitrage against ourselves.
  const rows = [
    candidate({ odds: -130, oppositeOdds: 110, ourProb: 0.62 }),
    { ...candidate({ odds: 110, oppositeOdds: -130, ourProb: 0.38 }), side: "under" },
  ];
  repriceWithBlend(rows, MARKET_ONLY_FIT);
  const over = rows.find((r) => r.side === "over");
  const under = rows.find((r) => r.side === "under");
  assert.ok(Math.abs(over.ourProb + under.ourProb - 1) < 1e-9);
});

test("repriceWithBlend leaves a market with no consensus on the projection price", () => {
  // No book in the requested set quotes it, so there is no market prior. The
  // row keeps its projection price rather than being dropped or defaulted.
  const rows = [candidate({ odds: -110, oppositeOdds: -110, book: "circasports" })];
  const changed = repriceWithBlend(rows, MARKET_ONLY_FIT, { marketSet: "retail" });
  assert.equal(changed, 0);
  assert.equal(rows[0].ourProb, 0.62);
  assert.equal(rows[0].priceModel, undefined); // written as "projection" at CSV time
});

test("repriceWithBlend prices each line of a player separately", () => {
  const rows = [
    candidate({ odds: -110, oppositeOdds: -110 }),
    { ...candidate({ odds: 300, oppositeOdds: -400 }), line: 74.5 },
  ];
  repriceWithBlend(rows, MARKET_ONLY_FIT);
  assert.ok(rows[0].ourProb > rows[1].ourProb, "the longer line must price lower");
});

test("repriceWithBlend is a no-op without a fit", () => {
  const rows = [candidate({ odds: -110, oppositeOdds: -110 })];
  assert.equal(repriceWithBlend(rows, null), 0);
  assert.equal(rows[0].ourProb, 0.62);
});

// --- repriceWithPool -----------------------------------------------------------
// The weighted pool: every book and the projection as votes. As with the blend,
// the point is the wiring — which prices go in, which invariants hold.

test("repriceWithPool prices off the books and relabels the row", () => {
  const rows = [
    candidate({ odds: -110, oppositeOdds: -110, book: "DraftKings" }),
    candidate({ odds: -110, oppositeOdds: -110, book: "FanDuel" }),
  ];
  const changed = repriceWithPool(rows, {});
  assert.equal(changed, 2);
  assert.ok(rows.every((r) => r.priceModel === "pool"));
  // Two books at -110 de-vig to 0.5, and the projection (0.62) has no weight
  // until it has earned some.
  assert.ok(Math.abs(rows[0].ourProb - 0.5) < 1e-6, `got ${rows[0].ourProb}`);
});

test("repriceWithPool: the projection moves the price exactly as much as its weight says", () => {
  const mk = () => [
    candidate({ odds: -110, oppositeOdds: -110, book: "DraftKings" }),
    candidate({ odds: -110, oppositeOdds: -110, book: "FanDuel" }),
  ];
  const none = mk();
  repriceWithPool(none, {});
  const some = mk();
  repriceWithPool(some, { projection: 0.3 });
  assert.ok(some[0].ourProb > none[0].ourProb, "a weighted projection that says 62% pulls the price up");
  assert.ok(some[0].ourProb < 0.62, "but never past the projection itself");
});

test("repriceWithPool keeps the two sides of a market complementary", () => {
  const rows = [
    candidate({ odds: -130, oppositeOdds: 110, ourProb: 0.62 }),
    { ...candidate({ odds: 110, oppositeOdds: -130, ourProb: 0.38 }), side: "under" },
  ];
  repriceWithPool(rows, { projection: 0.3 });
  const over = rows.find((r) => r.side === "over");
  const under = rows.find((r) => r.side === "under");
  assert.ok(Math.abs(over.ourProb + under.ourProb - 1) < 1e-9);
});

test("repriceWithPool leaves a market with no book price on the projection price", () => {
  const rows = [{ ...candidate({ odds: -110, oppositeOdds: -110 }), odds: null, oppositeOdds: null }];
  assert.equal(repriceWithPool(rows, { projection: 1 }), 0);
  assert.equal(rows[0].ourProb, 0.62);
  assert.equal(rows[0].priceModel, undefined);
});

test("repriceWithPool counts a reference book's price in the pool", () => {
  // Pinnacle is never staked, but pricing off it is the point of having it.
  const base = [candidate({ odds: -110, oppositeOdds: -110, book: "DraftKings" })];
  const withRef = [
    candidate({ odds: -110, oppositeOdds: -110, book: "DraftKings" }),
    candidate({ odds: 140, oppositeOdds: -170, book: "Pinnacle" }),
  ];
  repriceWithPool(base, { "draftkings:2": 0.1 });
  repriceWithPool(withRef, { "draftkings:2": 0.1, "pinnacle:2": 0.9 });
  assert.ok(withRef[0].ourProb < base[0].ourProb, "Pinnacle quotes the over as the underdog and carries the weight");
});

test("repriceWithPool is a no-op without weights", () => {
  const rows = [candidate({ odds: -110, oppositeOdds: -110 })];
  assert.equal(repriceWithPool(rows, null), 0);
  assert.equal(rows[0].ourProb, 0.62);
});

// --- loadSourceWeights ---------------------------------------------------------

function weightsFile(byWeek) {
  const dir = mkdtempSync(join(tmpdir(), "sw-"));
  const path = join(dir, "source-weights.json");
  writeFileSync(path, JSON.stringify({ season: 2026, byWeek }));
  return path;
}

test("loadSourceWeights reads the entry for the week being priced", () => {
  const path = weightsFile({
    "2": { weights: { "a:2": 0.2 }, trainedOnWeeks: [1] },
    "3": { weights: { "a:2": 0.3 }, trainedOnWeeks: [1, 2] },
  });
  assert.deepEqual(loadSourceWeights({ sourceWeightsFile: path, week: 2, season: 2026 }).weights, { "a:2": 0.2 });
  assert.deepEqual(loadSourceWeights({ sourceWeightsFile: path, week: 3, season: 2026 }).trainedOnWeeks, [1, 2]);
});

test("loadSourceWeights: a live week past the last entry takes the last, fitted on everything so far", () => {
  const path = weightsFile({ "2": { weights: { x: 1 }, trainedOnWeeks: [1] }, "5": { weights: { x: 2 }, trainedOnWeeks: [1, 2, 3, 4] } });
  assert.deepEqual(loadSourceWeights({ sourceWeightsFile: path, week: 6, season: 2026 }).weights, { x: 2 });
});

test("loadSourceWeights: a week before any record prices on the priors, not on later weeks", () => {
  // A backfill of week 1 must not be priced with weights that have seen week 4.
  const path = weightsFile({ "2": { weights: { x: 1 }, trainedOnWeeks: [1] } });
  const got = loadSourceWeights({ sourceWeightsFile: path, week: 1, season: 2026 });
  assert.deepEqual(got.weights, {});
  assert.deepEqual(got.trainedOnWeeks, []);
});

test("loadSourceWeights refuses weights that had seen the week they would price", () => {
  const path = weightsFile({ "3": { weights: { x: 1 }, trainedOnWeeks: [1, 2, 3] } });
  assert.throws(() => loadSourceWeights({ sourceWeightsFile: path, week: 3, season: 2026 }), /fitted on week 3 or later/);
});

test("loadSourceWeights fails loudly, with the command to fix it, when the file is missing", () => {
  assert.throws(
    () => loadSourceWeights({ sourceWeightsFile: "/nonexistent/source-weights.json", week: 3, season: 2026 }),
    /source-weights\.mjs --season 2026 --write/
  );
});

test("PROPS_COLUMNS and LEDGER_COLUMNS record which model priced each row", () => {
  // Without this, an archived ledger cannot say whether a bet was taken on
  // the projection price or the blend — and the two are not comparable.
  assert.ok(PROPS_COLUMNS.includes("PriceModel"));
  assert.ok(LEDGER_COLUMNS.includes("PriceModel"));
});


// --- median correction -------------------------------------------------------

const RUSH_SPLITS = {
  F: { RushYards: "28.0" },
  M: { RushYards: "40.0" },
  C: { RushYards: "52.0" },
};
const RUSH_CORRECTION = { rushYds: { applied: true, kF: 0.7, kM: 0.8, kC: 0.95 } };

test("ourProbability with no correction is exactly the long-standing price", () => {
  const plain = ourProbability({ line: 40, statKey: "rushYds" }, RUSH_SPLITS);
  assert.equal(ourProbability({ line: 40, statKey: "rushYds" }, RUSH_SPLITS, null), plain);
  assert.equal(ourProbability({ line: 40, statKey: "rushYds" }, RUSH_SPLITS, {}), plain);
  // A correction that was fitted but not APPLIED must change nothing.
  assert.equal(
    ourProbability({ line: 40, statKey: "rushYds" }, RUSH_SPLITS, { rushYds: { applied: false, kF: 0.5, kM: 0.5, kC: 0.5 } }),
    plain
  );
  assert.ok(Math.abs(plain - 0.5) < 1e-9, "a line at the median is a coin flip before correction");
});

test("ourProbability with a correction prices the line at the corrected median", () => {
  const corrected = ourProbability({ line: 40, statKey: "rushYds" }, RUSH_SPLITS, RUSH_CORRECTION);
  // The median moves from 40 to 32, so a 40-yard line is now well above it.
  assert.ok(corrected < 0.4, `P(over 40) = ${corrected}`);
  // And a line at the corrected median is the coin flip.
  const atNewMedian = ourProbability({ line: 32, statKey: "rushYds" }, RUSH_SPLITS, RUSH_CORRECTION);
  assert.ok(Math.abs(atNewMedian - 0.5) < 1e-9, `P(over 32) = ${atNewMedian}`);
});

test("a correction for one stat does not leak into another", () => {
  const splits = { F: { PassYards: "230" }, M: { PassYards: "277.9" }, C: { PassYards: "320" } };
  assert.equal(
    ourProbability({ line: 250, statKey: "passYds" }, splits, RUSH_CORRECTION),
    ourProbability({ line: 250, statKey: "passYds" }, splits)
  );
});

test("a poisson stat never takes a median correction", () => {
  // Poisson stats price off the projected count, not the F/M/C band, so there
  // is no median to move. Even a hand-built correction must be inert here.
  const splits = { M: { PassTDs: "1.7" } };
  const hostile = { passTD: { applied: true, kF: 0.5, kM: 0.5, kC: 0.5 } };
  assert.equal(
    ourProbability({ line: 1.5, statKey: "passTD" }, splits, hostile),
    ourProbability({ line: 1.5, statKey: "passTD" }, splits)
  );
});

test("PROPS_COLUMNS and LEDGER_COLUMNS record the median adjustment", () => {
  assert.ok(PROPS_COLUMNS.includes("MedianAdj"));
  assert.ok(LEDGER_COLUMNS.includes("MedianAdj"));
});

// The flag checks live in parseArgs, which runs before anything touches the
// network, so they can be exercised through the real CLI without a key.
const CAPTURE = fileURLToPath(new URL("./capture-props.mjs", import.meta.url));
const runCapture = (...args) =>
  spawnSync(process.execPath, [CAPTURE, ...args], { encoding: "utf8", env: { ...process.env, OPTICODDS_API_KEY: "" } });

test("--median-correction rejects a value it does not know", () => {
  const r = runCapture("--median-correction", "sometimes");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--median-correction must be one of: off, auto/);
});

test("--median-correction auto cannot be combined with the pool", () => {
  // The projection's weight in the pool was earned by the uncorrected projection.
  const r = runCapture("--median-correction", "auto", "--price-model", "pool");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /cannot be combined with --price-model pool/);
});

test("--price-model accepts pool and rejects what it does not know", () => {
  const bad = runCapture("--price-model", "ensemble");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /--price-model must be one of: projection, blend, pool/);
});

test("--median-correction auto cannot be combined with the blend", () => {
  // The blend was fitted on uncorrected projection probabilities; feeding it
  // corrected ones would change its input without refitting it.
  const r = runCapture("--median-correction", "auto", "--price-model", "blend");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /cannot be combined with --price-model blend/);
});

test("the correction is off by default", () => {
  // The Tuesday drop is the product; its pricing changes when someone decides
  // it should, not when they upgrade. --help is the only way to read the
  // default without a network, so the help text has to say it.
  const r = runCapture("--help");
  assert.match(r.stdout, /--median-correction <m>\s+off \| auto \(default: off\)/);
});
