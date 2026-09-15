import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeOutcome } from "./grading.mjs";
import { STAT_DEFS } from "./markets.mjs";

test("an over settles on beating the line", () => {
  assert.equal(gradeOutcome(280, 249.5, "over"), "won");
  assert.equal(gradeOutcome(200, 249.5, "over"), "lost");
});

test("an under settles on staying below the line", () => {
  assert.equal(gradeOutcome(200, 249.5, "under"), "won");
  assert.equal(gradeOutcome(280, 249.5, "under"), "lost");
});

test("landing exactly on a whole-number line is a push, either side", () => {
  // Only possible on whole-number lines, which the old RotoWire feed never
  // produced — every line there was effectively a half-point.
  assert.equal(gradeOutcome(5, 5, "over"), "push");
  assert.equal(gradeOutcome(5, 5, "under"), "push");
  assert.equal(gradeOutcome(0, 0, "over"), "push");
});

test("a half-point line can never push", () => {
  for (const actual of [4, 5, 6]) {
    assert.notEqual(gradeOutcome(actual, 5.5, "over"), "push");
    assert.notEqual(gradeOutcome(actual, 5.5, "under"), "push");
  }
});

test("an absent side grades as an over", () => {
  // Pre-migration ledgers have no Side column and were all overs.
  assert.equal(gradeOutcome(280, 249.5, undefined), "won");
  assert.equal(gradeOutcome(200, 249.5, ""), "lost");
});

test("every stat's actuals columns exist in the actuals schema", () => {
  // Guards the consolidation: markets.mjs now owns both projCols and
  // actualCols, and a typo in either would silently grade every bet on that
  // stat as a loss (a missing column reads as 0).
  const ACTUALS_SCHEMA = new Set([
    "PlayerID", "ID", "position", "Season", "Week", "NFLTeamID",
    "Rushes", "RushYards", "PassComp", "PassAtt", "PassYards",
    "Receptions", "ReceptYds", "PassTD", "RecptTD", "RushTD", "Targets",
  ]);
  const PROJECTIONS_SCHEMA = new Set([
    "PassAttempts", "RushAttempts", "Targets", "PassCompletions", "PassYards",
    "PassTDs", "PassInts", "RushYards", "RushTDs", "RecCompletions",
    "RecYards", "RecTDs",
  ]);
  for (const [statKey, def] of Object.entries(STAT_DEFS)) {
    for (const col of def.actualCols) {
      assert.ok(ACTUALS_SCHEMA.has(col), `${statKey}: actuals column "${col}" is not in the actuals schema`);
    }
    for (const col of def.projCols) {
      assert.ok(PROJECTIONS_SCHEMA.has(col), `${statKey}: projection column "${col}" is not in the projections schema`);
    }
  }
});

test("interceptions are knowingly ungradeable", () => {
  // The RotoWire actuals feed has no INT column, so these bets stay pending
  // forever. Pinned so it's a deliberate state, not an unnoticed regression.
  assert.deepEqual(STAT_DEFS.int.actualCols, []);
});
