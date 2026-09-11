// Verifies the props-feed normalizer against real sample records captured
// from the live all-bets-props-plus-proj.php endpoint (2026-09-11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePropsFeed, parseRecord, STAT_DEFS } from "./props.mjs";

// ---- Captured samples --------------------------------------------------------
const ANYTIME_TD_RECORD = {
  bet: "Score TD",
  betSubject: "Colbie Young",
  playerID: "19447",
  team: "CIN",
  opp: "vs TB",
  pos: "WR",
  game: "TB @ CIN",
  proj: "0.1",
  betr_val: "317",
  betr_ml: "317",
  betr_chance: null,
  draftkings_val: "370",
  draftkings_ml: "370",
  draftkings_chance: null,
  fanduel_val: "280",
  fanduel_ml: "280",
  fanduel_chance: null,
  mgm_val: "400",
  mgm_ml: "400",
  mgm_chance: null,
  betrivers_val: "320",
  betrivers_ml: "320",
  betrivers_chance: null,
  caesars_val: "330",
  caesars_ml: "330",
  caesars_chance: null,
  hardrock_val: null,
  hardrock_ml: null,
  hardrock_chance: null,
  thescore_val: "375",
  thescore_ml: "375",
  thescore_chance: null,
  circasports_val: null,
  circasports_ml: null,
  circasports_chance: null,
};

const PASS_YARDS_RECORD = {
  bet: "Pass Yards",
  betSubject: "Joe Burrow",
  playerID: "14442",
  team: "CIN",
  opp: "vs TB",
  pos: "QB",
  game: "TB @ CIN",
  proj: "277.9",
  betr_val: "269.5 (-116)",
  betr_ml: "-116",
  betr_chance: "3.0",
  draftkings_val: "267.5 (-111)",
  draftkings_ml: "-111",
  draftkings_chance: "3.7",
  fanduel_val: "269.5 (-114)",
  fanduel_ml: "-114",
  fanduel_chance: "3.0",
  mgm_val: null,
  mgm_ml: null,
  mgm_chance: null,
  betrivers_val: "267.5 (-117)",
  betrivers_ml: "-117",
  betrivers_chance: "3.7",
  caesars_val: "268.5 (-114)",
  caesars_ml: "-114",
  caesars_chance: "3.4",
  hardrock_val: "268.5 (-115)",
  hardrock_ml: "-115",
  hardrock_chance: "3.4",
  thescore_val: "269.5 (-120)",
  thescore_ml: "-120",
  thescore_chance: "3.0",
  circasports_val: null,
  circasports_ml: null,
  circasports_chance: null,
};

test("parseRecord: single-sided TD market, one row per quoting book, line implied 0.5", () => {
  const rows = parseRecord(ANYTIME_TD_RECORD, "anytimeTD", STAT_DEFS.anytimeTD);
  // hardrock and circasports are null -> excluded (7 of 9 books remain).
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.line === 0.5));
  assert.ok(rows.every((r) => r.playerId === "19447"));
  assert.ok(rows.every((r) => r.rwProj === 0.1));
  const dk = rows.find((r) => r.book === "draftkings");
  assert.equal(dk.odds, 370);
  assert.equal(dk.name, "Colbie Young");
  assert.equal(dk.team, "CIN");
  assert.equal(dk.pos, "WR");
});

test("parseRecord: over/under market parses line out of _val, odds out of _ml", () => {
  const rows = parseRecord(PASS_YARDS_RECORD, "passYds", STAT_DEFS.passYds);
  assert.equal(rows.length, 7); // mgm and circasports null -> excluded (7 of 9 books remain)
  const dk = rows.find((r) => r.book === "draftkings");
  assert.equal(dk.line, 267.5);
  assert.equal(dk.odds, -111);
  const betr = rows.find((r) => r.book === "betr");
  assert.equal(betr.line, 269.5);
  assert.equal(betr.odds, -116);
  assert.ok(rows.every((r) => r.rwProj === 277.9));
});

test("normalizePropsFeed: unwraps a bare array payload", () => {
  const rows = normalizePropsFeed([PASS_YARDS_RECORD], "passYds");
  assert.equal(rows.length, 7);
});

test("normalizePropsFeed: unwraps a { data: [...] } payload", () => {
  const rows = normalizePropsFeed({ data: [ANYTIME_TD_RECORD] }, "anytimeTD");
  assert.equal(rows.length, 7);
});

test("parseRecord: no playerID -> no rows", () => {
  assert.deepEqual(parseRecord({ betSubject: "Nobody" }, "passYds", STAT_DEFS.passYds), []);
});
