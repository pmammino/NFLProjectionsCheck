import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILTERS,
  PRESETS,
  presetFilters,
  edgeOf,
  oddsInRange,
  isAmerican,
  passesRow,
  applyFilters,
  summarize,
  betsToResolve,
  verdict,
  groupSummaries,
  oddsBucket,
  edgeBucket,
  pack,
  unpack,
} from "./paper-filter.mjs";
import { americanToProb } from "./odds.mjs";

let n = 0;
// A candidate row with sensible defaults; override what a test is about.
const row = (o = {}) => {
  const odds = o.odds ?? -110;
  return {
    week: 5, slot: "main", playerId: "p1", name: "A B", team: "TB", pos: "WR", opp: "at DAL",
    stat: "recYds", book: "fanduel", bookLabel: "FanDuel", bettable: true, side: "over", line: 50.5,
    odds, implied: americanToProb(odds), pProj: americanToProb(odds) + 0.08, pPool: americanToProb(odds) + 0.01,
    pSharp: americanToProb(odds) + 0.02, pFair: americanToProb(odds), nBooks: 5, nSharp: 1,
    mainLine: 50.5, rung: 0, status: "won", actual: 70, closeFair: americanToProb(odds) + 0.01, ...o, _n: n++,
  };
};
const all = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false, minBooks: 1, oddsMin: -1000, oddsMax: 3000, slots: null };

test("the default odds range is -400 to +200 and the default filters start from it", () => {
  assert.equal(DEFAULT_FILTERS.oddsMin, -400);
  assert.equal(DEFAULT_FILTERS.oddsMax, 200);
  assert.equal(presetFilters("realistic").oddsMin, -400);
  assert.equal(presetFilters("realistic").oddsMax, 200);
  assert.equal(presetFilters("nope").oddsMax, 200);
  for (const p of PRESETS) assert.ok(p.label && p.description, p.id);
});

test("odds are compared as payouts, so the range spans even money correctly", () => {
  for (const [o, ok] of [[-400, true], [-401, false], [-110, true], [100, true], [150, true], [200, true], [201, false], [1500, false], [-1000, false]]) {
    assert.equal(oddsInRange(o, -400, 200), ok, `${o}`);
  }
  // Widening works in either order, and nonsense prices are never in range.
  assert.equal(oddsInRange(1500, -400, 2000), true);
  assert.equal(oddsInRange(200, 200, -400), true);
  assert.equal(oddsInRange(0, -400, 200), false);
  assert.equal(isAmerican(-110), true);
  assert.equal(isAmerican(100), true);
  assert.equal(isAmerican(50), false);
  assert.equal(isAmerican(NaN), false);
});

test("an edge is a price's probability of the side minus what the odds imply", () => {
  const r = row({ odds: 100, implied: 0.5, pProj: 0.58, pPool: 0.52, pSharp: 0.49 });
  assert.ok(Math.abs(edgeOf(r, "projection") - 0.08) < 1e-9);
  assert.ok(Math.abs(edgeOf(r, "pool") - 0.02) < 1e-9);
  assert.ok(Math.abs(edgeOf(r, "sharp") - -0.01) < 1e-9);
  assert.equal(edgeOf(row({ pSharp: null }), "sharp"), null);
});

test("each per-row control removes what it should and nothing else", () => {
  const base = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false };
  const keep = (r, f) => passesRow(r, { ...base, ...f });
  assert.equal(keep(row(), {}), true);
  assert.equal(keep(row({ odds: 250 }), {}), false, "outside the default range");
  assert.equal(keep(row({ odds: 250 }), { oddsMax: 300 }), true, "the range is editable");
  assert.equal(keep(row({ slot: "opening" }), {}), false, "a reconstructed board is off by default");
  assert.equal(keep(row({ slot: "opening" }), { slots: ["opening"] }), true);
  assert.equal(keep(row({ week: 3 }), { weeks: [4, 5] }), false);
  assert.equal(keep(row({ bettable: false, book: "pinnacle" }), {}), false, "a reference book cannot be staked");
  assert.equal(keep(row({ bettable: false, book: "pinnacle" }), { bettableOnly: false }), true);
  assert.equal(keep(row({ book: "hardrock" }), { books: ["fanduel"] }), false);
  assert.equal(keep(row({ stat: "rushYds" }), { stats: ["recYds"] }), false);
  assert.equal(keep(row({ side: "under" }), { sides: "over" }), false);
  assert.equal(keep(row({ side: "over" }), { sides: "over" }), true);
  assert.equal(keep(row({ nBooks: 2 }), { minBooks: 3 }), false, "not enough books quote the line");
  assert.equal(keep(row({ nBooks: 3 }), { minBooks: 3 }), true);
  assert.equal(keep(row({ rung: 2 }), { maxRung: 1 }), false);
  assert.equal(keep(row({ rung: -1 }), { maxRung: 1 }), true, "rungs are measured either side of the main line");
  assert.equal(keep(row({ rung: 1 }), { maxRung: 0 }), false, "0 is the main line only");
  assert.equal(keep(row({ rung: -3 }), { maxRung: 1 }), false, "a rung far BELOW the main line is as far away as one far above");
  assert.equal(keep(row({ rung: 0 }), { maxRung: 0 }), true);
});

test("the edge floor and ceiling apply to the chosen price", () => {
  const r = row({ odds: 100, implied: 0.5, pProj: 0.6, pPool: 0.51, pSharp: 0.45 });
  const f = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false };
  assert.equal(passesRow(r, { ...f, basis: "projection" }), true);
  assert.equal(passesRow(r, { ...f, basis: "pool" }), false, "1% is under the 3% floor");
  assert.equal(passesRow(r, { ...f, basis: "pool", minEdge: 0.01 }), true);
  assert.equal(passesRow(r, { ...f, basis: "sharp" }), false, "the sharp price says the bet is bad");
  assert.equal(passesRow(r, { ...f, maxEdge: 0.05 }), false, "an edge over the ceiling is an outlier, not a find");
  assert.equal(passesRow(r, { ...f, maxEdge: 0.1 }), true);
  assert.equal(passesRow(row({ pSharp: null }), { ...f, basis: "sharp" }), false, "no sharp quote, no sharp edge");
});

test("sharp confirmation needs a sharp quote and a price the sharps do not contradict", () => {
  const f = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false, sharpConfirm: 0 };
  assert.equal(passesRow(row({ odds: 100, implied: 0.5, pSharp: 0.5 }), f), true, "level with the sharps is not contradicted");
  assert.equal(passesRow(row({ odds: 100, implied: 0.5, pSharp: 0.49 }), f), false);
  assert.equal(passesRow(row({ pSharp: null }), f), false, "a market no sharp book quoted cannot be confirmed");
  assert.equal(passesRow(row({ odds: 100, implied: 0.5, pSharp: 0.49 }), { ...f, sharpConfirm: -0.02 }), true, "the tolerance is editable");
  assert.equal(passesRow(row({ pSharp: null }), { ...f, sharpConfirm: null }), true, "off means off");
});

test("shopping keeps the best price among the books left, per market, per capture", () => {
  const rows = [row({ book: "fanduel", odds: 110 }), row({ book: "caesars", odds: 130 }), row({ book: "hardrock", odds: 120 })];
  const one = applyFilters(rows, { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: true });
  assert.equal(one.length, 1);
  assert.equal(one[0].book, "caesars");
  const each = applyFilters(rows, { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false });
  assert.equal(each.length, 3);
  // Shopping happens after the book filter, so excluding the best book moves the bet.
  const without = applyFilters(rows, { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: true, books: ["fanduel", "hardrock"] });
  assert.equal(without[0].book, "hardrock");
  // Negative odds: -105 beats -120.
  const neg = applyFilters([row({ book: "a", odds: -120 }), row({ book: "b", odds: -105 })], { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: true });
  assert.equal(neg[0].book, "b");
  // Different captures are different markets.
  const two = applyFilters([row({ slot: "main" }), row({ slot: "saturday" })], { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: true });
  assert.equal(two.length, 2);
});

test("ladder 'best' takes one rung per player, stat and side; 'all' takes them all", () => {
  const rungs = [
    row({ line: 40.5, rung: -1, pProj: 0.7, odds: -110, implied: americanToProb(-110) }),
    row({ line: 50.5, rung: 0, pProj: 0.62, odds: -110, implied: americanToProb(-110) }),
    row({ line: 60.5, rung: 1, pProj: 0.58, odds: -110, implied: americanToProb(-110) }),
  ];
  const f = { ...DEFAULT_FILTERS, timing: "every", shop: true };
  const best = applyFilters(rungs, { ...f, ladder: "best" });
  assert.equal(best.length, 1);
  assert.equal(best[0].line, 40.5, "the biggest edge");
  assert.equal(applyFilters(rungs, { ...f, ladder: "all" }).length, 3);
  // The over and the under of one player are different bets.
  const sides = applyFilters([...rungs, row({ side: "under", line: 50.5, pProj: 0.6 })], { ...f, ladder: "best" });
  assert.equal(sides.length, 2);
  // Different stats are different bets.
  assert.equal(applyFilters([...rungs, row({ stat: "rushYds" })], { ...f, ladder: "best" }).length, 2);
});

test("a tie between rungs goes to the one nearer the main line", () => {
  const a = row({ line: 40.5, rung: -2, pProj: 0.7 });
  const b = row({ line: 50.5, rung: 0, pProj: 0.7 });
  const out = applyFilters([a, b], { ...DEFAULT_FILTERS, timing: "every", ladder: "best" });
  assert.equal(out[0].rung, 0);
});

test("timing 'first' places a bet once, at the first capture where it qualifies", () => {
  const rows = [row({ slot: "saturday", odds: -105 }), row({ slot: "main", odds: -120 }), row({ slot: "thursday", odds: -110 })];
  const f = { ...DEFAULT_FILTERS, ladder: "all", shop: true };
  const first = applyFilters(rows, { ...f, timing: "first" });
  assert.equal(first.length, 1);
  assert.equal(first[0].slot, "main");
  assert.equal(applyFilters(rows, { ...f, timing: "every" }).length, 3, "every capture counts, which triple-counts one market");
  // If Tuesday's price does not qualify, Thursday's is the first that does.
  const late = applyFilters([row({ slot: "main", pProj: 0.4 }), row({ slot: "thursday" })], { ...f, timing: "first" });
  assert.equal(late.length, 1);
  assert.equal(late[0].slot, "thursday");
  // Captures are ordered by when they happen, not alphabetically.
  const order = applyFilters([row({ slot: "saturday" }), row({ slot: "thursday" })], { ...f, timing: "first", slots: ["thursday", "saturday"] });
  assert.equal(order[0].slot, "thursday");
});

test("the capture is chosen after the rung, so Saturday cannot pick a bet Tuesday never offered", () => {
  const rows = [
    row({ slot: "main", line: 40.5, rung: -1, pProj: 0.6 }),
    row({ slot: "saturday", line: 50.5, rung: 0, pProj: 0.75 }), // the bigger edge, but later
  ];
  const out = applyFilters(rows, { ...DEFAULT_FILTERS, ladder: "best", timing: "first", shop: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].slot, "main");
  assert.equal(out[0].line, 40.5);
});

test("settling: a win pays the decimal price, a loss costs a unit, a push returns it, pending is unsettled", () => {
  const f = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false, oddsMin: -1000, oddsMax: 3000 };
  const [w, l, p, pend] = ["won", "lost", "push", "pending"].map((status) => applyFilters([row({ odds: 150, status })], f)[0]);
  assert.ok(Math.abs(w.pnl - 1.5) < 1e-9);
  assert.equal(l.pnl, -1);
  assert.equal(p.pnl, 0);
  assert.equal(pend.pnl, null);
  assert.ok(Math.abs(applyFilters([row({ odds: -200, status: "won" })], f)[0].pnl - 0.5) < 1e-9);
});

test("summarize: ROI is on settled wins and losses, a push is neither, and pending is counted apart", () => {
  const f = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false };
  const mk = (status, i, extra = {}) => applyFilters([row({ odds: 100, status, playerId: "p" + i, week: 5, ...extra })], f)[0];
  const bets = [mk("won", 1), mk("lost", 2), mk("lost", 3), mk("push", 4), mk("pending", 5)];
  const s = summarize(bets, { completeWeeks: [] });
  assert.equal(s.bets, 5);
  assert.equal(s.settled, 3);
  assert.equal(s.won, 1);
  assert.equal(s.push, 1);
  assert.equal(s.unplayed, 1);
  assert.equal(s.noLine, 0);
  assert.ok(Math.abs(s.roi - -1 / 3) < 1e-9);
  assert.ok(Math.abs(s.winRate - 1 / 3) < 1e-9);
  assert.ok(s.roiBand > 0);
  assert.equal(summarize([]).roi, null);
});

test("pending in a finished week is a bounded loss for an over and voided for an under; in a live week it is unplayed", () => {
  const f = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false };
  const mk = (side, week, i) => applyFilters([row({ odds: 100, status: "pending", side, week, playerId: "q" + i })], f)[0];
  const won = applyFilters([row({ odds: 100, status: "won", playerId: "w1" })], f)[0];
  const done = summarize([won, mk("over", 4, 1), mk("under", 4, 2)], { completeWeeks: [4] });
  assert.equal(done.noLine, 2);
  assert.equal(done.unplayed, 0);
  assert.equal(done.roi, 1);
  assert.ok(Math.abs(done.roiConservative - 0) < 1e-9, "one win, one over counted as a loss: (1 - 1) / 2");
  const live = summarize([won, mk("over", 5, 3)], { completeWeeks: [4] });
  assert.equal(live.unplayed, 1);
  assert.equal(live.noLine, 0);
  assert.equal(live.roiConservative, 1);
});

test("CLV is the market's closing fair price of the side minus the price taken", () => {
  const f = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false };
  const bets = applyFilters([row({ odds: 100, implied: 0.5, closeFair: 0.55, playerId: "a" }), row({ odds: 100, implied: 0.5, closeFair: 0.48, playerId: "b" }), row({ odds: 100, implied: 0.5, closeFair: null, playerId: "c" })], f);
  const s = summarize(bets);
  assert.equal(s.clv.n, 2);
  assert.ok(Math.abs(s.clv.avg - 0.015) < 1e-9);
  assert.equal(s.clv.beatRate, 0.5);
  assert.equal(summarize(applyFilters([row({ closeFair: null })], f)).clv, null);
});

test("betsToResolve and the verdict say how far to trust a number", () => {
  assert.equal(betsToResolve(0.05, 2), 6400);
  assert.equal(betsToResolve(0, 2), null);
  assert.equal(verdict({ settled: 50, roi: 0.5, roiBand: 0.1 }), "too few bets to call");
  assert.equal(verdict({ settled: 500, roi: 0.1, roiBand: 0.05 }), "positive");
  assert.equal(verdict({ settled: 500, roi: -0.1, roiBand: 0.05 }), "negative");
  assert.equal(verdict({ settled: 500, roi: 0.03, roiBand: 0.05 }), "indistinguishable from zero");
});

test("groups are summarised separately and the biggest comes first", () => {
  const f = { ...DEFAULT_FILTERS, ladder: "all", timing: "every", shop: false };
  const bets = applyFilters([row({ stat: "recYds", playerId: "a" }), row({ stat: "recYds", playerId: "b" }), row({ stat: "rushYds", playerId: "c", status: "lost" })], f);
  const g = groupSummaries(bets, (b) => b.stat, { label: (k) => k.toUpperCase() });
  assert.deepEqual(g.map((x) => [x.label, x.summary.bets]), [["RECYDS", 2], ["RUSHYDS", 1]]);
  assert.equal(g[1].summary.roi, -1);
});

test("odds and edge buckets cover everything exactly once", () => {
  assert.match(oddsBucket(1.2), /heavy favourite/);
  assert.match(oddsBucket(1.9), /near even/);
  assert.match(oddsBucket(3), /underdog/);
  assert.match(oddsBucket(15), /long shot/);
  assert.equal(edgeBucket(0.04), "3–5%");
  assert.equal(edgeBucket(0.07), "5–10%");
  assert.equal(edgeBucket(0.12), "10–15%");
  assert.equal(edgeBucket(0.3), "15%+");
});

test("packing and unpacking round-trips a row, with missing values staying missing", () => {
  const rows = [
    row({ playerId: "17784", pSharp: null, closeFair: null, actual: null, status: "pending", side: "under", rung: -2, bettable: false, odds: 1500, implied: 0.0625 }),
    row({ playerId: "99", actual: 0, status: "won" }),
  ];
  const packed = pack(rows);
  assert.ok(packed.rows.every((r) => r.every(Number.isFinite)), "all integers");
  const players = [{ id: "17784", name: "Bucky Irving", team: "TB", pos: "RB" }, { id: "99", name: "Z Z", team: "X", pos: "WR" }];
  const back = unpack(JSON.parse(JSON.stringify(packed)), players);
  assert.equal(back[0].name, "Bucky Irving");
  assert.equal(back[0].pSharp, null);
  assert.equal(back[0].closeFair, null);
  assert.equal(back[0].actual, null);
  assert.equal(back[0].status, "pending");
  assert.equal(back[0].side, "under");
  assert.equal(back[0].rung, -2);
  assert.equal(back[0].bettable, false);
  assert.equal(back[0].odds, 1500);
  assert.equal(back[1].actual, 0, "an actual of zero is a real value");
  assert.ok(Math.abs(back[1].pProj - rows[1].pProj) < 1e-4);
  assert.equal(back[1].book, "fanduel");
  assert.equal(back[1].bookLabel, "FanDuel");
});
