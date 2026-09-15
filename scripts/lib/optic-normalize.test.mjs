// Verifies the OpticOdds payload normalizer: flattening, side detection,
// two-sided pairing, and closing-price selection from a historical series.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenOddsPayloads,
  readOdd,
  detectSide,
  pairOdds,
  normalizeOddsPayloads,
  historicalLineValue,
  lastEntryBefore,
  flattenHistoricalPayloads,
  toEpochMs,
} from "./optic-normalize.mjs";
import { STAT_DEFS, matchStatKey, normalizeMarketName } from "./markets.mjs";

const opts = { statDefs: STAT_DEFS };

// ---------------------------------------------------------------------------
// Fixtures shaped like the real v3 response (see the OpenAPI definition):
// odds nest under a fixture, the player's name arrives in `selection`, and
// `team_id` is a hex id resolved through the fixture's competitors.
// ---------------------------------------------------------------------------
const CIN_ID = "4F11A5896C24";
const PHI_ID = "E970E2EDDCAE";

// One side of a player-prop market, in the API's own shape.
const propOdd = (over = {}) => ({
  id: "60486:DraftKings:player_passing_yards:joe_burrow_over_249_5",
  sportsbook: "DraftKings",
  market: "Player Passing Yards",
  market_id: "player_passing_yards",
  name: "Joe Burrow Over 249.5", // the LABEL, not a player name
  is_main: true,
  selection: "Joe Burrow", // this is where the player's name lives
  normalized_selection: "joe_burrow",
  selection_line: "over",
  player_id: "OO-500",
  team_id: CIN_ID, // a hex id, NOT "CIN"
  price: -110,
  points: 249.5,
  timestamp: 1724865905.59815, // Unix epoch SECONDS, not ISO
  grouping_key: "default:249.5",
  deep_link: null,
  limits: { max: 500 },
  ...over,
});

// Wrap odds in the fixture envelope the API actually returns.
const fixturePayload = (odds) => ({
  data: [
    {
      id: "F1",
      game_id: "60486-35183-2026-09-10-17",
      start_date: "2026-09-10T20:20:00Z",
      home_competitors: [{ id: CIN_ID, name: "Cincinnati Bengals", abbreviation: "CIN" }],
      away_competitors: [{ id: PHI_ID, name: "Philadelphia Eagles", abbreviation: "PHI" }],
      home_team_display: "Cincinnati Bengals",
      away_team_display: "Philadelphia Eagles",
      status: "unplayed",
      is_live: false,
      sport: { id: "football", name: "Football" },
      league: { id: "nfl", name: "NFL" },
      odds,
    },
  ],
});

// A complete two-sided market.
const overUnder = (over = {}, under = {}) => [
  propOdd(over),
  propOdd({ selection_line: "under", name: "Joe Burrow Under 249.5", ...under }),
];

// ---- Market matching ---------------------------------------------------------
test("market names match case- and punctuation-insensitively", () => {
  assert.equal(matchStatKey("Player Passing Yards"), "passYds");
  assert.equal(matchStatKey("player_passing_yards"), "passYds");
  assert.equal(matchStatKey("PLAYER PASSING YARDS"), "passYds");
  assert.equal(matchStatKey("Player Receptions"), "receptions");
  assert.equal(matchStatKey("Anytime Touchdown Scorer"), "anytimeTD");
  assert.equal(normalizeMarketName("Player  Passing-Yards"), "player passing yards");
});

test("markets we do not model return null rather than a wrong stat", () => {
  assert.equal(matchStatKey("Moneyline"), null);
  assert.equal(matchStatKey("Player Kicking Points"), null);
  assert.equal(matchStatKey("First Touchdown Scorer"), null);
  assert.equal(matchStatKey(""), null);
  assert.equal(matchStatKey(null), null);
});

test("passing and rushing touchdowns never collide", () => {
  // Both contain "touchdowns"; a substring match would conflate them and
  // price a bet against the wrong projection column.
  assert.equal(matchStatKey("Player Passing Touchdowns"), "passTD");
  assert.equal(matchStatKey("Player Rushing Touchdowns"), "rushTD");
  assert.equal(matchStatKey("Player Receiving Touchdowns"), "recTD");
});

// ---- Flattening --------------------------------------------------------------
test("a bare array payload flattens", () => {
  const flat = flattenOddsPayloads([overUnder()]);
  assert.equal(flat.length, 2);
});

test("a data-enveloped payload flattens", () => {
  const flat = flattenOddsPayloads([{ data: overUnder() }]);
  assert.equal(flat.length, 2);
});

test("fixture-nested odds inherit the fixture's context", () => {
  const [rec] = flattenOddsPayloads([fixturePayload([propOdd()])]).map(readOdd);
  // None of these live on the odd itself — they come from the parent fixture.
  assert.equal(rec.fixtureId, "F1");
  assert.equal(rec.startDate, "2026-09-10T20:20:00Z");
  assert.equal(rec.statKey, "passYds");
});

test("the player's name is read from `selection`, never from `name`", () => {
  // There is no player_name field. `name` is the full label
  // ("Joe Burrow Over 249.5") — using it would produce a junk crosswalk key
  // that silently matches nothing.
  const [rec] = flattenOddsPayloads([fixturePayload([propOdd()])]).map(readOdd);
  assert.equal(rec.playerName, "Joe Burrow");
  assert.notEqual(rec.playerName, "Joe Burrow Over 249.5");
});

test("a normalized_selection is usable when selection is absent", () => {
  const odd = propOdd();
  delete odd.selection;
  const [rec] = flattenOddsPayloads([fixturePayload([odd])]).map(readOdd);
  assert.equal(rec.playerName, "joe_burrow");
});

test("team_id resolves to an abbreviation via the fixture's competitors", () => {
  // The odd carries only a hex id; "CIN" exists solely on the parent fixture.
  // Without this the crosswalk loses its team-disambiguation tier.
  const [rec] = flattenOddsPayloads([fixturePayload([propOdd()])]).map(readOdd);
  assert.equal(rec.teamId, CIN_ID);
  assert.equal(rec.team, "CIN");
});

test("an unknown team_id leaves team blank rather than leaking a hex id", () => {
  const [rec] = flattenOddsPayloads([
    fixturePayload([propOdd({ team_id: "DEADBEEF" })]),
  ]).map(readOdd);
  assert.equal(rec.team, "");
});

test("the API's numeric epoch timestamp is preserved and convertible", () => {
  const [rec] = flattenOddsPayloads([fixturePayload([propOdd()])]).map(readOdd);
  assert.equal(rec.timestamp, 1724865905.59815);
  assert.equal(toEpochMs(rec.timestamp), 1724865905598.15);
});

test("toEpochMs handles seconds, milliseconds and ISO strings", () => {
  assert.equal(toEpochMs(1724865905.59815), 1724865905598.15);
  assert.equal(toEpochMs(1724865905598), 1724865905598);
  assert.equal(toEpochMs("2026-09-10T20:20:00Z"), Date.parse("2026-09-10T20:20:00Z"));
  assert.ok(Number.isNaN(toEpochMs(null)));
  assert.ok(Number.isNaN(toEpochMs("")));
});

test("the book's max stake is captured when published", () => {
  const [rec] = flattenOddsPayloads([fixturePayload([propOdd()])]).map(readOdd);
  assert.equal(rec.maxStake, 500);
  const [noLimit] = flattenOddsPayloads([
    fixturePayload([propOdd({ limits: null })]),
  ]).map(readOdd);
  assert.equal(noLimit.maxStake, null);
});

test("flattening tolerates junk without throwing", () => {
  assert.deepEqual(flattenOddsPayloads([null, undefined, 5, "x"]).length, 0);
  assert.deepEqual(flattenOddsPayloads(null), []);
  assert.equal(readOdd(null), null);
  assert.equal(readOdd({ raw: "nope" }), null);
});

// ---- Field tolerance ---------------------------------------------------------
test("alternate field spellings are read", () => {
  const rec = readOdd({
    raw: {
      fixtureId: "F2",
      book: "BetMGM",
      market_name: "Player Rushing Yards",
      playerId: "OO-1",
      playerName: "Chase Brown",
      line: 65.5,
      american_odds: 105,
      side: "over",
    },
  });
  assert.equal(rec.fixtureId, "F2");
  assert.equal(rec.sportsbook, "BetMGM");
  assert.equal(rec.statKey, "rushYds");
  assert.equal(rec.points, 65.5);
  assert.equal(rec.price, 105);
  assert.equal(rec.side, "over");
});

test("object-valued fields are unwrapped to their name", () => {
  const rec = readOdd({
    raw: {
      fixture_id: "F3",
      sportsbook: { id: "dk", name: "DraftKings" },
      market: { id: "pry", name: "Player Rushing Yards" },
      player: { id: "OO-7", name: "Saquon Barkley", team: "PHI" },
      points: 89.5,
      price: -112,
      selection_line: "over",
    },
  });
  assert.equal(rec.sportsbook, "DraftKings");
  assert.equal(rec.statKey, "rushYds");
  assert.equal(rec.playerId, "OO-7");
  assert.equal(rec.playerName, "Saquon Barkley");
  assert.equal(rec.team, "PHI");
});

test("a team market (no player) is still read without inventing a player", () => {
  // Moneyline: `selection` is the TEAM name. It reaches playerName, but the
  // market doesn't map to a stat, so pairing discards it before it can be
  // mistaken for a player.
  const { rows, diagnostics } = normalizeOddsPayloads(
    [fixturePayload([{ sportsbook: "BetMGM", market: "Moneyline", market_id: "moneyline",
       name: "Cincinnati Bengals", selection: "Cincinnati Bengals",
       normalized_selection: "cincinnati_bengals", selection_line: null,
       player_id: null, team_id: CIN_ID, price: -156, points: null, is_main: true }])],
    opts
  );
  assert.equal(rows.length, 0);
  assert.equal(diagnostics.unmatchedMarkets.get("Moneyline"), 1);
});

// ---- Side detection ----------------------------------------------------------
test("side is read from the explicit field or the selection label", () => {
  assert.equal(detectSide({ selection_line: "Over" }), "over");
  assert.equal(detectSide({ selection_line: "UNDER" }), "under");
  assert.equal(detectSide({ selection: "Yes" }), "over");
  assert.equal(detectSide({ selection: "No" }), "under");
  assert.equal(detectSide({ side: "u" }), "under");
  // A player name is not a side word.
  assert.equal(detectSide({ selection: "Ja'Marr Chase" }), null);
  assert.equal(detectSide({}), null);
});

// ---- Pairing -----------------------------------------------------------------
test("two sides of one market pair into a single two-sided row", () => {
  const { rows } = normalizeOddsPayloads([overUnder()], opts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].overOdds, -110);
  assert.equal(rows[0].underOdds, -110);
  assert.equal(rows[0].oneSided, false);
  assert.equal(rows[0].line, 249.5);
  assert.equal(rows[0].statKey, "passYds");
});

test("a book quoting only the over yields a one-sided row", () => {
  const [over] = overUnder();
  const { rows } = normalizeOddsPayloads([[over]], opts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oneSided, true);
  assert.equal(rows[0].underOdds, null);
});

test("an under with no over is dropped — there is nothing for us to bet", () => {
  const [, under] = overUnder();
  const { rows } = normalizeOddsPayloads([[under]], opts);
  assert.equal(rows.length, 0);
});

test("different lines for one player are separate markets", () => {
  // This is the critical grouping rule. De-vigging an Over 249.5 against an
  // Under 259.5 invents a market that does not exist, and because those two
  // raw probabilities sum to less than 1 it would look like guaranteed value.
  const payload = [
    ...overUnder(),
    ...overUnder({ points: 259.5, price: 120 }, { points: 259.5, price: -145 }),
  ];
  const { rows } = normalizeOddsPayloads([payload], opts);
  assert.equal(rows.length, 2);
  const lines = rows.map((r) => r.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [249.5, 259.5]);
  for (const r of rows) assert.equal(r.oneSided, false);
});

test("different books are separate markets", () => {
  const payload = [...overUnder(), ...overUnder({ sportsbook: "FanDuel" }, { sportsbook: "FanDuel" })];
  const { rows } = normalizeOddsPayloads([payload], opts);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.sportsbook)), new Set(["DraftKings", "FanDuel"]));
});

test("an anytime-TD market with no line becomes an implicit over 0.5", () => {
  const payload = [
    {
      fixture_id: "F1",
      sportsbook: "DraftKings",
      market: "Anytime Touchdown Scorer",
      player_id: "OO-9",
      player_name: "Chase Brown",
      team: "CIN",
      price: 145,
      selection: "Chase Brown", // the selection is the player, not a side
    },
  ];
  const { rows } = normalizeOddsPayloads([payload], opts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 0.5);
  assert.equal(rows[0].overOdds, 145);
  assert.equal(rows[0].oneSided, true);
});

test("an anytime-TD market quoting Yes and No pairs up", () => {
  const base = {
    fixture_id: "F1",
    sportsbook: "FanDuel",
    market: "Anytime Touchdown Scorer",
    player_id: "OO-9",
    player_name: "Chase Brown",
  };
  const { rows } = normalizeOddsPayloads(
    [[{ ...base, price: 145, selection: "Yes" }, { ...base, price: -190, selection: "No" }]],
    opts
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oneSided, false);
  assert.equal(rows[0].overOdds, 145);
  assert.equal(rows[0].underOdds, -190);
});

// ---- Diagnostics -------------------------------------------------------------
test("unusable records are counted, not silently dropped", () => {
  const payload = [
    { fixture_id: "F1", sportsbook: "DK", market: "Moneyline", price: -110, selection_line: "over", player_name: "x" },
    { fixture_id: "F1", sportsbook: "DK", market: "Moneyline", price: 100, selection_line: "under", player_name: "x" },
    { fixture_id: "F1", sportsbook: "DK", market: "Player Passing Yards", player_name: "A", points: 1.5, selection_line: "over" }, // no price
    { fixture_id: "F1", sportsbook: "DK", market: "Player Passing Yards", points: 1.5, price: -110, selection_line: "over" }, // no player
    { fixture_id: "F1", sportsbook: "DK", market: "Player Passing Yards", player_name: "B", points: 1.5, price: -110 }, // no side
  ];
  const { rows, diagnostics } = normalizeOddsPayloads([payload], opts);
  assert.equal(rows.length, 0);
  assert.equal(diagnostics.unmatchedMarkets.get("Moneyline"), 2);
  assert.equal(diagnostics.missingPrice, 1);
  assert.equal(diagnostics.missingPlayer, 1);
  assert.equal(diagnostics.noSide, 1);
  assert.equal(diagnostics.total, 5);
});

test("an over/under record with no side is dropped, not assumed to be the over", () => {
  // Guessing here would be a coin flip on which half of the market we hold.
  const [over] = overUnder();
  delete over.selection_line;
  const { rows, diagnostics } = normalizeOddsPayloads([[over]], opts);
  assert.equal(rows.length, 0);
  assert.equal(diagnostics.noSide, 1);
});

test("pairing prefers whichever side carries the player detail", () => {
  const [over, under] = overUnder({ selection: "", normalized_selection: "" }, {});
  const { rows } = normalizeOddsPayloads([fixturePayload([over, under])], opts);
  assert.equal(rows[0].playerName, "Joe Burrow");
  assert.equal(rows[0].team, "CIN");
});

// ---- Historical --------------------------------------------------------------
// /fixtures/odds/historical returns the same fixture envelope, but each odd
// carries `olv` (opening line value) and `clv` (closing line value) instead of
// a live price — plus an `entries` timeseries that is empty unless the key has
// the include_timeseries permission.

const KICKOFF = "2026-09-10T20:20:00Z";

const historicalOdd = (extra = {}) => {
  const o = propOdd(extra);
  delete o.price;
  delete o.points;
  return {
    ...o,
    deep_link_info: null,
    entries: [],
    olv: { price: -185, points: 251.5 },
    clv: { price: -140, points: 249.5 },
    ...extra,
  };
};

test("the closing line value is used by default", () => {
  const lv = historicalLineValue(historicalOdd());
  assert.equal(lv.price, -140);
  assert.equal(lv.points, 249.5);
  assert.equal(lv.source, "closing");
});

test("--use-opening selects the opening line value instead", () => {
  // The gap between the two is how far the market moved after posting.
  const lv = historicalLineValue(historicalOdd(), { prefer: "opening" });
  assert.equal(lv.price, -185);
  assert.equal(lv.points, 251.5);
  assert.equal(lv.source, "opening");
});

test("a missing closing value falls back to the opening one", () => {
  const lv = historicalLineValue(historicalOdd({ clv: null }));
  assert.equal(lv.price, -185);
  assert.equal(lv.source, "fallback");
});

test("with neither olv nor clv, the timeseries is used if present", () => {
  const rec = historicalOdd({
    olv: null,
    clv: null,
    startDate: KICKOFF,
    entries: [
      { price: -105, points: 249.5, timestamp: 1757000000 },
      { price: -118, points: 251.5, timestamp: 1757100000 },
    ],
  });
  const lv = historicalLineValue(rec);
  assert.equal(lv.price, -118);
  assert.equal(lv.source, "timeseries");
});

test("an odd with no price information at all yields null", () => {
  assert.equal(historicalLineValue(historicalOdd({ olv: null, clv: null })), null);
  assert.equal(historicalLineValue(historicalOdd({ olv: {}, clv: {} })), null);
  assert.equal(historicalLineValue(null), null);
});

test("locked timeseries entries are skipped — that price wasn't takeable", () => {
  const entries = [
    { price: -105, timestamp: 1757000000 },
    { price: -999, timestamp: 1757100000, locked: true },
  ];
  assert.equal(lastEntryBefore(entries, null).price, -105);
});

test("timeseries entries after kickoff are excluded", () => {
  const entries = [
    { price: -118, timestamp: Math.floor(Date.parse(KICKOFF) / 1000) - 600 },
    { price: 350, timestamp: Math.floor(Date.parse(KICKOFF) / 1000) + 3600 },
  ];
  assert.equal(lastEntryBefore(entries, KICKOFF).price, -118);
  // With no cutoff the later price wins.
  assert.equal(lastEntryBefore(entries, null).price, 350);
});

test("an empty or unusable timeseries returns null", () => {
  assert.equal(lastEntryBefore([], KICKOFF), null);
  assert.equal(lastEntryBefore(null, KICKOFF), null);
  assert.equal(lastEntryBefore([{ timestamp: 1757000000 }], KICKOFF), null); // no price
});

test("historical payloads flatten with olv/clv/entries attached", () => {
  const [rec] = flattenHistoricalPayloads([fixturePayload([historicalOdd()])]);
  assert.equal(rec.statKey, "passYds");
  assert.equal(rec.side, "over");
  assert.equal(rec.playerName, "Joe Burrow");
  assert.equal(rec.team, "CIN");
  assert.deepEqual(rec.clv, { price: -140, points: 249.5 });
  assert.deepEqual(rec.entries, []);
});

test("a full historical pull pairs into two-sided markets at closing prices", () => {
  // End to end: the shape the backfill actually consumes.
  const over = historicalOdd();
  const under = historicalOdd({
    selection_line: "under",
    olv: { price: 155, points: 251.5 },
    clv: { price: 115, points: 249.5 },
  });
  const collapsed = flattenHistoricalPayloads([fixturePayload([over, under])]).map((rec) => {
    const lv = historicalLineValue(rec);
    return { ...rec, price: lv.price, points: lv.points };
  });
  const { rows } = pairOdds(collapsed, opts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 249.5);
  assert.equal(rows[0].overOdds, -140);
  assert.equal(rows[0].underOdds, 115);
  assert.equal(rows[0].oneSided, false);
});
