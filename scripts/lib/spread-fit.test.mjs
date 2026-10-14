import test from "node:test";
import assert from "node:assert/strict";
import {
  SPREAD_GROUPS,
  MAX_SPREAD,
  MIN_SPREAD_CLUSTERS,
  groupOf,
  widenPoints,
  widenedProb,
  bestSpread,
  logLossGain,
  fitSpread,
  fitSpreads,
  spreadFor,
  spreadAdjustedPoints,
  spreadsAsOf,
} from "./spread-fit.mjs";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const Z75 = 0.6744897501960817;

// Players whose true outcome has half-spreads `k` times the projected ones, each
// priced on a ladder of lines. k = 1 is a projection with the right spread.
function world({ k, players = 300, rungs = 7, seed = 3, week = 1, stat = "recYds" }) {
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < players; i++) {
    const M = 40 + r() * 60;
    const lo = M * (0.25 + r() * 0.2);
    const hi = M * (0.25 + r() * 0.25);
    const F = M - lo;
    const C = M + hi;
    const z = gauss(r);
    const actual = M + (z < 0 ? z * ((k * lo) / Z75) : z * ((k * hi) / Z75));
    for (let j = 0; j < rungs; j++) {
      const line = M + (j - (rungs - 1) / 2) * (M * 0.25);
      rows.push({ line, F, M, C, y: actual > line ? 1 : 0, cluster: `${week}|${i}`, week, stat });
    }
  }
  return rows;
}

test("widening scales both distances from the median and leaves the median alone", () => {
  assert.deepEqual(widenPoints({ F: 30, M: 50, C: 80 }, 1.5), { F: 20, M: 50, C: 95 });
  assert.deepEqual(widenPoints({ F: 30, M: 50, C: 80 }, 1), { F: 30, M: 50, C: 80 });
  assert.deepEqual(widenPoints({ F: 30, M: 50, C: 80 }, undefined), { F: 30, M: 50, C: 80 });
});

test("a wider band moves a tail probability up and leaves the median at a coin flip", () => {
  const pts = { F: 30, M: 50, C: 80 };
  assert.ok(widenedProb(120, pts, 1.5) > widenedProb(120, pts, 1));
  assert.ok(widenedProb(10, pts, 1.5) < widenedProb(10, pts, 1)); // under-tail: over becomes less likely to be a lock
  assert.ok(Math.abs(widenedProb(50, pts, 1.5) - 0.5) < 1e-9);
});

test("a projection that is too narrow is found out, and one that is right is left alone", () => {
  const narrow = bestSpread(world({ k: 1.6, seed: 5 }));
  assert.ok(narrow.w >= 1.4 && narrow.w <= 1.8, `best ${narrow.w}`);
  const right = bestSpread(world({ k: 1, seed: 6 }));
  assert.ok(right.w <= 1.1, `best ${right.w}`);
});

test("the logged gain is negative when widening helps, with a clustered z", () => {
  const rows = world({ k: 1.6, seed: 7 });
  const g = logLossGain(rows, 1.6);
  assert.ok(g.mean < 0 && g.z < -3, JSON.stringify(g));
  const flat = logLossGain(world({ k: 1, seed: 8 }), 1.6);
  assert.ok(flat.mean > 0, "widening a correct band costs");
});

test("a fit applies, is marked down by its own error, and never exceeds the cap", () => {
  const f = fitSpread(world({ k: 1.5, seed: 9, players: 400 }));
  assert.equal(f.applied, true);
  assert.ok(f.w > 1 && f.w <= f.raw, `used ${f.w} from ${f.raw} ± ${f.se}`);
  assert.ok(f.w < f.raw || f.se === 0, "caution marks it down");
  const huge = fitSpread(world({ k: 3, seed: 10, players: 400 }));
  assert.ok(huge.w <= MAX_SPREAD + 1e-9, `used ${huge.w}`);
  assert.equal(huge.w, MAX_SPREAD);
});

test("a correct projection is not widened", () => {
  const f = fitSpread(world({ k: 1, seed: 11, players: 400 }));
  assert.equal(f.applied, false);
  assert.equal(f.w, 1);
});

test("too few player-weeks is a refusal, not a fit", () => {
  const f = fitSpread(world({ k: 1.8, seed: 12, players: MIN_SPREAD_CLUSTERS - 10 }));
  assert.equal(f.applied, false);
  assert.equal(f.reason, "too-few-player-weeks");
  assert.equal(f.w, 1);
});

test("a fit that does not improve the log-loss clearly is not applied, however wide it looks", () => {
  // Same data, but a z bar nothing can clear.
  const f = fitSpread(world({ k: 1.5, seed: 9, players: 400 }), { solidZ: 1e9 });
  assert.equal(f.applied, false);
  assert.equal(f.reason, "not-solid");
});

test("stats share a multiplier by group; an unknown stat is never widened", () => {
  assert.equal(groupOf("recYds"), "yards");
  assert.equal(groupOf("receptions"), "counts");
  assert.equal(groupOf("anytimeTD"), null);
  const fits = { yards: { applied: true, w: 1.4 }, counts: { applied: false, w: 1 } };
  assert.equal(spreadFor(fits, "passYds"), 1.4);
  assert.equal(spreadFor(fits, "rushYds"), 1.4);
  assert.equal(spreadFor(fits, "receptions"), 1);
  assert.equal(spreadFor(fits, "anytimeTD"), 1);
  assert.equal(spreadFor(null, "recYds"), 1);
  assert.deepEqual(spreadAdjustedPoints({ F: 30, M: 50, C: 80 }, fits, "recYds"), { F: 22, M: 50, C: 92 });
  assert.deepEqual(spreadAdjustedPoints({ F: 30, M: 50, C: 80 }, fits, "receptions"), { F: 30, M: 50, C: 80 });
});

test("fitSpreads pools the stats of a group", () => {
  const byStat = { recYds: world({ k: 1.5, seed: 13, players: 200, stat: "recYds" }), rushYds: world({ k: 1.5, seed: 14, players: 200, stat: "rushYds", week: 2 }) };
  const fits = fitSpreads(byStat);
  assert.equal(fits.yards.clusters, 400);
  assert.equal(fits.yards.applied, true);
  assert.equal(fits.counts.applied, false);
  assert.deepEqual(Object.keys(fits).sort(), Object.keys(SPREAD_GROUPS).sort());
});

test("as of a week means strictly earlier weeks only", () => {
  // The band is wrong only in week 3. Scoring week 3 must not learn that from week 3.
  const rows = [...world({ k: 1, seed: 20, players: 250, week: 1 }), ...world({ k: 1, seed: 21, players: 250, week: 2 }), ...world({ k: 2, seed: 22, players: 250, week: 3 })];
  assert.equal(spreadsAsOf(rows, 3).yards.applied, false);
  assert.equal(spreadsAsOf(rows, 4).yards.applied, true);
  assert.equal(spreadsAsOf(rows, 1).yards.reason, "too-few-player-weeks");
});
