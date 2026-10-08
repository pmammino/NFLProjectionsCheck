import test from "node:test";
import assert from "node:assert/strict";
import {
  readPropRow,
  actualFor,
  buildSamples,
  bestPrice,
  STORED_PROB_EPS,
  isPointInTime,
  isProjectionPrice,
} from "./pricing-dataset.mjs";

const CURRENT = {
  Season: "2026", Week: "3", PlayerID: "17795", Name: "MarShawn Lloyd", Team: "GB",
  Pos: "RB", Opp: "vs ATL", Stat: "rushYds", Book: "DraftKings", Line: "49.5",
  Side: "over", Proj: "45.05", Odds: "-110", OppositeOdds: "-110",
  ImpliedProb: "0.5238", FairProb: "0.5000", Hold: "0.0476", OneSided: "0",
  OurProb: "0.4432",
};

// The 2026 week-1 schema: no Side, no OppositeOdds, no Hold/OneSided, and the
// projection lives in RwProj.
const LEGACY = {
  Season: "2026", Week: "1", PlayerID: "16965", Name: "Andrei Iosivas", Team: "CIN",
  Pos: "WR", Opp: "vs TB", Stat: "recYds", Book: "betr", Line: "24.5",
  Odds: "-115", ImpliedProb: "0.5349", OurProb: "0.1975", RwProj: "20.2",
};

test("readPropRow normalizes the current schema", () => {
  const r = readPropRow(CURRENT);
  assert.equal(r.side, "over");
  assert.equal(r.overOdds, -110);
  assert.equal(r.underOdds, -110);
  assert.equal(r.probOver, 0.4432);
  assert.equal(r.proj, 45.05);
});

test("readPropRow normalizes the week-1 schema", () => {
  const r = readPropRow(LEGACY);
  assert.equal(r.side, "over"); // no Side column; every row in that capture was an over
  assert.equal(r.overOdds, -115);
  assert.equal(r.underOdds, null);
  assert.equal(r.proj, 20.2); // read from RwProj
  assert.equal(r.probOver, 0.1975);
});

test("readPropRow states an under row from the market's point of view", () => {
  const r = readPropRow({ ...CURRENT, Side: "under", Odds: "-120", OppositeOdds: "100", OurProb: "0.5568" });
  assert.equal(r.side, "under");
  assert.equal(r.overOdds, 100); // the opposite of the under we were quoted
  assert.equal(r.underOdds, -120);
  // probOver is always P(over), whichever side the row was written from.
  assert.ok(Math.abs(r.probOver - 0.4432) < 1e-9);
});

test("readPropRow clamps a rounded-to-zero probability instead of discarding it", () => {
  // The captures store four decimals, so "0.0000" means "below 0.00005".
  // Reading it literally makes the row unusable by any model taking a logit,
  // and the rows removed would be exactly the ones the projection is most
  // confident about — a selection, not a rounding detail.
  const r = readPropRow({ ...CURRENT, OurProb: "0.0000" });
  assert.equal(r.probOver, STORED_PROB_EPS);
  const one = readPropRow({ ...CURRENT, OurProb: "1.0000" });
  assert.equal(one.probOver, 1 - STORED_PROB_EPS);
});

test("readPropRow rejects rows it cannot price", () => {
  assert.equal(readPropRow({ ...CURRENT, Stat: "notAStat" }), null);
  assert.equal(readPropRow({ ...CURRENT, Line: "" }), null);
  assert.equal(readPropRow({ ...CURRENT, OurProb: "" }), null);
});

test("actualFor sums every column a stat is graded from", () => {
  const row = { RushTD: "1", RecptTD: "2", RushYards: "40" };
  assert.equal(actualFor(row, "rushYds"), 40);
  assert.equal(actualFor(row, "anytimeTD"), 3);
  // `int` has no actuals column at all, so it can never be graded.
  assert.equal(actualFor(row, "int"), null);
  assert.equal(actualFor(null, "rushYds"), null);
});

test("bestPrice compares payouts, not the American number", () => {
  // +110 pays more than -110 but sorts lower numerically.
  assert.equal(bestPrice([-110, 110]), 110);
  assert.equal(bestPrice([-105, -110, -120]), -105);
  assert.equal(bestPrice([]), null);
  assert.equal(bestPrice([NaN, 0, -110]), -110);
});

// --- buildSamples ----------------------------------------------------------

const quote = (over) => ({
  season: 2026, week: 2, playerId: "1", name: "A", team: "X", pos: "RB",
  stat: "rushYds", line: 49.5, book: "DraftKings", odds: -110,
  overOdds: -110, underOdds: -110, hold: 0.048, proj: 50, probOver: over,
  side: "over",
});

const actuals = (yards) => new Map([[2, new Map([["1", { RushYards: String(yards) }]])]]);

test("buildSamples grades a market and keeps one row per market", () => {
  const quotes = [
    quote(0.52),
    { ...quote(0.52), book: "FanDuel", odds: -105, overOdds: -105, underOdds: -115 },
  ];
  const { samples } = buildSamples(quotes, actuals(60));
  assert.equal(samples.length, 1, "two books quoting one market is one observation");
  assert.equal(samples[0].y, 1);
  assert.equal(samples[0].bookCount, 2);
  assert.equal(samples[0].bestOverOdds, -105);
  assert.equal(samples[0].pProj, 0.52);
});

test("buildSamples collapses the Over and Under rows of one market", () => {
  // The Under is an exact mirror, not a second observation.
  const over = quote(0.52);
  const under = { ...quote(0.52), side: "under", odds: -110 };
  const { samples } = buildSamples([over, under], actuals(60));
  assert.equal(samples.length, 1);
});

test("buildSamples drops a push", () => {
  const { samples, dropped } = buildSamples([{ ...quote(0.5), line: 60 }], actuals(60));
  assert.equal(samples.length, 0);
  assert.equal(dropped.push, 1);
});

test("buildSamples drops a market with no actuals and counts it", () => {
  const { samples, dropped } = buildSamples([quote(0.5)], new Map());
  assert.equal(samples.length, 0);
  assert.equal(dropped.noActual, 1);
});

test("buildSamples excludes retired markets unless asked, and counts them", () => {
  const td = { ...quote(0.3), stat: "anytimeTD", line: 0.5 };
  const acts = new Map([[2, new Map([["1", { RushTD: "1", RecptTD: "0" }]])]]);
  const excluded = buildSamples([td, { ...td, book: "FanDuel" }], acts);
  assert.equal(excluded.samples.length, 0);
  // Counted once per market, not once per book quote — otherwise the drop
  // tallies do not add up to the markets that went in.
  assert.equal(excluded.dropped.retired, 1);
  assert.equal(buildSamples([td], acts, { includeRetired: true }).samples.length, 1);
});

test("the drop tallies account for every market that went in", () => {
  // A silent drop is how a dataset quietly stops representing the board.
  const quotes = [
    quote(0.5), // graded
    { ...quote(0.5), line: 60 }, // push
    { ...quote(0.5), playerId: "2", line: 30 }, // no actuals
    { ...quote(0.3), stat: "anytimeTD", line: 0.5 }, // retired
    { ...quote(0.5), line: 80, book: "circasports" }, // no book in the retail set
  ];
  const { samples, dropped } = buildSamples(quotes, actuals(60), { marketSet: "retail" });
  const marketsIn = new Set(
    quotes.map((q) => [q.slot ?? "main", q.week, q.playerId, q.stat, q.line].join("|"))
  ).size;
  const accounted =
    samples.length + Object.values(dropped).reduce((a, b) => a + b, 0) - dropped.inconsistentProj;
  assert.equal(accounted, marketsIn, `${accounted} accounted for vs ${marketsIn} markets in`);
});

test("buildSamples honours the market set and min-books gate", () => {
  const quotes = [quote(0.5), { ...quote(0.5), book: "circasports" }];
  assert.equal(buildSamples(quotes, actuals(60), { marketSet: "sharp" }).samples[0].bookCount, 1);
  const gated = buildSamples(quotes, actuals(60), { marketSet: "sharp", minBooks: 2 });
  assert.equal(gated.samples.length, 0);
  assert.equal(gated.dropped.fewBooks, 1);
});

test("buildSamples separates the same player's different lines", () => {
  const quotes = [quote(0.52), { ...quote(0.25), line: 74.5 }];
  const { samples } = buildSamples(quotes, actuals(60));
  assert.equal(samples.length, 2);
  // 60 yards clears 49.5 and misses 74.5 — and both resolve off one game,
  // which is why pricing.mjs clusters them.
  assert.deepEqual(samples.map((s) => s.y).sort(), [0, 1]);
  assert.equal(new Set(samples.map((s) => `${s.week}|${s.playerId}`)).size, 1);
});

test("buildSamples reports a projection that disagrees across books", () => {
  // Every book shares one projection, so a mismatch is a keying bug, not data.
  const quotes = [quote(0.52), { ...quote(0.31), book: "FanDuel" }];
  const { dropped } = buildSamples(quotes, actuals(60));
  assert.equal(dropped.inconsistentProj, 1);
});

// --- slots ----------------------------------------------------------------

test("readPropRow takes the slot from its caller, falling back to the row", () => {
  // loadSeason knows which directory it read the file from, which is more
  // reliable than a column that did not exist when most rows were written.
  assert.equal(readPropRow(CURRENT).slot, "main");
  assert.equal(readPropRow({ ...CURRENT, Slot: "thursday" }).slot, "thursday");
  assert.equal(readPropRow(CURRENT, "t-48h").slot, "t-48h");
});

test("buildSamples keeps two captures of the same market apart", () => {
  // A slot is a capture at a MOMENT. Merging them would build a consensus
  // blended across times that matches no moment the market occupied, and —
  // since RotoWire revises projections daily — would also have to pick
  // arbitrarily between two values of P(over) for the same line.
  const tue = { ...quote(0.52), slot: "main", book: "DraftKings" };
  const thu = { ...quote(0.41), slot: "thursday", book: "FanDuel", odds: -105, overOdds: -105, underOdds: -115 };
  const { samples, dropped } = buildSamples([tue, thu], actuals(60));
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s.slot).sort(), ["main", "thursday"]);
  // Each carries its own capture's projection, not the other's.
  assert.equal(samples.find((s) => s.slot === "main").pProj, 0.52);
  assert.equal(samples.find((s) => s.slot === "thursday").pProj, 0.41);
  // And each sees only its own capture's books.
  assert.ok(samples.every((s) => s.bookCount === 1));
  // Which means the cross-capture projection disagreement is no longer a
  // disagreement at all.
  assert.equal(dropped.inconsistentProj, 0);
  // They are still one game, so they share a cluster.
  assert.equal(new Set(samples.map((s) => `${s.week}|${s.playerId}`)).size, 1);
});

test("a market only the later capture saw is still a market", () => {
  const thu = { ...quote(0.3), slot: "thursday", line: 74.5 };
  const { samples } = buildSamples([thu], actuals(60));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].slot, "thursday");
  assert.equal(samples[0].y, 0); // 60 yards misses 74.5
});

test("readPropRow carries the median adjustment, and blank means none", () => {
  // Rows captured before the correction existed have no MedianAdj, and none
  // of them were corrected.
  assert.equal(readPropRow(CURRENT).medianAdj, null);
  assert.equal(readPropRow({ ...CURRENT, MedianAdj: "" }).medianAdj, null);
  assert.equal(readPropRow({ ...CURRENT, MedianAdj: "0.8412" }).medianAdj, 0.8412);
});

test("buildSamples keeps the adjustment so a fit can see it is mixing", () => {
  const { samples } = buildSamples([{ ...quote(0.4), medianAdj: 0.84 }], actuals(60));
  assert.equal(samples[0].medianAdj, 0.84);
  const plain = buildSamples([quote(0.4)], actuals(60)).samples;
  assert.equal(plain[0].medianAdj, null);
});

test("readPropRow carries how the price was obtained and which model priced it", () => {
  assert.equal(readPropRow({ ...CURRENT, LineSource: "live", PriceModel: "pool" }).lineSource, "live");
  assert.equal(readPropRow({ ...CURRENT, LineSource: "live", PriceModel: "pool" }).priceModel, "pool");
  // Rows from before either column existed.
  assert.equal(readPropRow(CURRENT).lineSource, "");
  assert.equal(readPropRow(CURRENT).priceModel, "");
});

test("isPointInTime: a live capture is, a reconstruction is not", () => {
  // A backfilled board is priced from the week's latest snapshot, which has
  // absorbed everything since. Legacy week-1 rows have no source and were live.
  assert.equal(isPointInTime({ lineSource: "live" }), true);
  assert.equal(isPointInTime({ lineSource: "" }), true);
  assert.equal(isPointInTime({ lineSource: "opening" }), false);
  assert.equal(isPointInTime({ lineSource: "closing" }), false);
});

test("isProjectionPrice: only a row priced from the projection alone says what the projection said", () => {
  assert.equal(isProjectionPrice({ priceModel: "" }), true);
  assert.equal(isProjectionPrice({ priceModel: "projection" }), true);
  assert.equal(isProjectionPrice({ priceModel: "blend" }), false);
  assert.equal(isProjectionPrice({ priceModel: "pool" }), false);
});

test("buildSamples will not take a blend- or pool-priced OurProb for the projection", () => {
  // Fitting on such a row would train the model on a number that is already the
  // books' — the market agreeing with itself, credited to the projection.
  const pooled = [{ ...quote(0.55), priceModel: "pool" }, { ...quote(0.55), book: "FanDuel", priceModel: "pool" }];
  const { samples, dropped } = buildSamples(pooled, actuals(60));
  assert.equal(samples.length, 0);
  assert.equal(dropped.notProjectionPrice, 1);

  // A market with one projection-priced quote still has its projection.
  const mixed = [{ ...quote(0.4), priceModel: "projection" }, { ...quote(0.55), book: "FanDuel", priceModel: "pool" }];
  const kept = buildSamples(mixed, actuals(60));
  assert.equal(kept.samples.length, 1);
  assert.equal(kept.samples[0].pProj, 0.4);
  assert.equal(kept.samples[0].bookCount, 2, "and both books still feed the consensus");
});
