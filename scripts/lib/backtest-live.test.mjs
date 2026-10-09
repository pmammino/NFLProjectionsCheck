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
  MIN_CLV_FOR_A_BOOK,
  indexClosingConsensus,
  marketClv,
  summarizeMarketClv,
  summarizeByBook,
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

// --- CLV by book ----------------------------------------------------------------

test("CLV carries two standard errors, and the beat rate its distance from a coin flip", () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(bet({ ClvStatus: "matched", ClvProb: i % 2 ? "0.05" : "-0.03", ClvPct: "0" }));
  const c = summarizeBets(rows).clv;
  assert.equal(c.nMatched, 100);
  assert.ok(Math.abs(c.avgClvProb - 0.01) < 1e-9);
  // sd of +0.05/-0.03 is ~0.0402, so two se is ~0.008.
  assert.ok(Math.abs(c.avgBand - (2 * 0.04019) / 10) < 1e-3, `band ${c.avgBand}`);
  assert.ok(Math.abs(c.beatBand - 0.1) < 1e-12, "2 * sqrt(0.25/100)");
  assert.equal(summarizeBets([]).clv.avgBand, null);
  assert.equal(summarizeBets([]).clv.beatBand, null);
});

// A closing quote as readPropRow gives it.
const cq = (book, overOdds, underOdds, o = {}) => ({ book, week: 3, playerId: "p1", stat: "recYds", line: 50.5, side: "over", overOdds, underOdds, ...o });
const closing = [cq("DraftKings", -110, -110), cq("FanDuel", -120, 100), cq("Caesars", -105, -115), cq("Hard Rock", -110, -110)];
const mbet = (o = {}) => ({ Week: "3", PlayerID: "p1", Stat: "recYds", Line: "50.5", Side: "over", Odds: "120", Book: "Hard Rock", ...o });

test("market CLV compares the price taken with the OTHER books' closing fair price", () => {
  const idx = indexClosingConsensus(closing);
  const r = marketClv(mbet(), idx);
  // Taking +120 (45.5% implied) when the market closed near 51% is worth about 5 points.
  assert.equal(r.others, 3, "Hard Rock's own closing quote is left out");
  assert.ok(r.clvProb > 0.03 && r.clvProb < 0.08, `got ${r.clvProb}`);
});

test("market CLV leaves out the bet's own book however it is spelled", () => {
  const idx = indexClosingConsensus(closing);
  assert.equal(marketClv(mbet({ Book: "Hard Rock" }), idx).others, 3);
  assert.equal(marketClv(mbet({ Book: "hardrockbet" }), idx).others, 3);
  assert.equal(marketClv(mbet({ Book: "DraftKings" }), idx).others, 3);
});

test("an under is the mirror of the over", () => {
  // A lopsided market, so a bet on the wrong side cannot pass by accident: the
  // fair price of the over is ~60%.
  const idx = indexClosingConsensus([cq("DraftKings", -150, 130), cq("FanDuel", -145, 125), cq("Caesars", -155, 135), cq("Hard Rock", -150, 130)]);
  const over = marketClv(mbet({ Side: "over", Odds: "-110" }), idx);
  const under = marketClv(mbet({ Side: "under", Odds: "-110" }), idx);
  // Taking -110 on each side of the same market: the two CLVs add up to what the
  // margin costs, 1 - 2 * 0.5238 = -4.76 points, whatever the market's fair price is.
  assert.ok(Math.abs(over.clvProb + under.clvProb - (1 - 2 * (110 / 210))) < 1e-9, `got ${over.clvProb + under.clvProb}`);
  // And the over is worth much more than the under when the market favours the over.
  assert.ok(over.clvProb > 0.05 && under.clvProb < -0.1, `over ${over.clvProb}, under ${under.clvProb}`);
});

test("no market, no CLV: too few other books, a different line, or a different week", () => {
  const idx = indexClosingConsensus(closing);
  assert.equal(marketClv(mbet({ Line: "49.5" }), idx), null, "a different line is a different market");
  assert.equal(marketClv(mbet({ Week: "4" }), idx), null);
  assert.equal(marketClv(mbet({ PlayerID: "p9" }), idx), null);
  const thin = indexClosingConsensus([cq("Hard Rock", -110, -110), cq("DraftKings", -110, -110)]);
  assert.equal(marketClv(mbet(), thin), null, "one other book is not a market");
  assert.ok(marketClv(mbet(), thin, { minOthers: 1 }) !== null, "unless asked for");
  assert.equal(marketClv(mbet({ Odds: "x" }), idx), null);
});

test("market CLV is not the book's own closing price: a book that never moves still shows the gap", () => {
  // Hard Rock closed exactly where it opened (+120) while everyone else moved to
  // ~-110/-110. Against its OWN close that bet is worth zero; against the market it
  // is worth about five points. That difference is the whole reason to report both.
  const idx = indexClosingConsensus([cq("Hard Rock", 120, -140), cq("DraftKings", -110, -110), cq("FanDuel", -115, -105), cq("Caesars", -105, -115)]);
  const r = marketClv(mbet({ Odds: "120" }), idx);
  assert.ok(r.clvProb > 0.03, `got ${r.clvProb}`);
});

test("summarizeMarketClv: beat rate, average, and bands; empty is null not NaN", () => {
  const s = summarizeMarketClv([{ clvProb: 0.04 }, { clvProb: -0.02 }, { clvProb: 0.03 }, null, { clvProb: NaN }]);
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.beatRate - 2 / 3) < 1e-12);
  assert.ok(Math.abs(s.avg - 0.01666667) < 1e-6);
  assert.ok(s.avgBand > 0 && s.beatBand > 0);
  assert.deepEqual(summarizeMarketClv([]), { n: 0, beatRate: null, avg: null, avgBand: null, beatBand: null });
});

test("bets are grouped by book on the canonical key, most bets first, with both CLVs", () => {
  const idx = indexClosingConsensus(closing);
  const rows = [
    mbet({ Book: "Hard Rock", StakeUnits: "1", Status: "won", PnlUnits: "1.2", ClvStatus: "matched", ClvProb: "0", ClvPct: "0" }),
    mbet({ Book: "hardrockbet", StakeUnits: "1", Status: "lost", PnlUnits: "-1", ClvStatus: "matched", ClvProb: "0", ClvPct: "0" }),
    mbet({ Book: "DraftKings", Odds: "130", StakeUnits: "1", Status: "lost", PnlUnits: "-1" }),
  ];
  const by = summarizeByBook(rows, { closingIndex: idx });
  assert.deepEqual(by.map((b) => b.book), ["hardrock", "draftkings"]);
  assert.deepEqual(by.map((b) => b.label), ["Hard Rock", "DraftKings"], "one display name per book, whichever spelling the capture used");
  assert.equal(by[0].summary.bets, 2, "the two spellings are one book");
  assert.equal(by[0].summary.settled, 2);
  assert.equal(by[0].summary.clv.nMatched, 2, "the ledger's own-close CLV");
  assert.equal(by[0].market.n, 2, "and the market's");
  assert.ok(by[0].market.avg > 0.03);
  assert.equal(summarizeByBook(rows)[0].market, null, "no closing data, no market CLV");
  assert.equal(MIN_CLV_FOR_A_BOOK, 20);
});
