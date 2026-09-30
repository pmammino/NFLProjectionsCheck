// Assembling the labeled dataset the pricing model is fitted and scored on:
// one row per market, carrying the projection's probability, the market
// consensus probability, and what actually happened.
//
// Pure apart from the CSV reads, which are isolated in loadSeason(); the
// shaping functions below take rows and are unit tested directly (see
// pricing-dataset.test.mjs).
//
// ---------------------------------------------------------------------------
// The unit of analysis is a MARKET, not a book row
// ---------------------------------------------------------------------------
// data/props/{season}/week-NN.csv has one row per (market x book): eight books
// quoting Saquon Barkley Over 74.5 rushing yards is eight rows. They share one
// projection, one line and one outcome, so treating them as eight observations
// would inflate every sample size by the number of books and shrink every
// confidence interval by sqrt(8) — while adding no information about whether
// the model is right.
//
// So the books are collapsed into one consensus probability (consensus.mjs)
// and the market becomes one row.
//
// ---------------------------------------------------------------------------
// ... and only ONE SIDE of that market
// ---------------------------------------------------------------------------
// Where the capture recorded both sides, the Under row is an exact mirror of
// the Over: p_proj(under) = 1 - p_proj(over) by construction, the consensus
// mirrors too (median(logit(1-p)) = -median(logit(p)) exactly, since logit is
// odd and the median commutes with negation), and the outcome is the
// complement. Keeping both would double n without adding a single independent
// observation.
//
// Every market is therefore canonicalized to its Over side. A market captured
// only as an Under is mirrored into one rather than dropped, so nothing is
// lost. The report's n is then the number of genuinely distinct forecasts.
//
// ---------------------------------------------------------------------------
// Two capture schemas
// ---------------------------------------------------------------------------
// 2026 week 1 was written by an older capture: no Side, no OppositeOdds, no
// Hold/OneSided, and the projected value is in `RwProj` rather than `Proj`.
// Every row in it is an Over at a single price. Rather than exclude the week,
// readPropRow() normalizes both shapes into the same record — which is worth
// doing precisely because week 1 is the only week with no de-vigged market
// number anywhere, and so the sharpest test of the assumed-hold fallback.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./csv.mjs";
import { STAT_DEFS, isBettableStat } from "./markets.mjs";
import { gradeOutcome } from "./grading.mjs";
import { consensusProb, estimateHoldByStat } from "./consensus.mjs";

// The captures store OurProb to four decimals, so a stored "0.0000" means
// "below 0.00005", not "impossible", and a stored "1.0000" likewise. Reading
// them literally would make those rows unusable by any model that takes a
// logit — which is not a neutral exclusion: the rows the projection is most
// certain about are exactly the ones a rounding artifact would remove, and
// removing them would leave the models scored over different samples and the
// comparison between them meaningless.
//
// So they are clamped to half the storage resolution. That is the most
// probable value consistent with what was written down, and it keeps every
// model scoring the same markets.
export const STORED_PROB_EPS = 5e-5;

const clampStoredProb = (p) =>
  Math.min(1 - STORED_PROB_EPS, Math.max(STORED_PROB_EPS, p));

// Number(), except that a missing or blank cell is NaN rather than 0.
//
// The shared CSV reader fills absent columns with "", and Number("") is 0 —
// so a row missing its Line would otherwise read as a market priced at zero
// and be graded as though it were real. Every numeric read in this file goes
// through here.
function num(v) {
  if (v === undefined || v === null) return NaN;
  const t = String(v).trim();
  return t === "" ? NaN : Number(t);
}

// One CSV row -> a normalized per-book quote, or null if it isn't usable.
//
// `overOdds`/`underOdds` are stated from the market's point of view regardless
// of which side the row was written from, because that is what de-vigging
// needs and it removes the sidedness from everything downstream.
export function readPropRow(row) {
  const stat = row.Stat;
  if (!stat || !STAT_DEFS[stat]) return null;

  const side = row.Side === "under" ? "under" : "over"; // week-1 rows carry no Side; all were overs
  const line = num(row.Line);
  const odds = num(row.Odds);
  const opposite = num(row.OppositeOdds);
  const ourProb = num(row.OurProb);
  if (!Number.isFinite(line) || !Number.isFinite(odds) || !Number.isFinite(ourProb)) return null;

  const overOdds = side === "over" ? odds : opposite;
  const underOdds = side === "over" ? opposite : odds;

  return {
    season: Number(row.Season),
    week: Number(row.Week),
    playerId: String(row.PlayerID),
    name: row.Name,
    team: row.Team,
    pos: row.Pos,
    stat,
    line,
    side,
    book: row.Book,
    odds,
    overOdds: Number.isFinite(overOdds) ? overOdds : null,
    underOdds: Number.isFinite(underOdds) ? underOdds : null,
    hold: num(row.Hold),
    // `Proj` in the current schema, `RwProj` in the week-1 one. A column that
    // is present but blank must fall through the same as a missing one, which
    // `??` alone would not do.
    proj: Number.isFinite(num(row.Proj)) ? num(row.Proj) : num(row.RwProj),
    // P(over) regardless of which side the row was written from, so a mirrored
    // Under row lands on the same scale as everything else.
    probOver: clampStoredProb(side === "over" ? ourProb : 1 - ourProb),
  };
}

// The actual result for one market, or null when the actuals feed cannot grade
// it. Two distinct reasons, both legitimate:
//   - the player has no actuals row (inactive, or not yet ingested)
//   - the stat has no actuals column at all (`int`; see markets.mjs)
export function actualFor(actualsRow, stat) {
  const def = STAT_DEFS[stat];
  if (!def || !def.actualCols.length || !actualsRow) return null;
  let sum = 0;
  for (const col of def.actualCols) {
    const v = num(actualsRow[col]);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

// Group per-book quotes into markets and attach the outcome.
//
// `quotes` are readPropRow() outputs for one season (any number of weeks);
// `actualsByWeek` is Map<week, Map<playerId, actualsRow>>.
//
// Returns { samples, dropped } where `dropped` counts each reason separately —
// a silent drop is how a dataset quietly stops representing the board.
export function buildSamples(quotes, actualsByWeek, { includeRetired = false, marketSet = "retail", devigMethod, minBooks = 1 } = {}) {
  const holdByStat = estimateHoldByStat(quotes);

  const dropped = { retired: 0, noActual: 0, push: 0, noConsensus: 0, fewBooks: 0, inconsistentProj: 0 };

  const byMarket = new Map();
  const retired = new Set();
  for (const q of quotes) {
    // Canonical key ignores side: the Over and Under rows of one market are
    // the same forecast and must land in the same group.
    const key = [q.week, q.playerId, q.stat, q.line].join("|");
    if (!includeRetired && !isBettableStat(q.stat)) {
      retired.add(key);
      continue;
    }
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(q);
  }
  dropped.retired = retired.size;
  const samples = [];

  for (const [key, group] of byMarket) {
    const first = group[0];
    const actualsRow = actualsByWeek.get(first.week)?.get(first.playerId);
    const actual = actualFor(actualsRow, first.stat);
    if (actual === null) {
      dropped.noActual++;
      continue;
    }
    const outcome = gradeOutcome(actual, first.line, "over");
    if (outcome === "push") {
      dropped.push++;
      continue;
    }

    // Every quote in the group should agree on P(over) — it comes from the
    // projection, not the book. A disagreement means the group was keyed
    // wrongly or the snapshot mixes two captures; take the median and count
    // it rather than averaging a bug into the dataset.
    const probs = group.map((q) => q.probOver).filter(Number.isFinite);
    if (probs.length === 0) continue;
    const pProj = probs[0];
    if (probs.some((p) => Math.abs(p - pProj) > 1e-6)) dropped.inconsistentProj++;

    const cons = consensusProb(group, {
      side: "over",
      setName: marketSet,
      holdByStat,
      stat: first.stat,
      method: devigMethod,
    });
    if (!cons) {
      dropped.noConsensus++;
      continue;
    }
    if (cons.bookCount < minBooks) {
      dropped.fewBooks++;
      continue;
    }

    // Best available Over price among the books in the set. Not used in the
    // fit — the model predicts an outcome, not a return — but the report
    // needs it to translate a probability improvement into money.
    const bestOverOdds = bestPrice(group.map((q) => (q.side === "over" ? q.odds : q.overOdds)));

    samples.push({
      key,
      season: first.season,
      week: first.week,
      playerId: first.playerId,
      name: first.name,
      team: first.team,
      pos: first.pos,
      stat: first.stat,
      line: first.line,
      proj: first.proj,
      pProj,
      pMarket: cons.prob,
      bookCount: cons.bookCount,
      probSource: cons.probSource,
      meanHold: cons.meanHold,
      bestOverOdds,
      actual,
      y: outcome === "won" ? 1 : 0,
    });
  }

  return { samples, dropped };
}

// Best American price among a set: the one that pays most. Comparing American
// odds numerically is wrong across the sign boundary (+110 pays more than
// -110 but sorts lower), so compare on payout.
export function bestPrice(oddsList) {
  let best = null;
  let bestPayout = -Infinity;
  for (const o of oddsList) {
    if (!Number.isFinite(o) || o === 0) continue;
    const payout = o > 0 ? o / 100 : 100 / -o;
    if (payout > bestPayout) {
      bestPayout = payout;
      best = o;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export function availableSeasons(dataDir = "data") {
  const dir = join(dataDir, "props");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^\d{4}$/.test(d))
    .map(Number)
    .sort((a, b) => a - b);
}

// Load every committed prop capture and actuals snapshot for a season.
//
// A week with props but no actuals (the upcoming week) contributes nothing and
// is reported rather than silently skipped — "the model saw 3 weeks" and "the
// model saw 4 weeks, one of which was ungradable" are different facts.
export function loadSeason(season, { dataDir = "data" } = {}) {
  const propsDir = join(dataDir, "props", String(season));
  const actualsDir = join(dataDir, "actuals", String(season));
  if (!existsSync(propsDir)) throw new Error(`No prop captures at ${propsDir}`);

  const weekFiles = readdirSync(propsDir)
    .filter((f) => /^week-\d+\.csv$/.test(f))
    .sort();

  const quotes = [];
  const weeks = [];
  for (const f of weekFiles) {
    const week = Number(f.match(/week-(\d+)\.csv/)[1]);
    const rows = readCsv(join(propsDir, f));
    const parsed = rows.map(readPropRow).filter(Boolean);
    quotes.push(...parsed);
    weeks.push({ week, propRows: rows.length, usableQuotes: parsed.length });
  }

  const actualsByWeek = new Map();
  if (existsSync(actualsDir)) {
    for (const f of readdirSync(actualsDir).filter((x) => /^week-\d+\.csv$/.test(x))) {
      const week = Number(f.match(/week-(\d+)\.csv/)[1]);
      const byPlayer = new Map();
      for (const r of readCsv(join(actualsDir, f))) byPlayer.set(String(r.PlayerID), r);
      actualsByWeek.set(week, byPlayer);
    }
  }

  for (const w of weeks) w.hasActuals = actualsByWeek.has(w.week);
  return { season, quotes, actualsByWeek, weeks };
}
