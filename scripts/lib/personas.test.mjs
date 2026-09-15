import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERSONAS,
  PERSONA_BY_ID,
  STARTING_BANKROLL_UNITS,
  expectedValue,
  eligible,
  rank,
  diversify,
  stake,
  dedupe,
  simulateWeek,
  advanceBankroll,
  weeklyCapacity,
} from "./personas.mjs";

// A candidate edge, shaped like a row of data/edges/.
const edge = (o = {}) => ({
  playerId: "1",
  name: "Player One",
  team: "CIN",
  opp: "vs TB",
  fixtureId: "FX1",
  stat: "passYds",
  book: "draftkings",
  line: 249.5,
  side: "over",
  odds: -110,
  ourProb: 0.58,
  edge: 0.06,
  modelEdge: 0.08,
  oneSided: false,
  maxStake: 500,
  ...o,
});

// ---- Expected value ----------------------------------------------------------
test("expected value is profit per unit staked at the offered price", () => {
  // 58% at -110: 0.58 * 0.909… - 0.42
  assert.ok(Math.abs(expectedValue(0.58, -110) - (0.58 * (100 / 110) - 0.42)) < 1e-9);
  // Break-even at exactly the implied probability.
  assert.ok(Math.abs(expectedValue(110 / 210, -110)) < 1e-9);
  assert.equal(expectedValue(0.5, 0), null);
});

test("the same edge is worth more on a longshot than a favourite", () => {
  // This is why `top-ev` and `top-edge` rank differently: +300 with a 5-point
  // edge returns far more per unit than -300 with the same 5 points.
  const longshot = expectedValue(0.30, 300); // implied 25%, edge 5pts
  const favourite = expectedValue(0.80, -300); // implied 75%, edge 5pts
  assert.ok(longshot > favourite);
});

// ---- Eligibility -------------------------------------------------------------
test("a persona only sees its own books", () => {
  const edges = [edge({ book: "draftkings" }), edge({ book: "fanduel" })];
  const pool = eligible(edges, { books: ["draftkings"], minEdge: 0 });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].book, "draftkings");
});

test("book matching is case-insensitive", () => {
  const pool = eligible([edge({ book: "DraftKings" })], { books: ["draftkings"], minEdge: 0 });
  assert.equal(pool.length, 1);
});

test("the edge bar filters on the persona's chosen basis", () => {
  const e = edge({ edge: 0.02, modelEdge: 0.06 });
  assert.equal(eligible([e], { minEdge: 0.03 }).length, 0, "EV edge is below the bar");
  assert.equal(eligible([e], { minEdge: 0.03, edgeBasis: "novig" }).length, 1, "model edge clears it");
});

test("requireTwoSided drops markets that could not be de-vigged", () => {
  const edges = [edge({ oneSided: false }), edge({ oneSided: true })];
  assert.equal(eligible(edges, { minEdge: 0, requireTwoSided: true }).length, 1);
  assert.equal(eligible(edges, { minEdge: 0 }).length, 2);
});

test("a persona can require real betting limits", () => {
  // An edge only available at a $10 max is not a strategy.
  const edges = [edge({ maxStake: 10 }), edge({ maxStake: 1000 }), edge({ maxStake: null })];
  const pool = eligible(edges, { minEdge: 0, minLimit: 100 });
  assert.equal(pool.length, 2, "unknown limits are kept; known-tiny ones are dropped");
  assert.ok(!pool.some((e) => e.maxStake === 10));
});

test("an unusable price is never eligible", () => {
  assert.equal(eligible([edge({ odds: 0 })], { minEdge: 0 }).length, 0);
  assert.equal(eligible([edge({ edge: null })], { minEdge: 0 }).length, 0);
});

// ---- Ranking -----------------------------------------------------------------
test("top-edge and top-ev order differently", () => {
  const edges = [
    edge({ playerId: "fav", odds: -300, ourProb: 0.80, edge: 0.05 }),
    edge({ playerId: "dog", odds: 300, ourProb: 0.30, edge: 0.05 }),
  ];
  assert.equal(rank(edges, { select: "top-ev" })[0].playerId, "dog");
  // Equal edges: top-edge falls through to a stable tie-break, not randomness.
  const a = rank(edges, { select: "top-edge" });
  const b = rank([...edges].reverse(), { select: "top-edge" });
  assert.deepEqual(a.map((e) => e.playerId), b.map((e) => e.playerId));
});

test("ranking is stable across re-runs", () => {
  const edges = [edge({ playerId: "a" }), edge({ playerId: "b" }), edge({ playerId: "c" })];
  const once = rank(edges, {}).map((e) => e.playerId);
  const twice = rank([...edges].reverse(), {}).map((e) => e.playerId);
  assert.deepEqual(once, twice, "a re-run must produce the same ledger");
});

// ---- Diversification ---------------------------------------------------------
test("maxPerPlayer stops correlated bets on one player", () => {
  // Over Rushing Yards and Anytime TD on the same back win and lose together.
  // Taking both overstates return and understates variance.
  const edges = [
    edge({ playerId: "rb1", stat: "rushYds", edge: 0.09 }),
    edge({ playerId: "rb1", stat: "anytimeTD", edge: 0.08 }),
    edge({ playerId: "wr1", stat: "recYds", edge: 0.07 }),
  ];
  const taken = diversify(rank(edges, {}), { diversify: { maxPerPlayer: 1 } });
  assert.equal(taken.length, 2);
  assert.equal(taken.filter((e) => e.playerId === "rb1").length, 1);
  assert.equal(taken[0].stat, "rushYds", "keeps the bigger edge of the pair");
});

test("maxPerGame caps exposure to one result", () => {
  const edges = Array.from({ length: 5 }, (_, i) =>
    edge({ playerId: `p${i}`, fixtureId: "FX1", edge: 0.09 - i * 0.01 })
  );
  const taken = diversify(rank(edges, {}), { diversify: { maxPerGame: 2 } });
  assert.equal(taken.length, 2);
});

test("maxBetsPerWeek caps the slate", () => {
  const edges = Array.from({ length: 30 }, (_, i) =>
    edge({ playerId: `p${i}`, fixtureId: `FX${i}`, edge: 0.09 })
  );
  assert.equal(diversify(rank(edges, {}), { maxBetsPerWeek: 10 }).length, 10);
});

test("with no constraints everything is taken", () => {
  const edges = [edge({ playerId: "a" }), edge({ playerId: "b" })];
  assert.equal(diversify(edges, {}).length, 2);
});

// ---- Staking -----------------------------------------------------------------
test("flat staking puts the same amount on every bet", () => {
  const bets = stake([edge(), edge({ odds: 300 })], { staking: { kind: "flat", units: 1 } }, 100);
  assert.deepEqual(bets.map((b) => b.stakeUnits), [1, 1]);
});

test("kelly stakes more on a bigger edge and respects the cap", () => {
  const persona = { staking: { kind: "kelly", fraction: 0.25, cap: 0.03 }, bankroll: { kind: "compounding" } };
  const small = stake([edge({ ourProb: 0.55, edge: 0.03 })], persona, 100)[0].stakeUnits;
  const big = stake([edge({ ourProb: 0.80, edge: 0.28 })], persona, 100)[0].stakeUnits;
  assert.ok(big > small);
  assert.ok(big <= 3.0001, "cap of 3% of a 100-unit bankroll is 3 units");
});

test("kelly scales with a compounding bankroll", () => {
  const persona = { staking: { kind: "kelly", fraction: 0.25, cap: 0.03 }, bankroll: { kind: "compounding" } };
  const atStart = stake([edge()], persona, 100)[0].stakeUnits;
  const afterGrowth = stake([edge()], persona, 200)[0].stakeUnits;
  assert.ok(afterGrowth > atStart, "a bigger bankroll means bigger absolute stakes");
  assert.ok(Math.abs(afterGrowth - 2 * atStart) < 1e-6, "and proportionally so");
});

test("tiered staking steps up with edge size", () => {
  const persona = { staking: { kind: "tiered" } };
  const bets = stake(
    [edge({ edge: 0.12 }), edge({ edge: 0.07 }), edge({ edge: 0.035 })],
    persona,
    100
  );
  assert.deepEqual(bets.map((b) => b.stakeUnits), [3, 2, 1]);
});

test("proportional staking commits the whole budget, split by edge", () => {
  const persona = { staking: { kind: "proportional" }, bankroll: { kind: "weekly-budget", units: 20 } };
  const bets = stake([edge({ edge: 0.06 }), edge({ edge: 0.02 })], persona, 100);
  const total = bets.reduce((s, b) => s + b.stakeUnits, 0);
  assert.ok(Math.abs(total - 20) < 1e-6, "the full budget goes out");
  assert.ok(bets[0].stakeUnits > bets[1].stakeUnits);
  assert.ok(Math.abs(bets[0].stakeUnits - 15) < 1e-6, "3:1 edge ratio -> 3:1 stake ratio");
});

test("a week that would exceed its budget scales down rather than dropping bets", () => {
  // Keeping the selection intact matters: we want to know how the persona's
  // CHOICES performed, not how a ceiling happened to truncate them.
  const persona = { staking: { kind: "flat", units: 5 }, bankroll: { kind: "weekly-budget", units: 10 } };
  const bets = stake([edge(), edge(), edge(), edge()], persona, 100);
  assert.equal(bets.length, 4, "all four bets survive");
  const total = bets.reduce((s, b) => s + b.stakeUnits, 0);
  assert.ok(Math.abs(total - 10) < 1e-6);
  assert.ok(Math.abs(bets[0].scaledBy - 0.5) < 1e-6);
});

test("a week within budget is not scaled", () => {
  const persona = { staking: { kind: "flat", units: 1 }, bankroll: { kind: "weekly-budget", units: 10 } };
  const bets = stake([edge(), edge()], persona, 100);
  assert.equal(bets[0].scaledBy, 1);
});

test("a flat-bankroll persona has unlimited weekly capacity", () => {
  assert.equal(weeklyCapacity({ bankroll: { kind: "flat" } }, 100), Infinity);
  assert.equal(weeklyCapacity({ bankroll: { kind: "weekly-budget", units: 20 } }, 100), 20);
  assert.equal(weeklyCapacity({ bankroll: { kind: "compounding" } }, 137), 137);
});

// ---- Bankroll rollover -------------------------------------------------------
test("only a compounding bankroll moves between weeks", () => {
  const compounding = { bankroll: { kind: "compounding" } };
  assert.equal(advanceBankroll(compounding, 100, 12.5), 112.5);
  assert.equal(advanceBankroll(compounding, 100, -8), 92);

  for (const kind of ["weekly-budget", "flat"]) {
    assert.equal(advanceBankroll({ bankroll: { kind, units: 10 } }, 100, 25), 100);
  }
});

test("a bankroll cannot go negative", () => {
  assert.equal(advanceBankroll({ bankroll: { kind: "compounding" } }, 10, -50), 0);
});

// ---- End to end --------------------------------------------------------------
test("simulateWeek applies filter, rank, diversify and stake together", () => {
  const edges = [
    edge({ playerId: "a", book: "draftkings", edge: 0.09 }),
    edge({ playerId: "a", book: "draftkings", stat: "anytimeTD", edge: 0.08 }), // same player
    edge({ playerId: "b", book: "fanduel", edge: 0.10 }), // wrong book
    edge({ playerId: "c", book: "draftkings", edge: 0.01 }), // under the bar
    edge({ playerId: "d", book: "draftkings", fixtureId: "FX2", edge: 0.05 }),
  ];
  const bets = simulateWeek(edges, {
    books: ["draftkings"],
    minEdge: 0.03,
    maxBetsPerWeek: 5,
    diversify: { maxPerPlayer: 1 },
    staking: { kind: "flat", units: 1 },
    bankroll: { kind: "flat" },
  });
  assert.deepEqual(bets.map((b) => b.playerId), ["a", "d"]);
  assert.deepEqual(bets.map((b) => b.stakeUnits), [1, 1]);
});

test("a week with no qualifying edges produces no bets, not an error", () => {
  assert.deepEqual(simulateWeek([], PERSONA_BY_ID.get("firehose")), []);
  assert.deepEqual(simulateWeek(null, PERSONA_BY_ID.get("firehose")), []);
});

// ---- The roster --------------------------------------------------------------
test("every persona is well formed", () => {
  const ids = new Set();
  for (const p of PERSONAS) {
    assert.ok(p.id && !ids.has(p.id), `duplicate or missing id: ${p.id}`);
    ids.add(p.id);
    assert.ok(p.label && p.description, `${p.id} needs a label and description`);
    assert.ok(["flat", "kelly", "proportional", "tiered"].includes(p.staking.kind));
    assert.ok(["weekly-budget", "compounding", "flat"].includes(p.bankroll.kind));
    if (p.bankroll.kind === "weekly-budget") {
      assert.ok(p.bankroll.units > 0, `${p.id} needs a weekly budget`);
    }
  }
});

test("every persona can run a week without throwing", () => {
  const edges = Array.from({ length: 40 }, (_, i) =>
    edge({
      playerId: `p${i}`,
      fixtureId: `FX${i % 8}`,
      book: ["draftkings", "fanduel", "betmgm"][i % 3],
      edge: 0.03 + (i % 10) / 100,
      modelEdge: 0.05 + (i % 10) / 100,
      oneSided: i % 4 === 0,
    })
  );
  for (const p of PERSONAS) {
    const bets = simulateWeek(edges, p, STARTING_BANKROLL_UNITS);
    assert.ok(Array.isArray(bets), `${p.id} should return bets`);
    for (const b of bets) assert.ok(b.stakeUnits > 0, `${p.id} staked a non-positive amount`);
    if (p.maxBetsPerWeek) assert.ok(bets.length <= p.maxBetsPerWeek, `${p.id} exceeded its slate`);
  }
});

test("the shopper and the single-book bettor differ only in book access", () => {
  // The pair exists to isolate what line shopping is worth, so nothing else
  // about them may drift apart.
  const shopper = PERSONA_BY_ID.get("shopper");
  const disciplined = PERSONA_BY_ID.get("disciplined");
  assert.equal(shopper.books, undefined, "the shopper reaches every book");
  assert.deepEqual(disciplined.books, ["draftkings"]);
  for (const key of ["minEdge", "maxBetsPerWeek", "select"]) {
    assert.deepEqual(shopper[key], disciplined[key], `${key} must match`);
  }
  assert.deepEqual(shopper.diversify, disciplined.diversify);
  assert.deepEqual(shopper.staking, disciplined.staking);
});

test("the purist is the only persona demanding a de-viggable market", () => {
  assert.equal(PERSONA_BY_ID.get("purist").requireTwoSided, true);
  assert.equal(PERSONA_BY_ID.get("purist").edgeBasis, "novig");
  const others = PERSONAS.filter((p) => p.id !== "purist");
  assert.ok(others.every((p) => !p.requireTwoSided));
});

// ---- Deduplication -----------------------------------------------------------
// The edge set carries a row per (player, stat, book, line, side). A bettor
// does not place the same wager at five books — that is one bet at the best
// number. Without this step the ledger fills with perfectly correlated
// duplicates and every count, stake and return is inflated.
test("one player-stat collapses to a single bet at the best price", () => {
  const edges = [
    edge({ playerId: "p1", stat: "passYds", book: "draftkings", edge: 0.04, odds: -110 }),
    edge({ playerId: "p1", stat: "passYds", book: "fanduel", edge: 0.07, odds: 100 }),
    edge({ playerId: "p1", stat: "passYds", book: "betmgm", edge: 0.05, odds: -105 }),
  ];
  const bets = simulateWeek(edges, { minEdge: 0, staking: { kind: "flat", units: 1 }, bankroll: { kind: "flat" } });
  assert.equal(bets.length, 1);
  assert.equal(bets[0].book, "fanduel", "keeps the best-priced quote");
});

test("different stats on one player are still separate bets", () => {
  const edges = [
    edge({ playerId: "p1", stat: "passYds" }),
    edge({ playerId: "p1", stat: "passTD" }),
  ];
  const bets = simulateWeek(edges, { minEdge: 0, staking: { kind: "flat", units: 1 }, bankroll: { kind: "flat" } });
  assert.equal(bets.length, 2, "maxPerPlayer, not dedupe, is what limits these");
});

test("multiple lines at one book collapse too", () => {
  // Over 249.5 and Over 259.5 are alternatives, not additive positions.
  const edges = [
    edge({ playerId: "p1", stat: "passYds", line: 249.5, edge: 0.04 }),
    edge({ playerId: "p1", stat: "passYds", line: 259.5, edge: 0.09 }),
  ];
  const bets = simulateWeek(edges, { minEdge: 0, staking: { kind: "flat", units: 1 }, bankroll: { kind: "flat" } });
  assert.equal(bets.length, 1);
  assert.equal(bets[0].line, 259.5);
});

test("dedupe runs after the book filter, so it picks the best REACHABLE price", () => {
  // This is what makes shopper-vs-single-book measure line shopping: the
  // single-book persona must collapse to its own book's best, not the global
  // best it cannot reach.
  const edges = [
    edge({ playerId: "p1", book: "draftkings", edge: 0.04, odds: -110 }),
    edge({ playerId: "p1", book: "fanduel", edge: 0.09, odds: 120 }),
  ];
  const single = simulateWeek(edges, {
    books: ["draftkings"], minEdge: 0, staking: { kind: "flat", units: 1 }, bankroll: { kind: "flat" },
  });
  const shopper = simulateWeek(edges, {
    minEdge: 0, staking: { kind: "flat", units: 1 }, bankroll: { kind: "flat" },
  });
  assert.equal(single[0].book, "draftkings");
  assert.equal(single[0].odds, -110);
  assert.equal(shopper[0].book, "fanduel");
  assert.ok(shopper[0].edge > single[0].edge, "shopping finds the better number");
});

test("dedupe can be turned off for research", () => {
  const edges = [
    edge({ playerId: "p1", book: "draftkings" }),
    edge({ playerId: "p1", book: "fanduel" }),
  ];
  const bets = simulateWeek(edges, {
    minEdge: 0, dedupe: false, staking: { kind: "flat", units: 1 }, bankroll: { kind: "flat" },
  });
  assert.equal(bets.length, 2);
});
