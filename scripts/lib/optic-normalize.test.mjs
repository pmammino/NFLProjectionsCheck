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
  closingPriceFromHistory,
  flattenHistoricalPayloads,
} from "./optic-normalize.mjs";
import { STAT_DEFS, matchStatKey, normalizeMarketName } from "./markets.mjs";

const opts = { statDefs: STAT_DEFS };

// A representative pair of records for one over/under market.
const overUnder = (over = {}, under = {}) => [
  {
    fixture_id: "F1",
    sportsbook: "DraftKings",
    market: "Player Passing Yards",
    player_id: "OO-500",
    player_name: "Joe Burrow",
    team: "CIN",
    points: 249.5,
    price: -110,
    selection_line: "over",
    ...over,
  },
  {
    fixture_id: "F1",
    sportsbook: "DraftKings",
    market: "Player Passing Yards",
    player_id: "OO-500",
    player_name: "Joe Burrow",
    team: "CIN",
    points: 249.5,
    price: -110,
    selection_line: "under",
    ...under,
  },
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
  const payload = {
    data: [
      {
        id: "F9",
        start_date: "2026-09-14T17:00:00Z",
        home_team_display: "Cincinnati Bengals",
        odds: [{ sportsbook: "FanDuel", market: "Player Receptions", player_name: "Ja'Marr Chase", points: 5.5, price: -115, selection_line: "over" }],
      },
    ],
  };
  const [rec] = flattenOddsPayloads([payload]).map(readOdd);
  // fixture_id was only on the parent, and must be carried down.
  assert.equal(rec.fixtureId, "F9");
  assert.equal(rec.startDate, "2026-09-14T17:00:00Z");
  assert.equal(rec.statKey, "receptions");
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
  const [over, under] = overUnder({ player_name: "", team: "" }, {});
  const { rows } = pairOdds([readOdd({ raw: over }), readOdd({ raw: under })], opts);
  assert.equal(rows[0].playerName, "Joe Burrow");
  assert.equal(rows[0].team, "CIN");
});

// ---- Historical --------------------------------------------------------------
const KICKOFF = "2026-09-14T17:00:00Z";

test("the closing price is the last one before kickoff", () => {
  const history = [
    { timestamp: "2026-09-12T12:00:00Z", price: -105, points: 249.5 },
    { timestamp: "2026-09-14T16:45:00Z", price: -118, points: 251.5 },
    { timestamp: "2026-09-13T09:00:00Z", price: -112, points: 250.5 },
  ];
  const close = closingPriceFromHistory(history, KICKOFF);
  assert.equal(close.price, -118);
  assert.equal(close.points, 251.5);
});

test("prices after kickoff are excluded as look-ahead", () => {
  // An in-game price reflects information we could not have had, so grading
  // against it would flatter the backtest.
  const history = [
    { timestamp: "2026-09-14T16:45:00Z", price: -118 },
    { timestamp: "2026-09-14T18:30:00Z", price: 350 }, // in-game
  ];
  assert.equal(closingPriceFromHistory(history, KICKOFF).price, -118);
});

test("with no kickoff given, the latest price wins", () => {
  const history = [
    { timestamp: "2026-09-12T12:00:00Z", price: -105 },
    { timestamp: "2026-09-14T18:30:00Z", price: 350 },
  ];
  assert.equal(closingPriceFromHistory(history, null).price, 350);
});

test("an empty or unusable history returns null", () => {
  assert.equal(closingPriceFromHistory([], KICKOFF), null);
  assert.equal(closingPriceFromHistory(null, KICKOFF), null);
  assert.equal(closingPriceFromHistory([{ timestamp: KICKOFF }], KICKOFF), null); // no price
});

test("a history entirely after kickoff yields no closing price", () => {
  const history = [{ timestamp: "2026-09-14T18:30:00Z", price: 350 }];
  assert.equal(closingPriceFromHistory(history, KICKOFF), null);
});

test("historical payloads flatten with their price series attached", () => {
  const payload = {
    data: [
      {
        fixture_id: "F1",
        sportsbook: "DraftKings",
        market: "Player Passing Yards",
        player_name: "Joe Burrow",
        selection_line: "over",
        points: 249.5,
        price: -110,
        history: [{ timestamp: "2026-09-14T16:45:00Z", price: -118, points: 251.5 }],
      },
    ],
  };
  const [series] = flattenHistoricalPayloads([payload]);
  assert.equal(series.statKey, "passYds");
  assert.equal(series.side, "over");
  assert.equal(series.history.length, 1);
  assert.equal(closingPriceFromHistory(series.history, KICKOFF).price, -118);
});
