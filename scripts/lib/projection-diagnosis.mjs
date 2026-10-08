// The arithmetic behind `npm run projection-miss`: where, along the distribution
// a projection implies, does it lose to the books — and what would repairing each
// candidate cause recover?
//
// Pure, unit tested (projection-diagnosis.test.mjs). The report is
// scripts/projection-miss.mjs.
//
// The questions are separate on purpose. A projection can lose to the market
// because it is LATE (the books priced news it had not read yet), because its
// MIDDLE is in the wrong place (location), because its band is too NARROW
// (overconfidence), because its TAILS are too thin (shape), or because it simply
// knows less. Each has a different remedy, and a single "the projection is worse"
// number cannot tell them apart.

import { probOverContinuous } from "./probability.mjs";

const Z75 = 0.6744897501960817;

// ---------------------------------------------------------------------------
// Student-t, for asking whether heavier tails would help
// ---------------------------------------------------------------------------

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const a of c) s += a / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

// Continued fraction for the incomplete beta (Numerical Recipes, betacf).
function betacf(a, b, x) {
  const FP = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FP) d = FP;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FP) d = FP;
    c = 1 + aa / c;
    if (Math.abs(c) < FP) c = FP;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FP) d = FP;
    c = 1 + aa / c;
    if (Math.abs(c) < FP) c = FP;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// P(T <= t) for a Student-t with `nu` degrees of freedom.
export function tCdf(t, nu) {
  const x = nu / (nu + t * t);
  const p = 0.5 * incompleteBeta(x, nu / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

// The 75th percentile of a Student-t (so a band's quartiles can be matched).
const q75Cache = new Map();
export function tQuantile75(nu) {
  if (!q75Cache.has(nu)) {
    let lo = 0;
    let hi = 10;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      if (tCdf(m, nu) < 0.75) lo = m;
      else hi = m;
    }
    q75Cache.set(nu, (lo + hi) / 2);
  }
  return q75Cache.get(nu);
}

// Standard normal CDF, for the nu = Infinity case.
function normalCdf(z) {
  const s = z < 0 ? -1 : 1;
  const ax = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + s * erf);
}

// ---------------------------------------------------------------------------
// A projection priced with a different band
// ---------------------------------------------------------------------------

// P(actual > line) from a Floor/Median/Ceiling triple, as the long-standing
// two-piece normal does — with three dials, each of which is one hypothesis about
// where the projection goes wrong:
//
//   nu          tail weight. Infinity is the normal. A smaller nu is a heavier
//               tail with the SAME quartiles, so the middle is untouched and only
//               the tails change.
//   spreadMult  a multiplier on the band's width (both halves). Above 1 says the
//               band is too narrow, i.e. the projection is overconfident.
//   shift       a multiplier on F, M and C together: the whole projection is
//               too high or too low.
//
// With the defaults it equals probOverContinuous exactly (tested).
export function probOverVariant(line, { F, M, C }, { nu = Infinity, spreadMult = 1, shift = 1 } = {}) {
  if (nu === Infinity && spreadMult === 1 && shift === 1) return probOverContinuous(line, F, M, C);
  const f = F * shift;
  const m = M * shift;
  const c = C * shift;
  const q = nu === Infinity ? Z75 : tQuantile75(nu);
  const eps = Math.max(0.05, Math.abs(m) * 0.01);
  const sl = (Math.max(m - f, eps) / q) * spreadMult;
  const sh = (Math.max(c - m, eps) / q) * spreadMult;
  const z = line <= m ? (line - m) / sl : (line - m) / sh;
  return 1 - (nu === Infinity ? normalCdf(z) : tCdf(z, nu));
}

// ---------------------------------------------------------------------------
// Where on the curve a line sits
// ---------------------------------------------------------------------------

// How many of the projection's own standard deviations the line is from its
// median (negative: the projection says the Over is likely). Uses the same
// half-scales as the price.
export function curvePosition(line, { F, M, C }) {
  const eps = Math.max(0.05, Math.abs(M) * 0.01);
  const sl = Math.max(M - F, eps) / Z75;
  const sh = Math.max(C - M, eps) / Z75;
  return line <= M ? (line - M) / sl : (line - M) / sh;
}

export const POSITION_BINS = [
  { label: "far under  z < -1.5", test: (z) => z < -1.5 },
  { label: "under     -1.5..-0.67", test: (z) => z >= -1.5 && z < -0.67 },
  { label: "lean under -0.67..0", test: (z) => z >= -0.67 && z < 0 },
  { label: "lean over   0..0.67", test: (z) => z >= 0 && z < 0.67 },
  { label: "over      0.67..1.5", test: (z) => z >= 0.67 && z < 1.5 },
  { label: "far over   z > 1.5", test: (z) => z >= 1.5 },
];

export const binOf = (z) => POSITION_BINS.findIndex((b) => b.test(z));

// ---------------------------------------------------------------------------
// Fitting one dial
// ---------------------------------------------------------------------------

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// The Brier score of a probability forecaster over rows with outcome `y`.
export const brier = (rows, p) => mean(rows.map((r) => (p(r) - r.y) ** 2));

// The value in `grid` that minimises the Brier score of `price(row, value)`.
// Returns { best, scores } with a score per grid point, so a report can show the
// whole curve and not just its minimum: a flat curve means the dial barely
// matters, a steep one that it does.
export function bestOnGrid(rows, grid, price) {
  const scores = grid.map((v) => brier(rows, (r) => price(r, v)));
  let bi = 0;
  scores.forEach((s, i) => {
    if (s < scores[bi]) bi = i;
  });
  return { best: grid[bi], bestScore: scores[bi], scores };
}
