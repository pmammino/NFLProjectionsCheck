import test from "node:test";
import assert from "node:assert/strict";
import { tCdf, tQuantile75, probOverVariant, curvePosition, POSITION_BINS, binOf, bestOnGrid, brier, mean } from "./projection-diagnosis.mjs";
import { probOverContinuous } from "./probability.mjs";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

const TRIPLE = { F: 40, M: 60, C: 85 };

test("tCdf: symmetric, 0.5 at the origin, and matches published t-table values", () => {
  assert.ok(Math.abs(tCdf(0, 5) - 0.5) < 1e-12);
  assert.ok(Math.abs(tCdf(1.3, 4) + tCdf(-1.3, 4) - 1) < 1e-12);
  // t-table: P(T <= 2.015) = 0.95 at 5 df; P(T <= 1.638) = 0.90 at 2 df.
  assert.ok(Math.abs(tCdf(2.015, 5) - 0.95) < 1e-3);
  assert.ok(Math.abs(tCdf(1.886, 2) - 0.9) < 1e-3);
  // Many degrees of freedom is the normal.
  assert.ok(Math.abs(tCdf(1.96, 5000) - 0.975) < 1e-3);
});

test("tQuantile75 matches published values", () => {
  assert.ok(Math.abs(tQuantile75(1) - 1) < 1e-6); // Cauchy
  assert.ok(Math.abs(tQuantile75(5) - 0.7267) < 1e-3);
  assert.ok(Math.abs(tQuantile75(3) - 0.7649) < 1e-3);
});

test("probOverVariant with no variation is exactly the long-standing price", () => {
  for (const line of [20, 40, 60, 75, 85, 120]) {
    assert.equal(probOverVariant(line, TRIPLE), probOverContinuous(line, 40, 60, 85));
  }
});

test("every variant puts a line at the median at a coin flip, and keeps the quartiles", () => {
  for (const opts of [{ nu: 3 }, { nu: 8 }, { spreadMult: 1.7 }, { nu: 4, spreadMult: 1.3 }]) {
    assert.ok(Math.abs(probOverVariant(60, TRIPLE, opts) - 0.5) < 1e-9, JSON.stringify(opts));
  }
  // A heavier tail with the SAME quartiles: the band's edges still sit at 25/75.
  assert.ok(Math.abs(probOverVariant(85, TRIPLE, { nu: 3 }) - 0.25) < 1e-6);
  assert.ok(Math.abs(probOverVariant(40, TRIPLE, { nu: 3 }) - 0.75) < 1e-6);
});

test("heavier tails raise the far tail and leave the middle alone", () => {
  const far = 150;
  assert.ok(probOverVariant(far, TRIPLE, { nu: 3 }) > 2 * probOverVariant(far, TRIPLE));
  assert.ok(Math.abs(probOverVariant(70, TRIPLE, { nu: 3 }) - probOverVariant(70, TRIPLE)) < 0.03);
});

test("a wider band pulls every probability toward a coin flip", () => {
  for (const line of [30, 50, 70, 100]) {
    const base = probOverVariant(line, TRIPLE);
    const wide = probOverVariant(line, TRIPLE, { spreadMult: 2 });
    assert.ok(Math.abs(wide - 0.5) < Math.abs(base - 0.5), `line ${line}`);
  }
});

test("shifting the projection down lowers P(over) at a fixed line", () => {
  assert.ok(probOverVariant(70, TRIPLE, { shift: 0.9 }) < probOverVariant(70, TRIPLE));
  assert.ok(probOverVariant(70, TRIPLE, { shift: 1.1 }) > probOverVariant(70, TRIPLE));
});

test("curvePosition: zero at the median, the quartile z at the band's edges, same half-scales as the price", () => {
  assert.equal(curvePosition(60, TRIPLE), 0);
  assert.ok(Math.abs(curvePosition(85, TRIPLE) - 0.6744897501960817) < 1e-12);
  assert.ok(Math.abs(curvePosition(40, TRIPLE) + 0.6744897501960817) < 1e-12);
  // The price at z is the normal tail at z.
  assert.ok(Math.abs(probOverContinuous(100, 40, 60, 85) - probOverVariant(100, TRIPLE)) < 1e-12);
});

test("every position falls in exactly one bin", () => {
  for (let z = -4; z <= 4; z += 0.05) {
    const hits = POSITION_BINS.filter((b) => b.test(z)).length;
    assert.equal(hits, 1, `z=${z}`);
    assert.ok(binOf(z) >= 0);
  }
});

test("bestOnGrid recovers the dial: outcomes drawn twice as wide as the band are best priced with spreadMult 2", () => {
  // The projection's band is too narrow by a factor of two; the fit should say so.
  const r = rng(21);
  const rows = [];
  for (let i = 0; i < 30000; i++) {
    const line = 60 + gauss(r) * 20;
    const sigmaLow = (60 - 40) / 0.6744897501960817;
    const sigmaHigh = (85 - 60) / 0.6744897501960817;
    const g = gauss(r);
    const actual = 60 + (g < 0 ? g * sigmaLow : g * sigmaHigh) * 2;
    rows.push({ line, y: actual > line ? 1 : 0 });
  }
  const { best, scores } = bestOnGrid(rows, [1, 1.5, 2, 2.5, 3], (row, k) => probOverVariant(row.line, TRIPLE, { spreadMult: k }));
  assert.equal(best, 2);
  assert.ok(scores[2] < scores[0], "and it beats the band as given");
});

test("brier and mean", () => {
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(brier([{ y: 1 }, { y: 0 }], () => 0.5), 0.25);
});
