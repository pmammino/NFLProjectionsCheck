import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PROJECTION,
  MIN_LINE,
  MAX_MARKET_DISAGREEMENT,
  meetsSupportFloor,
  marketsExceedingTolerance,
  marketIdentity,
  applyCalibrationGuards,
} from "./calibration.mjs";
import { STAT_DEFS } from "./markets.mjs";

// ---- Guard 1: the support floor --------------------------------------------
// Two floors doing different jobs. MIN_LINE is the real guard — it removes the
// near-zero lines where a point mass at zero lives and a two-piece normal
// cannot represent it. MIN_PROJECTION is a light backstop for players we
// barely project at all.

const mkt = (o) => ({ stat: "rushYds", projectedMedian: 40, line: 24.5, ...o });

test("a stat with neither floor is always supported", () => {
  assert.equal(meetsSupportFloor(mkt({ stat: "passYds", projectedMedian: 0.1, line: 0.5 })), true);
  assert.equal(meetsSupportFloor(mkt({ stat: "completions", projectedMedian: 0, line: 0.5 })), true);
});

// The failure this guard exists for lives at the lowest lines, not at low
// projections: pooled over every projected player, rushYds is +20 points
// overconfident at a 0.5 line and within 3 points from 1.5 upward.
test("a near-zero line is refused even for a heavily projected player", () => {
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: 90, line: 0.5 })), false);
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: 90, line: 1.5 })), false);
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: 90, line: 2.5 })), true);
});

// The whole point of lowering the projection floor: these are well calibrated
// at the line (gap -1 to -4) and the earlier projection-based floor threw them
// all away.
test("a lightly projected player is bettable at an ordinary line", () => {
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: 6.81, line: 24.5 })), true);
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: 4, line: 3.5 })), true);
  assert.equal(meetsSupportFloor(mkt({ stat: "recYds", projectedMedian: 5, line: 14.5 })), true);
});

test("the projection backstop still refuses a player we barely project", () => {
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: 2.9, line: 24.5 })), false);
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: 3, line: 24.5 })), true); // inclusive
});

// All five bets that prompted this work were rushing yards. Four were priced
// at a 0.5 line; Geno Smith's was 6.5 on a 12.1 projection, which the line
// floor does NOT catch — the disagreement cap is what removes that one.
test("the near-zero-line bets that prompted this are refused by the line floor", () => {
  for (const projectedMedian of [4.4, 4.49, 2.14]) {
    assert.equal(meetsSupportFloor(mkt({ projectedMedian, line: 0.5 })), false);
  }
});

test("a missing or non-finite line or projection fails closed", () => {
  assert.equal(meetsSupportFloor(mkt({ line: undefined })), false);
  assert.equal(meetsSupportFloor(mkt({ line: NaN })), false);
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: undefined })), false);
  assert.equal(meetsSupportFloor(mkt({ projectedMedian: null })), false);
});

// A line floor on a stat with no Floor/Ceiling, or on a retired market, would
// be config that can never fire.
test("floors only exist for live continuous stats", () => {
  for (const stat of [...Object.keys(MIN_PROJECTION), ...Object.keys(MIN_LINE)]) {
    assert.equal(STAT_DEFS[stat].kind, "continuous", `${stat} should be continuous`);
    assert.equal(STAT_DEFS[stat].hasLine, true, `${stat} should have a real line`);
    assert.notEqual(STAT_DEFS[stat].bet, false, `${stat} is retired — a floor on it is dead config`);
  }
});

// ---- Guard 2: the market-disagreement cap -----------------------------------

const row = (o) => ({ marketKey: "p|rushYds|50.5|over", ourProb: 0.55, fairProb: 0.52, ...o });

test("a market we broadly agree with survives", () => {
  assert.equal(marketsExceedingTolerance([row({})]).size, 0);
});

test("a market we wildly disagree with is rejected", () => {
  const out = marketsExceedingTolerance([row({ ourProb: 0.94, fairProb: 0.48 })]);
  assert.equal(out.size, 1);
});

test("the cap is symmetric — a huge disagreement the other way is equally wrong", () => {
  assert.equal(marketsExceedingTolerance([row({ ourProb: 0.05, fairProb: 0.5 })]).size, 1);
});

test("the boundary is inclusive, so exactly the cap survives", () => {
  const at = row({ ourProb: 0.5 + MAX_MARKET_DISAGREEMENT, fairProb: 0.5 });
  assert.equal(marketsExceedingTolerance([at]).size, 0);
  const over = row({ ourProb: 0.5 + MAX_MARKET_DISAGREEMENT + 1e-9, fairProb: 0.5 });
  assert.equal(marketsExceedingTolerance([over]).size, 1);
});

// The reason this guard is market-level rather than row-level. With our prob at
// 0.90, the book offering 0.55 disagrees by 35 points and the one offering 0.72
// by only 18. A per-row cap would cut the FIRST — which is the better price —
// and keep betting the same broken market at the worse number.
test("one book's outlier price cannot drag the market under the cap", () => {
  const rejected = marketsExceedingTolerance([
    row({ ourProb: 0.9, fairProb: 0.55 }),
    row({ ourProb: 0.9, fairProb: 0.72 }),
    row({ ourProb: 0.9, fairProb: 0.68 }),
  ]);
  // Median fair is 0.68, so the disagreement is 0.22 > 0.20: the whole market goes.
  assert.equal(rejected.size, 1, "the market should be cut as a unit, not row by row");
  assert.ok(rejected.has("p|rushYds|50.5|over"));
});

test("a market is judged on the median book, not the most extreme one", () => {
  // Four books cluster at ~0.75 and one is stale at 0.40. Median is 0.75, so
  // our 0.80 is a 5-point disagreement and the market stands.
  const rejected = marketsExceedingTolerance([
    row({ ourProb: 0.8, fairProb: 0.4 }),
    row({ ourProb: 0.8, fairProb: 0.74 }),
    row({ ourProb: 0.8, fairProb: 0.75 }),
    row({ ourProb: 0.8, fairProb: 0.76 }),
    row({ ourProb: 0.8, fairProb: 0.77 }),
  ]);
  assert.equal(rejected.size, 0);
});

test("distinct markets are judged independently", () => {
  const rejected = marketsExceedingTolerance([
    { marketKey: "a", ourProb: 0.55, fairProb: 0.52 },
    { marketKey: "b", ourProb: 0.95, fairProb: 0.45 },
  ]);
  assert.deepEqual([...rejected], ["b"]);
});

test("a market with no usable price is refused rather than assumed fine", () => {
  assert.equal(marketsExceedingTolerance([row({ fairProb: NaN })]).size, 1);
  assert.equal(marketsExceedingTolerance([row({ ourProb: null })]).size, 1);
});

test("marketIdentity ignores the book, so the same wager groups across books", () => {
  const bet = { playerId: "1", stat: "rushYds", line: 50.5, side: "over" };
  assert.equal(marketIdentity({ ...bet, book: "draftkings" }), marketIdentity({ ...bet, book: "fanduel" }));
  assert.notEqual(marketIdentity(bet), marketIdentity({ ...bet, side: "under" }));
  assert.notEqual(marketIdentity(bet), marketIdentity({ ...bet, line: 51.5 }));
});

// ---- Both guards together ---------------------------------------------------

const cand = (o) => ({
  playerId: "p1",
  stat: "recYds",
  line: 40.5,
  side: "over",
  projectedMedian: 60,
  ourProb: 0.58,
  fairProb: 0.55,
  ...o,
});

test("a sound bet passes both guards", () => {
  const { kept, rejected } = applyCalibrationGuards([cand({})]);
  assert.equal(kept.length, 1);
  assert.equal(rejected.length, 0);
});

test("each guard reports the reason it fired", () => {
  const { kept, rejected } = applyCalibrationGuards([
    cand({ playerId: "floor", line: 0.5 }),
    cand({ playerId: "wild", ourProb: 0.95, fairProb: 0.4 }),
    cand({ playerId: "fine" }),
  ]);
  assert.deepEqual(kept.map((r) => r.playerId), ["fine"]);
  assert.deepEqual(
    rejected.map((r) => [r.row.playerId, r.reason]).sort(),
    [["floor", "support-floor"], ["wild", "market-disagreement"]]
  );
});

// Sequencing matters. A market below the support floor should never have been
// priced, so its prices must not help decide what the market believes.
test("a floored-out row cannot vote in the consensus that judges another book", () => {
  // Same market at two books. One row is below the floor (it should not exist
  // at all), and it is the only price that would pull the median our way.
  const rows = [
    cand({ stat: "rushYds", line: 0.5, fairProb: 0.85 }),
    cand({ stat: "rushYds", line: 0.5, fairProb: 0.5 }),
  ];
  const { kept, rejected } = applyCalibrationGuards(rows.map((r) => ({ ...r, ourProb: 0.9 })));
  assert.equal(kept.length, 0);
  assert.ok(rejected.every((r) => r.reason === "support-floor"));
});

test("guards are order-independent for a mixed batch", () => {
  const batch = [
    cand({ playerId: "a" }),
    cand({ playerId: "b", projectedMedian: 2, line: 0.5 }),
    cand({ playerId: "c", ourProb: 0.99, fairProb: 0.3 }),
  ];
  const fwd = applyCalibrationGuards(batch);
  const rev = applyCalibrationGuards([...batch].reverse());
  assert.deepEqual(fwd.kept.map((r) => r.playerId).sort(), rev.kept.map((r) => r.playerId).sort());
  assert.equal(fwd.rejected.length, rev.rejected.length);
});

test("an empty or missing batch is not an error", () => {
  assert.deepEqual(applyCalibrationGuards([]), { kept: [], rejected: [] });
  assert.deepEqual(applyCalibrationGuards(undefined), { kept: [], rejected: [] });
  assert.equal(marketsExceedingTolerance(undefined).size, 0);
});
