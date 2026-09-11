// Pure normalizer for RotoWire's "all-bets-props-plus-proj" feed
// (betting/nfl/tables/all-bets-props-plus-proj.php[?prop=X]) into flat
// candidate rows, one per (player, stat, book). No I/O — unit tested against
// captured sample records (see props.test.mjs).
//
// ---------------------------------------------------------------------------
// Feed field reference (captured from the live endpoint, 2026-09-11)
// ---------------------------------------------------------------------------
// Bare array of records, keyed by RotoWire `playerID` (same id space as the
// projection/actuals feeds — joins with no crosswalk):
//   betSubject, team, opp, pos, game, proj (RotoWire's own point projection —
//   NOT used by our model, captured only for reference), plus per-book columns:
//     {book}_ml   American odds for the side this feed surfaces (always present
//                 when the book quotes this player/stat)
//     {book}_val  "<line> (<odds>)" for over/under markets (e.g. Pass Yards),
//                 or just "<odds>" for single-sided yes/no markets (Anytime TD
//                 and, assumed, the other TD/turnover count props) — {book}_ml
//                 always carries the same odds, so it's the only field we need
//                 for price; {book}_val is only consulted for its line number.
//     {book}_chance  present on over/under markets, absent on TD markets;
//                 unexplained/inconsistent with implied probability from the
//                 odds (e.g. -116 implies ~53.7%, but chance reads "3.0") — not
//                 RotoWire's win probability. Ignored; we compute our own
//                 implied probabilities from the odds.
//
// IMPORTANT CAVEAT: every market here is single-sided — the feed surfaces one
// price (presumably "Over" for yardage/attempt/completion/reception markets,
// "Yes" for TD/turnover count markets) with no opposing price, so there is no
// way to de-vig against this feed alone. Our "market probability" is the
// vig-included implied probability of the best available single-sided price,
// not a fair/no-vig probability. See README for detail.

import { asRecords } from "./rotowire.mjs";

// Sportsbooks RotoWire quotes in this feed.
export const BOOKS = [
  "betr",
  "draftkings",
  "fanduel",
  "mgm",
  "betrivers",
  "caesars",
  "hardrock",
  "thescore",
  "circasports",
];

// Stat definitions: how to query the feed, how to price it, and which
// column(s) of the weekly projections snapshot hold its projection.
//   queryProp: value for the feed's `?prop=` query param (null = no param,
//     i.e. the default Anytime TD table).
//   hasLine: true = over/under market with a real line (parsed from `_val`);
//     false = single-sided yes/no market, treated as an implicit "over 0.5"
//     (matches how lib/td.ts already treats anytime-TD scoring).
//   kind: "continuous" -> two-piece-normal model off Floor/Median/Ceiling;
//     "poisson" -> Poisson model off the projected median count.
//   projCols: weekly_projections column(s) to sum for the projected value.
export const STAT_DEFS = {
  anytimeTD: { queryProp: null, hasLine: false, kind: "poisson", projCols: ["RushTDs", "RecTDs"] },
  passYds: { queryProp: "passYds", hasLine: true, kind: "continuous", projCols: ["PassYards"] },
  passAtt: { queryProp: "passAtt", hasLine: true, kind: "continuous", projCols: ["PassAttempts"] },
  completions: { queryProp: "completions", hasLine: true, kind: "continuous", projCols: ["PassCompletions"] },
  passTD: { queryProp: "passTD", hasLine: false, kind: "poisson", projCols: ["PassTDs"] },
  int: { queryProp: "int", hasLine: false, kind: "poisson", projCols: ["PassInts"] },
  rushYds: { queryProp: "rushYds", hasLine: true, kind: "continuous", projCols: ["RushYards"] },
  rushAtt: { queryProp: "rushAtt", hasLine: true, kind: "continuous", projCols: ["RushAttempts"] },
  rushTD: { queryProp: "rushTD", hasLine: false, kind: "poisson", projCols: ["RushTDs"] },
  receptions: { queryProp: "receptions", hasLine: true, kind: "continuous", projCols: ["RecCompletions"] },
  recYds: { queryProp: "recYds", hasLine: true, kind: "continuous", projCols: ["RecYards"] },
  recTD: { queryProp: "recTD", hasLine: false, kind: "poisson", projCols: ["RecTDs"] },
};

const pick = (row, key) => {
  const v = row?.[key];
  return v === undefined || v === null ? "" : String(v).trim();
};

const numOrNull = (row, key) => {
  const v = pick(row, key);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// One feed record -> zero or more candidate rows (one per book that quotes
// this player/stat).
export function parseRecord(rec, statKey, statDef) {
  const playerId = pick(rec, "playerID") || pick(rec, "playerid");
  if (!playerId) return [];
  const name = pick(rec, "betSubject");
  const team = pick(rec, "team").toUpperCase();
  const pos = pick(rec, "pos").toUpperCase();
  const opp = pick(rec, "opp");
  const game = pick(rec, "game");
  const rwProj = numOrNull(rec, "proj");

  const out = [];
  for (const book of BOOKS) {
    const odds = numOrNull(rec, `${book}_ml`);
    if (odds === null) continue;

    let line = 0.5;
    if (statDef.hasLine) {
      const valRaw = pick(rec, `${book}_val`);
      const m = valRaw.match(/^(-?[\d.]+)/);
      if (!m) continue; // malformed/unexpected val — skip this book's price
      line = Number(m[1]);
    }

    out.push({ statKey, playerId, name, team, pos, opp, game, book, line, odds, rwProj });
  }
  return out;
}

// Full feed payload (for one stat's query) -> flat candidate rows.
export function normalizePropsFeed(payload, statKey) {
  const statDef = STAT_DEFS[statKey];
  if (!statDef) throw new Error(`Unknown stat key: ${statKey}`);
  const rows = [];
  for (const rec of asRecords(payload)) rows.push(...parseRecord(rec, statKey, statDef));
  return rows;
}
