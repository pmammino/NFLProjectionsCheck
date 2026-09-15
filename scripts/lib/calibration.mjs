// Where we trust our own model, and by how much. Pure — no I/O, unit tested
// directly (see calibration.test.mjs).
//
// Everything in markets.mjs is about what a market IS. Everything here is
// about whether our number for it is worth betting. The two change for
// different reasons and on different schedules: a market name changes when a
// book renames it, these thresholds change when another week of actuals lands.
//
// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
// probability.mjs turns a Floor/Median/Ceiling projection into P(over) by
// splining two normal halves through those three points, treating Floor and
// Ceiling as the 25th and 75th percentiles. That treatment is an ASSUMPTION,
// and measured against week-1 actuals it holds for high-volume players and
// fails badly for low-volume ones.
//
// The test is direct: the Floor-to-Ceiling band should contain 50% of actual
// outcomes. Share of week-1 actuals landing inside their own projected band,
// by projected median:
//
//     stat          <5    5-20   20+
//     rushYds       20%    42%   50%
//     rushAtt       18%    50%     -
//     recYds        32%    38%   47%
//     receptions    42%      -     -
//     passYds       63%      -   63%
//
// And where the misses go, for rushing yards specifically:
//
//     bucket        <Floor  F-M   M-C  >Ceiling
//     rushYds <5      84%    2%    1%     13%     (n=115)
//     rushYds 20+     29%   27%   23%     21%     (n=62)
//
// At 20+ it is a genuinely good quantile forecast. Under 5 it is 84% below its
// own Floor. The band there is a conditional-on-playing average rather than a
// quantile, and the real distribution is bimodal — a point mass at zero or
// below (kneels, and sacks counted as negative rushing yards) plus a scramble
// tail. That shape is why a variance multiplier cannot rescue it: widening a
// unimodal normal does not reconstruct a point mass. The honest move is to
// decline to price the market at all.
//
// This is what produced the complaint that started this work: quarterbacks
// priced at 77-94% to clear a 0.5-yard rushing line while eight books quoted
// 40-50%. The books were right. Aaron Rodgers went for -3.
//
// Note passYds/passAtt/completions run the OPPOSITE way — 63-78% coverage
// means their bands are too WIDE and we are under-confident there, leaving
// edge on the table. That is why there is no single global variance fix and no
// floor on those stats: one multiplier would have to widen rushing and narrow
// passing at the same time.

// ---------------------------------------------------------------------------
// Guard 1: support floor
// ---------------------------------------------------------------------------
// Minimum projected median for a continuous stat to be priced at all, chosen
// as the lowest threshold whose band coverage reaches ~50%.
//
// Gated on OUR projected median rather than the book's line, because the
// median is the variable the miscalibration was measured against. The two are
// closely correlated in practice, but the measurement is what should decide.
//
// These are deliberately coarse. They come from a single week (n in the
// hundreds per stat, which is enough to establish 84%-vs-25% but nowhere near
// enough to distinguish a 20 cutoff from a 22 one), so treat them as "roughly
// where the model starts working" rather than as tuned parameters. Re-derive
// them once several weeks of actuals exist.
//
// Stats absent from this table have no floor:
//   - passYds, passAtt, completions are over-dispersed, never under-dispersed
//   - poisson stats (passTD, rushTD, recTD, int) do not use Floor/Ceiling at
//     all, so the band measurement says nothing about them. Absence here is
//     "not measured", not "verified fine".
export const MIN_PROJECTION = {
  rushYds: 20, // 50% coverage at >=20 (20% unfiltered)
  recYds: 25, // 50% coverage at >=25 (32% unfiltered)
  rushAtt: 5, //  50% coverage at >=5  (18% unfiltered)
  receptions: 1, // 49% coverage at >=1 (42% unfiltered)
};

// Does this projection sit where the model has been shown to work?
//
// A missing or non-finite projection fails: we cannot place it on the
// calibration curve, and betting an unmeasurable number is the thing this
// guard exists to stop.
export function meetsSupportFloor(statKey, projectedMedian) {
  const floor = MIN_PROJECTION[statKey];
  if (floor === undefined) return true;
  if (!Number.isFinite(projectedMedian)) return false;
  return projectedMedian >= floor;
}

// ---------------------------------------------------------------------------
// Guard 2: market-disagreement cap
// ---------------------------------------------------------------------------
// Reject any bet where our probability differs from the market's by more than
// this, in probability points.
//
// The support floor removes the miscalibration we have MEASURED. This removes
// the ones we have not. Eight books independently pricing a market do not
// misprice it by 40 points; a disagreement that large is our error with
// near-certainty, whatever its source. So the cap is not a model improvement
// and should not be mistaken for one — it is a backstop that converts an
// unbounded model failure into a skipped bet.
//
// Set deliberately loose. A real edge in player props is worth a few points,
// occasionally ten; 20 is far outside that range, so this should almost never
// bind on a healthy model. If it starts firing often, that is a signal to go
// fix the model rather than to raise the cap.
//
// Measured against ModelEdge (ourProb - fairProb), the de-vigged disagreement.
// On a one-sided market fairProb falls back to the raw vig-inclusive price,
// which understates the true disagreement slightly — conservative in the right
// direction, since it lets marginal rows through rather than cutting good ones.
//
// Two-sided, because a 40-point disagreement is equally wrong whichever way it
// points. The negative side matters less in practice (it fails the min-edge
// bar first) but leaving it unguarded would mean the under side of a broken
// market stayed bettable after the over side was cut.
export const MAX_MARKET_DISAGREEMENT = 0.2;

// IMPORTANT: this is a judgement about a MARKET, not about one book's price.
//
// Applying it per book row looks equivalent and is not. Books quote the same
// market at different prices, so ModelEdge varies across them. Cutting row by
// row therefore drops the book whose price disagrees MOST — which, when our
// number is the one that is wrong, is usually the best price available — while
// leaving a slightly tamer quote on the same broken market intact. The result
// is that we keep betting the market we just declared untrustworthy, at a
// worse number than we would have got. Observed directly: a per-row cap on
// week 1 swapped 7 bets onto inferior prices rather than removing them.
//
// So the market's belief is taken as the MEDIAN fair probability across every
// book quoting it, and the whole market lives or dies on that. Median rather
// than mean because a single stale or erroneous book should not drag the
// consensus, which is the entire reason a multi-book consensus is worth more
// than any one price.
//
// `rows` are [{ marketKey, ourProb, fairProb }]. `marketKey` must identify the
// bet independently of the book — player, stat, line and side. Returns the set
// of marketKeys to reject.
export function marketsExceedingTolerance(rows) {
  const byMarket = new Map();
  for (const r of rows ?? []) {
    if (!byMarket.has(r.marketKey)) byMarket.set(r.marketKey, []);
    byMarket.get(r.marketKey).push(r);
  }

  const rejected = new Set();
  for (const [key, group] of byMarket) {
    const fair = group.map((r) => Number(r.fairProb)).filter(Number.isFinite);
    const ourProb = Number(group[0].ourProb);
    // No usable price, or no model number: nothing to compare, so refuse. A
    // bet we cannot sanity-check is what this guard exists to stop.
    if (fair.length === 0 || !Number.isFinite(ourProb)) {
      rejected.add(key);
      continue;
    }
    if (Math.abs(ourProb - median(fair)) > MAX_MARKET_DISAGREEMENT) rejected.add(key);
  }
  return rejected;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The book-independent identity of a bet. Two rows share this exactly when
// they are the same wager at different books.
export function marketIdentity({ playerId, stat, line, side }) {
  return [playerId, stat, line, side].join("|");
}

// Both guards over a list of priced candidates, in one pass.
//
// The support floor is a per-row decision; the disagreement cap needs every
// book's price for a market before it can decide. Sequencing matters: the
// floor runs first so a market that should never have been priced cannot
// contribute its prices to a consensus.
//
// `rows` need { stat, projectedMedian, playerId, line, side, ourProb, fairProb }.
// Returns { kept, rejected } where rejected rows carry a `reason`.
export function applyCalibrationGuards(rows) {
  const kept = [];
  const rejected = [];

  const supported = [];
  for (const r of rows ?? []) {
    if (meetsSupportFloor(r.stat, r.projectedMedian)) supported.push(r);
    else rejected.push({ row: r, reason: "support-floor" });
  }

  const overTolerance = marketsExceedingTolerance(
    supported.map((r) => ({ marketKey: marketIdentity(r), ourProb: r.ourProb, fairProb: r.fairProb }))
  );
  for (const r of supported) {
    if (overTolerance.has(marketIdentity(r))) rejected.push({ row: r, reason: "market-disagreement" });
    else kept.push(r);
  }

  return { kept, rejected };
}
