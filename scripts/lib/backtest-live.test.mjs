import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_SLOTS,
  isLiveSlot,
  summarizeBets,
  betsToResolve,
  verdict,
  boardStats,
  pricingAccuracy,
  counterfactualOf,
  projectionProbOf,
  asProjectionPriced,
  MIN_BETS_FOR_A_VERDICT,
} from "./backtest-live.mjs";

const bet = (o = {}) => ({
  Week: "3", Stat: "recYds", Side: "over", Odds: "100", StakeUnits: "1",
  Status: "won", PnlUnits: "1", ClvStatus: "", ClvProb: "", ClvPct: "", ...o,
});

test("only the captures taken at the time are live; a backfill never is", () => {
  assert.deepEqual(LIVE_SLOTS, ["main", "thursday", "saturday"]);
  for (const s of ["main", "thursday", "saturday"]) assert.equal(isLiveSlot(s), true, s);
  for (const s of ["opening", "closing", "t-48h", "anything-new"]) assert.equal(isLiveSlot(s), false, s);
  // A row from before slots existed was the Tuesday drop.
  assert.equal(isLiveSlot(""), true);
  assert.equal(isLiveSlot(undefined), true);
  // And the list is overridable, so a new live slot is a flag rather than an edit.
  assert.equal(isLiveSlot("sunday", [...LIVE_SLOTS, "sunday"]), true);
});

test("ROI is on settled bets, and a push returns its stake rather than counting as a bet", () => {
  const rows = [bet(), bet({ Status: "lost", PnlUnits: "-1" }), bet({ Status: "lost", PnlUnits: "-1" }), bet({ Status: "push", PnlUnits: "0" })];
  const s = summarizeBets(rows);
  assert.equal(s.bets, 4);
  assert.equal(s.settled, 3);
  assert.equal(s.push, 1);
  assert.equal(s.staked, 3);
  assert.ok(Math.abs(s.roi - -1 / 3) < 1e-12);
});

test("a pending bet is unplayed in an unfinished week and 'no stat line' in a finished one", () => {
  const rows = [bet({ Status: "pending", Week: "5" }), bet({ Status: "pending", Week: "3" }), bet({ Status: "pending", Week: "3", Side: "under" })];
  const s = summarizeBets(rows, { completeWeeks: new Set([3]) });
  assert.equal(s.unplayed, 1);
  assert.equal(s.noLine, 2);
});

test("interception bets cannot be graded and are counted apart, not as a missing stat line", () => {
  const s = summarizeBets([bet({ Status: "pending", Stat: "int", Week: "3" })], { completeWeeks: new Set([3]) });
  assert.equal(s.noSource, 1);
  assert.equal(s.noLine, 0);
});

test("the conservative ROI counts pending overs as losses and voids pending unders", () => {
  // The actuals feed omits players who recorded nothing, so a pending over in a
  // finished week is almost always a loss the settlement cannot see; a pending
  // under would have won, which the worst reading ignores.
  const rows = [
    bet(), // +1
    bet({ Status: "lost", PnlUnits: "-1" }), // -1
    bet({ Status: "pending", Week: "3", Side: "over" }),
    bet({ Status: "pending", Week: "3", Side: "under" }),
  ];
  const s = summarizeBets(rows, { completeWeeks: new Set([3]) });
  assert.equal(s.roi, 0);
  // pnl 0 - 1 (the pending over) over 3 staked = -1/3.
  assert.ok(Math.abs(s.roiConservative - -1 / 3) < 1e-12);
});

test("the ROI band is two standard errors of the per-bet returns", () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(i % 2 ? bet() : bet({ Status: "lost", PnlUnits: "-1" }));
  const s = summarizeBets(rows);
  // returns alternate +1, -1: mean 0, sd ~1.005, so two se ~ 0.2.
  assert.ok(Math.abs(s.perBetSd - 1.005) < 0.01, `sd ${s.perBetSd}`);
  assert.ok(Math.abs(s.roiBand - (2 * s.perBetSd) / 10) < 1e-12);
});

test("an empty or single-bet set has no band, not NaN", () => {
  const empty = summarizeBets([]);
  assert.equal(empty.roi, null);
  assert.equal(empty.roiBand, null);
  assert.equal(summarizeBets([bet()]).roiBand, null);
});

test("CLV is summarised from the ledger's own columns", () => {
  const rows = [
    bet({ ClvStatus: "matched", ClvProb: "0.04", ClvPct: "0.10" }),
    bet({ ClvStatus: "matched", ClvProb: "-0.02", ClvPct: "-0.05" }),
    bet({ ClvStatus: "line-moved" }),
    bet({ ClvStatus: "" }),
  ];
  const c = summarizeBets(rows).clv;
  assert.equal(c.nMatched, 2);
  assert.equal(c.beatRate, 0.5);
  assert.equal(c.nLineMoved, 1);
  assert.ok(Math.abs(c.avgClvProb - 0.01) < 1e-9);
});

test("betsToResolve: a 5% ROI at a 1.4 unit spread takes about 3,100 bets", () => {
  assert.equal(betsToResolve(0.05, 1.4), Math.ceil((2.8 / 0.05) ** 2));
  assert.ok(Math.abs(betsToResolve(0.05, 1.4) - 3136) <= 1);
  assert.ok(betsToResolve(0.1, 1.4) < betsToResolve(0.05, 1.4));
  assert.equal(betsToResolve(0, 1.4), null);
  assert.equal(betsToResolve(0.05, null), null);
  // Sign does not matter: a -5% ROI is as hard to resolve as +5%.
  assert.equal(betsToResolve(-0.05, 1.4), betsToResolve(0.05, 1.4));
});

test("verdict refuses small samples and calls only what clears the noise", () => {
  assert.equal(verdict(null), "no settled bets");
  assert.equal(verdict({ settled: 0 }), "no settled bets");
  assert.match(verdict({ settled: MIN_BETS_FOR_A_VERDICT - 1, roi: 0.5, roiBand: 0.1 }), /too few to say/);
  assert.equal(verdict({ settled: 500, roi: 0.3, roiBand: 0.1 }), "above zero beyond noise");
  assert.equal(verdict({ settled: 500, roi: -0.3, roiBand: 0.1 }), "below zero beyond noise");
  assert.equal(verdict({ settled: 500, roi: 0.05, roiBand: 0.1 }), "within noise");
  assert.equal(verdict({ settled: 500, roi: null, roiBand: null }), "no estimate");
});

// --- boards ----------------------------------------------------------------

const prop = (o = {}) => ({ PlayerID: "1", Stat: "recYds", Line: "50.5", Book: "DraftKings", OneSided: "0", Bettable: "1", Edge: "0.01", PriceModel: "pool", LineSource: "live", ...o });

test("a board's edge rows are bettable rows at or above the minimum, never a reference book's", () => {
  const b = boardStats(
    [
      prop({ Edge: "0.05" }),
      prop({ Edge: "0.02" }),
      prop({ Edge: "0.09", Book: "Pinnacle", Bettable: "0" }), // reference: priced, never staked
      prop({ Edge: "0.04", PlayerID: "2" }),
    ],
    { minEdge: 0.03 }
  );
  assert.equal(b.rows, 4);
  assert.equal(b.bettable, 3);
  assert.equal(b.edges, 2);
  assert.equal(b.pinnacleRows, 1);
  assert.equal(b.markets, 2);
  assert.equal(b.books, 2);
});

test("a board reports its price model and where its prices came from", () => {
  const b = boardStats([prop(), prop({ PriceModel: "", LineSource: "opening" })]);
  assert.deepEqual(b.priceModels, { pool: 1, projection: 1 });
  // A "live" file holding a reconstruction is visible.
  assert.deepEqual(b.lineSources, { live: 1, opening: 1 });
  assert.equal(boardStats([]).oneSidedShare, null);
  assert.equal(boardStats([prop({ OneSided: "1" }), prop()]).oneSidedShare, 0.5);
});

// --- pricing accuracy --------------------------------------------------------

test("pricing accuracy compares near the money by the BOOK's price and ignores a missing projection", () => {
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push({ y: i % 2, pBook: 0.5, pProj: i % 2 ? 0.7 : 0.3, pPool: 0.5, cluster: `c${i}` });
  samples.push({ y: 1, pBook: 0.95, pProj: 0.5, pPool: 0.95, cluster: "tail" });
  samples.push({ y: 1, pBook: 0.5, pProj: NaN, pPool: 0.5, cluster: "noproj" });
  const r = pricingAccuracy(samples);
  assert.equal(r.all.n, 42);
  assert.equal(r.near.n, 41, "the 95% market is not near the money");
  // The projection here is better than the book (it leans the right way): negative gap.
  assert.ok(r.near.projVsBook.mean < 0);
  // The NaN projection is left out of the projection comparison but not the pool's.
  assert.equal(r.near.projVsBook.n, 40);
  assert.equal(r.near.poolVsBook.n, 41);
  assert.equal(r.near.poolVsBook.mean, 0);
});

// --- the counterfactual --------------------------------------------------------

test("a board is compared with the price it was not priced under", () => {
  assert.equal(counterfactualOf("pool"), "projection");
  assert.equal(counterfactualOf("projection"), "pool");
  assert.equal(counterfactualOf(undefined), "pool");
});

test("what the projection said: ProjProb where recorded, OurProb only for a projection-priced row", () => {
  assert.equal(projectionProbOf({ ProjProb: "0.61", OurProb: "0.50", PriceModel: "pool" }), 0.61);
  assert.equal(projectionProbOf({ OurProb: "0.62", PriceModel: "projection" }), 0.62);
  assert.equal(projectionProbOf({ OurProb: "0.62" }), 0.62, "a row from before the column was a projection price");
  assert.equal(projectionProbOf({ OurProb: "0.50", PriceModel: "pool" }), null, "a pooled row with no ProjProb cannot say");
});

test("asProjectionPriced rewrites the price and the edges and keeps everything else", () => {
  const row = { Book: "DraftKings", ImpliedProb: "0.5238", FairProb: "0.5000", OurProb: "0.5100", ProjProb: "0.6200", Edge: "-0.0138", ModelEdge: "0.0100", PriceModel: "pool", Slot: "main" };
  const out = asProjectionPriced(row);
  assert.equal(out.PriceModel, "projection");
  assert.equal(out.OurProb, "0.6200");
  assert.equal(out.Edge, "0.0962");
  assert.equal(out.ModelEdge, "0.1200");
  assert.equal(out.Book, "DraftKings");
  assert.equal(out.Slot, "main");
  assert.equal(asProjectionPriced({ ...row, ProjProb: "", PriceModel: "pool" }), null);
});
