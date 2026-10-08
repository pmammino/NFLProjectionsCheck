// The arithmetic behind the Line Pricer tab. Pure and free of Node imports, so
// the browser bundle can use it directly and `node --test` can check it (see
// lines-view.test.mjs). The numbers that need the model — the projection's
// P(over), the multi-book consensus, the median correction — are computed once
// at build time in lines-index.mjs; this file only does arithmetic on prices.

import { americanToProb } from "./odds.mjs";
import { devigTwoWay } from "./devig.mjs";

// `books` is the file's book table: [{ k, label, t }] where t is 1 for a book a
// bet can be placed at. `quotes` is one market's per-book prices:
// [[bookIndex, overOdds|null, underOdds|null], ...].

// The price that pays most. Compared on payout, not on the American number:
// +110 pays more than -110 but sorts lower.
function payout(odds) {
  return odds > 0 ? odds / 100 : 100 / -odds;
}

// Best price on one side among books a bet can actually be placed at.
//
// Reference books (Pinnacle) are deliberately excluded: they sharpen the
// consensus and can be the best number on the board, but a price nobody here
// can take is a return nobody could have earned. They still appear in the
// per-book table, flagged. Returns { odds, book } or null.
export function bestPrice(quotes, books, side) {
  const col = side === "over" ? 1 : 2;
  let best = null;
  for (const q of quotes ?? []) {
    const odds = q[col];
    if (odds === null || odds === undefined || !Number.isFinite(odds) || odds === 0) continue;
    if (!books[q[0]]?.t) continue;
    if (best === null || payout(odds) > payout(best.odds)) best = { odds, book: q[0] };
  }
  return best;
}

// Edge of a bet at a price: our probability of winning it minus the break-even
// probability at that price. The same definition the ledger uses — at -110 you
// need 52.4%, not 50%, because the margin is a cost actually paid.
//
// `pOver` is OUR P(over); the under side is its complement.
export function edgeAt(pOver, odds, side) {
  if (pOver === null || pOver === undefined || !Number.isFinite(pOver)) return null;
  const implied = americanToProb(odds);
  if (implied === null) return null;
  return (side === "over" ? pOver : 1 - pOver) - implied;
}

// This book's no-vig P(over), or null when it quotes one side only: a fair
// price cannot be derived from a single quote, and inventing one would be
// reporting a number the book never implied.
export function fairOver(overOdds, underOdds) {
  if (overOdds === null || underOdds === null || overOdds === undefined || underOdds === undefined) return null;
  const d = devigTwoWay(overOdds, underOdds, "multiplicative");
  return d ? d.fairProbOver : null;
}

// What the actual result did to a line. A whole-number line can land exactly on
// it, and that is a push, not a win for either side.
export function resultOf(actual, line) {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return null;
  if (actual === line) return "push";
  return actual > line ? "over" : "under";
}

// Which line is "the" line: the one the books price closest to a coin flip.
// Falls back to our own price when no consensus exists, then to the middle.
export function mainLineIndex(lines) {
  if (!lines?.length) return -1;
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].m ?? lines[i].p;
    if (p === null || p === undefined) continue;
    const d = Math.abs(p - 0.5);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI === -1 ? Math.floor(lines.length / 2) : bestI;
}

// Everything the table needs for one line, in one place so the component stays
// presentational. `useCorrected` swaps in the median-corrected price where one
// exists; where it does not, the as-priced price is used and `corrected` says
// so, so a column never silently mixes the two.
export function lineView(line, books, { useCorrected = false } = {}) {
  const corrected = useCorrected && line.a !== null && line.a !== undefined;
  const p = corrected ? line.a : line.p;
  const bestOver = bestPrice(line.b, books, "over");
  const bestUnder = bestPrice(line.b, books, "under");
  return {
    line: line.l,
    p,
    corrected,
    market: line.m ?? null,
    sharp: line.s ?? null,
    // How far OUR price sits from the books'. The tilt a projection carries
    // against the market is the thing worth reading at a glance.
    gap: p !== null && p !== undefined && line.m !== null && line.m !== undefined ? p - line.m : null,
    bestOver,
    bestUnder,
    edgeOver: bestOver ? edgeAt(p, bestOver.odds, "over") : null,
    edgeUnder: bestUnder ? edgeAt(p, bestUnder.odds, "under") : null,
    nBooks: (line.b ?? []).length,
  };
}

// The better of the two sides' edges, for highlighting rows worth a look.
export function bestEdge(view) {
  const o = view.edgeOver;
  const u = view.edgeUnder;
  if (o === null && u === null) return null;
  if (o === null) return { side: "under", edge: u };
  if (u === null) return { side: "over", edge: o };
  return o >= u ? { side: "over", edge: o } : { side: "under", edge: u };
}

// Strip accents and case so "Jose" finds "José" and "amon ra" finds
// "Amon-Ra St. Brown".
const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Players matching a search box. Every typed word must match the START of some
// word in the name or the team, so "st brown" finds St. Brown and "gb" finds
// Green Bay's players. Exact-start matches rank first; ties keep file order
// (alphabetical), so results never shuffle as you type.
export function searchPlayers(players, query, limit = 12) {
  const terms = fold(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  const scored = [];
  for (const p of players ?? []) {
    const words = fold(`${p.name} ${p.team}`).split(" ");
    if (!terms.every((t) => words.some((w) => w.startsWith(t)))) continue;
    const startsWithName = fold(p.name).startsWith(terms.join(" "));
    scored.push({ p, rank: startsWithName ? 0 : 1 });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((s) => s.p);
}

export function formatOdds(odds) {
  if (odds === null || odds === undefined || !Number.isFinite(odds)) return "—";
  return odds > 0 ? `+${odds}` : String(odds);
}

// A line is "in play" when the books price it between IN_PLAY_MIN and
// IN_PLAY_MAX — close enough to a coin flip that someone could actually be
// deciding on it. The far tails (a 98% market on a 40-yard line for a back
// projected at 80) make up most of a ladder and none of the decisions.
//
// This is a DISPLAY default, not a data trim: every line is in the file, so
// "why is my line missing?" always has an answer one click away. A line with no
// market price falls back to ours, and a line with neither is kept — hiding
// something we know nothing about would be the wrong way to be tidy.
export const IN_PLAY_MIN = 0.05;
export const IN_PLAY_MAX = 0.95;

export function inPlay(line) {
  const p = line?.m ?? line?.p;
  if (p === null || p === undefined || !Number.isFinite(p)) return true;
  return p >= IN_PLAY_MIN && p <= IN_PLAY_MAX;
}
