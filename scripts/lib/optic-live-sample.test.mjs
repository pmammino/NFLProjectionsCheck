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
import { normalizeOddsPayloads, flattenOddsPayloads, readOdd } from "./optic-normalize.mjs";
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
