import test from "node:test";
import assert from "node:assert/strict";
import { bestPrice, edgeAt, fairOver, resultOf, mainLineIndex, lineView, bestEdge, searchPlayers, formatOdds, inPlay, IN_PLAY_MIN, IN_PLAY_MAX } from "./lines-view.mjs";
import { americanToProb } from "./odds.mjs";

const books = [
  { k: "draftkings", label: "DraftKings", t: 1 },
  { k: "fanduel", label: "FanDuel", t: 1 },
  { k: "pinnacle", label: "Pinnacle", t: 0 },
];

test("bestPrice compares payouts, not the American number", () => {
  // +110 pays more than -110 but sorts lower numerically.
  assert.deepEqual(bestPrice([[0, -110, null], [1, 110, null]], books, "over"), { odds: 110, book: 1 });
  assert.deepEqual(bestPrice([[0, -105, null], [1, -120, null]], books, "over"), { odds: -105, book: 0 });
});

test("bestPrice never returns a reference book, however good its number", () => {
  // The whole reason for two rosters: a price nobody here can take is a return
  // nobody could have earned.
  const q = [[0, -115, null], [2, 150, null]];
  assert.deepEqual(bestPrice(q, books, "over"), { odds: -115, book: 0 });
  assert.equal(bestPrice([[2, 150, null]], books, "over"), null);
});

test("bestPrice looks at the requested side and skips missing prices", () => {
  const q = [[0, -110, 120], [1, null, 100]];
  assert.deepEqual(bestPrice(q, books, "under"), { odds: 120, book: 0 });
  assert.deepEqual(bestPrice(q, books, "over"), { odds: -110, book: 0 });
  assert.equal(bestPrice([], books, "over"), null);
  assert.equal(bestPrice(undefined, books, "over"), null);
  assert.equal(bestPrice([[0, 0, null]], books, "over"), null);
});

test("edge is our probability minus the break-even probability at the price", () => {
  // At -110 the break-even is 52.38%, not 50%: the margin is a cost actually paid.
  assert.ok(Math.abs(edgeAt(0.6, -110, "over") - (0.6 - americanToProb(-110))) < 1e-12);
  assert.ok(Math.abs(edgeAt(0.6, -110, "over") - 0.0762) < 1e-3);
  // The under side is the complement.
  assert.ok(Math.abs(edgeAt(0.6, 120, "under") - (0.4 - americanToProb(120))) < 1e-12);
  assert.equal(edgeAt(null, -110, "over"), null);
  assert.equal(edgeAt(0.6, 0, "over"), null);
});

test("fairOver de-vigs a two-sided quote and refuses a one-sided one", () => {
  assert.ok(Math.abs(fairOver(-110, -110) - 0.5) < 1e-9);
  assert.ok(fairOver(-150, 130) > 0.5 && fairOver(-150, 130) < americanToProb(-150));
  // A fair price cannot be derived from one quote, and must not be invented.
  assert.equal(fairOver(-110, null), null);
  assert.equal(fairOver(null, 100), null);
});

test("resultOf distinguishes over, under and a push", () => {
  assert.equal(resultOf(82, 49.5), "over");
  assert.equal(resultOf(12, 49.5), "under");
  assert.equal(resultOf(50, 50), "push");
  assert.equal(resultOf(null, 49.5), null);
  assert.equal(resultOf(undefined, 49.5), null);
});

test("mainLineIndex picks the line the books price closest to a coin flip", () => {
  const ls = [{ l: 20, m: 0.9, p: 0.8 }, { l: 50, m: 0.51, p: 0.4 }, { l: 80, m: 0.1, p: 0.1 }];
  assert.equal(mainLineIndex(ls), 1);
  // No consensus: fall back to our own price.
  assert.equal(mainLineIndex([{ l: 1, m: null, p: 0.9 }, { l: 2, m: null, p: 0.52 }]), 1);
  assert.equal(mainLineIndex([]), -1);
  assert.equal(mainLineIndex(undefined), -1);
});

test("lineView computes edges at the best BETTABLE price and the gap to the market", () => {
  const line = { l: 49.5, p: 0.6, a: 0.45, m: 0.5, s: null, b: [[0, -110, -110], [1, 105, -125], [2, 130, -150]] };
  const v = lineView(line, books);
  assert.deepEqual(v.bestOver, { odds: 105, book: 1 }, "Pinnacle's +130 is not takeable");
  assert.ok(Math.abs(v.gap - 0.1) < 1e-12);
  assert.ok(Math.abs(v.edgeOver - edgeAt(0.6, 105, "over")) < 1e-12);
  assert.equal(v.corrected, false);
  assert.equal(v.nBooks, 3);
});

test("lineView swaps in the corrected price only where one exists", () => {
  const withA = lineView({ l: 1, p: 0.6, a: 0.45, m: 0.5, b: [[0, -110, -110]] }, books, { useCorrected: true });
  assert.equal(withA.p, 0.45);
  assert.equal(withA.corrected, true);
  // No corrected price for this line: it must fall back, and SAY so, so a column
  // never silently mixes the two.
  const without = lineView({ l: 1, p: 0.6, a: null, m: 0.5, b: [[0, -110, -110]] }, books, { useCorrected: true });
  assert.equal(without.p, 0.6);
  assert.equal(without.corrected, false);
});

test("bestEdge reports the better side, tolerating a missing one", () => {
  assert.deepEqual(bestEdge({ edgeOver: 0.05, edgeUnder: -0.02 }), { side: "over", edge: 0.05 });
  assert.deepEqual(bestEdge({ edgeOver: -0.05, edgeUnder: 0.01 }), { side: "under", edge: 0.01 });
  assert.deepEqual(bestEdge({ edgeOver: null, edgeUnder: 0.03 }), { side: "under", edge: 0.03 });
  assert.equal(bestEdge({ edgeOver: null, edgeUnder: null }), null);
});

const roster = [
  { id: "1", name: "Amon-Ra St. Brown", team: "DET" },
  { id: "2", name: "José Ramírez", team: "CLE" },
  { id: "3", name: "Josh Allen", team: "BUF" },
  { id: "4", name: "Josh Jacobs", team: "GB" },
  { id: "5", name: "Brown Runner", team: "GB" },
];

test("searchPlayers matches word starts, ignores accents and punctuation", () => {
  assert.deepEqual(searchPlayers(roster, "amon ra").map((p) => p.id), ["1"]);
  assert.deepEqual(searchPlayers(roster, "st brown").map((p) => p.id), ["1"]);
  assert.deepEqual(searchPlayers(roster, "jose").map((p) => p.id), ["2"]);
  assert.deepEqual(searchPlayers(roster, "josh").map((p) => p.id), ["3", "4"]);
});

test("searchPlayers needs every word to match, and finds by team", () => {
  assert.deepEqual(searchPlayers(roster, "josh allen").map((p) => p.id), ["3"]);
  assert.deepEqual(searchPlayers(roster, "josh buf").map((p) => p.id), ["3"]);
  assert.deepEqual(searchPlayers(roster, "gb").map((p) => p.id).sort(), ["4", "5"]);
  assert.deepEqual(searchPlayers(roster, "zzz"), []);
});

test("searchPlayers ranks a name that starts with the query first, and is stable", () => {
  // "brown" starts one name and is only the surname of another.
  assert.deepEqual(searchPlayers(roster, "brown").map((p) => p.id), ["5", "1"]);
  assert.deepEqual(searchPlayers(roster, "brown"), searchPlayers(roster, "brown"));
  assert.deepEqual(searchPlayers(roster, ""), []);
  assert.deepEqual(searchPlayers(roster, "   "), []);
  assert.equal(searchPlayers(roster, "j", 2).length, 2);
});

test("formatOdds signs positive prices and survives a missing one", () => {
  assert.equal(formatOdds(110), "+110");
  assert.equal(formatOdds(-110), "-110");
  assert.equal(formatOdds(null), "—");
  assert.equal(formatOdds(undefined), "—");
});

test("inPlay hides the far tails and keeps what could be decided on", () => {
  assert.equal(inPlay({ m: 0.5, p: 0.5 }), true);
  assert.equal(inPlay({ m: 0.9, p: 0.5 }), true);
  assert.equal(inPlay({ m: 0.97, p: 0.5 }), false);
  assert.equal(inPlay({ m: 0.02, p: 0.5 }), false);
  // The bounds are inclusive: a 5% / 95% market is still in play.
  assert.equal(inPlay({ m: IN_PLAY_MIN }), true);
  assert.equal(inPlay({ m: IN_PLAY_MAX }), true);
});

test("inPlay judges by the market, falls back to ours, and never hides the unknown", () => {
  // The books' price decides, not ours: our 50% on a line they price at 98%
  // does not make it a line in play.
  assert.equal(inPlay({ m: 0.98, p: 0.5 }), false);
  // No market price: ours decides.
  assert.equal(inPlay({ m: null, p: 0.99 }), false);
  assert.equal(inPlay({ m: null, p: 0.4 }), true);
  // Neither: hiding what we know nothing about would be the wrong way to tidy.
  assert.equal(inPlay({ m: null, p: null }), true);
  assert.equal(inPlay({}), true);
  assert.equal(inPlay(undefined), true);
});
