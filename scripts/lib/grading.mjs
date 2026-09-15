// Settling a bet against the actual result. Pure — no I/O, unit tested
// directly (see grading.test.mjs).

// "won", "lost", or "push" when the result lands exactly on the line.
//
// A push is only reachable on a whole-number line. The old RotoWire feed
// quoted half-points almost exclusively, so this case never arose there;
// OpticOdds quotes real integer lines (Over 5.0 receptions) where landing
// exactly on the number returns the stake.
//
// `side` defaults to "over": ledgers written before unders were bettable
// carry no Side column, and every bet in them was an over.
export function gradeOutcome(actual, line, side) {
  if (actual === line) return "push";
  if (side === "under") return actual < line ? "won" : "lost";
  return actual > line ? "won" : "lost";
}
