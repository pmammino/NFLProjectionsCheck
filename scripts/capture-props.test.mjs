import { test } from "node:test";
import assert from "node:assert/strict";
import { ourProbability, PROPS_COLUMNS } from "./capture-props.mjs";
import { LEDGER_COLUMNS } from "./simulate-personas.mjs";
import {
  matchStatKey,
  isBettableStat,
  allOpticMarketNames,
  BETTABLE_STAT_KEYS,
} from "./lib/markets.mjs";

// Joe Burrow, week-1-shaped projection split (F/M/C rows keyed like the real
// weekly_projections snapshot).
const BURROW_SPLITS = {
  F: { PassYards: "230.0" },
  M: { PassYards: "277.9" },
  C: { PassYards: "320.0" },
};

test("ourProbability: continuous stat well below floor is near-certain over", () => {
  const p = ourProbability({ line: 100, statKey: "passYds" }, BURROW_SPLITS);
  assert.ok(p > 0.9);
});

test("ourProbability: continuous stat at the median is ~0.5", () => {
  const p = ourProbability({ line: 277.9, statKey: "passYds" }, BURROW_SPLITS);
  assert.ok(Math.abs(p - 0.5) < 1e-6);
});

test("ourProbability: missing Floor/Ceiling for a continuous stat -> null (can't price)", () => {
  const p = ourProbability({ line: 250, statKey: "passYds" }, { M: { PassYards: "277.9" } });
  assert.equal(p, null);
});

test("ourProbability: poisson stat sums the configured projection columns", () => {
  const splits = { M: { RecTDs: "0.1" } };
  const p = ourProbability({ line: 0.5, statKey: "recTD" }, splits);
  assert.ok(Math.abs(p - (1 - Math.exp(-0.1))) < 1e-9);
});

// Anytime TD is defined but retired (bet: false). It must still MATCH — old
// ledgers carry the stat key and need to label it — while never producing a
// price, because a price is what lets a bet be selected.
test("ourProbability: a retired market never prices, even with a full projection", () => {
  const splits = { M: { RushTDs: "0.4", RecTDs: "0.3" } };
  assert.equal(ourProbability({ line: 0.5, statKey: "anytimeTD" }, splits), null);
});

test("a retired market is still recognised, just not bet", () => {
  assert.equal(matchStatKey("Anytime Touchdown Scorer"), "anytimeTD");
  assert.equal(isBettableStat("anytimeTD"), false);
  assert.equal(isBettableStat("rushYds"), true);
  assert.equal(isBettableStat("notAStat"), false);
});

test("retired markets are never requested from the API", () => {
  const names = allOpticMarketNames();
  assert.ok(!names.includes("Anytime Touchdown Scorer"));
  assert.ok(names.includes("Player Rushing Yards"));
  assert.equal(names.length, BETTABLE_STAT_KEYS.length);
});

test("ourProbability: no projection at all for this player -> null", () => {
  assert.equal(ourProbability({ line: 250, statKey: "passYds" }, undefined), null);
});

test("ourProbability: an unknown stat key -> null rather than a wrong model", () => {
  assert.equal(ourProbability({ line: 250, statKey: "fieldGoals" }, BURROW_SPLITS), null);
});

// The published edge set is what every persona reads, so anything the persona
// engine needs must survive the round-trip to CSV and back.
test("the published edge set carries everything a persona needs", () => {
  for (const col of ["Edge", "ModelEdge", "FairProb", "ImpliedProb", "Hold", "OneSided", "Side", "Proj", "Book", "Line", "Odds", "FixtureID"]) {
    assert.ok(PROPS_COLUMNS.includes(col), `PROPS_COLUMNS missing ${col}`);
  }
});

test("the persona ledger carries its settlement and CLV fields", () => {
  for (const col of ["Status", "Actual", "PnlUnits", "StakeUnits", "BankrollBefore", "ClvStatus", "ClvProb"]) {
    assert.ok(LEDGER_COLUMNS.includes(col), `LEDGER_COLUMNS missing ${col}`);
  }
});

// ---- Empty-result protection -------------------------------------------------
// A historical pull can return a fixture with "odds": [] — an unauthorized key,
// a week past the 2-month retention window, and a book with nothing archived
// all look identical. Verified against a real response for the CIN/TB week-1
// game, which came back with an empty odds array.
//
// The snapshots under data/ are the durable record of what we actually saw, and
// are not reconstructible once overwritten, so an empty run must never replace
// a populated file.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCsv } from "./lib/csv.mjs";

// Exercises the same guard the script applies, against a real file on disk.
function writeGuarded(path, csv, { allowEmpty = false } = {}) {
  const rowCount = (t) => Math.max(0, t.trim().split("\n").length - 1);
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prev === csv) return "unchanged";
  if (rowCount(csv) === 0 && prev !== null && rowCount(prev) > 0 && !allowEmpty) return "refused";
  writeFileSync(path, csv);
  return "written";
}

test("an empty result never overwrites a populated snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-01.csv");
  const populated = toCsv(LEDGER_COLUMNS, [
    { Season: 2026, Week: 1, PlayerID: "1", Stat: "passYds", Edge: "0.05" },
    { Season: 2026, Week: 1, PlayerID: "2", Stat: "rushYds", Edge: "0.04" },
  ]);
  writeFileSync(path, populated);

  const empty = toCsv(LEDGER_COLUMNS, []);
  assert.equal(writeGuarded(path, empty), "refused");
  assert.equal(readFileSync(path, "utf8"), populated, "the ledger must be untouched");
});

test("--allow-empty is the deliberate override", () => {
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-01.csv");
  writeFileSync(path, toCsv(LEDGER_COLUMNS, [{ Season: 2026, Week: 1, PlayerID: "1" }]));
  assert.equal(writeGuarded(path, toCsv(LEDGER_COLUMNS, []), { allowEmpty: true }), "written");
});

test("an empty result is fine when there is nothing to lose", () => {
  // A brand-new week with no odds yet should still write its header.
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-09.csv");
  assert.equal(writeGuarded(path, toCsv(LEDGER_COLUMNS, [])), "written");
});

test("a non-empty result replaces a populated snapshot as normal", () => {
  const dir = mkdtempSync(join(tmpdir(), "bets-"));
  const path = join(dir, "week-01.csv");
  writeFileSync(path, toCsv(LEDGER_COLUMNS, [{ Season: 2026, Week: 1, PlayerID: "1" }]));
  const updated = toCsv(LEDGER_COLUMNS, [
    { Season: 2026, Week: 1, PlayerID: "1" },
    { Season: 2026, Week: 1, PlayerID: "2" },
  ]);
  assert.equal(writeGuarded(path, updated), "written");
  assert.equal(readFileSync(path, "utf8"), updated);
});
