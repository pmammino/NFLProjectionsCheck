// Pure probability models that turn a Floor/Median/Ceiling projection into
// P(actual > line) for an arbitrary betting line. No I/O — unit tested
// directly (see probability.test.mjs).
//
// Two models, matching how the rest of this repo already treats projections
// (lib/stats.ts, lib/td.ts):
//
//  - "continuous" stats (yards, attempts, completions, receptions): Floor/
//    Median/Ceiling are already treated elsewhere as the 25th/50th/75th
//    percentiles of the outcome. We spline two normal halves through those
//    three points (median as the exact center, so it stays continuous at M)
//    rather than fitting one symmetric normal — real yardage/attempt
//    distributions are skewed, and this preserves whatever skew the Floor/
//    Ceiling spread already encodes without inventing a heavier model.
//
//  - "poisson" stats (TDs, INTs — rare small-count events): same Poisson
//    approach lib/td.ts already uses for anytime-TD scoring probability,
//    with lambda = the projected median count.

// Φ^-1(0.75): how many standard deviations the 75th percentile sits above
// the mean of a standard normal. Also splits the 25th percentile below it.
const Z75 = 0.6744897501960817;

// Abramowitz & Stegun 7.1.26 rational approximation of erf, |error| < 1.5e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Smallest usable half-spread, relative to the median, so a projection with
// essentially zero Floor/Ceiling spread (e.g. a deep-bench player projected
// to touch the ball zero times) doesn't produce a divide-by-zero step
// function — it instead becomes a very tight (but not infinitely tight) band.
function safeSigma(spread, median) {
  const floorEps = Math.max(0.05, Math.abs(median) * 0.01);
  return Math.max(spread, floorEps) / Z75;
}

// P(actual > line) for a continuous stat given its Floor(25th)/Median(50th)/
// Ceiling(75th) projection.
export function probOverContinuous(line, floor, median, ceiling) {
  const sigmaLow = safeSigma(median - floor, median);
  const sigmaHigh = safeSigma(ceiling - median, median);
  const z = line <= median ? (line - median) / sigmaLow : (line - median) / sigmaHigh;
  return 1 - normalCdf(z);
}

// Poisson CDF: P(X <= k) for integer k >= 0.
function poissonCdf(k, lambda) {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  let term = Math.exp(-lambda); // P(X=0)
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

// P(actual > line) for a Poisson-distributed count stat (TDs, INTs) given
// its expected count (lambda). Lines are conventionally k+0.5 (e.g. Anytime
// TD is "over 0.5"), so floor(line) is the largest integer still <= line.
export function probOverPoisson(line, lambda) {
  const k = Math.floor(line);
  if (line < 0) return 1;
  return 1 - poissonCdf(k, Math.max(0, lambda));
}

// Shrink a Poisson lambda toward its Floor estimate as a player's underlying
// volume ("touches") gets thin. A TD/turnover count has no Floor/Ceiling
// spread of its own to lean on (unlike the continuous model), so a backup's
// tiny median TD projection would otherwise be trusted exactly as much as a
// starter's — even though a small absolute wobble in a tiny count is a huge
// *relative* swing in scoring probability, and a backup's role is far less
// stable week to week than a starter's.
//
// At/below `minVolume`, the caller should treat the prop as unpriceable
// entirely (see capture-props.mjs) — this function assumes volume >=
// minVolume. Between minVolume and `stableVolume` (a "real, trusted role"
// threshold), lambda is linearly blended from the conservative Floor count
// up to the full Median count; at/above stableVolume, Median is used as-is.
export function blendLambda(median, floor, volume, minVolume, stableVolume) {
  if (stableVolume <= minVolume) return median; // degenerate config — no blending band
  const t = Math.min(1, Math.max(0, (volume - minVolume) / (stableVolume - minVolume)));
  return floor + t * (median - floor);
}
