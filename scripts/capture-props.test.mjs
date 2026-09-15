import { test } from "node:test";
import assert from "node:assert/strict";
import { ourProbability, PROPS_COLUMNS, BETS_COLUMNS } from "./capture-props.mjs";

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
  // Colbie Young: small rush + rec TD expectation, no Floor/Ceiling needed.
  const splits = { M: { RushTDs: "0.02", RecTDs: "0.08" } };
  const p = ourProbability({ line: 0.5, statKey: "anytimeTD" }, splits);
  assert.ok(Math.abs(p - (1 - Math.exp(-0.1))) < 1e-9);
});

test("ourProbability: no projection at all for this player -> null", () => {
  assert.equal(ourProbability({ line: 250, statKey: "passYds" }, undefined), null);
});

test("ourProbability: an unknown stat key -> null rather than a wrong model", () => {
  assert.equal(ourProbability({ line: 250, statKey: "fieldGoals" }, BURROW_SPLITS), null);
});

// The ledger schema is a contract: grade-bets.mjs rewrites the file using
// BETS_COLUMNS, so a column present in the data but missing from the list
// would be silently dropped on the first grading pass.
test("the ledger carries both the EV edge and the model edge", () => {
  for (const col of ["Edge", "ModelEdge", "EdgeBasis", "FairProb", "ImpliedProb", "Hold", "OneSided", "Side"]) {
    assert.ok(BETS_COLUMNS.includes(col), `BETS_COLUMNS missing ${col}`);
    assert.ok(PROPS_COLUMNS.includes(col), `PROPS_COLUMNS missing ${col}`);
  }
});

test("the ledger carries the grading fields grade-bets.mjs writes back", () => {
  for (const col of ["Status", "Actual", "PnlFlatUnits", "PnlKellyUnits"]) {
    assert.ok(BETS_COLUMNS.includes(col), `BETS_COLUMNS missing ${col}`);
  }
});
