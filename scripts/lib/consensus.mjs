// Turning many books' prices for one market into a single number: what the
// market believes. Pure — no I/O, unit tested directly (see consensus.test.mjs).
//
// ---------------------------------------------------------------------------
// Why this is a separate module from devig.mjs
// ---------------------------------------------------------------------------
// devig.mjs answers "what does THIS book believe, net of its margin?" — a
// question about one price pair. This module answers "what does THE MARKET
// believe?", which is a question about a set of books, and the two failure
// modes are different. A single book can be stale, can be the only one
// offering a number, or can be quoting one side only. A consensus has to
// survive all three and still produce a probability the pricing model can
// condition on.
//
// calibration.mjs already reached this conclusion for its disagreement cap and
// took the median fair probability across books. This module is that idea made
// first-class and reusable, because the pricing model needs the same object.
//
// ---------------------------------------------------------------------------
// The one-sided problem, and what we do about it
// ---------------------------------------------------------------------------
// A large share of the markets in the committed 2026 captures are quoted with
// only one side, at every book that prices them: 100% of week 1, 52% of week 2,
// 39% of week 3, 15% of week 4 as the capture widened.
// Cross-book pairing — taking an Over at DraftKings against an Under at
// FanDuel — was the obvious fix and it buys nothing here: measured over weeks
// 1-3, the number of markets where two different books quote opposite sides
// and no single book quotes both is exactly ZERO. One-sidedness is a property
// of the market, not of the book, so there is no pair to recover.
//
// That leaves two honest options for a one-sided market: drop it, or de-vig it
// against an ASSUMED overround. Dropping it throws away half the board and all
// of week 1. So we assume, and we flag every row where we did.
//
// The assumption is defensible because the measured hold is remarkably stable.
// Median two-sided hold by stat over 2026 weeks 1-3:
//
//     recYds .0772   rushYds .0769   passYds .0769   receptions .0693
//     passTD .0670   passAtt .0693   completions .0652   rushAtt .0652
//     int    .0678
//
// A 1.2-point spread across every stat on the board. So `fair = raw / (1 + H)`
// with H the median observed hold for that stat is a small, bounded correction
// — not a guess about the market's belief, just the removal of a margin we can
// see everywhere else.
//
// It is still an assumption, and `probSource` records it on every row so the
// pricing report can split its scores by whether the market number was
// measured or inferred. If the two disagree, believe the measured one.

import { americanToProb } from "./odds.mjs";
import { devigTwoWay, DEFAULT_DEVIG_METHOD } from "./devig.mjs";
import { normalizeBookName } from "./books.mjs";

// ---------------------------------------------------------------------------
// Market sets — whose opinion counts as "the market"
// ---------------------------------------------------------------------------
// Two different questions, which is why both exist and the report runs both:
//
//   retail — the recreational board. These are the books a subscriber actually
//     has an account at, so a disagreement with them is a disagreement with
//     the price you can really take. This is the commercially relevant prior.
//
//   sharp — limit-taking books that move first and are widely used as the
//     fair-value reference. Beating this consensus is the stronger claim: it
//     says we know something the people who set the number don't, rather than
//     something the soft books haven't caught up to.
//
// Names are normalized before matching (normalizeBookName), so "Hard Rock",
// "hardrock" and "hard_rock_bet" all resolve. That matters on this data: the
// week-1 capture wrote raw API ids ("draftkings", "mgm", "circasports") and
// weeks 2+ write display names ("DraftKings", "BetMGM", "Hard Rock"). A
// consensus keyed on the literal string would treat them as different books
// and silently halve the sample.
export const MARKET_SETS = {
  retail: ["draftkings", "fanduel", "betmgm", "mgm", "caesars", "betrivers", "hardrock", "hardrockbet", "thescore", "betr"],
  // Kept in step with REFERENCE_BOOKS in books.mjs: those are the books a
  // capture now pulls precisely so this set has something in it. Circa stays
  // listed here as well as in the bettable roster — it is both a book you can
  // bet at and a sharp price worth measuring against, and the two lists are
  // asking different questions.
  sharp: ["circa", "circasports", "circavegas", "pinnacle", "bookmaker", "betcris"],
  all: null, // null means "no filter" — every book present in the rows
};

export const MARKET_SET_NAMES = Object.keys(MARKET_SETS);

// Fallback overround for a stat we have no two-sided observation of. Set to
// the middle of the measured range above rather than to zero: assuming no vig
// would treat a one-sided price as already fair, which is the one thing we
// know it is not.
export const DEFAULT_ASSUMED_HOLD = 0.07;

// Is this book in the named set? An unknown set name matches nothing, which
// fails loudly at the caller rather than silently widening the consensus.
export function bookInSet(book, setName) {
  if (setName === "all") return true;
  const members = MARKET_SETS[setName];
  if (!members) return false;
  return members.includes(normalizeBookName(book));
}

// Median observed hold per stat, from the rows that carry one. Returns a Map
// stat -> hold, for feeding back in as `holdByStat`.
//
// Only two-sided rows carry a Hold, so this is measured, never circular: a row
// whose fair probability we are about to ASSUME contributes nothing to the
// assumption.
export function estimateHoldByStat(rows) {
  const byStat = new Map();
  for (const r of rows ?? []) {
    const h = Number(r.hold);
    if (!Number.isFinite(h) || h <= 0) continue;
    if (!byStat.has(r.stat)) byStat.set(r.stat, []);
    byStat.get(r.stat).push(h);
  }
  const out = new Map();
  for (const [stat, xs] of byStat) out.set(stat, median(xs));
  return out;
}

// One book's fair probability for one side of one market.
//
// `overOdds`/`underOdds` are that book's American prices; `underOdds` may be
// null, which is the one-sided case. `side` says which side we want back.
//
// Returns { fairProb, rawProb, hold, source } or null when the price is
// unusable. `source` is "devig" when both sides were quoted and
// "assumed-hold" when the margin was inferred.
export function bookFairProb({ overOdds, underOdds, side, assumedHold, method = DEFAULT_DEVIG_METHOD }) {
  const wantUnder = side === "under";
  const ownOdds = wantUnder ? underOdds : overOdds;
  const rawProb = americanToProb(ownOdds);
  if (rawProb === null) return null;

  const devigged =
    overOdds !== null && overOdds !== undefined && underOdds !== null && underOdds !== undefined
      ? devigTwoWay(overOdds, underOdds, method)
      : null;

  if (devigged) {
    return {
      fairProb: wantUnder ? devigged.fairProbUnder : devigged.fairProbOver,
      rawProb,
      hold: devigged.hold,
      source: "devig",
    };
  }

  // One-sided: strip an assumed proportional margin. This is exactly the
  // multiplicative de-vig that devigTwoWay would apply if the unseen side
  // carried margin in proportion to its own price.
  const h = Number.isFinite(assumedHold) && assumedHold > 0 ? assumedHold : DEFAULT_ASSUMED_HOLD;
  const fair = rawProb / (1 + h);
  if (!(fair > 0 && fair < 1)) return null;
  return { fairProb: fair, rawProb, hold: null, source: "assumed-hold" };
}

// ---------------------------------------------------------------------------
// The consensus itself
// ---------------------------------------------------------------------------
// Aggregating in LOGIT space, then taking the median.
//
// Median rather than mean for the reason calibration.mjs already gives: one
// stale or erroneous book should not drag the number, and robustness is the
// entire reason a multi-book consensus beats any single price.
//
// Logit rather than raw probability because probabilities near 0 and 1 are
// compressed — the difference between 2% and 4% is one doubling of risk but
// two points of probability, while 50% to 52% is neither. Every downstream
// model here works in logits, so converting once at the source keeps the
// median a median of the quantity actually being modelled. (On a symmetric
// odd-count sample the two agree exactly, since the median picks an element
// rather than averaging; they diverge only on even counts, where the logit
// median interpolates on the scale the model uses.)
//
// `rows` are one market-side's per-book prices:
//   [{ book, overOdds, underOdds, hold }]
// and every row must be the same player/stat/line/side — the caller groups.
//
// Returns null when no book in the set produced a usable price, which the
// caller must treat as "this market has no market prior", not as 0.5.
export function consensusProb(rows, { side, setName = "retail", holdByStat = new Map(), stat, method = DEFAULT_DEVIG_METHOD } = {}) {
  const assumedHold = holdByStat.get?.(stat) ?? DEFAULT_ASSUMED_HOLD;

  const fairs = [];
  const books = new Set();
  const holds = [];
  let devigged = 0;
  for (const r of rows ?? []) {
    if (!bookInSet(r.book, setName)) continue;
    const key = normalizeBookName(r.book);
    if (books.has(key)) continue; // one vote per book, even if the capture duplicated it
    const fp = bookFairProb({ ...r, side, assumedHold, method });
    if (!fp) continue;
    books.add(key);
    fairs.push(fp.fairProb);
    if (fp.source === "devig") devigged++;
    if (Number.isFinite(fp.hold)) holds.push(fp.hold);
  }

  if (fairs.length === 0) return null;

  const prob = sigmoid(median(fairs.map(logit)));
  return {
    prob,
    bookCount: fairs.length,
    deviggedCount: devigged,
    // "devig" only when EVERY contributing book quoted both sides. A mixed
    // consensus is reported as assumed, because the weakest input is what
    // limits how far the number can be trusted.
    probSource: devigged === fairs.length ? "devig" : devigged > 0 ? "mixed" : "assumed-hold",
    meanHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    assumedHold: devigged === fairs.length ? null : assumedHold,
  };
}

// --- small shared numerics ----------------------------------------------------
// Clamped so a 0 or 1 probability (which a degenerate price can produce)
// becomes a large finite logit instead of an infinity that poisons every
// downstream fit. EPS is well below any real price: 1e-6 is +99999900 odds.
export const LOGIT_EPS = 1e-6;

export function logit(p) {
  const x = Math.min(1 - LOGIT_EPS, Math.max(LOGIT_EPS, p));
  return Math.log(x / (1 - x));
}

export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
