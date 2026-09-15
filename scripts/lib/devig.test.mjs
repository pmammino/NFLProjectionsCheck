// Verifies the de-vig math against hand-checked markets.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  devigTwoWay,
  devigProbabilities,
  DEVIG_METHODS,
  DEFAULT_DEVIG_METHOD,
} from "./devig.mjs";

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (within ${eps})`);

// ---- the standard symmetric market -------------------------------------------
// -110 / -110 is the canonical prop price. Raw implied is 110/210 = 0.523809…
// per side, summing to 1.047619 — a 4.76% hold. Every method must return
// exactly 0.5/0.5, because there is nothing to distinguish the two sides.
test("-110/-110 de-vigs to 50/50 under every method", () => {
  for (const method of DEVIG_METHODS) {
    const r = devigTwoWay(-110, -110, method);
    close(r.fairProbOver, 0.5, 1e-9);
    close(r.fairProbUnder, 0.5, 1e-9);
    close(r.hold, 110 / 210 + 110 / 210 - 1, 1e-12);
  }
});

test("raw implied probability overstates the fair price on -110/-110", () => {
  const r = devigTwoWay(-110, -110);
  // This is the bias the old single-sided pipeline carried: it would have
  // treated the market as believing 52.38%, when it actually believes 50%.
  close(r.rawProbOver, 110 / 210, 1e-12);
  close(r.fairProbOver, 0.5, 1e-9);
  assert.ok(r.rawProbOver - r.fairProbOver > 0.023, "overstatement ≈ half the hold");
});

// ---- fair probabilities are a proper distribution -----------------------------
test("every method returns two probabilities summing to 1", () => {
  const markets = [
    [-110, -110],
    [-120, 100],
    [400, -600],
    [-250, 200],
    [150, -180],
  ];
  for (const method of DEVIG_METHODS) {
    for (const [over, under] of markets) {
      const r = devigTwoWay(over, under, method);
      assert.ok(r, `${method} failed on ${over}/${under}`);
      close(r.fairProbOver + r.fairProbUnder, 1, 1e-9);
      assert.ok(r.fairProbOver > 0 && r.fairProbOver < 1);
    }
  }
});

test("hold is the raw overround and is independent of method", () => {
  const r = devigTwoWay(400, -600);
  close(r.rawProbOver, 0.2, 1e-12); // +400 -> 100/500
  close(r.rawProbUnder, 600 / 700, 1e-12);
  close(r.hold, 0.2 + 600 / 700 - 1, 1e-12);
  for (const method of DEVIG_METHODS) {
    close(devigTwoWay(400, -600, method).hold, r.hold, 1e-12);
  }
});

// ---- favorite-longshot bias ---------------------------------------------------
// On a skewed market the methods deliberately disagree. Power and Shin strip
// more margin from the longshot than multiplicative does, so they assign it a
// LOWER fair probability. This matters: a longshot's fair probability is the
// denominator of our edge, so the choice directly moves which bets qualify.
test("power and shin price a longshot below multiplicative", () => {
  const mult = devigTwoWay(400, -600, "multiplicative").fairProbOver;
  const power = devigTwoWay(400, -600, "power").fairProbOver;
  const shin = devigTwoWay(400, -600, "shin").fairProbOver;

  close(mult, 0.2 / (0.2 + 600 / 700), 1e-9); // proportional scaling
  assert.ok(power < mult, `power ${power} should be < multiplicative ${mult}`);
  assert.ok(shin < mult, `shin ${shin} should be < multiplicative ${mult}`);
  // The gap is material on a longshot — several points, not rounding noise.
  assert.ok(mult - power > 0.02, `gap ${mult - power} should be economically meaningful`);
});

test("methods converge as the market approaches symmetry", () => {
  const spread = (over, under) => {
    const ps = DEVIG_METHODS.map((m) => devigTwoWay(over, under, m).fairProbOver);
    return Math.max(...ps) - Math.min(...ps);
  };
  assert.ok(spread(-105, -105) < spread(-250, 200));
  assert.ok(spread(-250, 200) < spread(400, -600));
});

// ---- degenerate and hostile inputs -------------------------------------------
test("a one-sided market cannot be de-vigged", () => {
  // This is the signal the caller needs: no opposing price means fall back to
  // the raw implied probability and flag the row.
  assert.equal(devigTwoWay(400, null), null);
  assert.equal(devigTwoWay(null, -600), null);
  assert.equal(devigTwoWay(400, 0), null);
  assert.equal(devigTwoWay(undefined, undefined), null);
});

test("an arbitrage market (sum < 1) still returns a valid distribution", () => {
  // Two books crossed, or a stale quote. Normalizing keeps downstream math
  // total, and the negative hold is what flags it.
  const r = devigTwoWay(120, 120);
  close(r.fairProbOver + r.fairProbUnder, 1, 1e-12);
  assert.ok(r.hold < 0, "crossed market should report negative hold");
});

test("additive stays positive on any two-way market, however skewed", () => {
  // Provable, not just observed: the per-side excess is (q_over + q_under-1)/2,
  // and since q_under < 1 that is always below q_over. Worth pinning down,
  // because additive's negative-probability failure mode is real on 3+ way
  // markets and it would be easy to assume it applies here too.
  for (const [over, under] of [
    [2500, -20000],
    [10000, -50000],
    [-50000, 10000],
  ]) {
    const r = devigTwoWay(over, under, "additive");
    assert.ok(r, `additive should handle ${over}/${under}`);
    assert.ok(r.fairProbOver > 0 && r.fairProbUnder > 0);
  }
});

test("the negative-probability guard fires on a 3-way market", () => {
  // Here additive genuinely does break: a 2% longshot alongside a 112%
  // overround loses more than it has.
  assert.equal(devigProbabilities([0.02, 0.6, 0.5], "additive"), null);
  // The bias-aware methods still produce a usable distribution.
  const power = devigProbabilities([0.02, 0.6, 0.5], "power");
  assert.ok(power.every((p) => p > 0));
  close(power.reduce((s, x) => s + x, 0), 1, 1e-9);
});

test("devigProbabilities rejects malformed inputs", () => {
  assert.equal(devigProbabilities([0.5], "multiplicative"), null);
  assert.equal(devigProbabilities([], "multiplicative"), null);
  assert.equal(devigProbabilities([0.5, NaN], "multiplicative"), null);
  assert.equal(devigProbabilities([0.5, 1.2], "multiplicative"), null);
  assert.equal(devigProbabilities([0, 0.9], "multiplicative"), null);
  assert.throws(() => devigProbabilities([0.5, 0.6], "nonsense"), /Unknown de-vig method/);
});

test("the default method is one of the supported methods", () => {
  assert.ok(DEVIG_METHODS.includes(DEFAULT_DEVIG_METHOD));
});
