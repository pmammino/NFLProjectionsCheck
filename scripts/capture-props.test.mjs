import { test } from "node:test";
import assert from "node:assert/strict";
import { ourProbability } from "./capture-props.mjs";
import { STAT_DEFS } from "./lib/props.mjs";

// Joe Burrow, week-1-shaped projection split (F/M/C rows keyed like the real
// weekly_projections snapshot).
const BURROW_SPLITS = {
  F: { PassYards: "230.0" },
  M: { PassYards: "277.9" },
  C: { PassYards: "320.0" },
};

test("ourProbability: continuous stat well below floor is near-certain over", () => {
  const p = ourProbability({ line: 100 }, STAT_DEFS.passYds, BURROW_SPLITS);
  assert.ok(p > 0.9);
});

test("ourProbability: continuous stat at the median is ~0.5", () => {
  const p = ourProbability({ line: 277.9 }, STAT_DEFS.passYds, BURROW_SPLITS);
  assert.ok(Math.abs(p - 0.5) < 1e-6);
});

test("ourProbability: missing Floor/Ceiling for a continuous stat -> null (can't price)", () => {
  const p = ourProbability({ line: 250 }, STAT_DEFS.passYds, { M: { PassYards: "277.9" } });
  assert.equal(p, null);
});

test("ourProbability: poisson stat sums the configured projection columns", () => {
  // Colbie Young: small rush + rec TD expectation, no Floor/Ceiling needed.
  const splits = { M: { RushTDs: "0.02", RecTDs: "0.08" } };
  const p = ourProbability({ line: 0.5 }, STAT_DEFS.anytimeTD, splits);
  assert.ok(Math.abs(p - (1 - Math.exp(-0.1))) < 1e-9);
});

test("ourProbability: no projection at all for this player -> null", () => {
  assert.equal(ourProbability({ line: 250 }, STAT_DEFS.passYds, undefined), null);
});
