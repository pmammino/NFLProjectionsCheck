import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECTION_SOURCE,
  PRIOR_WEIGHT,
  MIN_WEIGHT,
  MAX_DEVIATION,
  sourceKey,
  bookOfSource,
  bookVotes,
  weightOf,
  weightedConsensusProb,
  poolVotes,
  buildLeadPairs,
  leadObservations,
  leadStats,
  assessSources,
  fitSourceWeights,
  weightsAsOf,
} from "./source-weights.mjs";
import { consensusProb, logit, sigmoid } from "./consensus.mjs";
import { devigTwoWay } from "./devig.mjs";

// A deterministic stream, so a failing case is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

// American odds for a fair probability with a flat 4.5% margin on each side.
function twoSided(pOver, vig = 0.045) {
  // A margin on a 96% side would imply more than 100%, which no book prints:
  // cap the implied probability the way a real price board does.
  const o = Math.min(0.995, pOver * (1 + vig));
  const u = Math.min(0.995, (1 - pOver) * (1 + vig));
  const toAm = (p) => (p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));
  return { overOdds: toAm(o), underOdds: toAm(u) };
}
const oneSided = (pOver, vig = 0.07) => {
  const p = pOver * (1 + vig);
  return { overOdds: p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p), underOdds: null };
};

const row = (book, pOver) => ({ book, ...twoSided(pOver) });

// ---------------------------------------------------------------------------
// keys and votes
// ---------------------------------------------------------------------------

test("a source is a book AND whether it was measured", () => {
  assert.equal(sourceKey("DraftKings", true), "draftkings:2");
  assert.equal(sourceKey("DraftKings", false), "draftkings:1");
  assert.equal(bookOfSource("draftkings:2"), "draftkings");
});

test("aliases of one book are one source", () => {
  // 2026 week 1 wrote "mgm", later weeks "BetMGM"; two track records for one
  // operator would be two votes and neither well measured.
  assert.equal(sourceKey("mgm", true), sourceKey("BetMGM", true));
  assert.equal(sourceKey("Hard Rock", true), sourceKey("hardrockbet", true));
  const votes = bookVotes([row("mgm", 0.5), row("BetMGM", 0.6)]);
  assert.equal(votes.length, 1, "one vote per book, first row wins");
  assert.ok(Math.abs(votes[0].logit) < 0.1);
});

test("bookVotes marks a one-sided quote as inferred and a two-sided as measured", () => {
  const votes = bookVotes([row("DraftKings", 0.5), { book: "FanDuel", ...oneSided(0.5) }]);
  const by = Object.fromEntries(votes.map((v) => [v.book, v]));
  assert.equal(by.draftkings.twoSided, true);
  assert.equal(by.fanduel.twoSided, false);
  assert.equal(by.fanduel.key, "fanduel:1");
});

test("an Under-only quote is mirrored into an Over probability, not dropped", () => {
  const under = bookVotes([{ book: "FanDuel", overOdds: null, underOdds: -150 }]);
  const over = bookVotes([{ book: "FanDuel", overOdds: 130, underOdds: null }]);
  assert.equal(under.length, 1);
  // -150 on the Under means the Over is the underdog.
  assert.ok(under[0].logit < 0);
  assert.ok(over[0].logit < 0);
});

test("bookVotes ignores books outside the requested set", () => {
  const rows = [row("DraftKings", 0.5), row("Pinnacle", 0.5)];
  assert.equal(bookVotes(rows, { setName: "retail" }).length, 1);
  assert.equal(bookVotes(rows, { setName: "all" }).length, 2);
});

// ---------------------------------------------------------------------------
// the weighted consensus
// ---------------------------------------------------------------------------

test("with equal weights it is the mean of the logits, within the clipping distance", () => {
  const rows = [row("DraftKings", 0.45), row("FanDuel", 0.5), row("Caesars", 0.55)];
  const got = weightedConsensusProb(rows, { weights: {} });
  const votes = bookVotes(rows);
  const mean = votes.reduce((a, v) => a + v.logit, 0) / votes.length;
  assert.ok(Math.abs(got.prob - sigmoid(mean)) < 1e-9);
});

test("weighting moves the consensus toward the heavier book and away from the lighter", () => {
  const rows = [row("Pinnacle", 0.6), row("DraftKings", 0.5), row("FanDuel", 0.5)];
  const equal = weightedConsensusProb(rows, { weights: {} }).prob;
  const heavy = weightedConsensusProb(rows, { weights: { "pinnacle:2": 0.9, "draftkings:2": 0.05, "fanduel:2": 0.05 } }).prob;
  assert.ok(heavy > equal, "more weight on the high book raises it");
  assert.ok(heavy < 0.6 + 1e-9 && heavy > 0.55, `and it lands near Pinnacle, got ${heavy}`);
});

test("the unweighted median is reported alongside, so a report can show how far weighting moved it", () => {
  const rows = [row("Pinnacle", 0.6), row("DraftKings", 0.5), row("FanDuel", 0.5)];
  const got = weightedConsensusProb(rows, { weights: { "pinnacle:2": 0.9 } });
  const ref = consensusProb(rows.map((r) => ({ ...r })), { side: "over", setName: "all" });
  assert.ok(Math.abs(got.unweighted - ref.prob) < 1e-9);
  assert.equal(got.bookCount, 3);
  assert.equal(got.probSource, "devig");
});

test("one wild price cannot drag a weighted mean further than MAX_DEVIATION from the median", () => {
  // A median shrugs this off; a mean would not. Bounding it keeps the weighted
  // consensus as robust as the one it replaces to a stale or flipped line.
  const rows = [row("DraftKings", 0.5), row("FanDuel", 0.5), row("Caesars", 0.5), row("Pinnacle", 0.97)];
  const w = { "pinnacle:2": 5 };
  const got = weightedConsensusProb(rows, { weights: w }).prob;
  assert.ok(got <= sigmoid(MAX_DEVIATION) + 1e-9, `got ${got}`);
});

test("a market with no usable book price has no consensus, even with a projection", () => {
  // The projection is a vote, not a market: it must never manufacture a
  // "market" price out of nothing.
  assert.equal(weightedConsensusProb([], { projectionProb: 0.7, weights: { [PROJECTION_SOURCE]: 1 } }), null);
  assert.equal(weightedConsensusProb([{ book: "DraftKings", overOdds: null, underOdds: null }], { projectionProb: 0.7 }), null);
});

test("the projection carries no weight until it has earned some", () => {
  const rows = [row("DraftKings", 0.5), row("FanDuel", 0.5), row("Caesars", 0.5)];
  const without = weightedConsensusProb(rows, {}).prob;
  const withIt = weightedConsensusProb(rows, { projectionProb: 0.9 });
  assert.equal(withIt.prob, without, "default weight is zero");
  assert.equal(withIt.projectionShare, 0);
  const earned = weightedConsensusProb(rows, { projectionProb: 0.9, weights: { [PROJECTION_SOURCE]: 0.15 } });
  assert.ok(earned.prob > without);
  assert.ok(earned.projectionShare > 0.2 && earned.projectionShare < 0.3, `share ${earned.projectionShare}`);
});

test("the projection is bounded by what the books say, so a broken projection cannot blow up a price", () => {
  // The passTD failure: a projection that is confident far from the market.
  // Even with a large weight it can only pull MAX_DEVIATION away from the books.
  const rows = [row("DraftKings", 0.04), row("FanDuel", 0.04), row("Caesars", 0.04)];
  const got = weightedConsensusProb(rows, { projectionProb: 0.99, weights: { [PROJECTION_SOURCE]: 5 } }).prob;
  assert.ok(got < sigmoid(logit(0.04) + MAX_DEVIATION) + 1e-6, `got ${got}`);
});

test("weightOf: books fall back to the prior, the projection to zero, and a floor holds", () => {
  assert.equal(weightOf({}, "draftkings:2"), PRIOR_WEIGHT);
  assert.equal(weightOf({}, PROJECTION_SOURCE), 0);
  assert.equal(weightOf({ "draftkings:2": 0 }, "draftkings:2"), MIN_WEIGHT);
  assert.equal(weightOf({ "draftkings:2": -3 }, "draftkings:2"), MIN_WEIGHT);
  assert.equal(weightOf({ [PROJECTION_SOURCE]: -1 }, PROJECTION_SOURCE), 0);
});

test("effectiveSources falls as one book takes over", () => {
  const rows = [row("DraftKings", 0.5), row("FanDuel", 0.5), row("Caesars", 0.5), row("Pinnacle", 0.5)];
  const eq = weightedConsensusProb(rows, { weights: {} }).effectiveSources;
  const concentrated = weightedConsensusProb(rows, { weights: { "pinnacle:2": 5 } }).effectiveSources;
  assert.ok(Math.abs(eq - 4) < 1e-9);
  assert.ok(concentrated < 2);
});

// ---------------------------------------------------------------------------
// assessment: lead
// ---------------------------------------------------------------------------

// A world where the true price T drifts between an early board and the close.
// `sources` gives each book's early noise (sd, in logit); a book with sd 0 knows
// the close. `sticky` books do not move between boards. Returns lead pairs.
function world({ n = 600, sources, sticky = [], seed = 7, week = 1, projection = null }) {
  const r = rng(seed);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const Tclose = gauss(r) * 0.3; // true close, logit
    const common = gauss(r) * 0.15; // what everybody gets wrong early
    const early = [];
    const late = [];
    for (const [book, sd] of Object.entries(sources)) {
      const e = Tclose + common + gauss(r) * sd - 0; // early price: a noisy view of the close
      const lateL = sticky.includes(book) ? e : Tclose + gauss(r) * 0.02;
      early.push({ book, key: sourceKey(book, true), twoSided: true, logit: e });
      late.push({ book, key: sourceKey(book, true), twoSided: true, logit: lateL });
    }
    pairs.push({
      week,
      slot: "opening",
      stat: "recYds",
      cluster: `${week}|${i}`,
      early,
      late,
      projection: projection ? sigmoid(Tclose + common + gauss(r) * projection) : null,
    });
  }
  return pairs;
}

test("a source that already knows where the market is going has a high lead; a noisy one a low lead", () => {
  const pairs = world({ sources: { sharp: 0.02, a: 0.3, b: 0.3, c: 0.3, noisy: 0.9 } });
  const got = assessSources(pairs);
  assert.ok(got["sharp:2"].lead > 0.5, `sharp ${got["sharp:2"].lead}`);
  assert.ok(got["noisy:2"].lead < 0.15, `noisy ${got["noisy:2"].lead}`);
  assert.ok(got["sharp:2"].lead > got["a:2"].lead && got["a:2"].lead > got["noisy:2"].lead);
  assert.ok(got["sharp:2"].z > 5);
});

test("a book whose price never moves does not 'lead' just because its own close is in the target", () => {
  // The bias the header warns about. If the target included the book itself, a
  // frozen price would be rewarded for agreeing with itself. It is compared with
  // OTHER books' later prices only, so a frozen noisy book scores like any noisy
  // book.
  const pairs = world({ sources: { sharp: 0.05, a: 0.3, b: 0.3, c: 0.3, frozen: 0.9 }, sticky: ["frozen"] });
  const got = assessSources(pairs);
  assert.ok(got["frozen:2"].lead < 0.15, `frozen ${got["frozen:2"].lead}`);
});

test("a source is excluded from its own comparison, in both medians", () => {
  const early = [
    { book: "x", key: "x:2", twoSided: true, logit: 0.5 },
    { book: "a", key: "a:2", twoSided: true, logit: 0.0 },
    { book: "b", key: "b:2", twoSided: true, logit: 0.0 },
  ];
  const late = [
    { book: "x", key: "x:2", twoSided: true, logit: 9 }, // would wreck the target if x were in it
    { book: "a", key: "a:2", twoSided: true, logit: 0.2 },
    { book: "b", key: "b:2", twoSided: true, logit: 0.2 },
  ];
  const obs = leadObservations([{ week: 1, slot: "opening", stat: "s", cluster: "c", early, late, projection: null }]);
  assert.deepEqual(obs.get("x:2"), [{ x: 0.5, y: 0.2, cluster: "c" }]);
});

test("too few other books means no observation, rather than a lead against nothing", () => {
  const early = [
    { book: "x", key: "x:2", twoSided: true, logit: 0.5 },
    { book: "a", key: "a:2", twoSided: true, logit: 0 },
  ];
  const late = [
    { book: "x", key: "x:2", twoSided: true, logit: 0 },
    { book: "a", key: "a:2", twoSided: true, logit: 0.1 },
  ];
  const obs = leadObservations([{ week: 1, slot: "opening", stat: "s", cluster: "c", early, late, projection: null }]);
  assert.equal(obs.size, 0, "one other book is not a market");
});

test("markets deep in the tail are left out of the assessment", () => {
  const mk = (l) => [
    { book: "x", key: "x:2", twoSided: true, logit: l + 0.3 },
    { book: "a", key: "a:2", twoSided: true, logit: l },
    { book: "b", key: "b:2", twoSided: true, logit: l },
    { book: "c", key: "c:2", twoSided: true, logit: l },
  ];
  const pairs = [
    { week: 1, slot: "opening", stat: "s", cluster: "near", early: mk(0), late: mk(0.1), projection: null },
    { week: 1, slot: "opening", stat: "s", cluster: "tail", early: mk(3.5), late: mk(3.6), projection: null },
  ];
  const obs = leadObservations(pairs).get("x:2");
  assert.equal(obs.length, 1);
  assert.equal(obs[0].cluster, "near");
});

test("leadStats clusters its errors: many rungs of one ladder are not many observations", () => {
  const one = [];
  for (let i = 0; i < 40; i++) one.push({ x: 0.2, y: 0.05 * (i % 2 ? 1 : -1) + 0.05, cluster: "same" });
  const many = one.map((o, i) => ({ ...o, cluster: `c${i}` }));
  const a = leadStats(one);
  const b = leadStats(many);
  assert.equal(a.clusters, 1);
  assert.equal(b.clusters, 40);
  assert.ok(Math.abs(a.lead - b.lead) < 1e-12, "same slope");
  // One cluster supports an estimate of the slope and none of its uncertainty:
  // the formula would return an error of exactly zero, and an infinite z.
  assert.equal(a.se, null);
  assert.equal(a.z, null);
  assert.ok(Number.isFinite(b.se) && b.se > 0);
});

test("leadStats on degenerate input returns nulls, not NaN", () => {
  assert.deepEqual(leadStats([]), { n: 0, clusters: 0, lead: null, se: null, z: null });
  assert.equal(leadStats([{ x: 0, y: 1, cluster: "a" }, { x: 0, y: 2, cluster: "b" }]).lead, null);
});

// ---------------------------------------------------------------------------
// the projection as a source
// ---------------------------------------------------------------------------

test("a projection that knows nothing the market does not gets a lead near zero", () => {
  const pairs = world({ sources: { a: 0.3, b: 0.3, c: 0.3 }, projection: 0.8 });
  const got = assessSources(pairs)[PROJECTION_SOURCE];
  assert.ok(got.lead < 0.15, `lead ${got.lead}`);
});

test("a projection that does lead the market earns a lead, assessed exactly as a book is", () => {
  const pairs = world({ sources: { a: 0.4, b: 0.4, c: 0.4 }, projection: 0.02 });
  const got = assessSources(pairs)[PROJECTION_SOURCE];
  assert.ok(got.lead > 0.3 && got.z > 5, `lead ${got.lead} z ${got.z}`);
});

test("a pair with no projection contributes nothing to the projection's record", () => {
  const pairs = world({ sources: { a: 0.3, b: 0.3, c: 0.3 }, projection: null });
  assert.equal(assessSources(pairs)[PROJECTION_SOURCE], undefined);
});

// ---------------------------------------------------------------------------
// building pairs from captures: point in time
// ---------------------------------------------------------------------------

function quote({ book, slot, week = 2, playerId = "p1", stat = "recYds", line = 50.5, pOver = 0.5, probOver = 0.6, lineSource }) {
  return { book, slot, week, playerId, stat, line, ...twoSided(pOver), probOver, lineSource };
}
const board = (slot, pOver, extra = {}) =>
  ["DraftKings", "FanDuel", "Caesars"].map((book) => quote({ book, slot, pOver, ...extra }));

test("a pair needs a closing board; an early board alone is not an assessment", () => {
  const pairs = buildLeadPairs(board("opening", 0.5, { lineSource: "opening" }));
  assert.equal(pairs.length, 0);
});

test("early and late boards of the same market are paired, one pair per early slot", () => {
  const quotes = [
    ...board("opening", 0.5, { lineSource: "opening" }),
    ...board("main", 0.5, { lineSource: "live" }),
    ...board("closing", 0.55, { lineSource: "closing" }),
  ];
  const pairs = buildLeadPairs(quotes);
  assert.deepEqual(pairs.map((p) => p.slot).sort(), ["main", "opening"]);
  assert.ok(pairs.every((p) => p.cluster === "2|p1" && p.late.length === 3));
  assert.deepEqual(buildLeadPairs(quotes, { earlySlots: ["main"] }).map((p) => p.slot), ["main"]);
});

test("the projection is withheld from a reconstructed board and kept on a live one", () => {
  // A backfilled board is priced from the week's LATEST snapshot. Using it would
  // credit the projection with news it only acquired after the market had it.
  const quotes = [
    ...board("opening", 0.5, { lineSource: "opening", probOver: 0.7 }),
    ...board("main", 0.5, { lineSource: "live", probOver: 0.7 }),
    ...board("thursday", 0.5, { lineSource: "", probOver: 0.7 }), // legacy week-1 rows carry no source
    ...board("closing", 0.5, { lineSource: "closing" }),
  ];
  const bySlot = Object.fromEntries(buildLeadPairs(quotes).map((p) => [p.slot, p]));
  assert.equal(bySlot.opening.projection, null);
  assert.equal(bySlot.main.projection, 0.7);
  assert.equal(bySlot.thursday.projection, 0.7);
});

// ---------------------------------------------------------------------------
// fitting weights
// ---------------------------------------------------------------------------

test("with no evidence a book keeps its prior and the projection keeps zero", () => {
  const { weights } = fitSourceWeights({ "a:2": { n: 0, clusters: 0, lead: null }, [PROJECTION_SOURCE]: { n: 0, clusters: 0, lead: null } });
  assert.equal(weights["a:2"], PRIOR_WEIGHT);
  assert.equal(weights[PROJECTION_SOURCE], 0);
});

test("evidence moves a weight toward its measured lead, more as clusters grow", () => {
  const w = (clusters) => fitSourceWeights({ "a:2": { n: clusters * 3, clusters, lead: 0.8 } }).weights["a:2"];
  assert.ok(w(10) > PRIOR_WEIGHT && w(10) < w(100) && w(100) < w(1000) && w(1000) < 0.8);
  assert.ok(Math.abs(w(1e7) - 0.8) < 1e-3, "enough data and the prior is irrelevant");
});

test("a negative lead is read as no information, floored rather than inverted", () => {
  const { weights } = fitSourceWeights({ "a:2": { n: 1e6, clusters: 1e5, lead: -0.5 } });
  assert.equal(weights["a:2"], MIN_WEIGHT);
});

test("a projection with no lead stays at zero; one with a lead earns exactly its evidence", () => {
  const none = fitSourceWeights({ [PROJECTION_SOURCE]: { n: 3000, clusters: 500, lead: -0.01 } }).weights[PROJECTION_SOURCE];
  assert.equal(none, 0);
  const some = fitSourceWeights({ [PROJECTION_SOURCE]: { n: 3000, clusters: 500, lead: 0.3 } }).weights[PROJECTION_SOURCE];
  assert.ok(some > 0.2 && some < 0.3, `got ${some}`);
});

test("the prior is configurable", () => {
  const w = fitSourceWeights({ "a:2": { n: 0, clusters: 0, lead: null } }, { priorWeight: 0.3 }).weights["a:2"];
  assert.equal(w, 0.3);
});

// ---------------------------------------------------------------------------
// no look-ahead
// ---------------------------------------------------------------------------

test("weights going into a week are fitted on strictly earlier weeks and nothing else", () => {
  const w1 = world({ sources: { sharp: 0.02, a: 0.3, b: 0.3, c: 0.3 }, seed: 1, week: 1 });
  const w2 = world({ sources: { sharp: 0.02, a: 0.3, b: 0.3, c: 0.3 }, seed: 2, week: 2 });
  // Week 3 is built so that the sharp book is useless in it. If its content
  // reached the week-3 weights, they would change.
  const w3 = world({ sources: { sharp: 2, a: 0.3, b: 0.3, c: 0.3 }, seed: 3, week: 3 });
  const w4 = world({ sources: { sharp: 2, a: 0.3, b: 0.3, c: 0.3 }, seed: 4, week: 4 });

  const into3 = weightsAsOf([...w1, ...w2, ...w3, ...w4], 3);
  const only12 = weightsAsOf([...w1, ...w2], 3);
  assert.deepEqual(into3.weights, only12.weights);
  assert.deepEqual(into3.weeksUsed, [1, 2]);

  const into4 = weightsAsOf([...w1, ...w2, ...w3, ...w4], 4);
  assert.ok(into4.weights["sharp:2"] < into3.weights["sharp:2"], "and a week that arrives is then reflected");
  assert.deepEqual(into4.weeksUsed, [1, 2, 3]);
});

test("the first week has nothing to learn from and prices on the priors", () => {
  const w1 = world({ sources: { sharp: 0.02, a: 0.3, b: 0.3, c: 0.3 }, week: 1 });
  const got = weightsAsOf(w1, 1);
  assert.deepEqual(got.weights, {});
  assert.deepEqual(got.weeksUsed, []);
});

// ---------------------------------------------------------------------------
// end to end: weighting a pool by lead predicts the market better
// ---------------------------------------------------------------------------

test("a pool weighted by earned lead lands closer to the eventual market than an equal pool", () => {
  const train = world({ sources: { sharp: 0.02, a: 0.4, b: 0.4, c: 0.4, d: 0.4 }, seed: 11, week: 1, n: 800 });
  const { weights } = fitSourceWeights(assessSources(train));
  assert.ok(weights["sharp:2"] > 3 * weights["a:2"], `sharp ${weights["sharp:2"]} vs a ${weights["a:2"]}`);

  // Fresh markets: how far is each pool from the (held-out) close?
  const test_ = world({ sources: { sharp: 0.02, a: 0.4, b: 0.4, c: 0.4, d: 0.4 }, seed: 12, week: 2, n: 800 });
  let eqErr = 0;
  let wErr = 0;
  for (const p of test_) {
    const rows = p.early.map((v) => ({ book: v.book, ...twoSided(sigmoid(v.logit)) }));
    const close = p.late.reduce((a, v) => a + v.logit, 0) / p.late.length;
    const eq = weightedConsensusProb(rows, { weights: {} });
    const wt = weightedConsensusProb(rows, { weights });
    eqErr += (logit(eq.prob) - close) ** 2;
    wErr += (logit(wt.prob) - close) ** 2;
  }
  assert.ok(wErr < 0.8 * eqErr, `weighted ${wErr} vs equal ${eqErr}`);
});

test("the devig used for votes is the same one consensusProb uses", () => {
  const r = { book: "DraftKings", overOdds: -130, underOdds: 110 };
  const v = bookVotes([r])[0];
  assert.ok(Math.abs(sigmoid(v.logit) - devigTwoWay(-130, 110).fairProbOver) < 1e-9);
});

test("poolVotes prices exactly as weightedConsensusProb does from the same votes", () => {
  // The report has votes, not odds; it must go through the code the live path
  // uses rather than a second implementation of it.
  const rows = [row("Pinnacle", 0.6), row("DraftKings", 0.5), row("FanDuel", 0.45)];
  const weights = { "pinnacle:2": 0.7, "draftkings:2": 0.2 };
  const a = weightedConsensusProb(rows, { weights, projectionProb: 0.7 });
  const b = poolVotes(bookVotes(rows), { weights, projectionProb: 0.7 });
  assert.deepEqual(a, b);
  assert.equal(poolVotes([], {}), null);
});
