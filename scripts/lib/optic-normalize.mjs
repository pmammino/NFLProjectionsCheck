// Turns OpticOdds response payloads into paired, two-sided market rows. Pure —
// no I/O, unit tested against representative payload shapes (see
// optic-normalize.test.mjs).
//
// ---------------------------------------------------------------------------
// What "pairing" means and why it's the point of this module
// ---------------------------------------------------------------------------
// OpticOdds returns each side of a market as its own record: an Over at one
// price and an Under at another. To de-vig we need them back together, because
// a fair probability is only defined for a COMPLETE market. This module groups
// records into (fixture, book, stat, player, line) buckets and emits one row
// per bucket carrying both prices — or one price plus an explicit
// `oneSided: true` flag when the book only quotes a single side.
//
// That flag matters downstream: a one-sided row cannot be de-vigged, so its
// edge has to fall back to the raw (vig-inclusive) implied probability — which
// is exactly the overstated number the whole OpticOdds migration exists to get
// away from. Callers should treat one-sided rows as lower-confidence and the
// capture script reports how many there were.
//
// ---------------------------------------------------------------------------
// CONTRACT STATUS
// ---------------------------------------------------------------------------
// Field names here have NOT been verified against a live OpticOdds response.
// Every read goes through `firstOf`, which tries the plausible spellings and
// returns undefined rather than throwing, and anything unreadable is counted
// in the returned diagnostics instead of silently becoming null. Run
// `node scripts/optic-discover.mjs --dump-odds` with a live key to print real
// records, then prune the alias lists below to what the API actually sends.

import { matchStatKey } from "./markets.mjs";

// Read the first present key from a list of candidate spellings.
function firstOf(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// Several fields may arrive either as a scalar or as a { id, name } object.
function scalarOf(value, nameKeys = ["name", "display_name", "title"]) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") return firstOf(value, nameKeys);
  return value;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- Flattening --------------------------------------------------------------
// A payload may be a bare array of odds, an envelope around one, or an array of
// fixtures each carrying a nested `odds` array. Flatten all three into odds
// records, attaching the parent fixture's context where it exists (the nested
// form usually omits fixture_id on the child records).
export function flattenOddsPayloads(payloads) {
  const out = [];
  const visitContainer = (container) => {
    const rows = Array.isArray(container)
      ? container
      : Array.isArray(container?.data)
        ? container.data
        : container && typeof container === "object"
          ? [container]
          : [];

    for (const row of rows) {
      const nested = row?.odds;
      if (Array.isArray(nested)) {
        // Fixture-shaped: carry the fixture's own identifiers down to each odd.
        const context = {
          fixtureId: scalarOf(firstOf(row, ["id", "fixture_id", "fixtureId", "game_id"])),
          homeTeam: scalarOf(firstOf(row, ["home_team_display", "home_team", "homeTeam"])),
          awayTeam: scalarOf(firstOf(row, ["away_team_display", "away_team", "awayTeam"])),
          startDate: scalarOf(firstOf(row, ["start_date", "startDate", "game_time", "start_time"])),
        };
        for (const odd of nested) out.push({ raw: odd, context });
      } else if (row && typeof row === "object") {
        out.push({ raw: row, context: {} });
      }
    }
  };

  for (const payload of payloads || []) visitContainer(payload);
  return out;
}

// ---- Side detection ----------------------------------------------------------
// Which half of the market a record is. Over/Yes is the side we model (our
// projections answer "how much", so "more than the line" is always the
// affirmative side); Under/No is its complement.
export function detectSide(raw) {
  const explicit = scalarOf(firstOf(raw, ["selection_line", "selectionLine", "side", "position"]));
  const fromExplicit = sideWord(explicit);
  if (fromExplicit) return fromExplicit;

  // Fall back to the selection label, which on an over/under market is
  // literally "Over"/"Under" and on a yes/no market "Yes"/"No". On an anytime
  // -TD market the selection is the player's NAME, which is not a side word —
  // handled by the caller as an implicitly-affirmative single side.
  return sideWord(scalarOf(firstOf(raw, ["selection", "name", "outcome"])));
}

function sideWord(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === "over" || s === "yes" || s === "o") return "over";
  if (s === "under" || s === "no" || s === "u") return "under";
  return null;
}

// ---- Record extraction -------------------------------------------------------
// One raw odds record -> our canonical shape, or null if it isn't usable.
export function readOdd(entry) {
  const raw = entry?.raw ?? entry;
  const context = entry?.context ?? {};
  if (!raw || typeof raw !== "object") return null;

  const marketName = scalarOf(firstOf(raw, ["market", "market_name", "marketName"]));
  const statKey = matchStatKey(marketName);

  const playerObj = raw.player && typeof raw.player === "object" ? raw.player : null;
  const playerId = scalarOf(
    firstOf(raw, ["player_id", "playerId"]) ?? (playerObj ? firstOf(playerObj, ["id"]) : undefined)
  );
  const playerName =
    scalarOf(firstOf(raw, ["player_name", "playerName"])) ??
    (playerObj ? scalarOf(playerObj) : undefined) ??
    scalarOf(firstOf(raw, ["player"]));

  const team = scalarOf(
    firstOf(raw, ["team", "team_abbreviation", "team_display", "player_team"]) ??
      (playerObj ? firstOf(playerObj, ["team", "team_abbreviation"]) : undefined)
  );

  return {
    fixtureId: String(
      scalarOf(firstOf(raw, ["fixture_id", "fixtureId", "game_id"])) ?? context.fixtureId ?? ""
    ),
    sportsbook: String(scalarOf(firstOf(raw, ["sportsbook", "sportsbook_name", "book"])) ?? ""),
    marketName: marketName === undefined ? "" : String(marketName),
    statKey,
    playerId: playerId === undefined ? "" : String(playerId),
    playerName: playerName === undefined ? "" : String(playerName),
    team: team === undefined ? "" : String(team),
    // `points` is the line. Absent on a yes/no market (anytime TD), where the
    // implicit line is 0.5 — the caller supplies that from the stat def.
    points: numOrNull(firstOf(raw, ["points", "line", "handicap", "total"])),
    price: numOrNull(firstOf(raw, ["price", "odds", "american_odds", "american", "money"])),
    side: detectSide(raw),
    isMain: firstOf(raw, ["is_main", "isMain", "main"]) === true,
    timestamp: scalarOf(firstOf(raw, ["timestamp", "updated_at", "last_updated", "time"])) ?? null,
    startDate: context.startDate ?? scalarOf(firstOf(raw, ["start_date", "game_time"])) ?? null,
  };
}

// ---- Pairing -----------------------------------------------------------------
// Group canonical records into two-sided markets.
//
// The grouping key deliberately includes the LINE: a book quoting 249.5 and
// 259.5 for the same player is offering two distinct markets, and de-vigging an
// Over 249.5 against an Under 259.5 would produce a fair probability for a
// market that does not exist (and one that always looks like free money,
// because the pair's raw probabilities sum to less than 1).
export function pairOdds(records, { statDefs }) {
  const groups = new Map();
  const diagnostics = {
    total: records.length,
    unmatchedMarkets: new Map(), // market name -> count
    missingPrice: 0,
    missingPlayer: 0,
    noSide: 0,
  };

  for (const rec of records) {
    if (!rec) continue;
    if (!rec.statKey) {
      const key = rec.marketName || "(unnamed market)";
      diagnostics.unmatchedMarkets.set(key, (diagnostics.unmatchedMarkets.get(key) ?? 0) + 1);
      continue;
    }
    if (rec.price === null) {
      diagnostics.missingPrice++;
      continue;
    }
    if (!rec.playerName && !rec.playerId) {
      diagnostics.missingPlayer++;
      continue;
    }

    const def = statDefs[rec.statKey];
    // A yes/no market carries no line; treat it as the implicit "over 0.5"
    // that lib/td.ts already uses for anytime-TD scoring.
    const line = def && def.hasLine === false ? 0.5 : rec.points;
    if (line === null) {
      diagnostics.missingPrice++;
      continue;
    }

    // No side word on a yes/no market means this is the affirmative side (the
    // selection was the player's name). On an over/under market it means the
    // record is unusable — we cannot tell which half we're holding.
    let side = rec.side;
    if (!side) {
      if (def && def.hasLine === false) {
        side = "over";
      } else {
        diagnostics.noSide++;
        continue;
      }
    }

    const playerKey = rec.playerId || rec.playerName.toLowerCase();
    const key = [rec.fixtureId, rec.sportsbook, rec.statKey, playerKey, line].join("|");

    if (!groups.has(key)) {
      groups.set(key, {
        fixtureId: rec.fixtureId,
        sportsbook: rec.sportsbook,
        statKey: rec.statKey,
        marketName: rec.marketName,
        playerId: rec.playerId,
        playerName: rec.playerName,
        team: rec.team,
        line,
        overOdds: null,
        underOdds: null,
        timestamp: rec.timestamp,
        startDate: rec.startDate,
      });
    }
    const g = groups.get(key);
    // Prefer the record that actually carries player/team detail; the two
    // sides of one market don't always populate both identically.
    if (!g.playerName && rec.playerName) g.playerName = rec.playerName;
    if (!g.playerId && rec.playerId) g.playerId = rec.playerId;
    if (!g.team && rec.team) g.team = rec.team;

    if (side === "over") g.overOdds = rec.price;
    else g.underOdds = rec.price;
  }

  const rows = [];
  for (const g of groups.values()) {
    // A row with only an Under is not useful: our model prices "more than the
    // line", so with no Over price there is nothing for us to bet.
    if (g.overOdds === null) continue;
    rows.push({ ...g, oneSided: g.underOdds === null });
  }

  return { rows, diagnostics };
}

// Convenience: payloads -> paired rows in one call.
export function normalizeOddsPayloads(payloads, { statDefs }) {
  const flat = flattenOddsPayloads(payloads);
  const records = flat.map(readOdd).filter(Boolean);
  return pairOdds(records, { statDefs });
}

// ---- Historical ---------------------------------------------------------------
// The historical endpoint returns a price HISTORY per odd: an array of
// timestamped price changes. Backfilling a played week means choosing one
// moment from that series, and the only defensible choice is the last price
// before kickoff — the closing line.
//
// Grading a backfilled bet against anything later would be look-ahead bias
// (prices move on injury and inactive news we would not have had), and
// anything much earlier isn't a price we could reliably have taken.
export function closingPriceFromHistory(history, kickoffIso) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const cutoff = kickoffIso ? Date.parse(kickoffIso) : NaN;

  let best = null;
  let bestTime = -Infinity;
  for (const point of history) {
    const price = numOrNull(firstOf(point, ["price", "odds", "american_odds", "american"]));
    if (price === null) continue;
    const tRaw = scalarOf(firstOf(point, ["timestamp", "time", "updated_at", "created_at"]));
    const t = tRaw === undefined ? NaN : Date.parse(tRaw);

    // An undated point can't be ordered; keep it only as a last resort.
    if (!Number.isFinite(t)) {
      if (best === null) best = { price, timestamp: tRaw ?? null, points: pointsOf(point) };
      continue;
    }
    if (Number.isFinite(cutoff) && t > cutoff) continue; // after kickoff — look-ahead
    if (t > bestTime) {
      bestTime = t;
      best = { price, timestamp: tRaw, points: pointsOf(point) };
    }
  }
  return best;
}

function pointsOf(point) {
  return numOrNull(firstOf(point, ["points", "line", "handicap", "total"]));
}

// Flatten a historical payload into per-odd history series, each carrying the
// identifying fields plus its price points.
export function flattenHistoricalPayloads(payloads) {
  const out = [];
  for (const entry of flattenOddsPayloads(payloads)) {
    const rec = readOdd(entry);
    if (!rec) continue;
    const history =
      firstOf(entry.raw, ["history", "prices", "odds_history", "price_history", "changes"]) ?? null;
    out.push({ ...rec, history: Array.isArray(history) ? history : null });
  }
  return out;
}
