// Distribution lab: is a two-piece normal the right shape for a player stat, and
// does a model of how the spread GROWS with the mean price it any better?
// Pure, no I/O, no unseeded randomness — tested in dist-lab.test.mjs.
//
// ---------------------------------------------------------------------------
// The families
// ---------------------------------------------------------------------------
//   tpn         the production model (probability.mjs): two normal halves
//               through Floor/Median/Ceiling. Symmetric tails, unbounded below,
//               no mass at zero.
//   gammaExact  a shifted gamma through all three of Floor/Median/Ceiling.
//               Right-skewed by construction; the skew is what the band's
//               asymmetry (C-M)/(M-F) selects. Can sit above zero (loc > 0).
//   gammaLS     an unshifted gamma on [0, inf) fitted to the three points by
//               least squares. Two parameters, so it cannot honour all three;
//               it keeps the "stats are non-negative" property.
//   gammaLaw    gamma with mean mu from the projection and VARIANCE FROM A LAW,
//                   Var = phi * mu^p,
//               fitted on earlier weeks' actuals. The Floor/Ceiling band is not
//               used for spread at all. spread-fit.mjs showed that band is too
//               narrow by a factor that moves week to week; this asks whether
//               the spread is better predicted by the mean alone.
//   tweedie     compound Poisson-gamma with the same mean-variance law
//               (1 < p < 2): a Poisson number of opportunities, each paying a
//               gamma amount. Has a point mass at zero, which every other
//               family lacks and which is where low rec/rush lines live.
//
// ---------------------------------------------------------------------------
// What "stochastic calculus" can and cannot mean here
// ---------------------------------------------------------------------------
// A pre-game price is a statement about the TERMINAL law of the stat, and we
// have no in-game path to calibrate a diffusion to, so the SDE content is in
// which process generates the terminal law — and, concretely, in how variance
// is tied to the mean:
//   - Feller / CIR from zero,  dX = a dt + s sqrt(X) dW,  has a GAMMA terminal
//     law with Var = s^2/2 * mean: the gammaLaw family at p = 1.
//   - A constant-volatility-ratio (geometric-type) diffusion has constant CV:
//     gammaLaw at p = 2.
//   - A compound Poisson process with gamma jumps (a Levy subordinator) has the
//     Tweedie law for 1 < p < 2, and an atom at zero.
// The fitted p says which of those the data resemble. Whether a stat's variance
// is Poisson-like (p near 1) or proportional to the mean squared (p near 2) is
// exactly the thing a fixed Floor/Ceiling band cannot adapt to.

import { probOverContinuous } from "./probability.mjs";

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

// ln Gamma(z), Lanczos approximation (g = 7, n = 9), accurate to ~1e-13 for z > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
export function lnGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lnGamma(1 - z);
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Regularized lower incomplete gamma P(a, x): series for x < a + 1, continued
// fraction otherwise (Numerical Recipes gser / gcf).
export function gammaP(a, x) {
  if (!(x > 0)) return 0;
  if (!(a > 0)) return 1;
  const lg = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - lg));
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - lg) * h);
}

export const gammaCdf = (x, k, theta) => (x > 0 ? gammaP(k, x / theta) : 0);

// Standard normal CDF and quantile (Acklam, refined by one Halley step).
function erfc(x) {
  // W. J. Cody-style rational approximation via the complementary error function
  // series is overkill here; Numerical Recipes erfcc, |err| < 1.2e-7, is enough
  // for a Wilson-Hilferty starting point. Exact normal tails are not needed.
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}
export const normCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);

export function normPpf(p) {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

// Quantile of a standard (scale 1) gamma(k): Wilson-Hilferty start, then
// safeguarded Newton on P(k, x) = p.
export function gammaPpf(p, k) {
  if (!(p > 0)) return 0;
  if (!(p < 1)) return Infinity;
  const z = normPpf(p);
  const wh = k * Math.pow(Math.max(1e-9, 1 - 1 / (9 * k) + z / (3 * Math.sqrt(k))), 3);
  // Below shape 1 the quantile can be astronomically small (k = 0.2 at p = 1%
  // is ~6e-11); the small-x expansion P ~ x^k / Gamma(k+1) starts it in range.
  let x = k < 1 ? Math.pow(p * Math.exp(lnGamma(k + 1)), 1 / k) : wh;
  x = Math.max(x, 1e-300);
  let lo = 0;
  let hi = Infinity;
  const lg = lnGamma(k);
  for (let i = 0; i < 60; i++) {
    const f = gammaP(k, x) - p;
    if (Math.abs(f) < 1e-12) break;
    if (f > 0) hi = Math.min(hi, x);
    else lo = Math.max(lo, x);
    const pdf = Math.exp((k - 1) * Math.log(x) - x - lg);
    let next = pdf > 0 ? x - f / pdf : NaN;
    if (!(next > lo) || !(next < hi)) next = Number.isFinite(hi) ? 0.5 * (lo + hi) : x * 2;
    if (Math.abs(next - x) < 1e-13 * x) {
      x = next;
      break;
    }
    x = next;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Gamma from quantiles
// ---------------------------------------------------------------------------

export const K_MIN = 0.15;
export const K_MAX = 3000;

function golden(f, lo, hi, iters = 22) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

// Unshifted gamma (k, theta) whose quantiles best match `points` = [{ x, p }]
// in squared error on x. For each k the best theta is a one-line regression of x
// on the standard quantiles, so only k is searched. Used for the projection
// (three points) and for a book's ladder (one point per rung).
export function fitGammaToQuantiles(points) {
  const pts = points.filter((q) => q.x > 0 && q.p > 0 && q.p < 1 && Number.isFinite(q.x));
  if (pts.length < 2) return null;
  const sseAt = (logK) => {
    const k = Math.exp(logK);
    let sxq = 0;
    let sqq = 0;
    const qs = pts.map((q) => gammaPpf(q.p, k));
    for (let i = 0; i < pts.length; i++) {
      sxq += pts[i].x * qs[i];
      sqq += qs[i] * qs[i];
    }
    const theta = sxq / sqq;
    let sse = 0;
    for (let i = 0; i < pts.length; i++) sse += (pts[i].x - theta * qs[i]) ** 2;
    return { sse, theta };
  };
  // Coarse grid first: SSE in log k is not guaranteed unimodal over the whole range.
  let bestLog = null;
  let bestSse = Infinity;
  const lo = Math.log(K_MIN);
  const hi = Math.log(K_MAX);
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const lk = lo + ((hi - lo) * i) / steps;
    const { sse } = sseAt(lk);
    if (sse < bestSse) {
      bestSse = sse;
      bestLog = lk;
    }
  }
  const w = (hi - lo) / steps;
  const lk = golden((l) => sseAt(l).sse, Math.max(lo, bestLog - w), Math.min(hi, bestLog + w), 16);
  const { theta, sse } = sseAt(lk);
  const k = Math.exp(lk);
  return { k, theta, loc: 0, mean: k * theta, sd: theta * Math.sqrt(k), sse };
}

// A shifted gamma through all three of F/M/C exactly: the shape is the one whose
// quantile asymmetry (q75-q50)/(q50-q25) equals the band's (C-M)/(M-F); scale
// then fixes the width and the shift fixes the median. A band that is not
// right-skewed (C-M <= M-F) is outside the family's range and is returned as
// the K_MAX (near-symmetric) limit rather than failing.
export function fitGammaExact({ F, M, C }) {
  if (!(F > 0 && M > F && C > M)) return null;
  const r = (C - M) / (M - F);
  const asym = (k) => {
    const q25 = gammaPpf(0.25, k);
    const q50 = gammaPpf(0.5, k);
    const q75 = gammaPpf(0.75, k);
    return (q75 - q50) / (q50 - q25);
  };
  let k;
  if (r <= asym(K_MAX)) k = K_MAX;
  else if (r >= asym(K_MIN)) k = K_MIN;
  else {
    let lo = Math.log(K_MIN);
    let hi = Math.log(K_MAX);
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      // asym decreases in k: too skewed means k too small.
      if (asym(Math.exp(mid)) > r) lo = mid;
      else hi = mid;
    }
    k = Math.exp(0.5 * (lo + hi));
  }
  const q25 = gammaPpf(0.25, k);
  const q50 = gammaPpf(0.5, k);
  const q75 = gammaPpf(0.75, k);
  const theta = (C - F) / (q75 - q25);
  const loc = M - theta * q50;
  return { k, theta, loc, mean: loc + k * theta, sd: theta * Math.sqrt(k), clamped: k === K_MAX || k === K_MIN };
}

// ---------------------------------------------------------------------------
// CDFs, as functions of x, for every family
// ---------------------------------------------------------------------------

export const gammaFitCdf = (fit) => (x) => (x <= fit.loc ? 0 : gammaP(fit.k, (x - fit.loc) / fit.theta));
export const tpnCdf = ({ F, M, C }) => (x) => 1 - probOverContinuous(x, F, M, C);

// Gamma with mean mu and Var = phi * mu^p.
export function gammaLawFit(mu, phi, p) {
  const v = phi * Math.pow(mu, p);
  return { k: (mu * mu) / v, theta: v / mu, loc: 0, mean: mu, sd: Math.sqrt(v) };
}
export const gammaLawCdf = (mu, phi, p) => gammaFitCdf(gammaLawFit(mu, phi, p));

// Compound Poisson-gamma (Tweedie, 1 < p < 2) with mean mu and Var = phi mu^p.
//   N ~ Poisson(lambda),  each jump ~ Gamma(alpha, scale g),  X = sum of N jumps
//   lambda = mu^(2-p) / (phi (2-p)),  alpha = (2-p)/(p-1),  g = phi (p-1) mu^(p-1)
export function tweedieParams(mu, phi, p) {
  return {
    lambda: Math.pow(mu, 2 - p) / (phi * (2 - p)),
    alpha: (2 - p) / (p - 1),
    scale: phi * (p - 1) * Math.pow(mu, p - 1),
  };
}

const MAX_LAMBDA = 4000;

export function tweedieCdf(mu, phi, p) {
  const { lambda: lam0, alpha, scale } = tweedieParams(mu, phi, p);
  const lambda = Math.min(lam0, MAX_LAMBDA);
  const sd = Math.sqrt(lambda);
  const nLo = Math.max(1, Math.floor(lambda - 9 * sd - 8));
  const nHi = Math.ceil(lambda + 9 * sd + 12);
  const lnL = Math.log(lambda);
  const weights = [];
  for (let n = nLo; n <= nHi; n++) weights.push(Math.exp(-lambda + n * lnL - lnGamma(n + 1)));
  const atom = Math.exp(-lambda);
  return (x) => {
    if (x < 0) return 0;
    let s = atom;
    if (x === 0) return s;
    const z = x / scale;
    for (let n = nLo, i = 0; n <= nHi; n++, i++) s += weights[i] * gammaP(n * alpha, z);
    return Math.min(1, s);
  };
}

// ---------------------------------------------------------------------------
// From a cumulative function to the quantities a price or a score needs
// ---------------------------------------------------------------------------

// P(actual > line) for a count or a yardage total, which is an integer. A
// half-point line is P(X > line) under the convention that integer a is the
// interval [a - 1/2, a + 1/2); a whole-number line can push, and the question
// the grader asks is P(over | no push). Applied identically to every family so
// the comparison does not depend on how each handles the integer lattice.
export function probOver(cdf, line) {
  if (Number.isInteger(line)) {
    const hi = cdf(line + 0.5);
    const lo = cdf(line - 0.5);
    const noPush = 1 - (hi - lo);
    return noPush > 1e-9 ? (1 - hi) / noPush : 0.5;
  }
  return 1 - cdf(line);
}

// Likelihood of an observed integer total a: the mass in [a - 1/2, a + 1/2).
export function massAt(cdf, a) {
  return Math.max(1e-12, cdf(a + 0.5) - cdf(a - 0.5));
}

// Probability integral transform of an observed a, randomised-free: the mid-rank
// F(a - 1/2) + (F(a + 1/2) - F(a - 1/2)) / 2, which is uniform for a calibrated
// discrete forecast.
export function pitMid(cdf, a) {
  const lo = cdf(a - 0.5);
  const hi = cdf(a + 0.5);
  return lo + (hi - lo) / 2;
}

// ---------------------------------------------------------------------------
// Fitting a variance law to actuals
// ---------------------------------------------------------------------------

// A normal with the same mean and variance law: the CONTROL for the others. It
// has the identical spread and so isolates what the gamma/Tweedie SHAPE adds.
export const normalLawCdf = (mu, phi, p) => {
  const s = Math.sqrt(phi * Math.pow(mu, p));
  return (x) => normCdf((x - mu) / s);
};

export const LAW_FAMILIES = {
  gamma: { pGrid: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5], cdf: (mu, phi, p) => gammaLawCdf(mu, phi, p) },
  tweedie: { pGrid: [1.02, 1.05, 1.1, 1.3, 1.5, 1.7, 1.9], cdf: (mu, phi, p) => tweedieCdf(mu, phi, p) },
  normal: { pGrid: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5], cdf: (mu, phi, p) => normalLawCdf(mu, phi, p) },
};

export const MIN_LAW_PAIRS = 60;

// pairs: [{ mu, a }]. Returns the (phi, p) maximising the discretised
// log-likelihood of the actuals, with phi searched on a log scale around its
// moment estimate for each p on the family's grid.
export function fitLaw(pairs, family = "gamma", { pGrid } = {}) {
  const fam = LAW_FAMILIES[family];
  const use = pairs.filter((x) => x.mu > 0 && Number.isFinite(x.a));
  if (use.length < MIN_LAW_PAIRS) return null;
  const grid = pGrid ?? fam.pGrid;
  let best = null;
  for (const p of grid) {
    let m2 = 0;
    for (const x of use) m2 += ((x.a - x.mu) ** 2) / Math.pow(x.mu, p);
    const phi0 = Math.max(1e-6, m2 / use.length);
    const ll = (logPhi) => {
      const phi = Math.exp(logPhi);
      let s = 0;
      for (const x of use) s += Math.log(massAt(fam.cdf(x.mu, phi, p), x.a));
      return -s;
    };
    const logPhi = golden(ll, Math.log(phi0) - 2.5, Math.log(phi0) + 2.5, 14);
    const nll = ll(logPhi);
    if (!best || nll < best.nll) best = { family, p, phi: Math.exp(logPhi), nll, ll: -nll / use.length, n: use.length };
  }
  return best;
}

// The mean mu of a gamma-law forecast whose `q`-quantile sits at x (q = 0.5 for
// "the line is the median"). Solved on mu with Wilson-Hilferty for the
// quantile, which is exact to a few parts in a thousand for k above ~1 and far
// cheaper than inverting the incomplete gamma inside a fit.
export function meanFromQuantile(x, q, phi, p) {
  if (!(x > 0)) return null;
  const z = normPpf(q);
  const quant = (mu) => {
    const v = phi * Math.pow(mu, p);
    const k = (mu * mu) / v;
    return mu * Math.pow(Math.max(0, 1 - 1 / (9 * k) + z / (3 * Math.sqrt(k))), 3);
  };
  let lo = x * 0.2;
  let hi = x * 5 + 5;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (quant(mid) < x) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

export const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
export const brier = (rows, p) => mean(rows.map((r) => (p(r) - r.y) ** 2));
export const logLoss = (rows, p) =>
  mean(
    rows.map((r) => {
      const q = Math.min(0.999, Math.max(0.001, p(r)));
      return r.y ? -Math.log(q) : -Math.log(1 - q);
    })
  );

// Seeded generator for tests and any bootstrap (mulberry32).
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
