import { test } from "node:test";
import assert from "node:assert/strict";
import {
  marketKey,
  indexClosing,
  lineMoveDirection,
  computeClv,
  summarizeClv,
} from "./clv.mjs";

const bet = (o = {}) => ({
  book: "draftkings",
  playerId: "1",
  stat: "passYds",
  side: "over",
  line: 249.5,
  odds: -110,
  ...o,
});

const closing = (o = {}) => ({ ...bet(), ...o });

// ---- Keys --------------------------------------------------------------------
test("a market is keyed by book, player, stat and side", () => {
  // The book belongs in the key: CLV is about the price WE could have got, and
  // a move at some other book says nothing about the one we bet.
  assert.notEqual(marketKey(bet()), marketKey(bet({ book: "fanduel" })));
  assert.notEqual(marketKey(bet()), marketKey(bet({ side: "under" })));
  assert.equal(marketKey(bet()), marketKey(bet({ book: "DraftKings" })), "case-insensitive");
  // The line is NOT in the key — a moved line still has to be findable.
  assert.equal(marketKey(bet()), marketKey(bet({ line: 999 })));
});

// ---- Direction ---------------------------------------------------------------
test("a rising line favours an over, a falling line favours an under", () => {
  // We already hold the ticket, so the question is whether our number is
  // easier than the one a closing bettor gets.
  assert.equal(lineMoveDirection("over", 249.5, 251.5), "toward");
  assert.equal(lineMoveDirection("over", 249.5, 247.5), "against");
  assert.equal(lineMoveDirection("under", 249.5, 247.5), "toward");
  assert.equal(lineMoveDirection("under", 249.5, 251.5), "against");
  assert.equal(lineMoveDirection("over", 249.5, 249.5), "same");
  assert.equal(lineMoveDirection("over", NaN, 251.5), null);
});

// ---- Price CLV ---------------------------------------------------------------
test("a price that shortens after we bet is positive CLV", () => {
  // Took -110, closed -130: the market ended up rating our side more likely
  // than we paid for.
  const r = computeClv(bet(), indexClosing([closing({ odds: -130 })]));
  assert.equal(r.status, "matched");
  assert.ok(r.clvProb > 0, "market moved toward us");
  assert.ok(r.clvPct > 0, "we got the better payout");
});

test("a price that drifts after we bet is negative CLV", () => {
  const r = computeClv(bet(), indexClosing([closing({ odds: 100 })]));
  assert.equal(r.status, "matched");
  assert.ok(r.clvProb < 0);
  assert.ok(r.clvPct < 0);
});

test("an unchanged price is zero CLV", () => {
  const r = computeClv(bet(), indexClosing([closing()]));
  assert.equal(r.clvProb, 0);
  assert.equal(r.clvPct, 0);
});

test("CLV is measured at OUR book, not whichever moved", () => {
  const index = indexClosing([
    closing({ book: "fanduel", odds: -200 }), // a huge move elsewhere
    closing({ book: "draftkings", odds: -110 }), // ours did not move
  ]);
  assert.equal(computeClv(bet(), index).clvProb, 0);
});

// ---- Line moves --------------------------------------------------------------
test("a moved line reports direction but no numeric CLV", () => {
  // Quantifying a half-point needs a model of what a half-point is worth for
  // that stat. We don't have one, and inventing a number to sit beside
  // measured ones would be worse than reporting the gap honestly.
  const r = computeClv(bet(), indexClosing([closing({ line: 251.5, odds: -110 })]));
  assert.equal(r.status, "line-moved");
  assert.equal(r.clvProb, null);
  assert.equal(r.clvPct, null);
  assert.equal(r.lineMove, "toward");
  assert.equal(r.closingLine, 251.5);
});

test("the exact line wins when the book quotes several", () => {
  const r = computeClv(
    bet(),
    indexClosing([closing({ line: 259.5, odds: 200 }), closing({ line: 249.5, odds: -130 })])
  );
  assert.equal(r.status, "matched");
  assert.equal(r.closingLine, 249.5);
  assert.equal(r.closingOdds, -130);
});

test("with no exact match the closest line is reported", () => {
  const r = computeClv(
    bet(),
    indexClosing([closing({ line: 269.5 }), closing({ line: 251.5 })])
  );
  assert.equal(r.closingLine, 251.5);
});

// ---- Missing markets ---------------------------------------------------------
test("a market gone by kickoff reports not-found", () => {
  // A player ruled out after we bet, or a book pulling the market. Worth
  // counting: a systematic pattern here means we are betting into news.
  const r = computeClv(bet(), indexClosing([]));
  assert.equal(r.status, "not-found");
  assert.equal(r.clvProb, null);
  assert.equal(computeClv(bet(), null).status, "not-found");
});

test("an unusable closing price is treated as missing, not as zero", () => {
  const r = computeClv(bet(), indexClosing([closing({ odds: 0 })]));
  assert.equal(r.status, "not-found");
});

// ---- De-vigged comparison ----------------------------------------------------
test("when both sides close, the comparison uses the de-vigged price", () => {
  // Comparing against the raw closing price would count a change in the book's
  // MARGIN as line movement. De-vigging isolates the belief.
  const closeIndex = indexClosing([closing({ odds: -110 })]);
  const opposing = indexClosing([closing({ side: "under", odds: -110 })]);

  const raw = computeClv(bet(), closeIndex);
  const fair = computeClv(bet(), closeIndex, opposing);

  assert.equal(raw.devigged, false);
  assert.equal(fair.devigged, true);
  // Our -110 implies 52.4%; the de-vigged close is 50%. So against the fair
  // price we actually LOST value, which the raw comparison hid entirely.
  assert.equal(raw.clvProb, 0);
  assert.ok(fair.clvProb < 0);
});

test("a one-sided close falls back to the raw comparison", () => {
  const r = computeClv(bet(), indexClosing([closing({ odds: -130 })]), indexClosing([]));
  assert.equal(r.status, "matched");
  assert.equal(r.devigged, false);
  assert.ok(r.clvProb > 0);
});

// ---- Summary -----------------------------------------------------------------
test("the summary reports beat rate over matched bets only", () => {
  const s = summarizeClv([
    { status: "matched", clvProb: 0.02, clvPct: 0.04 },
    { status: "matched", clvProb: 0.01, clvPct: 0.02 },
    { status: "matched", clvProb: -0.01, clvPct: -0.02 },
    { status: "line-moved", clvProb: null, clvPct: null, lineMove: "toward" },
    { status: "not-found", clvProb: null, clvPct: null },
  ]);
  assert.equal(s.n, 5);
  assert.equal(s.nMatched, 3);
  assert.equal(s.nLineMoved, 1);
  assert.equal(s.nNotFound, 1);
  // 2 of 3 matched beat the close — the unmatched rows must not dilute it.
  assert.ok(Math.abs(s.beatRate - 2 / 3) < 1e-4);
  assert.ok(Math.abs(s.avgClvProb - (0.02 + 0.01 - 0.01) / 3) < 1e-4);
  assert.equal(s.lineMovedToward, 1);
  assert.equal(s.lineMovedAgainst, 0);
});

test("a summary with nothing matched reports null rather than zero", () => {
  // Zero would read as "we broke even against the close", which is a claim.
  // Null says we could not measure.
  const s = summarizeClv([{ status: "not-found", clvProb: null }]);
  assert.equal(s.beatRate, null);
  assert.equal(s.avgClvProb, null);
  assert.equal(summarizeClv([]).n, 0);
  assert.equal(summarizeClv(null).n, 0);
});
