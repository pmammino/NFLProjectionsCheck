// Pure American-odds math: implied probability, decimal payout, and Kelly
// stake sizing. No I/O — unit tested directly (see odds.test.mjs).

// American odds -> implied probability (includes the book's vig; this is
// NOT a fair/no-vig probability).
export function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : -o / (-o + 100);
}

// American odds -> decimal payout multiplier (stake returned on a win,
// including the original stake). E.g. +150 -> 2.5, -110 -> 1.909...
export function americanToDecimal(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 1 + o / 100 : 1 + 100 / -o;
}

// Kelly fraction of bankroll to stake, given our model's win probability `p`
// and the decimal payout `decimalOdds` on offer. b = net odds (profit per unit
// staked); f* = (b*p - (1-p)) / b. Negative (no edge) clamps to 0.
export function kellyFraction(p, decimalOdds) {
  const b = decimalOdds - 1;
  if (!(b > 0) || !(p >= 0 && p <= 1)) return 0;
  const f = (b * p - (1 - p)) / b;
  return Math.max(0, f);
}
