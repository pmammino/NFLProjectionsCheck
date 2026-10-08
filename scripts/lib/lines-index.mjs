// Turning the captured price board into something a browser can search. Pure —
// no I/O, unit tested directly (see lines-index.test.mjs); the reading and
// writing live in scripts/build-lines-data.mjs.
//
// ---------------------------------------------------------------------------
// What this answers
// ---------------------------------------------------------------------------
// The Paper Trading tab shows the bets a persona TOOK. It cannot show the other
// side of a market, an alternate line, or anything under the edge bar, because
// those are not in a ledger — they are only in data/props/, which is far too
// large to ship (about 105,000 rows per week per capture). This is the compact
// view of that board: for one player and one stat, every line that was quoted,
// what our projection says about it, what the books say, and who is offering
// what.
//
// ---------------------------------------------------------------------------
// Shape, and why
// ---------------------------------------------------------------------------
// One file per (week, slot). A slot is one capture of the week (see slots.mjs),
// and the same line is priced differently in each — the Tuesday drop, the
// opening board and the closing board are different instruments — so they are
// kept apart rather than merged. Merging them was the mistake the pricing
// dataset made once already: a "consensus" blended across moments that matches
// none of them.
//
// Measured on 2026 week 4: the full board for one slot is 37,894 lines over 245
// players, 2.9 MB raw and 0.46 MB gzipped. That is small enough to ship whole,
// so nothing is trimmed: dropping lopsided alternate lines would save little
// and would make "why is this line missing?" a question the UI could not
// answer.
//
// Everything that needs the model is computed here, once. Everything that is
// arithmetic on a price (implied probability, edge at a book, no-vig) is left
// to the browser, so the file carries odds rather than a pre-multiplied matrix
// of edges.

import { canonicalBookKey } from "./books.mjs";
import { consensusProb, estimateHoldByStat } from "./consensus.mjs";
import { STAT_DEFS } from "./markets.mjs";
import { probOverContinuous } from "./probability.mjs";
import { adjustedPoints, CORRECTABLE_STATS } from "./median-correction.mjs";
import { actualFor } from "./pricing-dataset.mjs";

// Bump when the shape of the file changes, so a stale cached build is rebuilt
// AND so the page can refuse a file it does not understand. Version 2 added `q`
// (how the market price was obtained); a page reading a version-1 file would
// have shown every price as inferred. lib/lines.ts mirrors this number.
export const LINES_SCHEMA_VERSION = 2;

// A capture is "uncorrected" if its stored probability matches a re-pricing
// from the frozen snapshot to storage precision (four decimals).
const CONSISTENT = 1e-3;

// A priced median further than this from the frozen snapshot's means the
// capture was priced off an EARLIER projection (RotoWire refreshes daily).
const STALE_MEDIAN = 0.05;

const LABELS = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  caesars: "Caesars",
  betrivers: "BetRivers",
  hardrock: "Hard Rock",
  thescore: "theScore",
  circasports: "Circa",
  circavegas: "Circa Vegas",
  pinnacle: "Pinnacle",
  betr: "Betr",
};

export { canonicalBookKey };

export function bookLabel(book) {
  return LABELS[canonicalBookKey(book)] ?? String(book);
}

// How the retail consensus was obtained, as a code to keep the file small.
// A price built from a one-sided quote is INFERRED — an assumed margin is
// stripped from it — rather than measured, and the page marks it as such: a
// number the book never implied should not look like one it did.
export const MARKET_SOURCES = ["devig", "mixed", "assumed-hold"];

const round4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

const sumCols = (row, cols) => cols.reduce((t, c) => t + (Number(row?.[c]) || 0), 0);

// Stats in the order a person expects to read them, not the order they were
// first seen.
const STAT_ORDER = Object.keys(STAT_DEFS);

// The F/M/C of one player-stat from a projection snapshot (Map playerId ->
// { F, M, C } rows), or null.
export function projectionFor(snapshot, playerId, stat) {
  const sp = snapshot?.get?.(String(playerId));
  const def = STAT_DEFS[stat];
  if (!sp?.M || !def) return null;
  return {
    F: sp.F ? sumCols(sp.F, def.projCols) : null,
    M: sumCols(sp.M, def.projCols),
    C: sp.C ? sumCols(sp.C, def.projCols) : null,
  };
}

// Build one (week, slot) file.
//
//   quotes      readPropRow() output for exactly this slot and week
//   snapshot    Map playerId -> { F, M, C }, the frozen projection (or null)
//   actuals     Map playerId -> actuals row (or empty)
//   correction  fitFromData().fits as of this week (or null)
export function buildSlotFile({ season, week, slot, quotes, snapshot = null, actuals = new Map(), correction = null, generatedAt }) {
  const holdByStat = estimateHoldByStat(quotes);

  // 1. group quotes into markets: one per player, stat and line.
  const byMarket = new Map();
  for (const q of quotes) {
    const key = `${q.playerId}|${q.stat}|${q.line}`;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(q);
  }

  // 2. the book table. Order is deterministic — bettable first, then by label —
  //    so the same board always yields the same file.
  const found = new Map();
  for (const q of quotes) {
    const k = canonicalBookKey(q.book);
    const cur = found.get(k);
    const bettable = q.bettable !== false;
    // A book is bettable if ANY of its rows says so: the flag is a property of
    // the book, and a single stray row must not demote it.
    if (!cur) found.set(k, { k, label: bookLabel(q.book), t: bettable ? 1 : 0 });
    else if (bettable) cur.t = 1;
  }
  const books = [...found.values()].sort((a, b) => b.t - a.t || a.label.localeCompare(b.label));
  const bookIndex = new Map(books.map((b, i) => [b.k, i]));

  // 3. players, each with their stats and lines.
  const players = new Map();
  let markets = 0;
  for (const group of byMarket.values()) {
    const first = group[0];
    const def = STAT_DEFS[first.stat];

    // One entry per book. A two-sided book can appear as an Over row AND an
    // Under row; both carry both prices (stated from the market's side), so
    // the first non-null of each is the book's price.
    const perBook = new Map();
    for (const q of group) {
      const bi = bookIndex.get(canonicalBookKey(q.book));
      const cur = perBook.get(bi) ?? [bi, null, null];
      if (cur[1] === null && q.overOdds !== null) cur[1] = q.overOdds;
      if (cur[2] === null && q.underOdds !== null) cur[2] = q.underOdds;
      perBook.set(bi, cur);
    }

    const retail = consensusProb(group, { side: "over", setName: "retail", holdByStat, stat: first.stat });
    const sharp = consensusProb(group, { side: "over", setName: "sharp", holdByStat, stat: first.stat });

    // The median-corrected price, only where it is honest to give one: the
    // stat is corrected as of this week, the capture itself was NOT corrected,
    // and re-pricing from the snapshot reproduces what was stored. A capture
    // priced off an earlier projection cannot be compared with today's.
    let a = null;
    const fmc = def?.kind === "continuous" ? projectionFor(snapshot, first.playerId, first.stat) : null;
    if (fmc && fmc.F !== null && fmc.C !== null && correction?.[first.stat]?.applied && (first.medianAdj ?? null) === null) {
      const recomputed = probOverContinuous(first.line, fmc.F, fmc.M, fmc.C);
      if (Math.abs(recomputed - first.probOver) <= CONSISTENT) {
        const adj = adjustedPoints(fmc, correction, first.stat);
        a = round4(probOverContinuous(first.line, adj.F, adj.M, adj.C));
      }
    }

    const entry = {
      l: first.line,
      p: round4(first.probOver),
      a,
      m: round4(retail?.prob),
      // 0 = every contributing book quoted both sides (measured), 1 = a mix,
      // 2 = inferred from one-sided quotes. Index into MARKET_SOURCES.
      q: retail ? MARKET_SOURCES.indexOf(retail.probSource) : null,
      s: round4(sharp?.prob),
      b: [...perBook.values()].sort((x, y) => x[0] - y[0]),
    };

    if (!players.has(first.playerId)) {
      players.set(first.playerId, { id: first.playerId, name: first.name, team: first.team, pos: first.pos, opp: first.opp ?? "", stats: new Map() });
    }
    const pl = players.get(first.playerId);
    if (!pl.stats.has(first.stat)) pl.stats.set(first.stat, { priced: first.proj, lines: [] });
    pl.stats.get(first.stat).lines.push(entry);
    markets++;
  }

  // 4. finish each player-stat: sort lines, attach projection and result.
  const outPlayers = [...players.values()]
    .sort((x, y) => x.name.localeCompare(y.name) || String(x.id).localeCompare(String(y.id)))
    .map((pl) => {
      const stats = {};
      for (const stat of STAT_ORDER) {
        const st = pl.stats.get(stat);
        if (!st) continue;
        const def = STAT_DEFS[stat];
        const proj = projectionFor(snapshot, pl.id, stat);
        const adj =
          proj && def.kind === "continuous" && correction?.[stat]?.applied && proj.F !== null && proj.C !== null
            ? adjustedPoints(proj, correction, stat)
            : null;
        const actual = actualFor(actuals.get(String(pl.id)), stat);
        stats[stat] = {
          kind: def.kind,
          proj: proj && { F: round2(proj.F), M: round2(proj.M), C: round2(proj.C) },
          adj: adj && { F: round2(adj.F), M: round2(adj.M), C: round2(adj.C) },
          priced: Number.isFinite(st.priced) ? round2(st.priced) : null,
          stale: !!proj && Number.isFinite(st.priced) && Math.abs(st.priced - proj.M) > STALE_MEDIAN,
          actual,
          lines: st.lines.sort((x, y) => x.l - y.l),
        };
      }
      return { id: pl.id, name: pl.name, team: pl.team, pos: pl.pos, opp: pl.opp, stats };
    });

  return {
    schema: LINES_SCHEMA_VERSION,
    season,
    week,
    slot,
    generatedAt,
    books,
    // Which stats are corrected as of this week, and by how much. Only the
    // eligible stats are listed; the rest are "not eligible" by design.
    correction: correction
      ? Object.fromEntries(
          CORRECTABLE_STATS.filter((s) => correction[s]).map((s) => {
            const c = correction[s];
            return [s, { applied: !!c.applied, reason: c.reason, n: c.n, kF: round4(c.kF), kM: round4(c.kM), kC: round4(c.kC), z: round2(c.z) }];
          })
        )
      : null,
    counts: { players: outPlayers.length, markets, quotes: quotes.length },
    players: outPlayers,
  };
}

// Keep the latest `max` weeks. A season grows by ~6 MB of JSON per week, and
// the point of this view is the recent board, so older weeks age out rather
// than the deployment growing without bound.
export function selectWeeks(weeks, max) {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  if (!Number.isFinite(max) || max <= 0 || sorted.length <= max) return sorted;
  return sorted.slice(sorted.length - max);
}

// The index the UI opens first. `entries` are { week, slot, file, markets,
// players, bytes }; `actualsWeeks` is the set of weeks with results.
//
// The default slot for a week is the one with the MOST markets: the fullest
// board is the one a person looking for "the line" is most likely to want,
// and the others stay one click away. Ties break on name so the choice is
// deterministic.
export function buildIndex({ season, entries, actualsWeeks = new Set(), generatedAt }) {
  const byWeek = new Map();
  for (const e of entries) {
    if (!byWeek.has(e.week)) byWeek.set(e.week, []);
    byWeek.get(e.week).push(e);
  }
  const weeks = [...byWeek.keys()]
    .sort((a, b) => a - b)
    .map((week) => {
      const slots = byWeek
        .get(week)
        .map((e) => ({ slot: e.slot, file: e.file, markets: e.markets, players: e.players, bytes: e.bytes }))
        .sort((a, b) => b.markets - a.markets || a.slot.localeCompare(b.slot));
      return { week, hasActuals: actualsWeeks.has(week), defaultSlot: slots[0].slot, slots };
    });
  return {
    schema: LINES_SCHEMA_VERSION,
    season,
    generatedAt,
    defaultWeek: weeks.length ? weeks[weeks.length - 1].week : null,
    weeks,
  };
}
