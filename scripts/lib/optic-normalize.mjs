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
// The OpticOdds response shape (from the v3 OpenAPI definition)
// ---------------------------------------------------------------------------
// `{ data: [ FixtureWithOdds ] }`, where each fixture carries its odds nested:
//
//   { id, game_id, start_date, status, is_live,
//     home_competitors: [{ id, name, abbreviation, logo }],
//     away_competitors: [...], home_team_display, away_team_display,
//     season_year, season_week, season_type, sport, league,
//     odds: [ FixtureOdd ] }
//
// and each FixtureOdd is:
//
//   { id, sportsbook, market, market_id, name, is_main,
//     selection, normalized_selection, selection_line,
//     player_id, team_id, price, points, timestamp,
//     grouping_key, deep_link, limits: { max } }
//
// Four of these bite. All are confirmed against a live NFL pull (BetMGM,
// BUF/DET week 2), not just the OpenAPI definition:
//
// 1. THERE IS NO PLAYER NAME FIELD. An odd carries `player_id` (an OpticOdds
//    hex id, useless to us) and `selection`, which IS the player's name on a
//    prop — confirmed: {"selection": "James Cook", "name": "James Cook"} on an
//    anytime-TD odd, and {"selection": "Tom Kennedy", "name": "Tom Kennedy
//    Over 0.5"} on an over/under. `name` is the LABEL, so it is deliberately
//    not a fallback: it would yield a key matching nothing.
//
// 2. `team_id` IS NULL ON PLAYER PROPS. Not a hex id — absent entirely. In the
//    live pull, 0 of 49 player rows carried one; it appears only on team
//    markets. The parent fixture's two teams are therefore what disambiguate
//    two players sharing a name (see lib/crosswalk.mjs). Where team_id IS
//    present it is a hex id, resolved through the competitor map below.
//
// 3. `timestamp` IS A UNIX EPOCH FLOAT (1789480037.5886607), not an ISO string.
//
// 4. `selection_line` IS NOT ALWAYS A SIDE. On a Correct Score market it holds
//    values like "24:23". sideWord() returns null for anything that isn't a
//    real side word, so these fall through rather than being misread.
//
// One more thing the live data settles: a player market can include TEAM
// entries. An Anytime-TD market carries "Detroit Lions D/ST" rows with a
// team_id and no player_id. We don't project defenses, so pairOdds drops them
// and counts them as `teamEntries` rather than letting a team name reach the
// player crosswalk every week.

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
        // `teamById` is the important one — an odd's `team_id` is a hex id, and
        // the only place it maps to an abbreviation ("CIN") is right here on
        // the parent fixture's competitors.
        const context = {
          fixtureId: scalarOf(firstOf(row, ["id", "fixture_id", "fixtureId", "game_id"])),
          homeTeam: teamAbbr(row?.home_competitors) ?? scalarOf(firstOf(row, ["home_team_display", "home_team"])),
          awayTeam: teamAbbr(row?.away_competitors) ?? scalarOf(firstOf(row, ["away_team_display", "away_team"])),
          startDate: scalarOf(firstOf(row, ["start_date", "startDate", "game_time", "start_time"])),
          teamById: competitorMap(row),
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

// First competitor's abbreviation, falling back to its name. NFL fixtures have
// exactly one competitor per side; the array shape exists for team sports that
// don't (doubles tennis, relays).
function teamAbbr(competitors) {
  const c = Array.isArray(competitors) ? competitors[0] : null;
  if (!c) return undefined;
  return firstOf(c, ["abbreviation", "name"]);
}

// team_id (hex) -> abbreviation, for every competitor on this fixture.
function competitorMap(fixture) {
  const map = new Map();
  for (const side of ["home_competitors", "away_competitors"]) {
    for (const c of Array.isArray(fixture?.[side]) ? fixture[side] : []) {
      const id = firstOf(c, ["id"]);
      const abbr = firstOf(c, ["abbreviation", "name"]);
      if (id && abbr) map.set(String(id), String(abbr));
    }
  }
  return map;
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

  // The player's NAME. `selection` is the documented home for the entity a bet
  // is on (the team on a moneyline, "" on a game total), so on a player prop it
  // is the player. `normalized_selection` ("joe_burrow") is the same thing
  // underscored, which normalizeName handles. Deliberately NOT falling back to
  // `name`: that is the full label ("Joe Burrow Over 249.5"), and treating it
  // as a name would produce a garbage crosswalk key rather than an honest miss.
  const playerName =
    scalarOf(firstOf(raw, ["selection"])) ??
    scalarOf(firstOf(raw, ["normalized_selection"])) ??
    (playerObj ? scalarOf(playerObj) : undefined) ??
    scalarOf(firstOf(raw, ["player_name", "playerName"]));

  // `team_id` is an OpticOdds hex id; the abbreviation lives on the parent
  // fixture's competitors. Resolve through that map, and only fall back to a
  // literal team field if some other response shape supplies one.
  const teamId = scalarOf(firstOf(raw, ["team_id", "teamId"]));
  const team =
    (teamId && context.teamById?.get(String(teamId))) ??
    scalarOf(firstOf(raw, ["team", "team_abbreviation", "team_display", "player_team"])) ??
    (playerObj ? scalarOf(firstOf(playerObj, ["team", "team_abbreviation"])) : undefined);

  return {
    fixtureId: String(
      scalarOf(firstOf(raw, ["fixture_id", "fixtureId"])) ?? context.fixtureId ?? ""
    ),
    sportsbook: String(scalarOf(firstOf(raw, ["sportsbook", "sportsbook_name", "book"])) ?? ""),
    marketName: marketName === undefined ? "" : String(marketName),
    marketId: String(scalarOf(firstOf(raw, ["market_id"])) ?? ""),
    statKey,
    playerId: playerId === undefined ? "" : String(playerId),
    playerName: playerName === undefined ? "" : String(playerName),
    teamId: teamId === undefined ? "" : String(teamId),
    team: team === undefined ? "" : String(team),
    // `points` is the line. Null on a yes/no market (anytime TD), where the
    // implicit line is 0.5 — the caller supplies that from the stat def.
    points: numOrNull(firstOf(raw, ["points", "line", "handicap", "total"])),
    price: numOrNull(firstOf(raw, ["price", "odds", "american_odds", "american", "money"])),
    side: detectSide(raw),
    isMain: firstOf(raw, ["is_main", "isMain", "main"]) === true,
    // Groups the sides of one market together ("default:8.0"). Kept for
    // diagnostics; pairing keys on the line itself so the logic stays
    // independent of how the API happens to spell a group.
    groupingKey: String(scalarOf(firstOf(raw, ["grouping_key"])) ?? ""),
    // Unix epoch SECONDS as a float, not an ISO string.
    timestamp: firstOf(raw, ["timestamp", "updated_at", "last_updated", "time"]) ?? null,
    // The book's max stake, when it publishes one. Not used in sizing yet, but
    // it is the ceiling on what any of this is actually worth.
    maxStake: numOrNull(raw?.limits?.max),
    startDate: context.startDate ?? scalarOf(firstOf(raw, ["start_date", "game_time"])) ?? null,
  };
}

// The API sends timestamps as Unix epoch seconds (a float). Accept that, an
// epoch in milliseconds, or an ISO string, and return epoch milliseconds.
export function toEpochMs(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    // Seconds vs milliseconds: anything below ~1e11 is seconds (1e11 ms is
    // year 1973, while 1e11 seconds is year 5138 — no real timestamp is
    // ambiguous between the two).
    return n < 1e11 ? n * 1000 : n;
  }
  return Date.parse(String(value));
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
    teamEntries: 0,
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
    // A team entry inside a player market: an Anytime-TD market includes
    // "Detroit Lions D/ST" alongside the players, with a team_id and no
    // player_id. We don't project defenses, and letting these through would
    // put a team name into the player crosswalk every single week.
    if (!rec.playerId && rec.teamId) {
      diagnostics.teamEntries++;
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
        lineSource: rec.lineSource,
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
// /fixtures/odds/historical returns the SAME fixture-with-odds envelope, but
// each odd replaces `price`/`points` with:
//
//   olv: { price, points }   opening line value — the first price posted
//   clv: { price, points }   closing line value — the last before kickoff
//   entries: [ { price, timestamp, points, locked } ]
//                            the full movement series, but only if the key
//                            carries the separate `include_timeseries`
//                            permission; otherwise an empty array
//
// This is better than it sounds: the closing line is handed over directly, so
// backfilling a played week needs no scan of a series and no kickoff cutoff of
// our own. The endpoint is documented as covering "from the time odds are
// posted up until just before the fixture start time", so look-ahead bias is
// excluded at the source rather than by us filtering it out.

// Pick the price to grade a backfilled bet at. Closing by default: it is the
// most informed price the market produced, and the one we could actually have
// taken. `--use-opening` exists because comparing the two measures how much a
// line moved, which is the classic test of whether a model is early to news or
// merely agreeing with it after the fact.
export function historicalLineValue(rec, { prefer = "closing" } = {}) {
  const primary = prefer === "opening" ? rec?.olv : rec?.clv;
  const fallback = prefer === "opening" ? rec?.clv : rec?.olv;

  for (const source of [primary, fallback]) {
    const price = numOrNull(firstOf(source, ["price"]));
    if (price !== null) {
      return { price, points: numOrNull(firstOf(source, ["points"])), source: source === primary ? prefer : "fallback" };
    }
  }

  // No olv/clv (an odd posted and pulled without ever settling, say). Fall back
  // to the timeseries if the key has it.
  return lastEntryBefore(rec?.entries, rec?.startDate);
}

// Last non-locked price in a timeseries, at or before `cutoff`. Only reachable
// when the key carries the include_timeseries permission.
export function lastEntryBefore(entries, cutoffIso) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const cutoff = cutoffIso ? toEpochMs(cutoffIso) : NaN;

  let best = null;
  let bestTime = -Infinity;
  for (const e of entries) {
    if (e?.locked === true) continue; // price wasn't takeable at that moment
    const price = numOrNull(firstOf(e, ["price"]));
    if (price === null) continue;
    const t = toEpochMs(firstOf(e, ["timestamp"]));
    if (!Number.isFinite(t)) continue;
    if (Number.isFinite(cutoff) && t > cutoff) continue;
    if (t > bestTime) {
      bestTime = t;
      best = { price, points: numOrNull(firstOf(e, ["points"])), source: "timeseries", timestamp: t };
    }
  }
  return best;
}

// Flatten a historical payload into per-odd records carrying olv/clv/entries
// alongside the usual identifying fields.
export function flattenHistoricalPayloads(payloads) {
  const out = [];
  for (const entry of flattenOddsPayloads(payloads)) {
    const rec = readOdd(entry);
    if (!rec) continue;
    out.push({
      ...rec,
      olv: entry.raw?.olv ?? null,
      clv: entry.raw?.clv ?? null,
      entries: Array.isArray(entry.raw?.entries) ? entry.raw.entries : [],
    });
  }
  return out;
}
