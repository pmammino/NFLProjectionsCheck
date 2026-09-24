// Verifies the calibration-report maths against constructed data where the
// right answer is known by hand. Runs with `node --test` — no network, no
// dashboard build, and no unseeded randomness.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quantileSorted,
  wilson,
  mulberry32,
  verdictFor,
  coverage,
  coverageWith,
  coverageError,
  fitMultipliers,
  countInversions,
  holdout,
  cellsByMetric,
  analyze,
  isFantasyRelevant,
  filterFantasyRows,
  pointAccuracy,
  analyzeMetric,
} from "./calibration-report.mjs";

// A perfectly calibrated set: actuals 1..100 against floor 25 / median 50 /
// ceiling 75, so exactly 25 / 50 / 75 of them land at or below each line.
const perfect = () =>
  Array.from({ length: 100 }, (_, i) => ({ f: 25, m: 50, c: 75, a: i + 1 }));

// Fewer resamples in tests: the intervals only need to be sane, not tight.
const FAST = { samples: 200, seed: 7 };

// ---- Primitives ----------------------------------------------------------
test("quantileSorted interpolates and handles degenerate input", () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(quantileSorted(xs, 0), 1);
  assert.equal(quantileSorted(xs, 1), 5);
  assert.equal(quantileSorted(xs, 0.5), 3);
  assert.equal(quantileSorted([42], 0.25), 42);
  assert.ok(Number.isNaN(quantileSorted([], 0.5)));
  // Halfway between the 2nd and 3rd of four points.
  assert.equal(quantileSorted([0, 10, 20, 30], 0.5), 15);
});

test("wilson brackets the point estimate and clamps to [0,1]", () => {
  const w = wilson(50, 100);
  assert.ok(w.lo < 0.5 && w.hi > 0.5);
  const none = wilson(0, 30);
  assert.equal(none.lo, 0);
  assert.ok(none.hi > 0 && none.hi < 1);
  const all = wilson(30, 30);
  assert.equal(all.hi, 1);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
});

test("mulberry32 is deterministic for a seed and differs across seeds", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const draw = (r) => Array.from({ length: 5 }, () => r());
  assert.deepEqual(draw(a), draw(b));
  assert.notDeepEqual(draw(mulberry32(42)), draw(c));
  // Stays in [0,1).
  const r = mulberry32(1);
  for (let i = 0; i < 500; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});

test("verdictFor grades by |z|", () => {
  assert.equal(verdictFor(0.4), "noise");
  assert.equal(verdictFor(-1.9), "suggestive");
  assert.equal(verdictFor(3.1), "solid");
  assert.equal(verdictFor(-3.1), "solid");
});

// ---- Coverage ------------------------------------------------------------
test("coverage reads 25/50/75 on a perfectly calibrated set", () => {
  const c = coverage(perfect());
  assert.equal(c.n, 100);
  assert.equal(c.floor.share, 0.25);
  assert.equal(c.median.share, 0.5);
  assert.equal(c.ceiling.share, 0.75);
  assert.equal(c.within, 0.5);
  for (const line of ["floor", "median", "ceiling"]) {
    assert.equal(c[line].z, 0);
    assert.equal(c[line].verdict, "noise");
  }
});

test("coverage flags a band that is too narrow", () => {
  // Squeeze floor and ceiling toward the median: more actuals fall outside.
  const cells = perfect().map((x) => ({ ...x, f: 40, c: 60 }));
  const c = coverage(cells);
  assert.equal(c.floor.share, 0.4); // want 0.25 — too many below
  assert.equal(c.ceiling.share, 0.6); // want 0.75 — too many above
  assert.ok(c.within < 0.5);
  assert.ok(c.floor.z > 2.5 && c.ceiling.z < -2.5);
  assert.equal(c.floor.verdict, "solid");
});

test("coverage returns null for an empty set", () => {
  assert.equal(coverage([]), null);
});

// ---- Fitted multipliers --------------------------------------------------
test("fitMultipliers lands on ~1x when the bands are already right", () => {
  const f = fitMultipliers(perfect(), FAST);
  for (const line of ["floor", "median", "ceiling"]) {
    assert.ok(Math.abs(f[line].k - 1) < 0.05, `${line} drifted: ${f[line].k}`);
    assert.ok(f[line].ci.lo <= 1 && f[line].ci.hi >= 1, `${line} CI should span 1`);
  }
});

test("fitMultipliers recovers a known scaling of a line", () => {
  // Halving every floor should double the multiplier needed to put it back.
  const base = fitMultipliers(perfect(), FAST);
  const halved = fitMultipliers(
    perfect().map((x) => ({ ...x, f: x.f / 2 })),
    FAST
  );
  assert.ok(
    Math.abs(halved.floor.k - base.floor.k * 2) < 1e-9,
    `expected ${base.floor.k * 2}, got ${halved.floor.k}`
  );
  // The other lines are untouched.
  assert.equal(halved.median.k, base.median.k);
});

test("fitMultipliers drops rows whose line is zero and says how many", () => {
  const cells = perfect();
  cells[0] = { ...cells[0], f: 0 };
  cells[1] = { ...cells[1], f: -1 };
  const f = fitMultipliers(cells, FAST);
  assert.equal(f.floor.n, 98);
  assert.equal(f.floor.dropped, 2);
  assert.equal(f.median.dropped, 0);
});

test("fitMultipliers is reproducible for a seed", () => {
  const a = fitMultipliers(perfect(), { samples: 300, seed: 11 });
  const b = fitMultipliers(perfect(), { samples: 300, seed: 11 });
  assert.deepEqual(a.floor.ci, b.floor.ci);
});

test("countInversions catches a line pushed past its neighbour", () => {
  // Floor 9 / median 10: scaling the floor up 50% and the median down puts
  // the floor above its own median, which is nonsense downstream.
  const tight = [{ f: 9, m: 10, c: 11, a: 10 }];
  assert.equal(countInversions(tight, { floor: { k: 1 }, median: { k: 1 }, ceiling: { k: 1 } }), 0);
  assert.equal(countInversions(tight, { floor: { k: 1.5 }, median: { k: 0.9 }, ceiling: { k: 1 } }), 1);
  // Missing multipliers default to 1x rather than throwing.
  assert.equal(countInversions(tight, {}), 0);
});

// ---- Applying a fit ------------------------------------------------------
test("coverageWith scales the lines and leaves the input untouched", () => {
  const cells = perfect();
  const before = JSON.stringify(cells);
  const c = coverageWith(cells, { ceiling: { k: 2 } });
  assert.equal(JSON.stringify(cells), before, "must not mutate its input");
  assert.equal(c.ceiling.share, 1); // ceiling 150 is above every actual
  assert.equal(c.floor.share, 0.25); // untouched
});

test("coverageError sums the distance from 25/50/75 in points", () => {
  assert.equal(coverageError(coverage(perfect())), 0);
  const skewed = coverage(perfect().map((x) => ({ ...x, f: 40 })));
  assert.ok(Math.abs(coverageError(skewed) - 15) < 1e-9); // 40% vs 25%
  assert.ok(Number.isNaN(coverageError(null)));
});

// ---- Holdout -------------------------------------------------------------
test("holdout needs at least two weeks", () => {
  assert.equal(holdout(new Map([[1, perfect()]])), null);
  assert.equal(holdout(new Map()), null);
});

test("holdout scores a fit on the weeks it was not fitted to", () => {
  // Week 1 and week 2 share the same bias, so a correction fitted on week 1
  // should help on week 2.
  const biased = () => perfect().map((x) => ({ ...x, c: 60 })); // ceiling too low
  const h = holdout(new Map([[1, biased()], [2, biased()]]), FAST);
  assert.deepEqual(h.fitWeeks, [1]);
  assert.deepEqual(h.testWeeks, [2]);
  assert.ok(h.fitted.ceiling.k > 1, "should want a higher ceiling");
  assert.ok(h.adjustedError < h.baselineError);
  assert.equal(h.improved, true);
});

test("holdout reports no improvement when week 2 contradicts week 1", () => {
  // Opposite biases: a fix for week 1 is wrong for week 2. This is the case
  // the report exists to catch.
  const lowCeiling = perfect().map((x) => ({ ...x, c: 55 }));
  const highCeiling = perfect().map((x) => ({ ...x, c: 95 }));
  const h = holdout(new Map([[1, lowCeiling], [2, highCeiling]]), FAST);
  assert.equal(h.improved, false);
  assert.ok(h.adjustedError > h.baselineError);
});

test("holdout honours an explicit split", () => {
  const m = new Map([1, 2, 3, 4].map((w) => [w, perfect()]));
  assert.deepEqual(holdout(m, { ...FAST, split: 3 }).fitWeeks, [1, 2, 3]);
  assert.deepEqual(holdout(m, { ...FAST, split: 3 }).testWeeks, [4]);
  // Default splits down the middle.
  assert.deepEqual(holdout(m, FAST).fitWeeks, [1, 2]);
});

// ---- Assembly ------------------------------------------------------------
const META = [
  { key: "targets", label: "Targets", group: "Receiving", kind: "volume" },
  { key: "absent", label: "Absent", group: "Receiving", kind: "volume" },
];
const ROWS = [
  { wk: 1, m: { targets: { f: 2, m: 4, c: 6, a: 3 } } },
  { wk: 1, m: { targets: { f: 2, m: 4, c: 6, a: 9 } } },
  { wk: 2, m: { targets: { f: 2, m: 4, c: 6, a: 1 } } },
  { wk: 2, m: { other: { f: 1, m: 2, c: 3, a: 2 } } },
];

test("cellsByMetric groups by metric and by week, skipping absent metrics", () => {
  const g = cellsByMetric(ROWS, META);
  assert.equal(g.has("absent"), false, "a metric with no cells is left out");
  const t = g.get("targets");
  assert.equal(t.cells.length, 3);
  assert.equal(t.byWeek.get(1).length, 2);
  assert.equal(t.byWeek.get(2).length, 1);
});

test("analyze reports each metric and honours the --metrics filter", () => {
  const all = analyze(ROWS, META, FAST);
  assert.equal(all.length, 1);
  assert.equal(all[0].key, "targets");
  assert.equal(all[0].label, "Targets");
  assert.ok(all[0].coverage && all[0].fit);
  const none = analyze(ROWS, META, { ...FAST, only: new Set(["nope"]) });
  assert.equal(none.length, 0);
});

test("analyze can skip the holdout (season scope has no weeks)", () => {
  const [r] = analyze(ROWS, META, { ...FAST, holdout: false });
  assert.equal(r.holdout, null);
});

// ---- Fantasy relevance ---------------------------------------------------
const RANKS = { QB: null, RB: 50, WR: 60, TE: 40 };

test("isFantasyRelevant applies the per-position cap", () => {
  assert.equal(isFantasyRelevant("WR", 60, RANKS), true); // on the line
  assert.equal(isFantasyRelevant("WR", 61, RANKS), false);
  assert.equal(isFantasyRelevant("TE", 40, RANKS), true);
  assert.equal(isFantasyRelevant("TE", 41, RANKS), false);
  assert.equal(isFantasyRelevant("RB", 50, RANKS), true);
});

test("isFantasyRelevant treats a null cap as uncapped", () => {
  assert.equal(isFantasyRelevant("QB", 1, RANKS), true);
  assert.equal(isFantasyRelevant("QB", 97, RANKS), true);
});

test("isFantasyRelevant excludes unranked rows", () => {
  // No rank means the position was unknown at build time. The filter is
  // opt-in, so the conservative side is to leave those out.
  assert.equal(isFantasyRelevant("WR", null, RANKS), false);
  assert.equal(isFantasyRelevant("WR", undefined, RANKS), false);
  // A position with no entry at all is uncapped, not excluded.
  assert.equal(isFantasyRelevant("K", 200, RANKS), true);
  assert.equal(isFantasyRelevant("WR", 5, undefined), true);
});

test("filterFantasyRows keeps only the relevant rows", () => {
  const rows = [
    { pos: "WR", pr: 1 },
    { pos: "WR", pr: 61 },
    { pos: "QB", pr: 40 },
    { pos: "TE", pr: null },
    { pos: "RB", pr: 50 },
  ];
  const kept = filterFantasyRows(rows, RANKS);
  assert.deepEqual(kept, [{ pos: "WR", pr: 1 }, { pos: "QB", pr: 40 }, { pos: "RB", pr: 50 }]);
});

// ---- Point accuracy ------------------------------------------------------
test("pointAccuracy measures the median, not the band", () => {
  // Every actual is exactly 2 above its median, whatever the band does.
  const cells = [10, 20, 30, 40].map((m) => ({ f: 0, m, c: 999, a: m + 2 }));
  const p = pointAccuracy(cells);
  assert.equal(p.n, 4);
  assert.equal(p.meanErr, 2); // + = under-projected
  assert.equal(p.mae, 2);
  assert.equal(p.rmse, 2);
  assert.equal(p.spearman, 1); // order preserved perfectly
  // WAPE = total miss / total actual = 8 / (12+22+32+42)
  assert.ok(Math.abs(p.wape - 8 / 108) < 1e-12);
});

test("pointAccuracy signs the error the stated way", () => {
  const under = pointAccuracy([{ f: 0, m: 10, c: 20, a: 15 }]);
  assert.ok(under.meanErr > 0, "actual above projection reads positive");
  const over = pointAccuracy([{ f: 0, m: 10, c: 20, a: 5 }]);
  assert.ok(over.meanErr < 0);
});

test("pointAccuracy survives zero actuals and zero medians", () => {
  // WAPE exists because a mean of ratios blows up here.
  const p = pointAccuracy([
    { f: 0, m: 0, c: 0, a: 0 },
    { f: 0, m: 4, c: 8, a: 0 },
  ]);
  assert.equal(p.n, 2);
  assert.ok(Number.isNaN(p.wape) || Number.isFinite(p.wape));
  // The m===0 row contributes no percentage error rather than an Infinity.
  assert.equal(p.medianPctBias, -1);
});

test("pointAccuracy detects inverted ordering", () => {
  const cells = [
    { f: 0, m: 10, c: 20, a: 4 },
    { f: 0, m: 20, c: 30, a: 3 },
    { f: 0, m: 30, c: 40, a: 2 },
    { f: 0, m: 40, c: 50, a: 1 },
  ];
  assert.equal(pointAccuracy(cells).spearman, -1);
  assert.equal(pointAccuracy([]), null);
});

// ---- Unbanded metrics ----------------------------------------------------
test("analyzeMetric skips every band section for an unbanded metric", () => {
  // A ratio whose Floor/Ceiling do not order — scoring its band would be
  // reporting a number with no meaning, so the sections are omitted.
  const entry = {
    meta: { key: "passRate", label: "Pass Rate", group: "Passing", kind: "rate", banded: false },
    cells: [{ f: 0.6, m: 0.6, c: 0.6, a: 0.55 }],
    byWeek: new Map([[1, [{ f: 0.6, m: 0.6, c: 0.6, a: 0.55 }]]]),
  };
  const r = analyzeMetric(entry, FAST);
  assert.equal(r.banded, false);
  assert.equal(r.coverage, null);
  assert.equal(r.fit, null);
  assert.equal(r.holdout, null);
  assert.ok(r.point, "point accuracy is still reported — it is the only valid read");
  assert.ok(Math.abs(r.point.meanErr - -0.05) < 1e-9);
});

test("analyzeMetric keeps the band sections when banded is absent or true", () => {
  const cells = perfect();
  const byWeek = new Map([[1, cells.slice(0, 50)], [2, cells.slice(50)]]);
  for (const meta of [
    { key: "a", label: "A", group: "G", kind: "volume" },
    { key: "a", label: "A", group: "G", kind: "volume", banded: true },
  ]) {
    const r = analyzeMetric({ meta, cells, byWeek }, FAST);
    assert.equal(r.banded, true);
    assert.ok(r.coverage && r.fit && r.holdout && r.point);
  }
});
