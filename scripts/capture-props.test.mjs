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

test("ourProbability: poisson stat with a real role sums median TD columns as-is", () => {
  // A featured back: 14 touches clears the default stableTdVolume (8), so
  // Median is used at full weight, unshrunk.
  const splits = {
    F: { RushTDs: "0.05", RecTDs: "0.01" },
    M: { RushTDs: "0.30", RecTDs: "0.05", RushAttempts: "12", RecCompletions: "2" },
  };
  const p = ourProbability({ line: 0.5 }, STAT_DEFS.anytimeTD, splits);
  assert.ok(Math.abs(p - (1 - Math.exp(-0.35))) < 1e-9);
});

test("ourProbability: poisson stat below minTdVolume touches -> null (too thin a role to price)", () => {
  // Colbie Young-style deep bench WR: 1 rush att + 1 reception = 2 touches,
  // below the default minTdVolume of 3.
  const splits = {
    F: { RushTDs: "0.0", RecTDs: "0.01" },
    M: { RushTDs: "0.0", RecTDs: "0.03", RushAttempts: "0", RecCompletions: "2" },
  };
  const p = ourProbability({ line: 0.5 }, STAT_DEFS.anytimeTD, splits);
  assert.equal(p, null);
});

test("ourProbability: poisson stat between min/stable volume shrinks lambda toward Floor", () => {
  // 5.5 touches: exactly halfway between the default minTdVolume (3) and stableTdVolume (8).
  const splits = {
    F: { RushTDs: "0.02", RecTDs: "0.0" },
    M: { RushTDs: "0.30", RecTDs: "0.0", RushAttempts: "5.5", RecCompletions: "0" },
  };
  const p = ourProbability({ line: 0.5 }, STAT_DEFS.anytimeTD, splits);
  const expectedLambda = 0.02 + 0.5 * (0.3 - 0.02); // halfway between Floor and Median
  assert.ok(Math.abs(p - (1 - Math.exp(-expectedLambda))) < 1e-9);
});

test("ourProbability: custom min/stable TD volume thresholds are honored", () => {
  const splits = { F: { RushTDs: "0.1" }, M: { RushTDs: "0.4", RushAttempts: "4" } };
  // Default thresholds (3, 8): 4 touches is between them -> shrunk.
  const shrunk = ourProbability({ line: 0.5 }, STAT_DEFS.rushTD, splits);
  // Raised minTdVolume to 5: now below the bar entirely -> null.
  const excluded = ourProbability({ line: 0.5 }, STAT_DEFS.rushTD, splits, { minTdVolume: 5, stableTdVolume: 10 });
  assert.ok(shrunk !== null);
  assert.equal(excluded, null);
});

test("ourProbability: no projection at all for this player -> null", () => {
  assert.equal(ourProbability({ line: 250 }, STAT_DEFS.passYds, undefined), null);
});
