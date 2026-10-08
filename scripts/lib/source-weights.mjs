// A consensus that does not treat every book as equally informed, and that
// treats our own projection as one more source whose weight is earned.
//
// Pure: no I/O, unit tested directly (source-weights.test.mjs). The report is
// scripts/source-weights.mjs; the live pricing hook is `--price-model pool` in
// capture-props.mjs.
//
// ---------------------------------------------------------------------------
// The idea
// ---------------------------------------------------------------------------
// consensus.mjs takes the median of the books' de-vigged prices, which gives a
// one-sided Hard Rock quote exactly as much say as a two-sided Pinnacle one.
// That is a choice, not a fact, and the data does not support it: when the
// opening board is compared with where the rest of the market ends up, books
// differ enormously in how much of what they said turned out to be where the
// market was going.
//
// So every source — each book, and the projection — is assessed on the same
// question, constantly, and weighted by the answer:
//
//     When this source disagreed with everybody else at the open, how much of
//     that disagreement had the REST OF THE MARKET adopted by the close?
//
// Formally, with Lo the median logit of the other sources at the early board,
// Lc the same at the close, and x the source's own early logit minus Lo:
//
//     (Lc − Lo) = lead · x + noise
//
// `lead` is a regression slope through the origin, with errors clustered on
// (week, player). 0 means the market ignored the source; 1 means it moved all
// the way to it.
//
// ---------------------------------------------------------------------------
// Why this slope is a weight and not just a correlation
// ---------------------------------------------------------------------------
// If the best estimate of the closing price is a weighted average of the early
// sources, the coefficient on one source in a regression of the *future* market
// on that source is exactly its share of the total weight: lead = w_s / Σw.
// That is the textbook forecast-combination result, and it is why a number
// that is cheap to measure (no outcomes needed, one value per market rather
// than one coin flip) can set the weights of a model whose real goal is to
// predict outcomes.
//
// The measurement excludes the source itself from the target on purpose. A book
// whose price barely moves would otherwise "lead" the market simply because its
// own close is inside the closing consensus. Sources are compared with *other
// books'* later prices only.
//
// ---------------------------------------------------------------------------
// The projection is a source too — assessed on the yardstick that suits it
// ---------------------------------------------------------------------------
// It is assessed every week alongside the books, but not on the books' yardstick.
// "Did the market later move toward it" asks whether a source is AHEAD of the
// market, which is the right question for a book posting at the open and the
// wrong one for a projection that is written daily and read on Tuesday: it can
// only be behind. Measured that way it earns nothing at any freshness (0.8% of
// the market's move on the snapshot it had at the start of the week), and that
// number cannot distinguish a projection with nothing to add from one that is
// merely late.
//
// The question that can is the one the pool actually needs answered: at the
// moment of the price, how much of the price should come from the projection
// rather than the books? That is a one-parameter logistic fit against outcomes,
// with the books' pool as the offset:
//
//     logit P(over) = L_books + share · (L_proj − L_books)
//
// `share` is 0 for "ignore the projection" and 1 for "believe it over the
// books", fitted per stat and per capture slot — because it is not one number.
// On the 2026 weeks 2–4 data, with the snapshot an hour before kickoff, it was
// 0.54 on receptions (z 2.3), 0.24 on receiving yards, ~0 on rushing yards and
// NEGATIVE on passing yards; with Tuesday's snapshot it was ~0 everywhere. A
// pool with a single projection weight averages a real signal on receptions
// with noise elsewhere and finds nothing.
//
// Two rules keep that honest.
//
//  1. POINT IN TIME. A backfilled board is priced from the week's latest
//     projection snapshot, which has absorbed everything since. Only live
//     captures (pricing-dataset isPointInTime) count, using ProjProb — what the
//     projection alone said, recorded even when a pool priced the row.
//
//  2. NO CREDIT ON ACCOUNT. A share starts at zero, is pulled toward zero by a
//     prior worth PRIOR_CLUSTERS player-weeks, and a negative fit is read as "no
//     information" and floored at zero. A cell with no live data prices on the
//     books alone.

// ---------------------------------------------------------------------------
// What the weights are NOT
// ---------------------------------------------------------------------------
// They describe an EARLY board — Tuesday or Thursday, hours to days before
// kickoff. At the close the books agree with each other (there is nothing left
// for them to lead), and these weights should not be applied there. A
// per-book difference in accuracy against OUTCOMES is not established by this
// data: it is far too noisy to say. What is established is that some books'
// early prices predict the market's later price and some do not.

import { canonicalBookKey } from "./books.mjs";
import {
  bookFairProb,
  bookInSet,
  DEFAULT_ASSUMED_HOLD,
  logit,
  median,
  sigmoid,
} from "./consensus.mjs";
import { DEFAULT_DEVIG_METHOD } from "./devig.mjs";
import { isPointInTime, isProjectionPrice } from "./pricing-dataset.mjs";

export const PROJECTION_SOURCE = "projection";

// The weight a book carries before any evidence about it exists, in the same
// units as a lead (a share of the total). About what one book of six or seven
// would hold in an equal-weight pool.
export const PRIOR_WEIGHT = 0.15;

// How many standard errors a fitted share is marked down by before it is used.
// There are a couple of dozen (stat, slot) cells and a few weeks of data in each,
// so the best-looking cell is partly luck — the winner's curse — and a share of
// 0.27 on 38 player-weeks with an error bar of ±1.2 is pricing off noise. One
// standard error means a share is used only to the extent the evidence supports
// it, and a cell that has not left its error bar is zero.
export const SHARE_CAUTION = 1;

// The most of a price the projection can ever be, however good its record. A
// ceiling on a four-week estimate, not a belief about the truth.
export const MAX_PROJECTION_SHARE = 0.75;

// Share fits use markets where the books' price is within this of 50/50 (the
// repo's "near the money"); in the tails a logit is rounding, and a projection
// that is overconfident out there would swamp the fit.
export const SHARE_BAND = 0.25;

// How much evidence it takes to outweigh the prior, in clusters (a cluster is
// one player's one game, which is what the observations are correlated on).
// At 150 a book assessed on ~450 player-weeks — about one week of the
// backfilled board — is weighted three parts evidence to one part prior.
export const PRIOR_CLUSTERS = 150;

// No source is silenced entirely. A weight of exactly zero would be a claim
// that a book carries no information, which a few weeks of data cannot support.
export const MIN_WEIGHT = 0.01;

// A source's lead is measured against the median of the OTHER sources, so at
// least this many must have quoted the market at both times.
export const MIN_OTHERS = 2;

// Only markets whose other-source price is within this distance of 50/50 are
// used. In the tails a logit is dominated by rounding in the odds and one
// market's noise would swamp the rest.
export const LEAD_BAND = 0.4;

// A vote is pulled to within this many logit points of the median before it is
// averaged. A weighted mean, unlike a median, can be dragged by one wild price;
// this bounds the damage of a stale line or a flipped market to a fixed
// distance. 1.5 logit is ~33 points at a coin flip: far wider than any real
// disagreement, narrower than an error.
export const MAX_DEVIATION = 1.5;

// Logits are bounded the same way the pricing model bounds them.
const MAX_LOGIT = 6;
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clipLogit = (p) => clip(logit(p), -MAX_LOGIT, MAX_LOGIT);

// ---------------------------------------------------------------------------
// Sources and votes
// ---------------------------------------------------------------------------

// A source is a book AND whether it quoted both sides. A two-sided quote is a
// measured fair price; a one-sided one has an assumed margin stripped from it
// and is a noisier statement from the same book. They get separate track
// records because on this data they are separate quality levels (Hard Rock's
// two-sided prices lead the market less than its one-sided ones, for one).
export const sourceKey = (book, twoSided) => `${canonicalBookKey(book)}:${twoSided ? 2 : 1}`;
export const bookOfSource = (key) => key.split(":")[0];

// One vote per book for one market: its fair P(over) as a logit, and whether it
// was measured. `rows` are { book, overOdds, underOdds } stated from the
// market's point of view, exactly as consensusProb takes them.
//
// A row quoting only the Under is mirrored (P(over) = 1 − P(under)) rather than
// dropped: it is a real price. Where a book appears twice the first row wins,
// as in consensusProb, so the two functions look at the same quotes.
export function bookVotes(rows, { assumedHold = DEFAULT_ASSUMED_HOLD, method = DEFAULT_DEVIG_METHOD, setName = "all" } = {}) {
  const seen = new Set();
  const votes = [];
  for (const r of rows ?? []) {
    if (!bookInSet(r.book, setName)) continue;
    const book = canonicalBookKey(r.book);
    if (!book || seen.has(book)) continue;

    const hasOver = r.overOdds !== null && r.overOdds !== undefined;
    const underOnly = !hasOver && r.underOdds !== null && r.underOdds !== undefined;
    const fp = bookFairProb({ overOdds: r.overOdds, underOdds: r.underOdds, side: underOnly ? "under" : "over", assumedHold, method });
    if (!fp) continue;
    const pOver = underOnly ? 1 - fp.fairProb : fp.fairProb;
    if (!(pOver > 0 && pOver < 1)) continue;

    seen.add(book);
    const twoSided = fp.source === "devig";
    votes.push({ book, key: sourceKey(book, twoSided), twoSided, logit: clipLogit(pOver), hold: fp.hold, assumedHold });
  }
  return votes;
}

const medianLogit = (votes) => median(votes.map((v) => v.logit));

// ---------------------------------------------------------------------------
// The weighted consensus
// ---------------------------------------------------------------------------

// A book's weight, falling back to its prior when it has no record.
export function weightOf(weights, key) {
  const given = weights?.[key];
  return Number.isFinite(given) ? Math.max(MIN_WEIGHT, given) : PRIOR_WEIGHT;
}

// The books' weighted consensus, with the projection's share of the price on top.
// Same contract as consensusProb — null when no BOOK produced a usable price,
// which a caller must treat as "this market has no market prior" — plus what the
// weighting did, so a report can say how far it moved the number.
//
// `projectionProb` is our own P(over) and `projectionShare` how much of the
// price it has earned (0 until it has earned some). The projection can never
// create a consensus by itself.
export function weightedConsensusProb(
  rows,
  { weights = {}, holdByStat = new Map(), stat, method = DEFAULT_DEVIG_METHOD, setName = "all", projectionProb = null, projectionShare = 0 } = {}
) {
  const assumedHold = holdByStat.get?.(stat) ?? DEFAULT_ASSUMED_HOLD;
  return poolVotes(bookVotes(rows, { assumedHold, method, setName }), { weights, projectionProb, projectionShare });
}

// The pooling itself, on votes already drawn from a market. Split out so a
// report that has the votes (and not the original odds) prices through exactly
// the code the live path does.
export function poolVotes(books, { weights = {}, projectionProb = null, projectionShare = 0 } = {}) {
  if (!books || books.length === 0) return null;

  // 1. the books: a weighted mean of logits, each drawn in to the median so one
  //    wild price cannot drag it further than MAX_DEVIATION.
  const centre = medianLogit(books);
  let sw = 0;
  let sl = 0;
  let sw2 = 0;
  for (const v of books) {
    const w = weightOf(weights, v.key);
    const l = clip(v.logit, centre - MAX_DEVIATION, centre + MAX_DEVIATION);
    sw += w;
    sl += w * l;
    sw2 += w * w;
  }
  const lBooks = sl / sw;

  // 2. the projection's share, drawn in to the same distance from the books, so
  //    a projection that is confidently far from the market is bounded by what
  //    the market says rather than by itself.
  const hasProj = projectionProb !== null && projectionProb !== undefined && Number.isFinite(projectionProb) && projectionProb > 0 && projectionProb < 1;
  const beta = hasProj ? clip(Number.isFinite(projectionShare) ? projectionShare : 0, 0, MAX_PROJECTION_SHARE) : 0;
  const lProj = hasProj ? clip(clipLogit(projectionProb), centre - MAX_DEVIATION, centre + MAX_DEVIATION) : lBooks;
  const prob = sigmoid((1 - beta) * lBooks + beta * lProj);

  const devigged = books.filter((v) => v.twoSided).length;
  const holds = books.map((v) => v.hold).filter(Number.isFinite);
  return {
    prob,
    // What the books alone said, before the projection had its share.
    booksProb: sigmoid(lBooks),
    bookCount: books.length,
    deviggedCount: devigged,
    probSource: devigged === books.length ? "devig" : devigged > 0 ? "mixed" : "assumed-hold",
    meanHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    assumedHold: devigged === books.length ? null : books[0].assumedHold ?? null,
    // Kish effective number of books: 7 at equal weight is 7; one book carrying
    // nearly everything is close to 1.
    effectiveSources: (sw * sw) / sw2,
    projectionShare: beta,
    unweighted: sigmoid(centre),
  };
}

// ---------------------------------------------------------------------------
// Assessment: how much of each source's early disagreement did the market adopt?
// ---------------------------------------------------------------------------

// Group one season's quotes into early/late pairs. `quotes` are readPropRow()
// outputs; a pair is one market on an early board together with the same market
// at the close.
//
//   earlySlots  the boards to assess (default: every slot except the close)
//   lateSlot    the board that supplies "where the market ended up"
//
// Pairs carry `projection` — our P(over) — only when it was the projection we
// actually had on that board (isPointInTime) and the row was priced from the
// projection alone (isProjectionPrice — a row priced off the pool already
// contains the books). Otherwise it is withheld from the assessment and only
// the books are measured.
export function buildLeadPairs(quotes, { lateSlot = "closing", earlySlots = null, holdByStat = new Map(), method = DEFAULT_DEVIG_METHOD, pointInTime = isPointInTime } = {}) {
  const groups = new Map();
  for (const q of quotes) {
    const key = [q.week, q.playerId, q.stat, q.line].join("|");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { week: q.week, playerId: q.playerId, stat: q.stat, line: q.line, slots: new Map() }));
    if (!g.slots.has(q.slot)) g.slots.set(q.slot, []);
    g.slots.get(q.slot).push(q);
  }

  const pairs = [];
  for (const g of groups.values()) {
    const lateRows = g.slots.get(lateSlot);
    if (!lateRows) continue;
    const assumedHold = holdByStat.get?.(g.stat) ?? DEFAULT_ASSUMED_HOLD;
    const late = bookVotes(lateRows, { assumedHold, method });
    if (late.length === 0) continue;
    for (const [slot, rows] of g.slots) {
      if (slot === lateSlot) continue;
      if (earlySlots && !earlySlots.includes(slot)) continue;
      const early = bookVotes(rows, { assumedHold, method });
      if (early.length === 0) continue;
      const first = rows[0];
      pairs.push({
        week: g.week,
        slot,
        stat: g.stat,
        playerId: g.playerId,
        line: g.line,
        cluster: `${g.week}|${g.playerId}`,
        early,
        late,
        projection: pointInTime(first) && isProjectionPrice(first) && Number.isFinite(first.probOver) ? first.probOver : null,
      });
    }
  }
  return pairs;
}

// Per-source observations { x, y, cluster } for the lead regression. Each
// source is measured against the OTHER books only (see the header).
export function leadObservations(pairs, { minOthers = MIN_OTHERS, band = LEAD_BAND } = {}) {
  const out = new Map();
  const push = (key, o) => {
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(o);
  };

  for (const p of pairs) {
    // Books: leave this book out of both medians.
    for (const v of p.early) {
      const oe = p.early.filter((u) => u.book !== v.book);
      const ol = p.late.filter((u) => u.book !== v.book);
      if (oe.length < minOthers || ol.length < minOthers) continue;
      const lo = medianLogit(oe);
      if (Math.abs(sigmoid(lo) - 0.5) > band) continue;
      push(v.key, { x: v.logit - lo, y: medianLogit(ol) - lo, cluster: p.cluster });
    }

    // The projection: measured against every book.
    if (p.projection !== null && p.projection !== undefined && p.early.length >= minOthers && p.late.length >= minOthers) {
      const lo = medianLogit(p.early);
      if (Math.abs(sigmoid(lo) - 0.5) <= band) {
        push(PROJECTION_SOURCE, { x: clipLogit(p.projection) - lo, y: medianLogit(p.late) - lo, cluster: p.cluster });
      }
    }
  }
  return out;
}

// Slope through the origin of y on x with errors clustered on `cluster`
// (CR1: the usual G/(G−1) correction). `lead` is how far the later market moved
// toward the source's early disagreement.
export function leadStats(obs) {
  const n = obs.length;
  let sxx = 0;
  let sxy = 0;
  for (const o of obs) {
    sxx += o.x * o.x;
    sxy += o.x * o.y;
  }
  if (n < 2 || !(sxx > 0)) return { n, clusters: 0, lead: null, se: null, z: null };

  const lead = sxy / sxx;
  const byCluster = new Map();
  for (const o of obs) byCluster.set(o.cluster, (byCluster.get(o.cluster) ?? 0) + o.x * (o.y - lead * o.x));
  const G = byCluster.size;
  // With a single cluster the cluster total of the scores is zero by the normal
  // equation, so the formula returns an error of exactly zero — and an infinite
  // z. One player's one game is one observation; it carries an estimate of the
  // slope and no estimate of how uncertain it is.
  if (G < 2) return { n, clusters: G, lead, se: null, z: null };
  let ss = 0;
  for (const s of byCluster.values()) ss += s * s;
  const se = Math.sqrt(ss * (G / (G - 1))) / sxx;
  return { n, clusters: G, lead, se, z: se > 0 ? lead / se : null };
}

// Assess every source on a set of pairs.
export function assessSources(pairs, opts = {}) {
  const out = {};
  for (const [key, obs] of leadObservations(pairs, opts)) out[key] = leadStats(obs);
  return out;
}

// ---------------------------------------------------------------------------
// From assessment to weights
// ---------------------------------------------------------------------------

// A book's weight is its measured lead, pulled toward its prior in proportion
// to how little evidence there is:
//
//     w = (clusters·lead + K·prior) / (clusters + K)
//
// A book with no assessment keeps its prior. A negative lead is read as "no
// information" rather than "do the opposite": the market moving AWAY from a
// source is as consistent with noise as with anti-skill at these sample sizes,
// and a negative weight is a claim far beyond the evidence.
//
// The projection's lead is returned in `detail` for the report but is NOT a
// weight: its share of the price comes from fitProjectionShare, for the reason
// in the header.
export function fitSourceWeights(assessment, { priorClusters = PRIOR_CLUSTERS, priorWeight = PRIOR_WEIGHT } = {}) {
  const weights = {};
  const detail = {};
  for (const [key, s] of Object.entries(assessment)) {
    if (key === PROJECTION_SOURCE) {
      detail[key] = { ...s, prior: 0, weight: null };
      continue;
    }
    const evidence = Number.isFinite(s.lead) ? Math.max(0, s.lead) : priorWeight;
    const c = Number.isFinite(s.clusters) ? s.clusters : 0;
    const w = (c * evidence + priorClusters * priorWeight) / (c + priorClusters);
    weights[key] = Math.max(MIN_WEIGHT, w);
    detail[key] = { ...s, prior: priorWeight, weight: weights[key] };
  }
  return { weights, detail };
}

// The weights as they stood going INTO `week`: fitted on weeks strictly before
// it and on nothing else. This is the only way a weight may be used to price
// or to score a week, for the reason median-correction.mjs gives — a weight
// that had seen the week it prices is grading with the answer in hand.
export function weightsAsOf(pairs, week, opts = {}) {
  const prior = pairs.filter((p) => p.week < week);
  const assessment = assessSources(prior);
  const fit = fitSourceWeights(assessment, opts);
  return { ...fit, assessment, weeksUsed: [...new Set(prior.map((p) => p.week))].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// The projection's share of the price
// ---------------------------------------------------------------------------

export const shareKey = (stat, slot) => `${stat}|${slot}`;

// One observation per market on a point-in-time board: the books' pooled logit,
// the projection's logit, and what happened. `quotes` are readPropRow() outputs,
// `weightsFor(week)` the books' weights AS OF that week (a market priced in
// week 3 is judged against the pool as it stood in week 3), and `outcomeOf(q)`
// returns 1, 0 or null for a quote's market.
export function buildShareSamples(quotes, { weightsFor = () => ({}), outcomeOf, holdByStat = new Map(), method = DEFAULT_DEVIG_METHOD, pointInTime = isPointInTime } = {}) {
  const groups = new Map();
  for (const q of quotes) {
    const key = [q.slot, q.week, q.playerId, q.stat, q.line].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }

  const out = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    // The projection is only a source where it was the projection we had.
    const withProj = rows.find((q) => pointInTime(q) && isProjectionPrice(q));
    if (!withProj) continue;
    const y = outcomeOf(first);
    if (y === null || y === undefined) continue;

    const assumedHold = holdByStat.get?.(first.stat) ?? DEFAULT_ASSUMED_HOLD;
    const books = bookVotes(rows, { assumedHold, method });
    if (books.length < MIN_OTHERS + 1) continue;
    const pooled = poolVotes(books, { weights: weightsFor(first.week) });
    if (Math.abs(pooled.prob - 0.5) > SHARE_BAND) continue;

    out.push({
      stat: first.stat,
      slot: first.slot,
      week: first.week,
      cluster: `${first.week}|${first.playerId}`,
      lBooks: clipLogit(pooled.prob),
      lProj: clipLogit(withProj.probOver),
      y,
    });
  }
  return out;
}

// The projection's share for one cell, from observations of
//     logit P(over) = lBooks + share · (lProj − lBooks)
// by penalised maximum likelihood, with errors clustered on player-week.
//
// The prior is 0 and is worth `priorClusters` player-weeks of information: the
// penalty is that many clusters' average Fisher information, so the same K means
// the same thing in a sparse cell and a dense one. The returned `share` is the
// shrunk estimate, marked down by `caution` standard errors (SHARE_CAUTION),
// floored at zero and capped at MAX_PROJECTION_SHARE; `raw` is the shrunk
// estimate before any of that, because a report should say a cell is NEGATIVE
// (the projection is anti-informative there) rather than just "zero".
export function fitProjectionShare(obs, { priorClusters = PRIOR_CLUSTERS, cap = MAX_PROJECTION_SHARE, caution = SHARE_CAUTION } = {}) {
  const n = obs.length;
  const clusters = new Set(obs.map((o) => o.cluster)).size;
  if (n === 0) return { n: 0, clusters: 0, share: 0, raw: 0, se: null, z: null };

  const x = obs.map((o) => o.lProj - o.lBooks);
  const info = (b) => {
    let h = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(obs[i].lBooks + b * x[i]);
      h += p * (1 - p) * x[i] * x[i];
    }
    return h;
  };
  // Penalty: K clusters' worth of the information at b = 0.
  const lambda = clusters > 0 ? (priorClusters * info(0)) / clusters : 0;

  let b = 0;
  for (let it = 0; it < 60; it++) {
    let g = 0;
    let h = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(obs[i].lBooks + b * x[i]);
      g += (obs[i].y - p) * x[i];
      h += p * (1 - p) * x[i] * x[i];
    }
    g -= lambda * b;
    h += lambda;
    if (!(h > 0)) break;
    const step = g / h;
    b += step;
    if (Math.abs(step) < 1e-9) break;
  }

  // Cluster-robust SE of the UNpenalised score, for the report.
  let h = info(b);
  const byCluster = new Map();
  for (let i = 0; i < n; i++) {
    const p = sigmoid(obs[i].lBooks + b * x[i]);
    byCluster.set(obs[i].cluster, (byCluster.get(obs[i].cluster) ?? 0) + (obs[i].y - p) * x[i]);
  }
  const G = byCluster.size;
  let ss = 0;
  for (const v of byCluster.values()) ss += v * v;
  const se = G > 1 && h > 0 ? Math.sqrt(ss * (G / (G - 1))) / h : null;

  // With no standard error (a single cluster) there is no evidence to use.
  const used = se === null ? 0 : clip(b - caution * se, 0, cap);
  return { n, clusters, share: used, raw: b, se, z: se ? b / se : null };
}

// Every cell's share, from a set of observations.
export function fitProjectionShares(samples, opts = {}) {
  const cells = new Map();
  for (const o of samples) {
    const k = shareKey(o.stat, o.slot);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(o);
  }
  const out = {};
  for (const [k, obs] of cells) out[k] = fitProjectionShare(obs, opts);
  return out;
}

// The shares going INTO `week`: fitted on weeks strictly before it.
export function sharesAsOf(samples, week, opts = {}) {
  return fitProjectionShares(samples.filter((o) => o.week < week), opts);
}

// A cell's share, or zero. A cell with no record prices on the books alone.
export const shareFor = (shares, stat, slot) => shares?.[shareKey(stat, slot)]?.share ?? 0;
