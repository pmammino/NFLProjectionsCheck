// Regression tests against a REAL OpticOdds response, captured from a live
// BetMGM pull for BUF/DET (2026 week 2) and trimmed to a representative slice
// in __fixtures__/opticodds-nfl-sample.json.
//
// The other suites use hand-written payloads, which only ever prove the code
// agrees with my reading of the docs. This one proves it agrees with the API.
// Every assertion here encodes something the real feed does that the
// documentation did not show — and in three cases, something it contradicted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeOddsPayloads,
  flattenOddsPayloads,
  readOdd,
  flattenHistoricalPayloads,
  historicalLineValue,
  pairOdds,
} from "./optic-normalize.mjs";
import { STAT_DEFS, matchStatKey } from "./markets.mjs";
import { buildPlayerIndex, matchPlayer } from "./crosswalk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "opticodds-nfl-sample.json"), "utf8")
);
const opts = { statDefs: STAT_DEFS };
const records = flattenOddsPayloads([PAYLOAD]).map(readOdd);

// ---- Shape -------------------------------------------------------------------
test("the real envelope flattens fixture-nested odds", () => {
  assert.ok(records.length > 0);
  for (const r of records) {
    assert.equal(r.fixtureId, "202609189BE34D3B");
    assert.equal(r.startDate, "2026-09-18T00:15:00Z");
    assert.equal(r.sportsbook, "BetMGM");
  }
});

test("our market alias for Anytime TD matches the live name exactly", () => {
  const atd = records.filter((r) => r.marketName === "Anytime Touchdown Scorer");
  assert.ok(atd.length > 0, "sample should contain anytime-TD odds");
  assert.equal(matchStatKey("Anytime Touchdown Scorer"), "anytimeTD");
  for (const r of atd) assert.equal(r.statKey, "anytimeTD");
});

// ---- The three things the docs got wrong or didn't show -----------------------
test("the player's name comes from `selection`, and `name` is only a label", () => {
  const cook = records.find((r) => r.playerName === "James Cook");
  assert.ok(cook, "James Cook should be readable from the real payload");
  assert.equal(cook.statKey, "anytimeTD");

  // On an over/under prop the label carries the line; the name must not.
  const raw = PAYLOAD.data[0].odds.find((o) => o.selection === "Tom Kennedy");
  assert.equal(raw.name, "Tom Kennedy Over 0.5");
  assert.equal(raw.selection, "Tom Kennedy");
  const parsed = readOdd({ raw, context: {} });
  assert.equal(parsed.playerName, "Tom Kennedy");
});

test("player props carry NO team — team_id is null on every one", () => {
  // This is why the fixture disambiguates instead of the odd itself. Verified
  // 0 of 49 across the full live pull.
  const playerRows = PAYLOAD.data[0].odds.filter((o) => o.player_id);
  assert.ok(playerRows.length > 0);
  for (const o of playerRows) {
    assert.equal(o.team_id, null, `${o.selection} unexpectedly carried a team_id`);
  }
  for (const r of records.filter((r) => r.playerId)) assert.equal(r.team, "");
});

test("timestamps are Unix epoch floats", () => {
  for (const r of records) {
    assert.equal(typeof r.timestamp, "number");
    assert.ok(r.timestamp > 1e9 && r.timestamp < 1e11, `${r.timestamp} is not epoch seconds`);
  }
});

test("selection_line is not always a side — Correct Score uses scores", () => {
  // "24:23" appears in selection_line on correct-score markets. sideWord must
  // reject it rather than misreading it as over/under.
  const raw = { selection_line: "24:23", market: "Correct Score", price: 22500 };
  assert.equal(readOdd({ raw, context: {} }).side, null);
});

// ---- D/ST entries ------------------------------------------------------------
test("team entries inside a player market are dropped, not fed to the crosswalk", () => {
  // An Anytime-TD market includes "Buffalo Bills D/ST" with a team_id and no
  // player_id. Letting it through would put a team name in the unmatched-player
  // report every single week.
  const dst = PAYLOAD.data[0].odds.filter((o) => String(o.selection).includes("D/ST"));
  assert.equal(dst.length, 2, "sample should contain both D/ST entries");

  const { rows, diagnostics } = normalizeOddsPayloads([PAYLOAD], opts);
  assert.equal(diagnostics.teamEntries, 2);
  assert.ok(!rows.some((r) => r.playerName.includes("D/ST")));
});

// ---- Pairing -----------------------------------------------------------------
test("BetMGM's anytime-TD market is one-sided, and is flagged as such", () => {
  // No "No" price is offered, so this cannot be de-vigged. The flag is what
  // stops a one-sided row being mistaken for a fair-priced one downstream.
  const { rows } = normalizeOddsPayloads([PAYLOAD], opts);
  const atd = rows.filter((r) => r.statKey === "anytimeTD");
  assert.ok(atd.length > 0);
  for (const r of atd) {
    assert.equal(r.oneSided, true);
    assert.equal(r.underOdds, null);
    assert.equal(r.line, 0.5); // no points field; the implicit line
    assert.ok(Number.isFinite(r.overOdds));
  }
});

test("markets we do not model are counted, never silently mapped", () => {
  const { diagnostics } = normalizeOddsPayloads([PAYLOAD], opts);
  // Both of these are real NFL markets we deliberately skip — see markets.mjs.
  assert.ok(diagnostics.unmatchedMarkets.has("Player Touchdowns"));
  assert.ok(diagnostics.unmatchedMarkets.has("Player Rushing + Receiving Yards"));
  assert.ok(diagnostics.unmatchedMarkets.has("Moneyline"));
});

test("nothing in the real payload fails to parse for an unexpected reason", () => {
  const { diagnostics } = normalizeOddsPayloads([PAYLOAD], opts);
  assert.equal(diagnostics.missingPrice, 0);
  assert.equal(diagnostics.missingPlayer, 0);
  assert.equal(diagnostics.noSide, 0);
});

// ---- The crosswalk on real names ---------------------------------------------
test("real player names join to a roster, with the fixture breaking a tie", () => {
  const roster = [
    { PlayerID: "1", Name: "James Cook", Team: "BUF", Pos: "RB" },
    { PlayerID: "2", Name: "Tyler Conklin", Team: "BUF", Pos: "TE" },
    { PlayerID: "3", Name: "Keon Coleman", Team: "BUF", Pos: "WR" },
    // A namesake on a team that is NOT in this fixture. With no team on the
    // odd, only the fixture can tell these two apart.
    { PlayerID: "99", Name: "James Cook", Team: "KC", Pos: "RB" },
  ];
  const index = buildPlayerIndex(roster);
  const fixtureTeams = ["BUF", "DET"];
  const { rows } = normalizeOddsPayloads([PAYLOAD], opts);

  const cookRow = rows.find((r) => r.playerName === "James Cook");
  const cook = matchPlayer(index, {
    name: cookRow.playerName,
    team: cookRow.team, // "" — the real feed gives us nothing here
    fixtureTeams,
  });
  assert.equal(cook.playerId, "1", "should pick the Buffalo James Cook");
  assert.equal(cook.method, "name+fixture");

  // Without the fixture there is no way to choose, and it must not try.
  const blind = matchPlayer(index, { name: "James Cook", team: "" });
  assert.equal(blind.playerId, null);
  assert.equal(blind.reason, "ambiguous");
});

test("a player absent from the roster reports not-found rather than mis-joining", () => {
  const index = buildPlayerIndex([{ PlayerID: "1", Name: "James Cook", Team: "BUF", Pos: "RB" }]);
  const r = matchPlayer(index, { name: "Tyler Conklin", fixtureTeams: ["BUF", "DET"] });
  assert.equal(r.playerId, null);
  assert.equal(r.reason, "not-found");
});

// ---- Real HISTORICAL response ------------------------------------------------
// Captured from /fixtures/odds/historical for the completed CIN/TB week-1 game.
// The historical envelope differs from the live one in ways that would each
// have broken the backfill silently.
const HISTORICAL = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "opticodds-nfl-historical-sample.json"), "utf8")
);

test("the historical envelope replaces price/points with olv and clv", () => {
  const odd = HISTORICAL.data[0].odds.find((o) => o.market === "Player Touchdowns");
  assert.equal(odd.price, undefined, "no top-level price on a historical odd");
  assert.equal(odd.points, null, "the LINE is inside olv/clv, not on the odd");
  assert.ok(odd.olv, "olv should carry the opening price and line");
  assert.ok(Number.isFinite(odd.olv.price));
});

test("player props carry NO player_id in the historical response", () => {
  // Unlike the live endpoint, where anytime-TD odds DO have one. `selection`
  // is the only identifier available here, which is why it is read first.
  const playerMarkets = HISTORICAL.data[0].odds.filter((o) =>
    o.market.startsWith("Player") || o.market === "Anytime Touchdown Scorer"
  );
  assert.ok(playerMarkets.length > 0);
  for (const o of playerMarkets) assert.equal(o.player_id, null);

  const [rec] = flattenHistoricalPayloads([HISTORICAL]).filter((r) => r.statKey === "anytimeTD");
  assert.ok(rec.playerName.length > 0, "the name must still be recoverable from `selection`");
  assert.equal(rec.playerId, "");
});

test("player props have NO closing line value, so the price falls back to opening", () => {
  // Measured across the full real response: 0 of 122 player odds carried a
  // clv, while game markets had one 93-100% of the time. A backfilled prop is
  // therefore an OPENING-line bet, which is softer than the closing price a
  // real wager would have taken.
  const props = HISTORICAL.data[0].odds.filter(
    (o) => o.market.startsWith("Player") || o.market === "Anytime Touchdown Scorer"
  );
  for (const o of props) assert.equal(o.clv, null, `${o.selection} unexpectedly had a clv`);

  const rec = flattenHistoricalPayloads([HISTORICAL]).find((r) => r.statKey === "anytimeTD");
  const lv = historicalLineValue(rec);
  assert.equal(lv.source, "fallback", "closing requested, opening delivered");
  assert.equal(lv.price, rec.olv.price);
});

test("a game market DOES carry a closing value, and it is preferred", () => {
  // Proves the fallback above is a property of player markets, not a bug in
  // how we read clv.
  const ml = HISTORICAL.data[0].odds.find((o) => o.market === "Moneyline" && o.clv);
  assert.ok(ml, "moneyline should have a clv");
  const lv = historicalLineValue({ olv: ml.olv, clv: ml.clv });
  assert.equal(lv.source, "closing");
  assert.equal(lv.price, ml.clv.price);
});

test("the line comes out of olv/clv when the odd's own points is null", () => {
  const odd = HISTORICAL.data[0].odds.find((o) => o.market === "Player Touchdowns");
  assert.equal(odd.points, null);
  const lv = historicalLineValue({ olv: odd.olv, clv: odd.clv });
  assert.equal(lv.points, 0.5, "the 0.5 line lives inside olv");
});

test("the timeseries is empty without the include_timeseries permission", () => {
  for (const o of HISTORICAL.data[0].odds) assert.deepEqual(o.entries, []);
});

test("a historical pull still pairs into markets we model", () => {
  const recs = flattenHistoricalPayloads([HISTORICAL]);
  const collapsed = [];
  for (const rec of recs) {
    const lv = historicalLineValue(rec);
    if (!lv) continue;
    collapsed.push({ ...rec, price: lv.price, points: lv.points ?? rec.points });
  }
  const { rows, diagnostics } = pairOdds(collapsed, opts);
  assert.ok(rows.length > 0, "should recover anytime-TD markets");
  for (const r of rows) {
    assert.equal(r.statKey, "anytimeTD");
    assert.equal(r.line, 0.5);
    assert.ok(Number.isFinite(r.overOdds));
  }
  // D/ST rows are present in the historical anytime-TD market too.
  assert.equal(diagnostics.teamEntries, 2);
  assert.ok(!rows.some((r) => r.playerName.includes("D/S")));
});

test("markets we don't model are named, so a missing alias is visible", () => {
  const recs = flattenHistoricalPayloads([HISTORICAL]);
  const collapsed = recs.map((r) => {
    const lv = historicalLineValue(r);
    return lv ? { ...r, price: lv.price, points: lv.points ?? r.points } : r;
  });
  const { diagnostics } = pairOdds(collapsed, opts);
  for (const m of ["Player Kicking Points", "Player Rushing + Receiving Yards", "Player Touchdowns"]) {
    assert.ok(diagnostics.unmatchedMarkets.has(m), `${m} should be reported, not silently dropped`);
  }
});

// ---- The live NFL market list -------------------------------------------------
// From a real /markets call: 317 NFL markets, all 12 of our stats resolved.
// These assertions pin the exact names and, more importantly, pin the near
// misses that make EXACT matching load-bearing.
import { STAT_DEFS as DEFS, allOpticMarketNames } from "./markets.mjs";

const CONFIRMED = {
  anytimeTD: "Anytime Touchdown Scorer",
  passYds: "Player Passing Yards",
  passAtt: "Player Passing Attempts",
  completions: "Player Passing Completions",
  passTD: "Player Passing Touchdowns",
  int: "Player Interceptions",
  rushYds: "Player Rushing Yards",
  rushAtt: "Player Rushing Attempts",
  rushTD: "Player Rushing Touchdowns",
  receptions: "Player Receptions",
  recYds: "Player Receiving Yards",
  recTD: "Player Receiving Touchdowns",
};

test("every stat maps to its confirmed live market name", () => {
  for (const [statKey, name] of Object.entries(CONFIRMED)) {
    assert.equal(DEFS[statKey].opticName, name, `${statKey} should request "${name}"`);
    assert.equal(matchStatKey(name), statKey, `"${name}" should resolve to ${statKey}`);
  }
  assert.equal(Object.keys(CONFIRMED).length, Object.keys(DEFS).length);
});

test("the market query asks for exactly our twelve markets", () => {
  const names = allOpticMarketNames();
  assert.equal(names.length, 12);
  assert.deepEqual(new Set(names), new Set(Object.values(CONFIRMED)));
});

test("period-scoped variants never collide with the full-game market", () => {
  // The live list carries all of these alongside the ones we want. A substring
  // match would map them onto our stats and price a full-game projection
  // against a half- or quarter-length market.
  for (const m of [
    "1st Half Player Passing Yards",
    "1st Quarter Player Passing Yards",
    "2nd Half Player Receptions",
    "3rd Quarter Player Rushing Yards",
    "4th Quarter Player Receiving Touchdowns",
    "1st Half Anytime Touchdown Scorer",
    "1st Drive Player Passing Yards",
  ]) {
    assert.equal(matchStatKey(m), null, `"${m}" must not map to a stat`);
  }
});

test("combo and derivative variants never collide either", () => {
  for (const m of [
    "Player Passing Yards (Combo)",
    "Player Passing Yards (Either)",
    "Player Passing Yards Each Half",
    "Player Passing Yards Each Quarter",
    "Player Rushing Yards (Combo)",
    "Player Interceptions (Combo)",
    "Player Touchdowns (Either)",
    "Player Receiving Yards H2H Moneyline",
    "Player Passing + Rushing Yards",
    "Player Rushing + Receiving Yards",
    "Player Passes Completed", // NOT "Player Passing Completions"
  ]) {
    assert.equal(matchStatKey(m), null, `"${m}" must not map to a stat`);
  }
});

test("interceptions means thrown, not caught", () => {
  // The live list separates the two. Mapping the defensive one would price a
  // defender's takeaways against a quarterback's projected picks.
  assert.equal(matchStatKey("Player Interceptions"), "int");
  assert.equal(matchStatKey("Player Defensive Interceptions"), null);
});

test("markets for positions we do not project stay unmapped", () => {
  for (const m of [
    "Player Kicking Points",
    "Player Field Goals Made",
    "Player Extra Points Made",
    "Player Tackles",
    "Player Sacks",
    "Player Punts",
    "Player Fantasy Score (PrizePicks)",
    "Most Passing Yards Player",
    "First Touchdown Scorer",
    "Last Touchdown Scorer",
  ]) {
    assert.equal(matchStatKey(m), null, `"${m}" must not map to a stat`);
  }
});
