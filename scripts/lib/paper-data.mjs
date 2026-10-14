// The dataset behind the Filtered Paper Trading tab: every candidate bet on every
// board, with what a filter needs to judge it. Pure — no I/O — and unit tested
// (paper-data.test.mjs); build-paper-data.mjs does the reading and writing.
//
// ---------------------------------------------------------------------------
// Why this is not the persona ledgers
// ---------------------------------------------------------------------------
// The ledgers hold what a strategy chose, and the Firehose has already collapsed
// the board to the best price per player and stat. That is exactly the wrong
// shape for the questions the team is asking:
//
//   "only the sharper books"      the best price among ALL books is often a
//                                 recreational one; selecting sharp books after
//                                 the fact needs the best price among THEM
//   "ladders vs conservative"     a ladder is several rungs of one player-stat;
//                                 collapsing it first removes the comparison
//   "consensus lines, no outliers" needs how many books quoted the line, and
//                                 what the rest of the market said about it
//
// So every row of a board that has an edge under ANY of the three prices is
// kept, and the choosing is done in the browser (lib/paper-filter.mjs).
//
// ---------------------------------------------------------------------------
// Three prices, and which one is which
// ---------------------------------------------------------------------------
//   projection  what the RotoWire projection alone says (the price the team has
//               been evaluating)
//   pool        the books' weighted consensus with the projection's fitted share
//               (the default price of the live pipeline; mostly the books)
//   sharp       the consensus of the sharp books alone (Pinnacle, Circa). An "edge" against it
//               needs no projection at all: it is a price better than what the
//               sharpest part of the market thinks is fair.
//
// ---------------------------------------------------------------------------
// Live and reconstructed boards
// ---------------------------------------------------------------------------
// A backfilled opening or closing board is a reconstruction. Each book's "opening"
// price is posted at a different moment and the projection on it is the week's
// final one, so it flatters every strategy twice (see lib/backtest-live.mjs). The
// rows carry `live` so the tab can default to the boards we actually had and make
// the others a visible, labelled choice.

import { readPropRow } from "./pricing-dataset.mjs";
import { actualFor } from "./pricing-dataset.mjs";
import { gradeOutcome } from "./grading.mjs";
import { americanToProb } from "./odds.mjs";
import { median, sigmoid } from "./consensus.mjs";
import { canonicalBookKey } from "./books.mjs";
import { bookLabel } from "./lines-index.mjs";
import { bookVotes, poolVotes, weightsForStat } from "./source-weights.mjs";
import { asPoolPriced } from "./pool-reprice.mjs";
import { projectionProbOf, LIVE_SLOTS } from "./backtest-live.mjs";

// "Sharp" is the repo's own market set (MARKET_SETS.sharp in consensus.mjs:
// Pinnacle and Circa, plus the other limit-taking books should the feed carry
// them), the same set the Line Pricer's sharp consensus uses. It is deliberately
// NOT widened here to FanDuel or DraftKings: a book being hard to beat is not the
// same as it being a fair-value reference, and the tab lets a bettor choose
// which books to BET at separately from which books say what is fair.
export const SHARP_SET = "sharp";

// Smallest edge, under any of the three prices, that earns a row. The tab's own
// minimum-edge control can only be set at or above this.
export const MIN_CANDIDATE_EDGE = 0.03;
// Wider than the tab's default odds range (-400 to +200) so the range can be
// widened, and no wider than there is any point in.
export const ODDS_FLOOR = -1000;
export const ODDS_CEILING = 3000;

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// Which slots are live captures (the rest are reconstructions).
export const isLiveBoard = (slot) => LIVE_SLOTS.includes(slot || "main");

// Closing quotes -> per-market votes, keyed week|player|stat|line, for CLV
// against the market's close.
export function indexCloseVotes(closingQuotes, holdByStat = new Map()) {
  const groups = new Map();
  for (const q of closingQuotes ?? []) {
    const key = `${q.week}|${q.playerId}|${q.stat}|${q.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const out = new Map();
  for (const [key, rows] of groups) out.set(key, bookVotes(rows, { assumedHold: holdByStat.get?.(rows[0].stat) }));
  return out;
}

// The market's closing fair P(side) without `book`, or null when fewer than two
// other books quoted that exact line at the close.
export function closeFairFor(index, { week, playerId, stat, line, book, side }, { minOthers = 2 } = {}) {
  const votes = index?.get(`${week}|${playerId}|${stat}|${line}`);
  if (!votes) return null;
  const me = canonicalBookKey(book);
  const others = votes.filter((v) => v.book !== me);
  if (others.length < minOthers) return null;
  const pOver = sigmoid(median(others.map((v) => v.logit)));
  return side === "under" ? 1 - pOver : pOver;
}

// How a bet settled, as { status, actual } with status won | lost | push |
// pending. "pending" is no stat line to settle against: the game has not been
// played, OR the actuals feed omitted the player (it omits all-zero lines, so an
// under on a player who did nothing sits here rather than winning).
export function settle(actualsByWeek, { week, playerId, stat, line, side }) {
  const actual = actualFor(actualsByWeek.get(week)?.get(String(playerId)), stat);
  if (actual === null || actual === undefined) return { status: "pending", actual: null };
  return { status: gradeOutcome(actual, line, side), actual };
}

// One board's candidate rows.
//
//   board   { slot, week, rows }   rows are the props CSV rows (strings)
//   ctx     { model, actualsByWeek, closeIndex }
//
// Returns { players: Map id -> {...}, rows: [...] }. A row is a plain object; the
// writer packs it.
export function candidatesForBoard(board, ctx) {
  const { slot, week } = board;
  const { model, actualsByWeek, closeIndex } = ctx;
  const m = model.at(week);
  const priced = asPoolPriced(board.rows, m, slot);
  const quotes = board.rows.map((r) => readPropRow(r, slot));

  // Per market: how many books quoted it and what the rest of the market says.
  const markets = new Map();
  quotes.forEach((q, i) => {
    if (!q) return;
    const key = `${q.playerId}|${q.stat}|${q.line}`;
    if (!markets.has(key)) markets.set(key, { quotes: [], stat: q.stat, playerId: q.playerId, line: q.line });
    markets.get(key).quotes.push(q);
  });
  for (const mk of markets.values()) {
    const votes = bookVotes(mk.quotes, { assumedHold: model.holdByStat.get(mk.stat) });
    mk.votes = votes;
    mk.nBooks = votes.length;
    mk.pBooks = votes.length >= 2 ? poolVotes(votes, { weights: weightsForStat(m, mk.stat) }).prob : null;
    const sv = bookVotes(mk.quotes, { assumedHold: model.holdByStat.get(mk.stat), setName: SHARP_SET });
    mk.nSharp = sv.length;
    mk.pSharp = sv.length >= 1 ? sigmoid(median(sv.map((v) => v.logit))) : null;
  }

  // Per player-stat: which line is the main one, and how far each rung sits from it.
  const ladders = new Map();
  for (const mk of markets.values()) {
    const key = `${mk.playerId}|${mk.stat}`;
    if (!ladders.has(key)) ladders.set(key, []);
    ladders.get(key).push(mk);
  }
  for (const rungs of ladders.values()) {
    rungs.sort((a, b) => a.line - b.line);
    const main = [...rungs].sort((a, b) => b.nBooks - a.nBooks || Math.abs((a.pBooks ?? 0.5) - 0.5) - Math.abs((b.pBooks ?? 0.5) - 0.5))[0];
    const mi = rungs.indexOf(main);
    rungs.forEach((mk, i) => {
      mk.mainLine = main.line;
      mk.rung = i - mi;
    });
  }

  const players = new Map();
  const rows = [];
  board.rows.forEach((r, i) => {
    const q = quotes[i];
    if (!q) return;
    const side = r.Side === "under" ? "under" : "over";
    const odds = num(r.Odds);
    const implied = num(r.ImpliedProb) ?? (odds === null ? null : americanToProb(odds));
    if (odds === null || implied === null || odds < ODDS_FLOOR || odds > ODDS_CEILING) return;

    const mk = markets.get(`${q.playerId}|${q.stat}|${q.line}`);
    const flip = (p) => (p === null || p === undefined ? null : side === "under" ? 1 - p : p);
    const pProj = projectionProbOf(r);
    const pPool = num(priced[i].OurProb);
    const pSharp = flip(mk.pSharp);
    const pFair = flip(mk.pBooks);

    const best = Math.max(pProj !== null ? pProj - implied : -1, pPool !== null ? pPool - implied : -1, pSharp !== null ? pSharp - implied : -1);
    if (!(best >= MIN_CANDIDATE_EDGE)) return;

    const { status, actual } = settle(actualsByWeek, { week, playerId: q.playerId, stat: q.stat, line: q.line, side });
    const closeFair = slot === "closing" ? null : closeFairFor(closeIndex, { week, playerId: q.playerId, stat: q.stat, line: q.line, book: r.Book, side });

    if (!players.has(q.playerId)) players.set(q.playerId, { id: q.playerId, name: q.name, team: q.team, pos: q.pos });
    rows.push({
      week,
      slot,
      live: isLiveBoard(slot),
      playerId: q.playerId,
      opp: q.opp,
      stat: q.stat,
      book: canonicalBookKey(r.Book),
      bookLabel: bookLabel(canonicalBookKey(r.Book)),
      bettable: q.bettable,
      side,
      line: q.line,
      odds,
      implied: round(implied),
      pProj: round(pProj),
      pPool: round(pPool),
      pSharp: round(pSharp),
      pFair: round(pFair),
      nBooks: mk.nBooks,
      nSharp: mk.nSharp,
      mainLine: mk.mainLine,
      rung: mk.rung,
      status,
      actual,
      closeFair: round(closeFair),
    });
  });
  return { players, rows };
}

// The whole dataset from every board. `boards` is [{ slot, week, rows }].
export function buildPaperDataset(boards, ctx) {
  const players = new Map();
  const rows = [];
  for (const b of boards) {
    const out = candidatesForBoard(b, ctx);
    for (const [id, p] of out.players) players.set(id, p);
    rows.push(...out.rows);
  }
  return { players: [...players.values()], rows };
}
