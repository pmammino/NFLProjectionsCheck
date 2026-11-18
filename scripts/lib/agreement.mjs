// Does it pay to move the price harder when the projection and the sharp books
// lean the same way? Pure — no I/O, unit tested (agreement.test.mjs). The report
// is scripts/agreement-study.mjs.
//
// ---------------------------------------------------------------------------
// Why this needs its own module
// ---------------------------------------------------------------------------
// The observation that prompted it came from paper trading: a subset of bets
// looks profitable when the projection shows an edge AND the sharp books agree
// that the price is off. Both halves of that sentence hide a trap.
//
//   1. It is a SUBSET picked from a grid. Edge >= 3%, sharp confirm >= 2%,
//      "first capture" or "every capture", one rung or all of them: every
//      combination is a different subset, and with a few hundred bets a cell with
//      a 14% ROI turns up by chance in a large share of grids. A subset that was
//      found by looking is a hypothesis, and has to be tested on rows that were
//      not used to find it.
//
//   2. "Agrees" is not one thing. The sharp books are already INSIDE the pool the
//      pricing algorithm quotes (Pinnacle carries the largest weight), so the
//      gap between "the sharp books" and "the price" is small by construction
//      and the two operationalisations below measure different questions.
//
// Two definitions, because the data supports one of them far better:
//
//   books   The books' lead-weighted pool against the plain median of the same
//           books. The weights are the ones source-weights.mjs measured (how much
//           of a book's early disagreement the rest of the market adopted), so
//           "the weighted pool has moved off the median" reads "the books that
//           lead the market are somewhere the herd is not". Available on every
//           market with two books — tens of thousands of rows.
//
//   sharp   Pinnacle/Circa alone against the pool. The literal reading of "the
//           sharpest books agree", and the one the paper-trading filter uses. It
//           is available on about 7% of markets (Pinnacle prices the main line,
//           not the ladder), and where it is, it sits within ~0.03 logit of the
//           pool, so most of what it splits is noise-sized.
//
// Whichever definition, the projection "agrees" when it sits on the same side of
// the reference as the sharp signal does.

import { fitProjectionShare, MAX_DEVIATION } from "./source-weights.mjs";
import { sigmoid } from "./consensus.mjs";
import { pairedBrierDiff } from "./pricing.mjs";

// How far (in logit points) the sharp signal has to sit from its reference
// before it counts as leaning at all. 0.03 logit is about 0.75 points of
// probability at a coin flip — the order of one book's rounding. Below it the
// "direction" is not a measurement.
export const MIN_SHIFT = 0.03;

export const DEFINITIONS = ["books", "sharp"];

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// "agree" | "disagree" | "flat" | null.
//   agree     the sharp signal leans one way and the projection the same way
//   disagree  they lean opposite ways
//   flat      the sharp signal is not leaning (inside MIN_SHIFT)
//   null      the definition cannot be evaluated for this market (no sharp quote)
//
// `m` is { lBooks, lUnweighted, lProj, lSharp }, all logits of P(over).
export function classify(m, definition, { minShift = MIN_SHIFT } = {}) {
  let shift;
  let gap;
  if (definition === "books") {
    if (![m.lBooks, m.lUnweighted, m.lProj].every(Number.isFinite)) return null;
    shift = m.lBooks - m.lUnweighted;
    gap = m.lProj - m.lUnweighted;
  } else if (definition === "sharp") {
    if (![m.lBooks, m.lSharp, m.lProj].every(Number.isFinite)) return null;
    shift = m.lSharp - m.lBooks;
    gap = m.lProj - m.lBooks;
  } else {
    throw new Error(`Unknown agreement definition: ${definition}`);
  }
  if (Math.abs(shift) <= minShift) return "flat";
  if (gap === 0) return "disagree"; // a projection on the reference does not back the lean
  return sign(shift) === sign(gap) ? "agree" : "disagree";
}

// ---------------------------------------------------------------------------
// Cluster-robust summaries
// ---------------------------------------------------------------------------
// Every row in this study is one of many on the same player-week (a ladder of
// lines, several captures), and they resolve together. Counting them as
// independent shrinks every error bar by the square root of the ladder depth.
// Same CR0 estimator with the G/(G-1) correction as pricing.pairedBrierDiff.

// Mean of `value(item)` with a cluster-robust standard error and 95% half-width.
// Items whose value is null/NaN are dropped, not counted as zero.
export function clusterMean(items, value, clusterOf) {
  const rows = [];
  for (const it of items ?? []) {
    const v = value(it);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    rows.push({ v, c: clusterOf(it) });
  }
  const n = rows.length;
  if (n === 0) return { n: 0, clusters: 0, mean: null, se: null, half: null, z: null };
  const mean = rows.reduce((a, r) => a + r.v, 0) / n;
  const by = new Map();
  for (const r of rows) by.set(r.c, (by.get(r.c) ?? 0) + (r.v - mean));
  const G = by.size;
  if (G < 2) return { n, clusters: G, mean, se: null, half: null, z: null };
  let ss = 0;
  for (const s of by.values()) ss += s * s;
  const se = Math.sqrt((G / (G - 1)) * ss) / n;
  return { n, clusters: G, mean, se, half: 1.96 * se, z: se > 0 ? mean / se : null };
}

// Least squares with a cluster-robust covariance. `X` rows are regressors
// (include a 1 for an intercept), `y` the response, `clusters` one key per row.
// Returns { beta, se, n, clusters } or null if the normal equations are singular.
export function olsCluster(X, y, clusters) {
  const n = y.length;
  if (n === 0) return null;
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return null;
  const beta = inv.map((row) => row.reduce((a, v, j) => a + v * Xty[j], 0));

  const scores = new Map();
  for (let i = 0; i < n; i++) {
    let fit = 0;
    for (let j = 0; j < p; j++) fit += X[i][j] * beta[j];
    const e = y[i] - fit;
    const k = clusters[i];
    if (!scores.has(k)) scores.set(k, new Array(p).fill(0));
    const s = scores.get(k);
    for (let a = 0; a < p; a++) s[a] += X[i][a] * e;
  }
  const G = scores.size;
  if (G < 2 || n <= p) return { beta, se: beta.map(() => null), n, clusters: G };
  const meat = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const s of scores.values()) for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) meat[a][b] += s[a] * s[b];
  const c = (G / (G - 1)) * ((n - 1) / (n - p));
  const se = beta.map((_, a) => {
    let v = 0;
    for (let u = 0; u < p; u++) for (let w = 0; w < p; w++) v += inv[a][u] * meat[u][w] * inv[w][a];
    return Math.sqrt(Math.max(0, v * c));
  });
  return { beta, se, n, clusters: G };
}

function invert(A) {
  const m = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * m; j++) M[col][j] /= d;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = 0; j < 2 * m; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row.slice(m));
}

// ---------------------------------------------------------------------------
// Where the market goes next
// ---------------------------------------------------------------------------
// Outcomes are a coin flip per market; the closing price is not. If moving the
// price harder were right, the late board should sit further toward the
// projection (and the leaning books) than the price already does. That is a
// regression on thousands of markets with no outcome noise in it:
//
//     close - price  =  a * (projection - price)  +  b * (weighted - median)
//
// `a` is how far the late market goes toward the projection; `b` how far it
// carries on in the direction the lead-weighted books already lean (negative:
// it comes back to the median). Both in logit points, errors clustered on
// player-week, regressors clipped where the pool clips them.
export function closeMove(rows, { clip = MAX_DEVIATION } = {}) {
  const used = rows.filter((r) => [r.lBooks, r.lProj, r.lUnweighted, r.lClose].every(Number.isFinite));
  const c = (x) => Math.max(-clip, Math.min(clip, x));
  const fit = olsCluster(
    used.map((r) => [c(r.lProj - r.lBooks), r.lBooks - r.lUnweighted]),
    used.map((r) => r.lClose - r.lBooks),
    used.map((r) => r.cluster)
  );
  if (!fit) return { n: used.length, clusters: new Set(used.map((r) => r.cluster)).size, proj: null, shift: null };
  const half = (i) => (Number.isFinite(fit.se[i]) ? 1.96 * fit.se[i] : null);
  return {
    n: fit.n,
    clusters: fit.clusters,
    proj: { coef: fit.beta[0], half: half(0) },
    shift: { coef: fit.beta[1], half: half(1) },
  };
}

// Does the lead-weighted pool predict the late board better than the plain median
// of the same books? Paired squared error in logit points, per market; positive
// means the pool is WORSE. The yardstick is a median of the late books, which
// favours a median predictor by construction, so read the size as well as the z.
export function poolVsMedianOnClose(rows) {
  const used = rows.filter((r) => [r.lBooks, r.lUnweighted, r.lClose].every(Number.isFinite));
  const d = clusterMean(used, (r) => (r.lClose - r.lBooks) ** 2 - (r.lClose - r.lUnweighted) ** 2, (r) => r.cluster);
  const mse = (f) => (used.length ? used.reduce((a, r) => a + f(r) ** 2, 0) / used.length : null);
  return { n: used.length, poolMse: mse((r) => r.lClose - r.lBooks), medianMse: mse((r) => r.lClose - r.lUnweighted), diff: d };
}

// Difference of two cluster means (a - b), treating the groups as independent.
// A bet can sit in both groups' player-weeks, so this is if anything a little
// narrow; it is the comparison that matters, not either mean on its own.
export function differenceOfMeans(a, b) {
  if (a.mean === null || b.mean === null || a.se === null || b.se === null) return { mean: null, half: null, z: null };
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  return { mean: a.mean - b.mean, half: 1.96 * se, z: se > 0 ? (a.mean - b.mean) / se : null };
}

// ---------------------------------------------------------------------------
// The projection's share, by agreement cell
// ---------------------------------------------------------------------------
// Uses the pipeline's own fit (source-weights.fitProjectionShare): one parameter,
//     logit P(over) = lBooks + share * (lProj - lBooks)
// against outcomes, clustered. `raw` is the shrunk estimate before the cautious
// treatment, with `se`; `share` is what the pipeline would actually use.
export function shareByCell(samples, definition, opts = {}) {
  const cells = { agree: [], disagree: [], flat: [] };
  for (const s of samples) {
    const k = classify(s, definition, opts);
    if (k) cells[k].push(s);
  }
  const out = {};
  for (const [k, obs] of Object.entries(cells)) out[k] = shareOf(obs);
  return out;
}

// The raw share for one set of markets, and its error — no shrinkage, no markdown.
export function shareOf(samples) {
  const fit = fitProjectionShare(samples.map(toShareObs), { priorClusters: 1e-9, caution: 0 });
  return { n: samples.length, clusters: fit.clusters, raw: fit.raw, se: fit.se, half: fit.se === null ? null : 1.96 * fit.se };
}

const toShareObs = (s) => ({ lBooks: s.lBooks, lProj: s.lProj, y: s.y, cluster: s.cluster });

// ---------------------------------------------------------------------------
// The test that decides whether to ship it: walk-forward
// ---------------------------------------------------------------------------
// "Be more aggressive when they agree" is a pricing change, and a pricing change
// is judged out of sample against the price it replaces. For each week W with
// enough history:
//
//   1. fit the projection's share in the AGREE cell, and in everything else,
//      on weeks strictly before W (nothing from W, nothing after);
//   2. price week W's markets with the cell's share:
//         logit p = (1 - share) * lBooks + share * lProj      (lProj drawn in to
//         within MAX_DEVIATION of the books, as the pool does)
//   3. score against the pool as it stands (share 0) on what happened.
//
// Two variants, because they answer different questions:
//   cautious   the pipeline's own rule — shrunk to zero, marked down a standard
//              error, floored at zero. The price this repo would actually ship.
//   point      the cell's fitted share taken at face value (floored at 0, capped).
//              The best the idea can look; if THIS does not beat the pool, nothing
//              built on it will.
//
// Returns { weeks, variants: { cautious, point } } where each variant is
// { shares: [{week, agree, other}], diff } and `diff` is the clustered paired
// Brier difference over every out-of-sample market (negative = better than the
// pool), plus the same restricted to the agree cell, where any change lives.
export function gatedWalkForward(samples, definition, { minTrainWeeks = 3, cap = 0.75, minShift = MIN_SHIFT } = {}) {
  const weeks = [...new Set(samples.map((s) => s.week))].sort((a, b) => a - b);
  const test = weeks.slice(minTrainWeeks);
  const variants = {
    cautious: { priorClusters: 150, caution: 1 },
    point: { priorClusters: 1e-9, caution: 0 },
  };

  const out = {};
  for (const [name, opts] of Object.entries(variants)) {
    const shares = [];
    const all = [];
    const inAgree = [];
    for (const w of test) {
      const train = samples.filter((s) => s.week < w);
      const agreeTrain = train.filter((s) => classify(s, definition, { minShift }) === "agree").map(toShareObs);
      const otherTrain = train.filter((s) => classify(s, definition, { minShift }) !== "agree").map(toShareObs);
      const sAgree = fitProjectionShare(agreeTrain, { ...opts, cap }).share;
      const sOther = fitProjectionShare(otherTrain, { ...opts, cap }).share;
      shares.push({ week: w, agree: sAgree, other: sOther, nAgree: agreeTrain.length, nOther: otherTrain.length });

      for (const s of samples.filter((x) => x.week === w)) {
        const isAgree = classify(s, definition, { minShift }) === "agree";
        const beta = isAgree ? sAgree : sOther;
        const lp = Math.max(s.lBooks - MAX_DEVIATION, Math.min(s.lBooks + MAX_DEVIATION, s.lProj));
        const p = sigmoid((1 - beta) * s.lBooks + beta * lp);
        const row = { p, q: sigmoid(s.lBooks), y: s.y, cluster: s.cluster };
        all.push(row);
        if (isAgree) inAgree.push(row);
      }
    }
    out[name] = { shares, diff: pairedBrierDiff(all), diffAgree: pairedBrierDiff(inAgree) };
  }
  return { weeks: test, variants: out };
}

// ---------------------------------------------------------------------------
// Bets: one per market, at the best price, at the first capture
// ---------------------------------------------------------------------------
// The paper-trading tab offers "every capture" as a timing, which counts the same
// market up to three times. For a subset hunt that is the wrong default: the three
// captures of one prop are one observation, and a cell found by counting it three
// times looks three times as large. This keeps one.
const SLOT_RANK = { main: 1, thursday: 2, saturday: 3 };

export function oneBetPerMarket(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = [r.slot, r.week, r.playerId, r.stat, r.line, r.side].join("|");
    const cur = best.get(k);
    if (!cur || decimal(r.odds) > decimal(cur.odds)) best.set(k, r);
  }
  const first = new Map();
  const keyOf = (r) => [r.week, r.playerId, r.stat, r.line, r.side].join("|");
  for (const r of best.values()) {
    const rank = SLOT_RANK[r.slot] ?? 9;
    const cur = first.get(keyOf(r));
    if (cur === undefined || rank < cur) first.set(keyOf(r), rank);
  }
  return [...best.values()].filter((r) => (SLOT_RANK[r.slot] ?? 9) === first.get(keyOf(r)));
}

export function decimal(american) {
  if (!Number.isFinite(american) || american === 0) return NaN;
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

// A one-unit bet's profit, or null when it did not settle.
//
// `conservative` counts an Over on a player the actuals feed omitted as a LOSS.
// The feed carries no all-zero rows, so a player who dressed and did nothing is
// indistinguishable from one who was inactive; settled-only drops them and so
// flatters every Over. (An Under on such a player is voided either way: the book
// would have voided it if he did not play, and we cannot tell.)
export function betProfit(bet, { conservative = true } = {}) {
  if (bet.status === "won") return decimal(bet.odds) - 1;
  if (bet.status === "lost") return -1;
  if (bet.status === "pending" && conservative && bet.side === "over") return -1;
  return null;
}

export const betCluster = (bet) => `${bet.week}|${bet.playerId}`;

// ROI and closing-line value for a set of bets, both cluster-robust.
// CLV is `closeFair - implied`: the late market's fair price for the side minus
// the break-even probability of the price taken, in probability points. It has
// the variance of a price, not of a coin flip, which is why it can say something
// about a few hundred bets when ROI cannot.
export function summarizeBets(bets, opts = {}) {
  const roi = clusterMean(bets, (b) => betProfit(b, opts), betCluster);
  const clv = clusterMean(bets, (b) => (b.closeFair === null || b.closeFair === undefined ? null : b.closeFair - b.implied), betCluster);
  const withClose = bets.filter((b) => b.closeFair !== null && b.closeFair !== undefined);
  const beat = withClose.length ? withClose.filter((b) => b.closeFair - b.implied > 0).length / withClose.length : null;
  return { bets: bets.length, roi, clv, beatClose: beat };
}

// How many more markets it takes to halve an error bar. Precision grows with the
// square root of the sample, so a result that is "±0.21" now needs four times the
// data to be "±0.10" — the number to hold against how long a season is.
export const dataToHalveError = (n) => Math.ceil(3 * n);
