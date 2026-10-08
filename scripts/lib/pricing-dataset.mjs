// Assembling the labeled dataset the pricing model is fitted and scored on:
// one row per market, carrying the projection's probability, the market
// consensus probability, and what actually happened.
//
// Pure apart from the CSV reads, which are isolated in loadSeason(); the
// shaping functions below take rows and are unit tested directly (see
// pricing-dataset.test.mjs).
//
// ---------------------------------------------------------------------------
// The unit of analysis is a MARKET AT A MOMENT, not a book row
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
import { SLOT_MAIN, slotOf } from "./slots.mjs";

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
export function readPropRow(row, slot) {
  const stat = row.Stat;
  if (!stat || !STAT_DEFS[stat]) return null;

  const side = row.Side === "under" ? "under" : "over"; // week-1 rows carry no Side; all were overs
  const line = num(row.Line);
  const odds = num(row.Odds);
  const opposite = num(row.OppositeOdds);
  const ourProb = num(row.OurProb);
  const priceModel = row.PriceModel ?? "";
  const projRaw = num(row.ProjProb);
  const projProb = Number.isFinite(projRaw) ? projRaw : !priceModel || priceModel === "projection" ? ourProb : NaN;
  if (!Number.isFinite(line) || !Number.isFinite(odds) || !Number.isFinite(ourProb)) return null;

  const overOdds = side === "over" ? odds : opposite;
  const underOdds = side === "over" ? opposite : odds;

  return {
    // A row written before slots existed carries no Slot column, and every
    // one of those came from the Tuesday drop.
    slot: slot ?? slotOf(row),
    season: Number(row.Season),
    week: Number(row.Week),
    playerId: String(row.PlayerID),
    name: row.Name,
    team: row.Team,
    pos: row.Pos,
    opp: row.Opp ?? "",
    // How the price was obtained: "live" for a capture taken at the time,
    // "opening"/"closing" for a reconstruction from history. A row with no
    // column is a week-1 capture, all of which were live. It decides whether
    // the projection on the row can be trusted as of that moment (see
    // isPointInTime).
    lineSource: row.LineSource ?? "",
    // Which model produced OurProb on this row; blank on every row captured
    // before the column existed, all of which were the projection price.
    priceModel,
    // The fixture's id leads with its date (YYYYMMDD…): when the game was played.
    fixtureId: row.FixtureID ?? "",
    stat,
    line,
    side,
    book: row.Book,
    odds,
    overOdds: Number.isFinite(overOdds) ? overOdds : null,
    underOdds: Number.isFinite(underOdds) ? underOdds : null,
    hold: num(row.Hold),
    // The multiplier applied to the projected median before this row was
    // priced, or null. Blank on every row captured before the correction
    // existed, none of which were corrected. Carried so a fit can tell when it
    // is mixing corrected and uncorrected projection probabilities.
    medianAdj: Number.isFinite(num(row.MedianAdj)) ? num(row.MedianAdj) : null,
    // Reference books price the consensus but can never be staked, so they
    // are excluded from the best-price comparison below. Absent on rows
    // captured before the split, all of which were bettable.
    bettable: row.Bettable === undefined || row.Bettable === "" ? true : num(row.Bettable) === 1,
    // `Proj` in the current schema, `RwProj` in the week-1 one. A column that
    // is present but blank must fall through the same as a missing one, which
    // `??` alone would not do.
    proj: Number.isFinite(num(row.Proj)) ? num(row.Proj) : num(row.RwProj),
    // P(over) regardless of which side the row was written from, so a mirrored
    // Under row lands on the same scale as everything else.
    // What the projection ALONE said, as P(over); NaN when the row cannot say.
    // ProjProb is that where it exists. A row from before the column is a
    // projection price in OurProb if no re-pricing model ran, and otherwise has
    // no projection probability at all — OurProb is then mostly the books'.
    probOver: Number.isFinite(projProb) ? clampStoredProb(side === "over" ? projProb : 1 - projProb) : NaN,
    // The price we would have bet at, from whichever model priced the row.
    ourProbOver: clampStoredProb(side === "over" ? ourProb : 1 - ourProb),
  };
}

// Was the projection on this quote the one we actually HAD at the time?
//
// True for a live capture, whose OurProb was computed from the snapshot on disk
// that day. False for a reconstruction: a backfilled opening or closing board is
// priced from the week's latest snapshot, written days later, which contains
// everything that happened in between. The two are not the same forecast, and
// the difference is not small — the market later "moves toward" the final
// snapshot's price about ten times as strongly as toward the one available at
// the start of the week, because the late snapshot has absorbed the same news.
// Treating the reconstruction as a forecast would credit the projection with
// information it only acquired afterwards.
export function isPointInTime(quote) {
  return !quote.lineSource || quote.lineSource === "live";
}

// Can this quote say what the projection said?
//
// Everything downstream that wants "what the projection said" reads `probOver`,
// which is ProjProb where the capture recorded it and OurProb only for a row
// priced from the projection alone. A row priced off the blend or the weighted
// pool, from before ProjProb existed, carries an OurProb that is already mostly
// the books': fitting a model, or assessing the projection as a source, on it
// would measure the market agreeing with itself and credit the projection for it.
export function isProjectionPrice(quote) {
  return Number.isFinite(quote.probOver);
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

  const dropped = { retired: 0, noActual: 0, push: 0, noConsensus: 0, fewBooks: 0, inconsistentProj: 0, notProjectionPrice: 0 };

  const byMarket = new Map();
  const retired = new Set();
  for (const q of quotes) {
    // Canonical key ignores side — the Over and Under rows of one market are
    // the same forecast — but NOT the slot.
    //
    // Merging slots was the first version here and it is wrong twice over.
    // A slot is a capture at a moment, so pooling the Tuesday drop with a
    // closing reconstruction produces a "consensus" blended across times that
    // corresponds to no moment the market ever occupied; and because RotoWire
    // revises its projections daily, the two captures also disagree about
    // P(over) for the same line, so the merged row silently picked one. On
    // the 2026 backfill that fired on 2,072 markets.
    //
    // Keyed by slot, each capture is its own forecast of the same event at its
    // own lead time — which is how a forecast is normally scored, and it is
    // what lets the report ask whether the model does better on the Tuesday
    // board or the closing one. The two are not independent, but clustering is
    // on (week, player) and already handles that.
    const key = [q.slot, q.week, q.playerId, q.stat, q.line].join("|");
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

    // Every quote in the group should now agree on P(over) exactly: it comes
    // from the projection rather than the book, and a slot is one capture. A
    // disagreement here means the keying is wrong or a snapshot mixes two
    // captures, so it is counted rather than averaged away.
    // Only a projection-priced row can say what the projection said. A market
    // captured under the blend or the pool keeps its books' quotes for the
    // consensus but has no usable projection probability, and is counted.
    const probs = group.filter(isProjectionPrice).map((q) => q.probOver).filter(Number.isFinite);
    if (probs.length === 0) {
      dropped.notProjectionPrice++;
      continue;
    }
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
    // needs it to translate a probability improvement into money, and for
    // that it has to be a price somebody could have taken. Reference books
    // contribute to the consensus above and are excluded here.
    const bestOverOdds = bestPrice(
      group.filter((q) => q.bettable !== false).map((q) => (q.side === "over" ? q.odds : q.overOdds))
    );

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
      // Which capture of the week this forecast belongs to.
      slot: first.slot,
      medianAdj: first.medianAdj ?? null,
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

  // Every slot's capture of every week, with `slot` carried on every quote so
  // buildSamples can keep them apart. See the note there on why they must not
  // be merged.
  const slotDirs = [{ slot: SLOT_MAIN, dir: propsDir }];
  for (const entry of readdirSync(propsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) slotDirs.push({ slot: entry.name, dir: join(propsDir, entry.name) });
  }

  const quotes = [];
  const weeks = new Map();
  for (const { slot, dir } of slotDirs) {
    for (const f of readdirSync(dir).filter((x) => /^week-\d+\.csv$/.test(x)).sort()) {
      const week = Number(f.match(/week-(\d+)\.csv/)[1]);
      const rows = readCsv(join(dir, f));
      const parsed = rows.map((r) => readPropRow(r, slot)).filter(Boolean);
      quotes.push(...parsed);
      if (!weeks.has(week)) weeks.set(week, { week, propRows: 0, usableQuotes: 0, slots: [] });
      const w = weeks.get(week);
      w.propRows += rows.length;
      w.usableQuotes += parsed.length;
      w.slots.push(slot);
    }
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

  const weekList = [...weeks.values()].sort((a, b) => a.week - b.week);
  for (const w of weekList) w.hasActuals = actualsByWeek.has(w.week);
  return { season, quotes, actualsByWeek, weeks: weekList };
}
