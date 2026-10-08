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
// The projection is a source, with one handicap
// ---------------------------------------------------------------------------
// It is measured exactly as a book is: its early logit against the books'
// move. Two rules keep that honest.
//
//  1. POINT IN TIME. A backfilled board is priced from the week's latest
//     projection snapshot, which has absorbed everything that happened since.
//     Against that snapshot the market appears to move toward the projection by
//     ~8%; against the snapshot that existed at the start of the week it is
//     ~0.8%. The first number is the projection having read the same news as
//     the market, not leading it. The projection is therefore assessed only on
//     rows whose price was live when captured (pricing-dataset isPointInTime).
//
//  2. NO CREDIT ON ACCOUNT. Every book starts at an equal prior weight and moves
//     as evidence arrives. The projection starts at zero. Our own output has
//     been measured worse than the books in the middle of the board, so it has
//     to earn a vote rather than be handed one while it has no record.
//
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

// The projection's prior. See the header: it has to earn a vote.
export const PROJECTION_PRIOR_WEIGHT = 0;

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

// A source's weight, falling back to its prior when it has no record. The
// projection's fallback is zero; every book's is PRIOR_WEIGHT.
export function weightOf(weights, key) {
  const given = weights?.[key];
  if (Number.isFinite(given)) return key === PROJECTION_SOURCE ? Math.max(0, given) : Math.max(MIN_WEIGHT, given);
  return key === PROJECTION_SOURCE ? PROJECTION_PRIOR_WEIGHT : PRIOR_WEIGHT;
}

// The weighted average of the sources' logits, as a probability. Same contract
// as consensusProb — null when no BOOK produced a usable price, which a caller
// must treat as "this market has no market prior" — plus what the weighting
// did, so a report can say how far it moved the number.
//
// `projectionProb` is our own P(over). It is a vote like any other, with
// whatever weight the projection has earned (zero until it has earned some),
// and it can never create a consensus by itself.
export function weightedConsensusProb(
  rows,
  { weights = {}, holdByStat = new Map(), stat, method = DEFAULT_DEVIG_METHOD, setName = "all", projectionProb = null } = {}
) {
  const assumedHold = holdByStat.get?.(stat) ?? DEFAULT_ASSUMED_HOLD;
  return poolVotes(bookVotes(rows, { assumedHold, method, setName }), { weights, projectionProb });
}

// The pooling itself, on votes already drawn from a market. Split out so a
// report that has the votes (and not the original odds) prices through exactly
// the code the live path does.
export function poolVotes(books, { weights = {}, projectionProb = null } = {}) {
  if (!books || books.length === 0) return null;

  const votes = [...books];
  if (projectionProb !== null && projectionProb !== undefined && Number.isFinite(projectionProb) && projectionProb > 0 && projectionProb < 1) {
    votes.push({ book: PROJECTION_SOURCE, key: PROJECTION_SOURCE, twoSided: true, logit: clipLogit(projectionProb) });
  }

  // Votes are drawn in to the median of the BOOKS: the reference the projection
  // is also measured against, so a wild projection is bounded by what the
  // market says rather than by itself.
  const centre = medianLogit(books);
  let sw = 0;
  let sl = 0;
  let sw2 = 0;
  let projW = 0;
  for (const v of votes) {
    const w = weightOf(weights, v.key);
    if (w <= 0) continue;
    const l = clip(v.logit, centre - MAX_DEVIATION, centre + MAX_DEVIATION);
    sw += w;
    sl += w * l;
    sw2 += w * w;
    if (v.key === PROJECTION_SOURCE) projW = w;
  }
  const prob = sw > 0 ? sigmoid(sl / sw) : sigmoid(centre);

  const devigged = books.filter((v) => v.twoSided).length;
  const holds = books.map((v) => v.hold).filter(Number.isFinite);
  return {
    prob,
    bookCount: books.length,
    deviggedCount: devigged,
    probSource: devigged === books.length ? "devig" : devigged > 0 ? "mixed" : "assumed-hold",
    meanHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    assumedHold: devigged === books.length ? null : books[0].assumedHold ?? null,
    // Kish effective number of sources: 7 books at equal weight is 7; one book
    // carrying nearly everything is close to 1.
    effectiveSources: sw > 0 ? (sw * sw) / sw2 : books.length,
    projectionShare: sw > 0 ? projW / sw : 0,
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

// A source's weight is its measured lead, pulled toward its prior in proportion
// to how little evidence there is:
//
//     w = (clusters·lead + K·prior) / (clusters + K)
//
// A source with no assessment keeps its prior. A negative lead is read as "no
// information" rather than "do the opposite": the market moving AWAY from a
// source is as consistent with noise as with anti-skill at these sample sizes,
// and a negative weight is a claim far beyond the evidence.
export function fitSourceWeights(assessment, { priorClusters = PRIOR_CLUSTERS, priorWeight = PRIOR_WEIGHT, projectionPrior = PROJECTION_PRIOR_WEIGHT } = {}) {
  const weights = {};
  const detail = {};
  for (const [key, s] of Object.entries(assessment)) {
    const prior = key === PROJECTION_SOURCE ? projectionPrior : priorWeight;
    const evidence = Number.isFinite(s.lead) ? Math.max(0, s.lead) : prior;
    const c = Number.isFinite(s.clusters) ? s.clusters : 0;
    const w = (c * evidence + priorClusters * prior) / (c + priorClusters);
    weights[key] = key === PROJECTION_SOURCE ? Math.max(0, w) : Math.max(MIN_WEIGHT, w);
    detail[key] = { ...s, prior, weight: weights[key] };
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
