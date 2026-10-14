// The engine behind the Filtered Paper Trading tab: filter a board's candidate
// bets the way a bettor would, settle them, and roll them up. Pure — no I/O, no
// DOM — so the browser and the tests run the same code (paper-filter.test.mjs).
//
// ---------------------------------------------------------------------------
// What each control means, in the order a bettor would apply it
// ---------------------------------------------------------------------------
//   which boards    slots (the captures) and weeks
//   which books     where the bet may be placed. Reference books (Pinnacle) are
//                   priced but cannot be staked, so they are out unless asked for.
//   which bets      odds range, sides, stats, books on the line, distance from the
//                   main line, and an edge floor under one of three prices.
//   sharp confirm   the sharp books' own fair price must not be worse than the
//                   price taken. It needs a sharp quote: a market no sharp book
//                   quoted cannot be confirmed, so it is dropped, not waved through.
//   shopping        one bet per market, at the best price among the books left.
//   ladder          "all": every qualifying rung. "best": one bet per player, stat
//                   and side — the rung with the biggest edge. The conservative
//                   bettor Brian asked about, with far less long-shot volume.
//   timing          "first": a bet is placed at the earliest capture where it
//                   qualifies, once. "every": each capture is its own bet, which
//                   counts the same market up to three times.
//
// The order matters and is fixed: shop within a capture, pick the rung within a
// capture, THEN take the first capture that has one. Picking the capture first
// would let Saturday's price choose a bet Tuesday never offered.
//
// Stakes are one unit flat. A flat stake is the one that makes ROI comparable
// across filters; Kelly and budgets belong to the personas.

import { americanToDecimal } from "./odds.mjs";
import { STAT_DEFS } from "./markets.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The odds range the team settled on in the thread: most of the personal betting
// they described sits between -400 and +200. It is the default and it is editable.
export const DEFAULT_ODDS_MIN = -400;
export const DEFAULT_ODDS_MAX = 200;

// The order a bet's capture happens in a week. A reconstructed opening board is
// earlier than any live capture and the closing board later.
export const SLOT_ORDER = ["opening", "main", "thursday", "saturday", "closing"];
export const LIVE_SLOTS = ["main", "thursday", "saturday"];

export const BASES = ["projection", "pool", "sharp"];
export const LADDER_MODES = ["all", "best"];
export const TIMINGS = ["first", "every"];
export const SIDES = ["both", "over", "under"];

export const MIN_BETS_FOR_A_VERDICT = 200;

export const DEFAULT_FILTERS = Object.freeze({
  slots: LIVE_SLOTS,
  weeks: null, // null = every week
  books: null, // null = every book allowed by `bettableOnly`
  bettableOnly: true,
  stats: null, // null = every stat
  sides: "both",
  oddsMin: DEFAULT_ODDS_MIN,
  oddsMax: DEFAULT_ODDS_MAX,
  basis: "projection",
  minEdge: 0.03,
  maxEdge: null, // null = no ceiling
  sharpConfirm: null, // null = off; a number = sharp fair - price must be at least this
  minBooks: 3, // books quoting the exact line ("the majority", with a board of 5-7)
  maxRung: null, // null = any; 0 = the main line only; n = within n rungs of it
  ladder: "best",
  shop: true,
  timing: "first",
});

// One-click starting points. Each is a complete filter state.
export const PRESETS = [
  {
    id: "realistic",
    label: "Realistic",
    description:
      "What a careful bettor would place: odds between -400 and +200, lines at least three books quote, one bet per player and stat at the best rung and price, placed at the first capture where it qualifies.",
    filters: {},
  },
  {
    id: "sharp",
    label: "Sharp books",
    description:
      "Only FanDuel and DraftKings (plus Pinnacle and Circa as reference prices), and only bets the sharp books' own price does not contradict. The test of whether the projection beats the hardest-to-beat part of the market.",
    filters: { books: ["fanduel", "draftkings", "pinnacle", "circasports"], bettableOnly: false, sharpConfirm: 0 },
  },
  {
    id: "ladder",
    label: "Ladders",
    description: "Every qualifying rung, the way an edge hammered everywhere it appears would be played. High volume and long odds; compare it with Realistic.",
    filters: { ladder: "all", minBooks: 1, oddsMin: -1000, oddsMax: 3000 },
  },
  {
    id: "everything",
    label: "Everything",
    description: "No filtering beyond a 3% edge: every book, every rung, every capture counted. The number the firehose reports, and the one to be most suspicious of.",
    filters: { ladder: "all", shop: false, timing: "every", minBooks: 1, oddsMin: -1000, oddsMax: 3000 },
  },
];

export const presetFilters = (id) => {
  const p = PRESETS.find((x) => x.id === id);
  return { ...DEFAULT_FILTERS, ...(p ? p.filters : {}) };
};

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

// The edge of a row under a price basis: that price's probability of the side,
// minus the probability the book's odds imply. null when the basis has no price
// for the row (no sharp book quoted it).
export function edgeOf(row, basis) {
  const p = basis === "pool" ? row.pPool : basis === "sharp" ? row.pSharp : row.pProj;
  return p === null || p === undefined || row.implied === null || row.implied === undefined ? null : p - row.implied;
}

const dec = (american) => americanToDecimal(american);

// Is an American price inside [min, max]? Compared as decimal odds, which is the
// scale that is continuous across even money (-400 to +200 is 1.25 to 3.00), so
// the bounds may be given in either order and an unusable bound simply admits
// nothing.
export function oddsInRange(american, min, max) {
  const d = dec(american);
  const lo = dec(min);
  const hi = dec(max);
  if (d === null || lo === null || hi === null) return false;
  return d >= Math.min(lo, hi) - 1e-9 && d <= Math.max(lo, hi) + 1e-9;
}

// A valid American price: at least 100 either side of zero.
export const isAmerican = (x) => Number.isFinite(x) && Math.abs(x) >= 100;

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const slotRank = (slot) => {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
};

// Did a row survive the per-row tests? `f` is a full filter state.
export function passesRow(row, f) {
  if (f.slots && !f.slots.includes(row.slot)) return false;
  if (f.weeks && !f.weeks.includes(row.week)) return false;
  if (f.bettableOnly && !row.bettable) return false;
  if (f.books && !f.books.includes(row.book)) return false;
  if (f.stats && !f.stats.includes(row.stat)) return false;
  if (f.sides !== "both" && row.side !== f.sides) return false;
  if (!oddsInRange(row.odds, f.oddsMin, f.oddsMax)) return false;
  if (row.nBooks < f.minBooks) return false;
  if (f.maxRung !== null && f.maxRung !== undefined && Math.abs(row.rung) > f.maxRung) return false;

  const edge = edgeOf(row, f.basis);
  if (edge === null || edge < f.minEdge - 1e-12) return false;
  if (f.maxEdge !== null && f.maxEdge !== undefined && edge > f.maxEdge + 1e-12) return false;

  if (f.sharpConfirm !== null && f.sharpConfirm !== undefined) {
    if (row.pSharp === null || row.pSharp === undefined) return false;
    if (row.pSharp - row.implied < f.sharpConfirm - 1e-12) return false;
  }
  return true;
}

// Keep the best of each group. `keyOf` names the group, `better(a, b)` is true
// when a beats b. Groups keep first-seen order, so output is stable.
function bestPer(rows, keyOf, better) {
  const best = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = best.get(k);
    if (!cur || better(r, cur)) best.set(k, r);
  }
  return [...best.values()];
}

// A bet: the row, its edge under the chosen basis, and how it settled for one unit.
function toBet(row, basis) {
  const d = dec(row.odds);
  let pnl = null;
  if (row.status === "won") pnl = d - 1;
  else if (row.status === "lost") pnl = -1;
  else if (row.status === "push") pnl = 0;
  const clv = row.closeFair === null || row.closeFair === undefined ? null : row.closeFair - row.implied;
  return { ...row, edge: edgeOf(row, basis), dec: d, pnl, clv };
}

// Apply every control to a set of unpacked rows. Returns bets, sorted by week,
// capture and descending edge.
export function applyFilters(rows, filters = DEFAULT_FILTERS) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  let kept = rows.filter((r) => passesRow(r, f));
  const edge = (r) => edgeOf(r, f.basis);

  // 1. Shopping: one bet per market per capture, at the best price among the books left.
  if (f.shop) {
    kept = bestPer(
      kept,
      (r) => [r.slot, r.week, r.playerId, r.stat, r.line, r.side].join("|"),
      (a, b) => a.odds !== b.odds && dec(a.odds) > dec(b.odds)
    );
  }

  // 2. Ladder: within a capture, the rung with the biggest edge (nearer the main line on a tie).
  if (f.ladder === "best") {
    kept = bestPer(
      kept,
      (r) => [r.slot, r.week, r.playerId, r.stat, r.side, f.shop ? "" : r.book].join("|"),
      (a, b) => edge(a) > edge(b) + 1e-12 || (Math.abs(edge(a) - edge(b)) <= 1e-12 && Math.abs(a.rung) < Math.abs(b.rung))
    );
  }

  // 3. Timing: the first capture where it qualifies.
  if (f.timing === "first") {
    const keyOf = (r) => (f.ladder === "best" ? [r.week, r.playerId, r.stat, r.side, f.shop ? "" : r.book] : [r.week, r.playerId, r.stat, r.line, r.side, f.shop ? "" : r.book]).join("|");
    const first = new Map();
    for (const r of kept) {
      const k = keyOf(r);
      const cur = first.get(k);
      if (cur === undefined || slotRank(r.slot) < cur) first.set(k, slotRank(r.slot));
    }
    kept = kept.filter((r) => slotRank(r.slot) === first.get(keyOf(r)));
  }

  return kept
    .map((r) => toBet(r, f.basis))
    .sort((a, b) => a.week - b.week || slotRank(a.slot) - slotRank(b.slot) || (b.edge ?? 0) - (a.edge ?? 0));
}

// ---------------------------------------------------------------------------
// Rolling up
// ---------------------------------------------------------------------------

// ROI, win rate, the band around the ROI, and CLV for a set of bets.
//
// `completeWeeks` are weeks whose games have all been played. A bet still
// "pending" in one has no stat line: for an over that is almost always a player
// who did nothing (the actuals feed omits all-zero rows), a loss the settlement
// cannot see. `roiConservative` counts every such over as a loss and voids
// every such under. A pending bet in a week still being played is just unplayed.
export function summarize(bets, { completeWeeks = [] } = {}) {
  const done = new Set(completeWeeks);
  let won = 0;
  let lost = 0;
  let push = 0;
  let unplayed = 0;
  let noLine = 0;
  let pnl = 0;
  let lossIfZero = 0;
  const returns = [];
  const clv = [];
  let oddsSum = 0;
  let edgeSum = 0;

  for (const b of bets) {
    oddsSum += b.dec;
    edgeSum += b.edge ?? 0;
    if (b.clv !== null && b.clv !== undefined) clv.push(b.clv);
    if (b.status === "won" || b.status === "lost") {
      b.status === "won" ? won++ : lost++;
      pnl += b.pnl;
      returns.push(b.pnl);
    } else if (b.status === "push") push++;
    else if (!STAT_DEFS[b.stat]?.actualCols?.length) noLine++;
    else if (done.has(b.week)) {
      noLine++;
      if (b.side === "over") lossIfZero += 1;
    } else unplayed++;
  }

  const n = returns.length;
  const mean = n ? pnl / n : null;
  const sd = n > 1 ? Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : null;
  const cn = clv.length;
  const cmean = cn ? clv.reduce((a, x) => a + x, 0) / cn : null;
  const csd = cn > 1 ? Math.sqrt(clv.reduce((a, x) => a + (x - cmean) ** 2, 0) / (cn - 1)) : null;

  return {
    bets: bets.length,
    settled: n,
    won,
    lost,
    push,
    unplayed,
    noLine,
    pnl,
    roi: n ? pnl / n : null,
    roiBand: sd !== null ? (2 * sd) / Math.sqrt(n) : null,
    perBetSd: sd,
    roiConservative: n + lossIfZero > 0 ? (pnl - lossIfZero) / (n + lossIfZero) : null,
    winRate: n ? won / n : null,
    avgDecimal: bets.length ? oddsSum / bets.length : null,
    avgEdge: bets.length ? edgeSum / bets.length : null,
    clv: cn
      ? { n: cn, avg: cmean, avgBand: csd !== null ? (2 * csd) / Math.sqrt(cn) : null, beatRate: clv.filter((x) => x > 0).length / cn, beatBand: 2 * Math.sqrt(0.25 / cn) }
      : null,
  };
}

// How many settled one-unit bets it takes to see an ROI of `roi` at two standard
// errors, given the per-bet standard deviation: the number that says whether a
// table can be read at all.
export function betsToResolve(roi, perBetSd) {
  if (!roi || !perBetSd) return null;
  return Math.ceil((2 * perBetSd / Math.abs(roi)) ** 2);
}

// Is this ROI a result or noise? Under the floor, noise; otherwise a result only
// if its band excludes zero.
export function verdict(s, { floor = MIN_BETS_FOR_A_VERDICT } = {}) {
  if (s.settled < floor) return "too few bets to call";
  if (s.roi === null || s.roiBand === null) return "no ROI";
  if (s.roi - s.roiBand > 0) return "positive";
  if (s.roi + s.roiBand < 0) return "negative";
  return "indistinguishable from zero";
}

// Group bets by a key and summarise each group. `label` turns a key into display
// text; groups sort by bets taken, most first.
export function groupSummaries(bets, keyOf, { completeWeeks = [], label = String } = {}) {
  const groups = new Map();
  for (const b of bets) {
    const k = keyOf(b);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, label: label(key), summary: summarize(rs, { completeWeeks }) }))
    .sort((a, b) => b.summary.bets - a.summary.bets || String(a.label).localeCompare(String(b.label)));
}

// Fixed buckets for the dimensions that are numbers.
export const ODDS_BUCKETS = [
  ["heavy favourite (-400 or shorter)", (d) => d <= 1.25 + 1e-9],
  ["favourite (-399 to -150)", (d) => d <= 1 + 100 / 150 + 1e-9],
  ["near even (-149 to +120)", (d) => d <= 2.2 + 1e-9],
  ["underdog (+121 to +300)", (d) => d <= 4 + 1e-9],
  ["long shot (+301 and longer)", () => true],
];
export const oddsBucket = (decimal) => ODDS_BUCKETS.find(([, test]) => test(decimal))[0];

export const EDGE_BUCKETS = [
  ["3–5%", (e) => e < 0.05],
  ["5–10%", (e) => e < 0.1],
  ["10–15%", (e) => e < 0.15],
  ["15%+", () => true],
];
export const edgeBucket = (e) => EDGE_BUCKETS.find(([, test]) => test(e))[0];

// ---------------------------------------------------------------------------
// The packed form on disk
// ---------------------------------------------------------------------------
// public/data/paper*.json holds tens of thousands of rows, so they travel as
// arrays of integers against a table of strings. Probabilities are stored x10000
// and a missing value is -1; a missing actual is -1 as well (an actual is never
// negative).

export const COLUMNS = [
  "week", "slot", "player", "opp", "stat", "book", "side", "line", "odds",
  "implied", "pProj", "pPool", "pSharp", "pFair", "nBooks", "nSharp",
  "mainLine", "rung", "status", "actual", "closeFair", "bettable",
];
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));
const STATUSES = ["pending", "won", "lost", "push"];

// Rows (objects, as paper-data.mjs makes them) -> { tables, rows: number[][] }.
export function pack(rows) {
  const tables = { slots: [], opps: [], stats: [], books: [], bookLabels: [] };
  const idx = (list, v) => {
    let i = list.indexOf(v);
    if (i === -1) i = list.push(v) - 1;
    return i;
  };
  const players = [];
  const playerIdx = new Map();
  const out = rows.map((r) => {
    if (!playerIdx.has(r.playerId)) playerIdx.set(r.playerId, players.push(r.playerId) - 1);
    const bi = idx(tables.books, r.book);
    tables.bookLabels[bi] = tables.bookLabels[bi] ?? r.bookLabel;
    const prob = (p) => (p === null || p === undefined ? -1 : Math.round(p * 10000));
    return [
      r.week,
      idx(tables.slots, r.slot),
      playerIdx.get(r.playerId),
      idx(tables.opps, r.opp ?? ""),
      idx(tables.stats, r.stat),
      bi,
      r.side === "under" ? 1 : 0,
      r.line,
      r.odds,
      prob(r.implied),
      prob(r.pProj),
      prob(r.pPool),
      prob(r.pSharp),
      prob(r.pFair),
      r.nBooks,
      r.nSharp,
      r.mainLine,
      r.rung,
      STATUSES.indexOf(r.status),
      r.actual === null || r.actual === undefined ? -1 : r.actual,
      prob(r.closeFair),
      r.bettable ? 1 : 0,
    ];
  });
  return { tables: { ...tables, players }, columns: COLUMNS, rows: out };
}

// The inverse. `players` is the dataset's player table, { id, name, team, pos }.
export function unpack(packed, players = []) {
  const { tables, rows } = packed;
  const byId = new Map(players.map((p) => [String(p.id), p]));
  const prob = (v) => (v < 0 ? null : v / 10000);
  return rows.map((a) => {
    const id = tables.players[a[COL.player]];
    const p = byId.get(String(id));
    return {
      week: a[COL.week],
      slot: tables.slots[a[COL.slot]],
      playerId: String(id),
      name: p?.name ?? String(id),
      team: p?.team ?? "",
      pos: p?.pos ?? "",
      opp: tables.opps[a[COL.opp]],
      stat: tables.stats[a[COL.stat]],
      book: tables.books[a[COL.book]],
      bookLabel: tables.bookLabels[a[COL.book]],
      side: a[COL.side] === 1 ? "under" : "over",
      line: a[COL.line],
      odds: a[COL.odds],
      implied: prob(a[COL.implied]),
      pProj: prob(a[COL.pProj]),
      pPool: prob(a[COL.pPool]),
      pSharp: prob(a[COL.pSharp]),
      pFair: prob(a[COL.pFair]),
      nBooks: a[COL.nBooks],
      nSharp: a[COL.nSharp],
      mainLine: a[COL.mainLine],
      rung: a[COL.rung],
      status: STATUSES[a[COL.status]] ?? "pending",
      actual: a[COL.actual] < 0 ? null : a[COL.actual],
      closeFair: prob(a[COL.closeFair]),
      bettable: a[COL.bettable] === 1,
    };
  });
}
