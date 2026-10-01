// Pricing a line instead of merely disagreeing with one. Pure — no I/O, no
// unseeded randomness, unit tested directly (see pricing.test.mjs).
//
// ---------------------------------------------------------------------------
// What this is for
// ---------------------------------------------------------------------------
// Everything else in the betting path treats the projection as the price and
// the market as the yardstick: Edge = OurProb - ImpliedProb. That framing can
// only ever ask "do we disagree?", and it answers with a number that is large
// exactly where our model is worst, because disagreement and error are the
// same measurement when the market is right.
//
// This module asks the other question: given BOTH the projection distribution
// and what the books are charging, what is the best available estimate of
// P(actual > line)? That is a forecasting problem with a ground truth, so it
// can be scored properly — Brier, log loss, reliability — rather than argued
// about via ROI on a few hundred bets.
//
// ---------------------------------------------------------------------------
// The model: the market price, plus however much of our disagreement we believe
// ---------------------------------------------------------------------------
//     logit(p) = a + c * logit(p_market) + b * [logit(p_proj) - logit(p_market)]
//
// Three parameters, fitted by minimizing log loss against realized outcomes.
// Every number in it means something:
//
//   b  how much of our DISAGREEMENT with the market to believe. b = 0 means
//      price off the book and ignore the projection entirely; b = 1 means
//      take the projection at face value. This is the single most important
//      number the report produces, it is the direct answer to "are the
//      projections worth anything on top of the market", and it is worth
//      being genuinely open to b = 0.
//   c  how much the market is worth. Expected near 1, since a de-vigged
//      consensus is already a calibrated probability.
//   a  a global over/under tilt. calibration.mjs documents a systematic
//      over-prediction of overs; this is where that gets corrected.
//
// This is algebraically the same three-parameter family as the more obvious
// `a + b*logit(p_proj) + c*logit(p_market)`, and it is written this way on
// purpose. Fitted in the obvious form on real data, the two slopes are badly
// collinear — the projection and the market agree most of the time, which is
// exactly the condition under which a regression cannot tell their
// contributions apart. Measured on 2026 weeks 1-3, passing yards fitted to
// b = -0.58 against c = +2.18: a pair that reproduces the data and means
// nothing individually, and that predicts a near-certain Over for any market
// where the projection is confidently Under. Rewriting the second predictor
// as the DIFFERENCE makes it close to orthogonal to the first, so b is
// identified, stable, and reads as a shrinkage factor on our own opinion.
//
// Why a linear pool in logits rather than something richer: at n in the low
// thousands, three parameters is already most of what the data can support.
// A gradient-boosted anything would fit the 2026 sample beautifully and tell
// you nothing about 2027. The deliberate simplicity is the point — and b is
// interpretable in a way a tree ensemble's feature importance is not.
//
// ---------------------------------------------------------------------------
// Per-stat parameters, and why the shrinkage happens inside the likelihood
// ---------------------------------------------------------------------------
// calibration.mjs establishes that the projections are NOT uniformly
// miscalibrated — passing yards are over-dispersed (bands too wide) while
// rushing yards under 5 are catastrophically over-confident. One global b
// cannot express that. So each stat gets its own (a, b, c).
//
// But rushAtt has 98 markets across three weeks and passTD has 45. A per-stat
// fit on 45 rows is noise wearing a coefficient's clothes, so it has to be
// pulled toward the global fit. The obvious way to do that — fit each stat on
// its own, then average the coefficients with the global ones — was tried
// here first and is WRONG, in a way worth recording because it looks correct:
//
//     theta_stat = lambda * theta_own + (1 - lambda) * theta_global
//
// That formula assumes theta_own is a noisy but finite estimate. On small
// samples it is frequently neither. Logistic regression on 17 near-separable
// rows does not return a noisy coefficient, it returns a divergent one:
// measured on 2026 week-3 passTD, the own fit came back a = +4.5, c = +15.8,
// b = -85.0. Averaging that in at lambda = 0.08 still leaves b = -6.6, and
// the resulting model priced Josh Allen Over 4.5 passing TDs at 53% against a
// market price of 3.8%. Eight percent of a divergent number is a divergent
// number.
//
// So the shrinkage is applied where it belongs: as a Gaussian prior in the
// fit itself. Each stat is fitted with a quadratic penalty pulling its
// coefficients toward the GLOBAL fit, with strength K measured in
// observations:
//
//     minimize  [ log loss over this stat's rows ] + (K/2) * ||theta - theta_global||^2
//
// Now a stat with 45 rows against K = 200 cannot move far from the global fit
// no matter how separable its sample is, because the penalty grows
// quadratically while the likelihood gain saturates. The interpolation is the
// same one the averaging formula was reaching for — at large n the penalty
// becomes negligible and the stat gets its own fit — but it is bounded, which
// the averaging was not.
//
// The global fit is itself penalized, weakly, toward the null model
// `logit(p) = logit(p_market)` — believe the book, add nothing. That is the
// honest prior for this problem and at 5 observations' worth against n in the
// thousands it changes nothing; it exists so a degenerate sample produces the
// market price rather than an arbitrary one.
//
// ---------------------------------------------------------------------------
// The baselines this must beat
// ---------------------------------------------------------------------------
// A model that beats a coin flip has proven nothing. The bar is the MARKET:
// if `blend` does not beat `marketRaw` out of sample, the projections add
// nothing to a price and the honest conclusion is to stop pricing off them.
// scoreAgainst() therefore reports skill against the market as the headline
// and skill against the base rate only as context.

import { logit, sigmoid } from "./consensus.mjs";
import { wilson } from "./calibration-report.mjs";

export { logit, sigmoid };

// Sample size at which a stat's own fit gets half the weight. See above.
export const DEFAULT_SHRINKAGE_K = 200;

// Logits are winsorized to +/- this before they reach the fit or a prediction.
// 6 corresponds to a probability of 0.25% / 99.75%, or roughly +40000 in
// American odds — beyond anything a real prop board quotes.
//
// The reason is extrapolation, not outliers. A fitted slope multiplies its
// feature, so an unbounded logit gives an unbounded response: with the stored
// probabilities clamped at 5e-5 (logit -9.9), a slope of -0.58 on a projection
// that says "essentially impossible" produced a PREDICTION of 99.7% for the
// Over. Bounding the input bounds that failure to something the fit was
// actually trained across. Applied identically in fitting and prediction, so
// the model is never evaluated outside the range it was estimated on.
export const MAX_LOGIT = 6;

const clip = (x) => Math.min(MAX_LOGIT, Math.max(-MAX_LOGIT, x));

// The feature vocabulary. `disagree` is the reparameterization described
// above: our logit minus the market's, i.e. the part of our opinion the
// market does not already hold.
const FEATURES = {
  proj: (s) => clip(logit(s.pProj)),
  market: (s) => clip(logit(s.pMarket)),
  disagree: (s) => clip(logit(s.pProj)) - clip(logit(s.pMarket)),
};

// Strength of the prior on the GLOBAL fit, in observations. Deliberately
// negligible against any real sample; it only keeps a degenerate one finite.
export const GLOBAL_PRIOR_STRENGTH = 5;

// The feature builders. Each model is defined by which columns it reads, so
// the same fitter serves all of them and they cannot drift apart.
// `prior` is the coefficient vector each model is penalized toward, and in
// every case it is the identity model — "believe this input as given". So a
// fit that learns nothing returns the input unchanged rather than something
// arbitrary, and the penalty is a statement about the world rather than a
// numerical convenience.
export const MODEL_SPECS = {
  // Constant. The no-skill forecast: everybody gets the training base rate.
  baseRate: { features: [], usesProj: false, usesMarket: false, prior: [0] },
  // The projection, recalibrated: logit(p) = a + b*logit(p_proj).
  projRecal: { features: ["proj"], usesProj: true, usesMarket: false, prior: [0, 1] },
  // The market, recalibrated: logit(p) = a + c*logit(p_market).
  marketRecal: { features: ["market"], usesProj: false, usesMarket: true, prior: [0, 1] },
  // The full pool, in the disagreement parameterization: coefficient 1 is the
  // market weight c, coefficient 2 is the disagreement weight b. The prior
  // [0, 1, 0] is exactly "price off the book".
  blend: { features: ["market", "disagree"], usesProj: true, usesMarket: true, prior: [0, 1, 0] },
};

export const MODEL_NAMES = Object.keys(MODEL_SPECS);

// A sample is { stat, pProj, pMarket, y } with y in {0,1}. Design row for a
// given spec, intercept first.
function designRow(sample, spec) {
  const row = [1];
  for (const f of spec.features) row.push(FEATURES[f](sample));
  return row;
}

// ---------------------------------------------------------------------------
// Fitting: Newton-Raphson / IRLS on the log-loss surface
// ---------------------------------------------------------------------------
// Logistic log loss is convex, so Newton converges in a handful of iterations
// from zero and there is no local minimum to worry about. Written out rather
// than pulled from a library because the whole repo is dependency-free below
// the Next.js layer, and a 3x3 solve is not worth a package.
//
// Penalized maximum likelihood: minimize log loss + (penalty/2)*||coef - prior||^2.
// `penalty` is in units of observations, so it reads directly as "this prior
// is worth N rows of data".
//
// Returns { coef, iterations, converged, n }. On a singular Hessian or a
// non-finite step it returns the prior, which is always well defined, and
// reports converged: false — a caller must never ship coefficients the
// optimizer did not actually reach.
export function fitLogistic(samples, spec, { penalty = GLOBAL_PRIOR_STRENGTH, prior, maxIter = 100, tol = 1e-9 } = {}) {
  const n = samples.length;
  const p = spec.features.length + 1;
  const mu0 = prior ?? spec.prior ?? new Array(p).fill(0);
  if (mu0.length !== p) throw new Error(`Prior has ${mu0.length} entries, model needs ${p}`);
  if (n === 0) return { coef: [...mu0], iterations: 0, converged: false, n };

  const X = samples.map((s) => designRow(s, spec));
  const y = samples.map((s) => s.y);

  // Start at the prior. Newton on a strictly convex objective reaches the
  // same optimum from anywhere, and starting at the prior means an
  // early break leaves us somewhere defensible.
  const coef = [...mu0];

  let iterations = 0;
  let converged = false;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const grad = new Array(p).fill(0);
    const hess = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < p; j++) z += coef[j] * X[i][j];
      const mu = sigmoid(z);
      const w = Math.max(mu * (1 - mu), 1e-10);
      const r = y[i] - mu;
      for (let j = 0; j < p; j++) {
        grad[j] += r * X[i][j];
        for (let k = 0; k < p; k++) hess[j][k] += w * X[i][j] * X[i][k];
      }
    }
    // The prior. Penalizing every coefficient including the intercept is
    // deliberate: for a per-stat fit the prior IS the global fit, and a stat
    // should not be free to move its intercept arbitrarily on 17 rows either.
    for (let j = 0; j < p; j++) {
      grad[j] -= penalty * (coef[j] - mu0[j]);
      hess[j][j] += penalty;
    }

    const step = solve(hess, grad);
    if (!step) return { coef: [...mu0], iterations, converged: false, n };
    let maxStep = 0;
    for (let j = 0; j < p; j++) {
      coef[j] += step[j];
      maxStep = Math.max(maxStep, Math.abs(step[j]));
    }
    if (!coef.every(Number.isFinite)) return { coef: [...mu0], iterations, converged: false, n };
    if (maxStep < tol) {
      converged = true;
      break;
    }
  }
  return { coef, iterations, converged, n };
}

// Gaussian elimination with partial pivoting. Returns null if singular.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

// ---------------------------------------------------------------------------
// The hierarchical fit: one global model plus shrunk per-stat models
// ---------------------------------------------------------------------------
// Returns a fitted object with a predict(sample) method, plus the coefficients
// for reporting. Everything it needs to predict is in the returned value, so a
// fit can be JSON-serialized, committed, and re-loaded by the capture script
// without re-running the fit.
export function fitPricingModel(samples, modelName, { shrinkageK = DEFAULT_SHRINKAGE_K } = {}) {
  const spec = MODEL_SPECS[modelName];
  if (!spec) throw new Error(`Unknown pricing model: ${modelName}`);

  const usable = samples.filter((s) => isUsable(s, spec));
  const global = fitLogistic(usable, spec, { penalty: GLOBAL_PRIOR_STRENGTH, prior: spec.prior });

  const byStat = new Map();
  for (const s of usable) {
    if (!byStat.has(s.stat)) byStat.set(s.stat, []);
    byStat.get(s.stat).push(s);
  }

  const stats = {};
  for (const [stat, rows] of byStat) {
    const fit = fitLogistic(rows, spec, { penalty: shrinkageK, prior: global.coef });
    stats[stat] = {
      n: rows.length,
      // How much of this stat's fit is its own evidence rather than the
      // global prior. Descriptive only — the coefficients come from the
      // penalized fit, not from averaging by this number — but it is the
      // right scale for reading the table, since the penalty is expressed in
      // observations and this is the share the stat's own rows carry.
      ownWeight: rows.length / (rows.length + shrinkageK),
      converged: fit.converged,
      // A fit the optimizer never reached falls back to the global
      // coefficients entirely.
      coef: fit.converged ? fit.coef : [...global.coef],
    };
  }

  return {
    model: modelName,
    features: spec.features,
    shrinkageK,
    n: usable.length,
    global: global.coef,
    converged: global.converged,
    stats,
  };
}

// Does this row carry the inputs the model reads? A model that reads the
// market needs a market probability; one that doesn't, doesn't. Checking per
// model rather than globally matters: dropping every row without a market
// prior would change the sample the projection-only baseline is scored on,
// and then the comparison between models would be a comparison between
// datasets rather than between models.
export function hasFeatures(sample, spec) {
  if (!sample) return false;
  if (spec.usesProj && !isProb(sample.pProj)) return false;
  if (spec.usesMarket && !isProb(sample.pMarket)) return false;
  return true;
}

// Can this sample be FITTED on? Same inputs, plus a label. Prediction
// deliberately does not require one — a live market has no outcome yet, and
// that is the case the capture script runs in.
export function isUsable(sample, spec) {
  return hasFeatures(sample, spec) && (sample?.y === 0 || sample?.y === 1);
}

const isProb = (x) => Number.isFinite(x) && x > 0 && x < 1;

// Predict with a fitted model. Falls back to the global coefficients for a
// stat the fit never saw, which is the right behaviour for a new market
// appearing mid-season.
export function predict(fit, sample) {
  const spec = MODEL_SPECS[fit.model];
  if (!spec || !hasFeatures(sample, spec)) return null;
  const coef = fit.stats?.[sample.stat]?.coef ?? fit.global;
  const row = designRow(sample, spec);
  let z = 0;
  for (let j = 0; j < coef.length; j++) z += coef[j] * row[j];
  return sigmoid(z);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
// Brier and log loss are both proper, and they disagree in a way worth
// keeping: Brier is a squared error and so forgives a confident miss far more
// than log loss does. Prop pricing lives on longshots, where a model that
// says 2% about something that happens is making a much worse mistake than
// the squared error suggests. Report both; trust log loss when they conflict.
export function scoreProbabilities(pairs) {
  const rows = pairs.filter((r) => isProb(r.p) && (r.y === 0 || r.y === 1));
  const n = rows.length;
  if (n === 0) return { n: 0, brier: null, logLoss: null, baseRate: null, meanPred: null };

  let brier = 0;
  let ll = 0;
  let sumY = 0;
  let sumP = 0;
  for (const { p, y } of rows) {
    brier += (p - y) ** 2;
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    sumY += y;
    sumP += p;
  }
  return {
    n,
    brier: brier / n,
    logLoss: ll / n,
    baseRate: sumY / n,
    meanPred: sumP / n,
  };
}

// Skill = 1 - score/reference. Positive means better than the reference;
// 0 means no better. Expressed against an explicit reference rather than a
// hard-coded base rate because the reference that matters here is the market.
export function skill(score, reference) {
  if (!Number.isFinite(score) || !Number.isFinite(reference) || reference <= 0) return null;
  return 1 - score / reference;
}

// Reliability table: bucket by predicted probability, compare mean prediction
// to observed frequency, with a Wilson interval on the observation.
//
// A bucket whose interval excludes its own mean prediction is a real
// miscalibration at that confidence level, not noise — the same reading the
// dashboard's coverage cards already use.
export const DEFAULT_RELIABILITY_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export function reliability(pairs, edges = DEFAULT_RELIABILITY_EDGES) {
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    buckets.push({ lo: edges[i], hi: edges[i + 1], n: 0, sumP: 0, k: 0 });
  }
  for (const { p, y } of pairs) {
    if (!isProb(p) || !(y === 0 || y === 1)) continue;
    let idx = buckets.findIndex((b) => p >= b.lo && p < b.hi);
    if (idx === -1) idx = buckets.length - 1; // p === 1 lands in the top bucket
    buckets[idx].n++;
    buckets[idx].sumP += p;
    buckets[idx].k += y;
  }
  return buckets
    .filter((b) => b.n > 0)
    .map((b) => {
      const observed = b.k / b.n;
      const ci = wilson(b.k, b.n);
      return {
        lo: b.lo,
        hi: b.hi,
        n: b.n,
        meanPred: b.sumP / b.n,
        observed,
        ci,
        // Is the gap bigger than sampling noise? The test the dashboard uses.
        significant: b.sumP / b.n < ci.lo || b.sumP / b.n > ci.hi,
      };
    });
}

// ---------------------------------------------------------------------------
// Walk-forward evaluation
// ---------------------------------------------------------------------------
// The only evaluation that can argue for shipping this. An in-sample fit
// beats every baseline by construction — it was chosen to — which is exactly
// the trap calibration-report.mjs section 3 exists to avoid, and this is the
// same discipline applied to the pricing model.
//
// Fit on weeks <= k, score week k+1, pool the out-of-sample predictions across
// every k. `minTrainWeeks` is how many weeks must be in hand before the first
// prediction is made.
//
// Returns { folds, pooled } where pooled is the concatenation of every
// out-of-sample prediction, ready for scoreProbabilities/reliability.
export function walkForward(samples, modelName, { minTrainWeeks = 1, shrinkageK = DEFAULT_SHRINKAGE_K } = {}) {
  const weeks = [...new Set(samples.map((s) => s.week))].sort((a, b) => a - b);
  const folds = [];
  const pooled = [];

  for (let i = minTrainWeeks; i < weeks.length; i++) {
    const testWeek = weeks[i];
    const train = samples.filter((s) => s.week < testWeek);
    const test = samples.filter((s) => s.week === testWeek);
    const fit = fitPricingModel(train, modelName, { shrinkageK });
    const preds = [];
    for (const s of test) {
      const p = predict(fit, s);
      if (p === null) continue;
      preds.push({ ...s, p });
    }
    folds.push({ testWeek, trainN: fit.n, testN: preds.length, fit, preds });
    pooled.push(...preds);
  }

  return { folds, pooled };
}

// ---------------------------------------------------------------------------
// Comparing two forecasts: the paired Brier difference, clustered by player
// ---------------------------------------------------------------------------
// The naive standard error on a Brier difference treats every market as an
// independent observation. On this data that is badly wrong, and not by a
// small factor.
//
// A week's capture is a handful of games' worth of alternate lines. 2026
// week 3 holds 1,594 markets drawn from THREE fixtures and 28 players; Lamar
// Jackson alone accounts for 309 quoted rows. Over 274.5 passing yards, over
// 284.5 and over 294.5 are not three observations about whether our pricing
// is right — they are one quarterback having one game, and they resolve
// together. Counting them as 1,594 shrinks the standard error by roughly
// sqrt(1594/28) = 7.5x and manufactures significance out of alt lines.
//
// So the difference is clustered on (week, player): observations inside a
// cluster may be arbitrarily correlated, and only the cluster totals are
// treated as independent. This is the ordinary cluster-robust (CR0) variance
// with the usual G/(G-1) small-sample correction.
//
// `rows` are { p, q, y, cluster } where p is the model under test and q the
// reference. Returns the mean of (p-y)^2 - (q-y)^2 — negative means p is
// better — with both standard errors, so the report can show how much of the
// apparent significance was an artifact of counting alt lines.
export function pairedBrierDiff(rows) {
  const usable = rows.filter(
    (r) => Number.isFinite(r.p) && Number.isFinite(r.q) && (r.y === 0 || r.y === 1)
  );
  const n = usable.length;
  if (n < 2) return { n, clusters: 0, mean: null, se: null, naiveSe: null, z: null, naiveZ: null };

  const d = usable.map((r) => (r.p - r.y) ** 2 - (r.q - r.y) ** 2);
  const mean = d.reduce((a, b) => a + b, 0) / n;

  const varNaive = d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  const naiveSe = Math.sqrt(varNaive / n);

  const byCluster = new Map();
  usable.forEach((r, i) => {
    const key = r.cluster ?? i; // no cluster given -> each row is its own
    byCluster.set(key, (byCluster.get(key) ?? 0) + (d[i] - mean));
  });
  const G = byCluster.size;
  let sumSq = 0;
  for (const s of byCluster.values()) sumSq += s * s;
  const correction = G > 1 ? G / (G - 1) : 1;
  const se = Math.sqrt((correction * sumSq) / (n * n));

  return {
    n,
    clusters: G,
    mean,
    se,
    naiveSe,
    z: se > 0 ? mean / se : null,
    naiveZ: naiveSe > 0 ? mean / naiveSe : null,
  };
}

// The cluster key: one player's one game. Every market on him that week
// resolves off the same performance.
export function clusterKey(sample) {
  return `${sample.week}|${sample.playerId}`;
}
