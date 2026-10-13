// Everything the weighted pool needs, built from the committed captures: the
// books' weights and the projection's shares, each available AS OF any week.
//
// This is the I/O-and-assembly layer over source-weights.mjs (which is pure).
// It exists so the report and the live capture build the model the same way —
// capture-props asks for the entry for the week it is pricing and gets exactly
// what `npm run source-weights` shows for that week.
//
// Nothing here is persisted by default. A file of weights goes stale the moment
// a closing line fills in or a week is played, and the cost of recomputing —
// reading the season's captures once — is a few seconds against a weekly
// capture. `source-weights.mjs --write` still produces a file, for anyone who
// wants to audit or pin one.

import { loadSeason, actualFor, isPointInTime } from "./pricing-dataset.mjs";
import { gradeOutcome } from "./grading.mjs";
import { estimateHoldByStat } from "./consensus.mjs";
import { isBettableStat } from "./markets.mjs";
import { buildLeadPairs, buildShareSamples, weightsAsOf, sharesAsOf, weightsForStat } from "./source-weights.mjs";

// 1, 0, or null when the market cannot be graded (no actuals row, or a push).
export function outcomeFrom(actualsByWeek, q) {
  const act = actualFor(actualsByWeek.get(q.week)?.get(q.playerId), q.stat);
  if (act === null) return null;
  const o = gradeOutcome(act, q.line, "over");
  return o === "push" ? null : o === "won" ? 1 : 0;
}

// quotes: readPropRow() outputs for a season; actualsByWeek: Map week -> Map
// playerId -> actuals row. Returns the pooled inputs and an `at(week)` that
// yields the weights and shares as they stood going into that week.
export function buildSourceModel(quotes, actualsByWeek, { includeRetired = false, priorClusters, priorWeight } = {}) {
  const usable = includeRetired ? quotes : quotes.filter((q) => isBettableStat(q.stat));
  const holdByStat = estimateHoldByStat(usable);
  const opts = {};
  if (priorClusters !== undefined) opts.priorClusters = priorClusters;
  if (priorWeight !== undefined) opts.priorWeight = priorWeight;

  const pairs = buildLeadPairs(usable, { holdByStat });

  // A market priced in week w is judged against the books' pool as it stood
  // going into week w (with that stat's weights), not against the final one.
  const memo = new Map();
  const weightsAt = (week) => {
    if (!memo.has(week)) memo.set(week, weightsAsOf(pairs, week, opts));
    return memo.get(week);
  };

  // Only a live capture's projection is the one we had at the time.
  const samples = buildShareSamples(usable.filter(isPointInTime), {
    weightsFor: (w, stat) => weightsForStat(weightsAt(w), stat),
    outcomeOf: (q) => outcomeFrom(actualsByWeek, q),
    holdByStat,
  });

  const weeks = [...new Set(pairs.map((p) => p.week))].sort((a, b) => a - b);

  return {
    pairs,
    samples,
    weeks,
    holdByStat,
    opts,
    weightsAt,
    // The model going INTO `week`.
    at(week) {
      const w = weightsAt(week);
      return {
        week,
        weights: w.weights,
        statWeights: w.statWeights,
        detail: w.detail,
        assessment: w.assessment,
        trainedOnWeeks: w.weeksUsed,
        shares: sharesAsOf(samples, week, opts),
        shareWeeks: [...new Set(samples.filter((o) => o.week < week).map((o) => o.week))].sort((a, b) => a - b),
      };
    },
  };
}

// The same, straight from data/. Returns null when the season has no captures.
export function loadSourceModel({ dataDir = "data", season, ...opts } = {}) {
  const { quotes, actualsByWeek } = loadSeason(season, { dataDir });
  return buildSourceModel(quotes, actualsByWeek, opts);
}
