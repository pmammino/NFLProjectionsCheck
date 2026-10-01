import test from "node:test";
import assert from "node:assert/strict";
import {
  consensusProb,
  bookFairProb,
  bookInSet,
  estimateHoldByStat,
  logit,
  sigmoid,
  median,
  MARKET_SETS,
  DEFAULT_ASSUMED_HOLD,
} from "./consensus.mjs";
import { americanToProb } from "./odds.mjs";

test("logit and sigmoid invert each other", () => {
  for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    assert.ok(Math.abs(sigmoid(logit(p)) - p) < 1e-12);
  }
});

test("logit clamps rather than returning infinity", () => {
  assert.ok(Number.isFinite(logit(0)));
  assert.ok(Number.isFinite(logit(1)));
  assert.ok(logit(0) < -10 && logit(1) > 10);
});

test("logit is odd: logit(1-p) === -logit(p)", () => {
  // The dataset relies on this to justify canonicalizing every market to its
  // Over side — the Under is an exact mirror, not a second observation.
  for (const p of [0.02, 0.3, 0.5, 0.87]) {
    assert.ok(Math.abs(logit(1 - p) + logit(p)) < 1e-12);
  }
});

test("bookInSet normalizes spellings across capture schemas", () => {
  // Week 1 wrote API ids, weeks 2+ write display names.
  assert.equal(bookInSet("draftkings", "retail"), true);
  assert.equal(bookInSet("DraftKings", "retail"), true);
  assert.equal(bookInSet("Hard Rock", "retail"), true);
  assert.equal(bookInSet("hard_rock_bet", "retail"), true);
  assert.equal(bookInSet("BetMGM", "retail"), true);
  assert.equal(bookInSet("circasports", "sharp"), true);
  assert.equal(bookInSet("circasports", "retail"), false);
  assert.equal(bookInSet("anything", "all"), true);
  assert.equal(bookInSet("draftkings", "nope"), false);
});

test("retail and sharp sets do not overlap", () => {
  const overlap = MARKET_SETS.retail.filter((b) => MARKET_SETS.sharp.includes(b));
  assert.deepEqual(overlap, []);
});

test("bookFairProb de-vigs a two-sided quote", () => {
  const r = bookFairProb({ overOdds: -110, underOdds: -110, side: "over" });
  assert.equal(r.source, "devig");
  assert.ok(Math.abs(r.fairProb - 0.5) < 1e-9);
  assert.ok(Math.abs(r.hold - (americanToProb(-110) * 2 - 1)) < 1e-12);
});

test("bookFairProb falls back to an assumed hold when one-sided", () => {
  const raw = americanToProb(200);
  const r = bookFairProb({ overOdds: 200, underOdds: null, side: "over", assumedHold: 0.07 });
  assert.equal(r.source, "assumed-hold");
  assert.equal(r.hold, null);
  assert.ok(Math.abs(r.fairProb - raw / 1.07) < 1e-12);
  // Stripping margin always lowers the probability.
  assert.ok(r.fairProb < raw);
});

test("bookFairProb uses the default hold when none is supplied", () => {
  const r = bookFairProb({ overOdds: 200, underOdds: null, side: "over" });
  assert.ok(Math.abs(r.fairProb - americanToProb(200) / (1 + DEFAULT_ASSUMED_HOLD)) < 1e-12);
});

test("bookFairProb returns the under side of a two-sided quote", () => {
  const over = bookFairProb({ overOdds: -200, underOdds: 160, side: "over" });
  const under = bookFairProb({ overOdds: -200, underOdds: 160, side: "under" });
  assert.ok(Math.abs(over.fairProb + under.fairProb - 1) < 1e-9);
});

test("estimateHoldByStat takes the median of observed holds only", () => {
  const holds = estimateHoldByStat([
    { stat: "recYds", hold: 0.05 },
    { stat: "recYds", hold: 0.09 },
    { stat: "recYds", hold: 0.07 },
    { stat: "recYds", hold: NaN }, // one-sided row, contributes nothing
    { stat: "rushYds", hold: 0.04 },
  ]);
  assert.equal(holds.get("recYds"), 0.07);
  assert.equal(holds.get("rushYds"), 0.04);
  assert.equal(holds.has("passYds"), false);
});

test("consensusProb takes the median across books, not the extreme", () => {
  // Three books agree near 50%, one is stale at a much longer price. The
  // consensus must ignore the outlier — that is the whole point of a median.
  const rows = [
    { book: "draftkings", overOdds: -110, underOdds: -110 },
    { book: "fanduel", overOdds: -108, underOdds: -112 },
    { book: "caesars", overOdds: -112, underOdds: -108 },
    { book: "betrivers", overOdds: 400, underOdds: -600 },
  ];
  const c = consensusProb(rows, { side: "over", setName: "retail", stat: "recYds" });
  assert.equal(c.bookCount, 4);
  assert.equal(c.probSource, "devig");
  assert.ok(Math.abs(c.prob - 0.5) < 0.02, `expected ~0.5, got ${c.prob}`);
});

test("consensusProb filters to the named market set", () => {
  const rows = [
    { book: "draftkings", overOdds: -110, underOdds: -110 },
    { book: "circasports", overOdds: 300, underOdds: -400 },
  ];
  assert.equal(consensusProb(rows, { side: "over", setName: "retail" }).bookCount, 1);
  assert.equal(consensusProb(rows, { side: "over", setName: "sharp" }).bookCount, 1);
  assert.equal(consensusProb(rows, { side: "over", setName: "all" }).bookCount, 2);
});

test("consensusProb gives each book one vote", () => {
  // A capture can hold the same book twice (the Over row and the Under row of
  // one market). Counting it twice would weight that book double.
  const rows = [
    { book: "DraftKings", overOdds: -110, underOdds: -110 },
    { book: "draftkings", overOdds: -110, underOdds: -110 },
    { book: "fanduel", overOdds: -120, underOdds: 100 },
  ];
  assert.equal(consensusProb(rows, { side: "over", setName: "retail" }).bookCount, 2);
});

test("consensusProb labels a mixed consensus as mixed", () => {
  const rows = [
    { book: "draftkings", overOdds: -110, underOdds: -110 },
    { book: "fanduel", overOdds: -115, underOdds: null },
  ];
  const c = consensusProb(rows, { side: "over", setName: "retail" });
  assert.equal(c.probSource, "mixed");
  assert.equal(c.deviggedCount, 1);
});

test("consensusProb returns null when no book in the set quotes it", () => {
  const rows = [{ book: "circasports", overOdds: -110, underOdds: -110 }];
  assert.equal(consensusProb(rows, { side: "over", setName: "retail" }), null);
});

test("the over and under consensus are exact complements", () => {
  const rows = [
    { book: "draftkings", overOdds: -130, underOdds: 110 },
    { book: "fanduel", overOdds: -125, underOdds: 105 },
    { book: "caesars", overOdds: -140, underOdds: 118 },
  ];
  const over = consensusProb(rows, { side: "over", setName: "retail" });
  const under = consensusProb(rows, { side: "under", setName: "retail" });
  assert.ok(Math.abs(over.prob + under.prob - 1) < 1e-9);
});

test("median handles even and odd lengths", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
});
