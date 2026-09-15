// Closing Line Value: did the market move toward our bet after we placed it?
// Pure — no I/O, unit tested directly (see clv.test.mjs).
//
// ---------------------------------------------------------------------------
// Why this matters more than a season of ROI
// ---------------------------------------------------------------------------
// We capture Tuesday morning, which is the SOFTEST line of the week. Books post
// early with low limits, and prices sharpen toward kickoff as money and injury
// news arrive. Beating a Tuesday number is therefore easier than beating a
// Sunday one, and a healthy ROI measured against Tuesday prices cannot by
// itself distinguish "the projections are good" from "we measured against a
// stale price".
//
// CLV separates those. If the closing price on a market we bet is consistently
// WORSE than the price we took, the market moved our way — the model saw
// something before the market did. That is the claim worth making about a
// projection system, and unlike ROI it does not depend on whether the bets
// happened to win.
//
// It also converges far faster. A win/loss is one bit per bet, so a persona
// taking ten bets a week needs seasons before its ROI means anything. CLV is a
// continuous measurement on every bet, so a few hundred bets already say
// something.
//
// ---------------------------------------------------------------------------
// Two ways a market can move
// ---------------------------------------------------------------------------
// PRICE moves: we took Over 249.5 at -110, it closes at -130. Same bet, worse
//   price, so we won value. Directly comparable.
// LINE moves: we took Over 249.5, it closes at Over 251.5. Now it is a
//   different bet — and a better one than the closing bettor gets, because our
//   number is easier to clear. Meaningful, but not a price comparison.
//
// Quantifying a line move in price terms needs a model of how much a half-point
// is worth for that stat, which we do not have and should not invent. So a line
// move is reported as a DIRECTION and counted separately, while the numeric CLV
// is computed only where the line held. Mixing them would put a made-up number
// next to a measured one.

import { americanToProb, americanToDecimal } from "./odds.mjs";
import { devigTwoWay } from "./devig.mjs";

// Key a market so a bet can find its own closing quote. Includes the book:
// CLV is about the price WE could have got, and a move at a different book
// says nothing about the one we bet.
export function marketKey({ book, playerId, stat, side }) {
  return [String(book).toLowerCase(), playerId, stat, side].join("|");
}

// Index closing rows for lookup. Several lines may exist per market (a book
// offers 249.5 and 259.5), so each key holds every line it quoted.
export function indexClosing(rows) {
  const byKey = new Map();
  for (const r of rows ?? []) {
    const key = marketKey(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return byKey;
}

// Was a line move in our favour?
//
// For an OVER, a line that closes HIGHER is good: we hold the easier number.
// For an UNDER it is the reverse. Note this is the opposite of the intuition
// that "the line moved up so overs got expensive" — that is true for someone
// betting at close, but we already have our ticket.
export function lineMoveDirection(side, takenLine, closingLine) {
  if (!Number.isFinite(takenLine) || !Number.isFinite(closingLine)) return null;
  if (closingLine === takenLine) return "same";
  const higher = closingLine > takenLine;
  return (side === "under" ? !higher : higher) ? "toward" : "against";
}

// CLV for one bet against the closing market.
//
// `closingIndex` comes from indexClosing(). `opposingIndex`, when supplied,
// lets the closing price be de-vigged before comparison, which is the cleaner
// measure — but most player props are quoted one-sided, so the raw comparison
// is what usually applies.
//
// Returns a result object always; `status` says how much to trust it:
//   matched     same book, same line at close — the numeric CLV is real
//   line-moved  the market still exists but at a different number
//   not-found   the market was gone by kickoff (player ruled out, book pulled it)
export function computeClv(bet, closingIndex, opposingIndex = null) {
  const key = marketKey(bet);
  const candidates = closingIndex?.get(key) ?? [];
  const takenLine = Number(bet.line);

  if (candidates.length === 0) {
    return { status: "not-found", clvProb: null, clvPct: null, closingOdds: null, closingLine: null, lineMove: null };
  }

  const exact = candidates.find((c) => Number(c.line) === takenLine);
  if (!exact) {
    // Report against the closest line so the direction is still visible, but
    // do not dress it up as a price comparison.
    const closest = candidates.reduce((best, c) =>
      Math.abs(Number(c.line) - takenLine) < Math.abs(Number(best.line) - takenLine) ? c : best
    );
    return {
      status: "line-moved",
      clvProb: null,
      clvPct: null,
      closingOdds: Number(closest.odds),
      closingLine: Number(closest.line),
      lineMove: lineMoveDirection(bet.side, takenLine, Number(closest.line)),
    };
  }

  const takenProb = americanToProb(bet.odds);
  const closingRaw = americanToProb(exact.odds);
  const takenDec = americanToDecimal(bet.odds);
  const closingDec = americanToDecimal(exact.odds);
  if (takenProb === null || closingRaw === null) {
    return { status: "not-found", clvProb: null, clvPct: null, closingOdds: null, closingLine: null, lineMove: null };
  }

  // Prefer a de-vigged closing probability when the opposing side closed too:
  // the market's true belief is the honest thing to compare against, and a
  // change in the book's margin is not line movement.
  let closingProb = closingRaw;
  let devigged = false;
  const opposing = opposingIndex?.get(
    marketKey({ ...bet, side: bet.side === "over" ? "under" : "over" })
  );
  const opposingExact = opposing?.find((c) => Number(c.line) === takenLine);
  if (opposingExact) {
    const fair = devigTwoWay(exact.odds, opposingExact.odds);
    if (fair) {
      closingProb = fair.fairProbOver;
      devigged = true;
    }
  }

  return {
    status: "matched",
    // Positive = the market ended up rating our side MORE likely than the
    // price we paid implied. We bought it cheap.
    clvProb: round4(closingProb - takenProb),
    // The same thing in payout terms: how much better our price was.
    clvPct: round4(takenDec / closingDec - 1),
    closingOdds: Number(exact.odds),
    closingLine: takenLine,
    lineMove: "same",
    devigged,
  };
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

// Roll CLV up over a set of graded bets.
//
// `beatRate` is the headline: the share of bets whose price beat the close.
// Above 50% sustained is the signal that the model is early to information
// rather than lucky. Bets whose market vanished are excluded from the rates
// but counted, because a systematic disappearance (players ruled out after we
// bet them) is itself worth seeing.
export function summarizeClv(results) {
  const rows = results ?? [];
  const matched = rows.filter((r) => r.status === "matched" && r.clvProb !== null);
  const beat = matched.filter((r) => r.clvProb > 0).length;
  const moved = rows.filter((r) => r.status === "line-moved");

  return {
    n: rows.length,
    nMatched: matched.length,
    nLineMoved: moved.length,
    nNotFound: rows.filter((r) => r.status === "not-found").length,
    beatRate: matched.length ? round4(beat / matched.length) : null,
    avgClvProb: matched.length
      ? round4(matched.reduce((s, r) => s + r.clvProb, 0) / matched.length)
      : null,
    avgClvPct: matched.length
      ? round4(matched.reduce((s, r) => s + r.clvPct, 0) / matched.length)
      : null,
    // Where the line itself moved, which way did it go? A majority "toward"
    // is the same signal as positive CLV, measured on the markets where a
    // price comparison was not available.
    lineMovedToward: moved.filter((r) => r.lineMove === "toward").length,
    lineMovedAgainst: moved.filter((r) => r.lineMove === "against").length,
  };
}
