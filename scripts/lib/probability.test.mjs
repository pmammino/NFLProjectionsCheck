import { test } from "node:test";
import assert from "node:assert/strict";
import { probOverContinuous, probOverPoisson } from "./probability.mjs";

test("probOverContinuous: anchors reproduce the 25/50/75 quantiles", () => {
  const [f, m, c] = [200, 250, 300];
  assert.ok(Math.abs(probOverContinuous(m, f, m, c) - 0.5) < 1e-6);
  assert.ok(Math.abs(probOverContinuous(f, f, m, c) - 0.75) < 1e-6);
  assert.ok(Math.abs(probOverContinuous(c, f, m, c) - 0.25) < 1e-6);
});

test("probOverContinuous: monotonically decreasing in the line", () => {
  const [f, m, c] = [15, 22, 30];
  const ps = [-20, 10, 20, 22, 25, 40, 60].map((line) => probOverContinuous(line, f, m, c));
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i] <= ps[i - 1]);
  assert.ok(ps[0] > 0.99); // far below floor -> near-certain over
  assert.ok(ps[ps.length - 1] < 0.01); // far above ceiling -> near-certain under
});

test("probOverContinuous: widening just the ceiling side raises P(over) above the median", () => {
  // Only the ceiling gap governs the distribution above the median in this
  // two-piece model (each half is anchored independently) — holding Floor
  // fixed and widening Ceiling should make a fixed above-median line easier
  // to clear.
  const wideCeiling = probOverContinuous(30, 20, 22, 45); // ceiling gap 23
  const narrowCeiling = probOverContinuous(30, 20, 22, 25); // ceiling gap 3
  assert.ok(wideCeiling > narrowCeiling);
});

test("probOverContinuous: widening just the floor side lowers P(over) below the median", () => {
  // A fixed below-median line: only the floor gap matters. A wider floor gap
  // spreads more probability mass below the median (a flatter lower half),
  // so a fixed point below the median is comparatively less certain to be
  // cleared than under a tight floor gap.
  const wideFloor = probOverContinuous(14, -5, 22, 30); // floor gap 27
  const narrowFloor = probOverContinuous(14, 18, 22, 30); // floor gap 4
  assert.ok(wideFloor < narrowFloor);
});

test("probOverContinuous: degenerate zero-spread projection doesn't throw/NaN", () => {
  const p = probOverContinuous(5, 0, 0, 0);
  assert.ok(Number.isFinite(p));
  assert.ok(p >= 0 && p <= 1);
});

test("probOverPoisson: matches 1-e^-lambda for the 0.5 (anytime) line", () => {
  const lambda = 0.35;
  assert.ok(Math.abs(probOverPoisson(0.5, lambda) - (1 - Math.exp(-lambda))) < 1e-9);
});

test("probOverPoisson: higher line is harder to clear", () => {
  const lambda = 1.2;
  assert.ok(probOverPoisson(1.5, lambda) < probOverPoisson(0.5, lambda));
  assert.ok(probOverPoisson(2.5, lambda) < probOverPoisson(1.5, lambda));
});

test("probOverPoisson: zero lambda -> zero probability of scoring", () => {
  assert.equal(probOverPoisson(0.5, 0), 0);
});
