// The arithmetic behind `npm run backtest-live`: what the paper ledger would have
// earned on the boards we actually had at the time, and how much of that is
// anything but noise. Pure — no I/O — and unit tested (backtest-live.test.mjs).
//
// ---------------------------------------------------------------------------
// "Live" is the only honest backtest
// ---------------------------------------------------------------------------
// A backfilled board is a reconstruction, and it flatters every strategy twice:
//
//  - "opening" is each book's first-ever price, posted at different moments. A
//    book's first price compared with another book's later first price looks like
//    an edge that nobody could have seen when it was posted.
//  - it is priced from the week's final projection snapshot, which has read
//    everything the market did since.
//
// Only captures taken at the time (the Tuesday, Thursday and Saturday drops)
// carry the prices and the projection that existed at that moment, so only those
// are counted here. Everything a backfill produced is excluded by slot, not by
// judgement.
//
// ---------------------------------------------------------------------------
// And most of it is still noise
// ---------------------------------------------------------------------------
// A one-unit bet returns a standard deviation of roughly 1.5 to 2.3 units (the
// longshots pay a lot), so a 5% ROI is a 0.05 mean on a standard deviation of ~2:
// resolving it at two sigma takes several thousand settled bets, more than a
// season of live captures provides. The report therefore says, next to every ROI,
// how many bets it would take to see a number that size, and refuses to call
// anything under a floor.

import { STAT_DEFS } from "./markets.mjs";
import { americanToDecimal } from "./odds.mjs";
import { summarizeClv } from "./clv.mjs";
import { pairedBrierDiff, NEAR_MONEY_MAX } from "./pricing.mjs";

// The captures taken at the time. A slot not listed is treated as a
// reconstruction until it is added, which is the safe direction to be wrong in.
export const LIVE_SLOTS = ["main", "thursday", "saturday"];
export const isLiveSlot = (slot, liveSlots = LIVE_SLOTS) => liveSlots.includes(slot || "main");

// Below this many settled bets a ROI is not reported as a result.
export const MIN_BETS_FOR_A_VERDICT = 200;

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Bets
// ---------------------------------------------------------------------------

// Summarise a set of ledger rows (strings, as read from data/bets/).
//
// `completeWeeks` are weeks whose games have all been played. A bet still
// "pending" in one of them has no stat line, which for an over is almost always
// a player who recorded nothing — a loss the settlement code cannot see (the
// actuals feed omits all-zero rows). It is counted separately and bounded:
//
//   roi              settled bets only, as the ledger reports it
//   roiConservative  the same, with every such pending OVER counted as a loss and
//                    every such pending UNDER voided. The worst reading.
//
// A pending bet in a week that is not complete is just not played yet.
export function summarizeBets(rows, { completeWeeks = new Set() } = {}) {
  let won = 0;
  let lost = 0;
  let push = 0;
  let unplayed = 0;
  let noLine = 0;
  let noSource = 0;
  let staked = 0;
  let pnl = 0;
  let lossIfZeroStake = 0;
  const returns = [];
  const clvResults = [];

  for (const r of rows) {
    const stake = num(r.StakeUnits) ?? 0;
    const status = r.Status;
    if (r.ClvStatus) clvResults.push({ status: r.ClvStatus, clvProb: num(r.ClvProb), clvPct: num(r.ClvPct) });

    if (status === "won" || status === "lost") {
      status === "won" ? won++ : lost++;
      const p = num(r.PnlUnits) ?? 0;
      staked += stake;
      pnl += p;
      returns.push(stake > 0 ? p / stake : 0);
    } else if (status === "push") {
      push++;
    } else if (!STAT_DEFS[r.Stat]?.actualCols?.length) {
      noSource++; // interceptions: the actuals feed has no column to grade them
    } else if (completeWeeks.has(Number(r.Week))) {
      noLine++;
      if (r.Side === "over") lossIfZeroStake += stake;
    } else {
      unplayed++;
    }
  }

  const n = returns.length;
  const mean = n ? returns.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
  const roi = staked > 0 ? pnl / staked : null;
  const roiConservative = staked + lossIfZeroStake > 0 ? (pnl - lossIfZeroStake) / (staked + lossIfZeroStake) : null;

  return {
    bets: rows.length,
    settled: won + lost,
    won,
    lost,
    push,
    unplayed,
    noLine,
    noSource,
    staked,
    pnl,
    roi,
    // Two standard errors of the ROI, from the spread of the per-bet returns.
    // Bets on one player are correlated, so this is if anything too narrow.
    roiBand: sd !== null && n > 1 ? (2 * sd) / Math.sqrt(n) : null,
    perBetSd: sd,
    roiConservative,
    clv: summarizeClv(clvResults),
  };
}

// How many settled bets it takes to see an ROI of `roi` at two standard errors,
// given the per-bet standard deviation. The number that tells you not to read
// the table.
export function betsToResolve(roi, perBetSd) {
  if (!Number.isFinite(roi) || roi === 0 || !Number.isFinite(perBetSd)) return null;
  return Math.ceil(((2 * perBetSd) / Math.abs(roi)) ** 2);
}

// What a summary supports saying, in words. Never "profitable" on its own: the
// verdicts are about whether the number is distinguishable from zero.
export function verdict(summary, { floor = MIN_BETS_FOR_A_VERDICT } = {}) {
  if (!summary || summary.settled === 0) return "no settled bets";
  if (summary.settled < floor) return `too few to say (${summary.settled} < ${floor})`;
  if (summary.roi === null || summary.roiBand === null) return "no estimate";
  if (summary.roi - summary.roiBand > 0) return "above zero beyond noise";
  if (summary.roi + summary.roiBand < 0) return "below zero beyond noise";
  return "within noise";
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

// What a capture contained. `rows` are the rows of a props file.
export function boardStats(rows, { minEdge = 0.03 } = {}) {
  const markets = new Set();
  const books = new Set();
  let pinnacle = 0;
  let oneSided = 0;
  let bettable = 0;
  let edges = 0;
  const models = new Map();
  const sources = new Map();
  for (const r of rows) {
    markets.add(`${r.PlayerID}|${r.Stat}|${r.Line}`);
    books.add(String(r.Book).toLowerCase());
    if (String(r.Book).toLowerCase() === "pinnacle") pinnacle++;
    if (Number(r.OneSided) === 1) oneSided++;
    const isBettable = r.Bettable === undefined || r.Bettable === "" || Number(r.Bettable) === 1;
    if (isBettable) {
      bettable++;
      if ((num(r.Edge) ?? -Infinity) >= minEdge) edges++;
    }
    const m = r.PriceModel || "projection";
    models.set(m, (models.get(m) ?? 0) + 1);
    const s = r.LineSource || "live";
    sources.set(s, (sources.get(s) ?? 0) + 1);
  }
  return {
    rows: rows.length,
    markets: markets.size,
    books: books.size,
    pinnacleRows: pinnacle,
    oneSidedShare: rows.length ? oneSided / rows.length : null,
    bettable,
    edges,
    priceModels: Object.fromEntries(models),
    // A "live" slot file containing anything but live rows is a backfill that
    // wandered into the wrong directory, and the report says so.
    lineSources: Object.fromEntries(sources),
  };
}

// ---------------------------------------------------------------------------
// Pricing accuracy on live boards
// ---------------------------------------------------------------------------

// `samples` are { y, pBook, pProj, pPool, cluster }: one per market, with the
// books' consensus, the projection's own probability and the pool's. Compared
// near the money by the BOOK's price, as everywhere else, and clustered on
// player-week. Positive = worse than the reference.
export function pricingAccuracy(samples, { band = NEAR_MONEY_MAX } = {}) {
  const near = samples.filter((s) => Math.abs(s.pBook - 0.5) <= band);
  const diff = (rows, a, b) => {
    const usable = rows.filter((s) => Number.isFinite(s[a]) && Number.isFinite(s[b]));
    return pairedBrierDiff(usable.map((s) => ({ p: s[a], q: s[b], y: s.y, cluster: s.cluster })));
  };
  const brier = (rows, k) => {
    const u = rows.filter((s) => Number.isFinite(s[k]));
    return u.length ? u.reduce((a, s) => a + (s[k] - s.y) ** 2, 0) / u.length : null;
  };
  const block = (rows) => ({
    n: rows.length,
    clusters: new Set(rows.map((s) => s.cluster)).size,
    brierBook: brier(rows, "pBook"),
    brierProj: brier(rows.filter((s) => Number.isFinite(s.pProj)), "pProj"),
    brierPool: brier(rows, "pPool"),
    projVsBook: diff(rows, "pProj", "pBook"),
    poolVsBook: diff(rows, "pPool", "pBook"),
    poolVsProj: diff(rows, "pPool", "pProj"),
  });
  return { all: block(samples), near: block(near) };
}

// ---------------------------------------------------------------------------
// The counterfactual: the same boards, the other price
// ---------------------------------------------------------------------------

// Which price a live board was captured under, and so which one to put it
// against. A board priced by the pool is compared with the projection price (what
// the long-standing ledger would have done); a board priced from the projection
// is compared with the pool as it would have stood that week.
export function counterfactualOf(priceModelOnBoard) {
  return priceModelOnBoard === "pool" ? "projection" : "pool";
}

// The projection-only price of a props row, as the row's own Over/Under
// probability. ProjProb where the capture recorded it; OurProb only for a row
// that was projection-priced to begin with.
export function projectionProbOf(row) {
  const proj = num(row.ProjProb);
  if (proj !== null) return proj;
  const model = row.PriceModel || "projection";
  return model === "projection" ? num(row.OurProb) : null;
}

// Re-price a props row to the projection price. Returns a new row, or null when
// the row cannot say what the projection said.
export function asProjectionPriced(row) {
  const p = projectionProbOf(row);
  if (p === null) return null;
  const implied = num(row.ImpliedProb);
  const fair = num(row.FairProb) ?? implied;
  return {
    ...row,
    OurProb: p.toFixed(4),
    ProjProb: p.toFixed(4),
    Edge: (p - implied).toFixed(4),
    ModelEdge: (p - fair).toFixed(4),
    PriceModel: "projection",
  };
}
