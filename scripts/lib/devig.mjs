// Removing the bookmaker's margin ("vig") from a two-sided market to recover a
// fair probability. No I/O — unit tested directly (see devig.test.mjs).
//
// ---------------------------------------------------------------------------
// Why this module exists — and what a fair probability is NOT for
// ---------------------------------------------------------------------------
// Raw implied probabilities on a two-way market sum to more than 1; the excess
// is the "overround" (or vig/juice). De-vigging distributes that excess back
// across the outcomes, recovering the market's actual belief. Which way you
// distribute it is a modelling choice, and the choices disagree most exactly
// where prop betting lives — on longshots.
//
// IMPORTANT — a fair probability is the wrong yardstick for bet selection:
//
//   The break-even probability at a price IS its raw implied probability. At
//   -110 you must win more than 52.38% of the time to profit, not 50% — the
//   vig is a cost you actually pay, not an accounting artifact to remove. So
//   the test of whether a bet makes money is
//       ourProb > rawImpliedProb
//   and the EV edge is `ourProb - rawImpliedProb`.
//
//   Because de-vigging necessarily pushes the market probability BELOW the raw
//   one, `ourProb - fairProb` is always the larger number — by roughly half the
//   hold. Selecting bets on that basis would clear a 3% bar on markets carrying
//   no real EV at all, and size them with Kelly as if they did.
//
// What the fair probability IS good for is measuring our MODEL against the
// market's genuine belief: if ourProb merely equals fairProb we hold no
// information the market lacks, however profitable the raw comparison looks.
// That is a different and complementary question, which is why the capture
// script records both numbers and defaults to the EV one for selection.
//
// ---------------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------------
// MULTIPLICATIVE (a.k.a. proportional / normalization) — the default.
//   p_i = q_i / Σq. Scales every outcome down by the same factor. Simple,
//   always well-defined, and the standard baseline. Its weakness: it assumes
//   the book applies margin proportionally, which empirically it does not —
//   books load more margin onto longshots (the favorite-longshot bias), so
//   this method tends to leave a longshot's fair probability too HIGH.
//
// ADDITIVE (equal-margin) — p_i = q_i - (Σq - 1)/n. Splits the excess evenly
//   in absolute terms, so it strips the same number of percentage points from
//   each side. That over-corrects longshots relative to their size (taking 2.4
//   points off a 4% longshot is a far bigger proportional cut than off a 96%
//   favorite), which is the opposite error to multiplicative's. Offered mainly
//   as a comparison point. On a two-way market it is always safe: since
//   q_under < 1, the per-side excess (q_over + q_under - 1)/2 is necessarily
//   below q_over, so neither side can go negative. On a 3+ way market it can,
//   which is why devigProbabilities still guards for it.
//
// POWER — solves for k in Σ(q_i^k) = 1. Because raising a number below 1 to a
//   power k > 1 shrinks small numbers proportionally more, this removes more
//   margin from the longshot side. A better fit to observed book behaviour on
//   skewed markets like Anytime TD, and the one to prefer when the two sides
//   are far apart.
//
// SHIN — solves Shin's (1993) model, which derives the margin from an assumed
//   fraction z of insider money rather than assuming a functional form. Also
//   corrects favorite-longshot bias; widely used in academic work on odds
//   efficiency. Comparable to POWER in practice.
//
// All four agree exactly on a symmetric market (two equal prices), and diverge
// as the market skews. See devig.test.mjs for worked numbers.

import { americanToProb } from "./odds.mjs";

export const DEVIG_METHODS = ["multiplicative", "additive", "power", "shin"];
export const DEFAULT_DEVIG_METHOD = "multiplicative";

// --- individual methods -------------------------------------------------------
// Each takes an array of raw implied probabilities (which sum to > 1 on a
// vigged market) and returns fair probabilities summing to 1.

function devigMultiplicative(q) {
  const sum = q.reduce((s, x) => s + x, 0);
  return q.map((x) => x / sum);
}

function devigAdditive(q) {
  const sum = q.reduce((s, x) => s + x, 0);
  const excessEach = (sum - 1) / q.length;
  return q.map((x) => x - excessEach);
}

// Bisection on k for Σ(q_i^k) = 1. Σ(q_i^k) is strictly decreasing in k for
// q_i in (0,1), so the root is unique and bisection is both safe and adequate
// here (no derivatives, no divergence).
function devigPower(q) {
  const f = (k) => q.reduce((s, x) => s + Math.pow(x, k), 0) - 1;
  let lo = 1; // k=1 gives Σq > 1, i.e. f(lo) > 0
  let hi = 2;
  // Expand the bracket until f(hi) < 0. Bounded so a pathological input can
  // never spin forever; k above ~64 is far beyond any real market.
  let guard = 0;
  while (f(hi) > 0 && guard++ < 64) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return q.map((x) => Math.pow(x, k));
}

// Shin's model. With z the insider fraction, the fair probability of outcome i
// given raw implied q_i and overround Σq is
//   p_i = ( sqrt(z^2 + 4(1-z) * q_i^2 / Σq) - z ) / ( 2(1-z) )
// and z is chosen so Σp_i = 1. Σp_i is monotone in z over [0,1), so again
// bisection.
function devigShin(q) {
  const sum = q.reduce((s, x) => s + x, 0);
  const pForZ = (z) =>
    q.map((x) => (Math.sqrt(z * z + (4 * (1 - z) * x * x) / sum) - z) / (2 * (1 - z)));
  const f = (z) => pForZ(z).reduce((s, x) => s + x, 0) - 1;

  let lo = 0; // z=0 reduces to Σ(q_i^2/Σq) ... > 1 on a vigged book
  let hi = 0.99;
  if (f(lo) <= 0) return devigMultiplicative(q); // no margin to remove
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return pForZ((lo + hi) / 2);
}

const IMPLEMENTATIONS = {
  multiplicative: devigMultiplicative,
  additive: devigAdditive,
  power: devigPower,
  shin: devigShin,
};

// --- public API ---------------------------------------------------------------

// De-vig an arbitrary set of raw implied probabilities. Returns fair
// probabilities summing to 1, or null if the input isn't a usable market.
//
// A set that sums to <= 1 carries no margin to remove (arbitrage, or a stale/
// crossed quote). We normalize it rather than returning it untouched, so the
// result is always a proper probability distribution; `hold` on the caller's
// side will be negative, which is the signal that this happened.
export function devigProbabilities(rawProbs, method = DEFAULT_DEVIG_METHOD) {
  const impl = IMPLEMENTATIONS[method];
  if (!impl) throw new Error(`Unknown de-vig method: ${method}`);
  if (!Array.isArray(rawProbs) || rawProbs.length < 2) return null;
  if (!rawProbs.every((p) => Number.isFinite(p) && p > 0 && p < 1)) return null;

  const sum = rawProbs.reduce((s, x) => s + x, 0);
  if (sum <= 1) return devigMultiplicative(rawProbs);

  const fair = impl(rawProbs);
  // Additive can push an extreme longshot below zero; that's a signal the
  // method doesn't fit this market, not a usable answer.
  if (!fair.every((p) => Number.isFinite(p) && p > 0 && p < 1)) return null;
  return fair;
}

// De-vig a two-sided market quoted in American odds. `overOdds` is the price on
// the side we model (Over / Yes), `underOdds` its opposite (Under / No).
//
// Returns:
//   { fairProbOver, fairProbUnder, rawProbOver, rawProbUnder, hold, method }
// where `hold` is the book's overround (Σ raw - 1) — the margin removed.
// Returns null if either price is missing or unusable, which is the caller's
// cue that this market is one-sided and cannot be de-vigged.
export function devigTwoWay(overOdds, underOdds, method = DEFAULT_DEVIG_METHOD) {
  const rawProbOver = americanToProb(overOdds);
  const rawProbUnder = americanToProb(underOdds);
  if (rawProbOver === null || rawProbUnder === null) return null;

  const fair = devigProbabilities([rawProbOver, rawProbUnder], method);
  if (!fair) return null;

  return {
    fairProbOver: fair[0],
    fairProbUnder: fair[1],
    rawProbOver,
    rawProbUnder,
    hold: rawProbOver + rawProbUnder - 1,
    method,
  };
}
