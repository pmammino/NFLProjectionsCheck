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
//
// ---------------------------------------------------------------------------
// Why there is no sigma multiplier here
// ---------------------------------------------------------------------------
// Inflating sigma to make the bands cover 50% was tried and measured, and it
// does not help. Sweeping a global multiplier k over every (player, line) pair
// with a known outcome (n=25,840):
//
//     k      1.0     1.2     1.5     1.8     2.1
//     Brier  .1675   .1668   .1682   .1710   .1744
//     maxgap  7.8     7.9     9.7    11.6    12.9
//
// Brier is flat to three decimals and the worst reliability gap gets steadily
// worse. The reason is that the residual error is not a sharpness problem that
// widening fixes. The reliability curve reads -7, +5, +8, +7, +3 across
// predicted-probability buckets: realized outcomes come in BELOW our number
// almost everywhere, which is a systematic over-prediction of overs, not a
// distribution that is too narrow. Widening pulls every probability toward 0.5
// and so fixes one end while breaking the other.
//
// Correcting a uniform shift would mean fitting a recalibration curve, and one
// week cannot separate "projections are optimistic" from "week 1 was low
// scoring". That needs several weeks, and until then the honest thing is to
// leave the model alone and let the guards below cut what is unbettable.
//
// ---------------------------------------------------------------------------
// The likely cause of the over-dispersion, and why it is not corrected yet
// ---------------------------------------------------------------------------
// The projections are built by moving BOTH volume (attempts, carries, targets)
// AND efficiency (yards per attempt, TDs per touch) to their own high or low
// end for the Ceiling and Floor. So the stated Ceiling is roughly
// volume_75 x efficiency_75, not the 75th percentile of the product.
//
// For two independent components that is too wide, and by a predictable
// amount: stacking each component's own quartile offset adds their spreads,
// whereas the product's true quartile combines them in quadrature. The
// overshoot is (sv + se) / sqrt(sv^2 + se^2), which is sqrt(2) ~ 1.41 when the
// two contribute equally — implying a sigma multiplier of 1/sqrt(2) ~ 0.71.
//
// That prediction is visible in the projections themselves. Median relative
// band width, (Ceiling - Floor) / Median, volume vs the yardage it drives:
//
//     passing     volume 0.361   yards 0.508   ratio 1.41
//     rushing     volume 0.429   yards 0.781   ratio 1.82
//     receiving   volume 1.129   yards 1.002   ratio 0.89
//
// Passing lands on 1.41 almost exactly. Rushing at 1.82 says efficiency
// dominates there, which fits — yards per carry is far more volatile than
// attempts. This is a real structural explanation for why passYds/passAtt/
// completions come out over-dispersed, and it is the leading candidate for
// fixing them.
//
// It is NOT applied yet, because the outcome data cannot support it. Only 32
// quarterbacks have week-1 actuals, and at k=0.71 the results do not agree:
// passAtt coverage improves (66% -> 53%) but passYds overshoots into being too
// NARROW (63% -> 38%) and its line calibration gets worse at the low end. The
// correction also increases confidence, which is the direction that has
// already cost us money once.
//
// To act on this properly: re-measure once several weeks of quarterback
// actuals exist, and fit the multiplier per stat from the volume/yards band
// ratio above rather than assuming equal contribution.

// ---------------------------------------------------------------------------
// Guard 1: support floor
// ---------------------------------------------------------------------------
// The band-coverage table above says WHERE the model is wrong. It does not say
// what to gate on, and the first version of this guard got that wrong: it
// floored the projected median (rushYds >= 20 and so on), which threw away a
// large and perfectly well-calibrated part of the board.
//
// Band coverage measures the whole shape of the distribution. Betting only
// ever asks one question: P(actual > THIS line). Those come apart, and the
// second is the one that decides money. Measured directly — model probability
// vs realized frequency, pooled over every projected player:
//
//     line     0.5    1.5    2.5    3.5   ...  14.5   24.5
//     rushYds  +20     +3     -1     -1         -4     -3
//     recYds   +10     +7     +4     +2         -1     -1
//     rushAtt   -4     -4     -3     -6         -1     +1
//     recept    -5     -1     +3     +4          -      -
//
// (+ is overconfident.) The model is sound at essentially every line except
// the very lowest. The projection floor was cutting bets at 24.5 and 39.5 —
// where the gap is -3 and -2 — to avoid a failure that lives entirely at 0.5.
//
// What actually fails there is a point mass. Share of players recording
// exactly zero or less, by projected median:
//
//     stat        <3    3-8   8-15  15-25  25+
//     rushYds     85%     -    22%    0%    0%
//     rushAtt     73%    0%     0%     -     -
//     recYds      48%   45%    31%   20%    7%
//
// 82% of players projected 0-8 rushing yards recorded <= 0. A "will he get
// ANY" line is a question about whether someone touches the ball, and a
// two-piece normal centred on a positive median cannot answer it: at any
// sigma it puts roughly half its mass above the median, which is why widening
// moves P(over 0.5) only from 53% to 49% where the truth is 18%.
//
// Hence two floors that do different jobs. The LINE floor is the real guard —
// it removes the near-zero lines where the point mass lives. The PROJECTION
// floor is now only a light backstop for players we barely project at all.

// Minimum line for a continuous stat to be priced. This is the guard that
// targets the measured failure.
//
// Set where the gap closes for the hardest subgroup, players projected under 8:
// rushYds is +8 at 1.5 and +0 at 2.5; recYds is +8 at 1.5 and -3 at 2.5.
// rushAtt and receptions are not overconfident at any line and carry no floor —
// rushAtt is under-confident throughout.
export const MIN_LINE = {
  rushYds: 2.5,
  recYds: 2.5,
};

// Minimum projected median. A backstop only, well below where the model has
// been shown to break, because the line floor above is doing the real work.
// Left in place so a market on someone we project at essentially nothing does
// not get priced on the strength of a rounding error.
//
// Stats absent from both tables have no floor:
//   - passYds, passAtt, completions are over-dispersed, never under-dispersed
//   - poisson stats (passTD, rushTD, recTD, int) do not use Floor/Ceiling at
//     all, so the band measurement says nothing about them. Absence here is
//     "not measured", not "verified fine".
export const MIN_PROJECTION = {
  rushYds: 3,
  recYds: 3,
  rushAtt: 1,
  receptions: 0.5,
};

// Does this market sit where the model has been shown to work?
//
// A missing or non-finite projection or line fails: we cannot place it on the
// calibration curve, and betting an unmeasurable number is the thing this
// guard exists to stop.
export function meetsSupportFloor({ stat, projectedMedian, line }) {
  const lineFloor = MIN_LINE[stat];
  if (lineFloor !== undefined) {
    if (!Number.isFinite(line)) return false;
    if (line < lineFloor) return false;
  }
  const projFloor = MIN_PROJECTION[stat];
  if (projFloor === undefined) return true;
  if (!Number.isFinite(projectedMedian)) return false;
  return projectedMedian >= projFloor;
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
    if (meetsSupportFloor(r)) supported.push(r);
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
