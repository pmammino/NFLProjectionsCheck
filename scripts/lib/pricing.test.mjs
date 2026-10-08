import test from "node:test";
import assert from "node:assert/strict";
import {
  hasFeatures,
  fitLogistic,
  fitPricingModel,
  predict,
  walkForward,
  scoreProbabilities,
  reliability,
  skill,
  pairedBrierDiff,
  clusterKey,
  isUsable,
  MODEL_SPECS,
  MAX_LOGIT,
  sigmoid,
  logit,
  MONEY_BANDS,
  bandOf,
  isNearMoney,
  distanceFromEven,
  compareByBand,
} from "./pricing.mjs";

// Deterministic PRNG so every generated sample below is reproducible; a test
// whose data changes between runs cannot fail usefully.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate markets whose true probability is a known function of the market
// price and our projection, so the fitted coefficients have a right answer.
function synth({ n = 4000, seed = 7, a = 0, c = 1, b = 0, stat = "recYds", week = 1 } = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const pMarket = 0.05 + 0.9 * rnd();
    const pProj = Math.min(0.98, Math.max(0.02, pMarket + (rnd() - 0.5) * 0.4));
    const z = a + c * logit(pMarket) + b * (logit(pProj) - logit(pMarket));
    const truth = sigmoid(z);
    out.push({ stat, week, playerId: `p${i}`, pProj, pMarket, y: rnd() < truth ? 1 : 0 });
  }
  return out;
}

test("fitLogistic recovers known coefficients", () => {
  const samples = synth({ n: 20000, seed: 11, a: 0.3, c: 1.1, b: 0.4 });
  const fit = fitLogistic(samples, MODEL_SPECS.blend, { penalty: 0, prior: [0, 1, 0] });
  assert.equal(fit.converged, true);
  const [aHat, cHat, bHat] = fit.coef;
  assert.ok(Math.abs(aHat - 0.3) < 0.1, `a=${aHat}`);
  assert.ok(Math.abs(cHat - 1.1) < 0.1, `c=${cHat}`);
  assert.ok(Math.abs(bHat - 0.4) < 0.15, `b=${bHat}`);
});

test("fitLogistic with no data returns the prior", () => {
  const fit = fitLogistic([], MODEL_SPECS.blend, { prior: [0, 1, 0] });
  assert.deepEqual(fit.coef, [0, 1, 0]);
  assert.equal(fit.converged, false);
});

test("a strong prior holds a separable sample near the prior", () => {
  // This is the regression test for the failure that motivated moving the
  // shrinkage inside the likelihood. Perfectly separable data drives an
  // unpenalized logistic fit to infinity; averaging such a fit toward a
  // global one afterwards still leaves a divergent coefficient (measured on
  // real passTD data: own b = -85, shrunk b = -6.6, predicting 53% on a
  // market priced at 3.8%). A prior worth 200 observations cannot be moved
  // far by 12 rows however separable they are.
  const separable = [];
  for (let i = 0; i < 12; i++) {
    const pMarket = 0.1 + i * 0.05;
    separable.push({
      stat: "passTD",
      week: 1,
      playerId: `p${i}`,
      // pProj must vary independently of pMarket or the two features are
      // collinear and the Hessian is singular for reasons unrelated to the point.
      pProj: 0.2 + 0.05 * (i % 7),
      pMarket,
      y: pMarket > 0.35 ? 1 : 0,
    });
  }
  const prior = [0, 1, 0];
  const fit = fitLogistic(separable, MODEL_SPECS.blend, { penalty: 200, prior });
  for (let j = 0; j < prior.length; j++) {
    assert.ok(
      Math.abs(fit.coef[j] - prior[j]) < 0.5,
      `coefficient ${j} ran to ${fit.coef[j]} away from prior ${prior[j]}`
    );
  }

  // And with no penalty it does run away — the point being that the penalty
  // is what is holding it, not the data.
  const unpenalized = fitLogistic(separable, MODEL_SPECS.blend, { penalty: 0, prior });
  const drift = Math.max(...unpenalized.coef.map((v, j) => Math.abs(v - prior[j])));
  assert.ok(drift > 2, `expected the unpenalized fit to diverge, max drift was ${drift}`);
});

test("logit features are winsorized so predictions cannot run away", () => {
  // A coefficient fitted on ordinary data, applied to an extreme input, must
  // stay inside the range the fit was estimated across.
  const fit = {
    model: "blend",
    global: [0, 1, -0.6],
    stats: {},
  };
  const p = predict(fit, { stat: "recYds", pProj: 1e-9, pMarket: 0.04 });
  // Without clipping, -0.6 * logit(1e-9) alone contributes +12 logits.
  const worstCase = sigmoid(0 + 1 * logit(0.04) - 0.6 * (-MAX_LOGIT - logit(0.04)));
  assert.ok(Math.abs(p - worstCase) < 1e-9);
  assert.ok(p < 0.5, `clipped prediction should stay modest, got ${p}`);
});

test("per-stat fits are pulled toward the global fit by sample size", () => {
  const big = synth({ n: 3000, seed: 3, a: 0, c: 1, b: 0, stat: "recYds" });
  const tiny = synth({ n: 15, seed: 4, a: 2, c: 1, b: 2, stat: "passTD" });
  const fit = fitPricingModel([...big, ...tiny], "blend", { shrinkageK: 200 });

  const dist = (coef) => Math.hypot(...coef.map((v, i) => v - fit.global[i]));
  assert.ok(
    dist(fit.stats.passTD.coef) < dist(fit.stats.recYds.coef) + 0.5,
    "the 15-row stat should sit close to the global fit"
  );
  assert.ok(fit.stats.passTD.ownWeight < 0.1);
  assert.ok(fit.stats.recYds.ownWeight > 0.9);
});

test("predict falls back to the global fit for an unseen stat", () => {
  const fit = fitPricingModel(synth({ n: 500 }), "blend");
  const p = predict(fit, { stat: "neverSeen", pProj: 0.4, pMarket: 0.45 });
  assert.ok(Number.isFinite(p) && p > 0 && p < 1);
});

test("isUsable gates on the inputs each model actually reads", () => {
  const noMarket = { stat: "x", pProj: 0.4, pMarket: null, y: 1 };
  assert.equal(isUsable(noMarket, MODEL_SPECS.projRecal), true);
  assert.equal(isUsable(noMarket, MODEL_SPECS.blend), false);
  assert.equal(isUsable(noMarket, MODEL_SPECS.marketRecal), false);
  assert.equal(isUsable({ ...noMarket, y: 2 }, MODEL_SPECS.projRecal), false);
  // Prediction needs the features but not the label: a live market has no
  // outcome yet, which is exactly the case capture-props runs in.
  assert.equal(hasFeatures({ pProj: 0.4, pMarket: 0.5 }, MODEL_SPECS.blend), true);
  assert.equal(isUsable({ pProj: 0.4, pMarket: 0.5 }, MODEL_SPECS.blend), false);
});

test("scoreProbabilities computes Brier and log loss", () => {
  const s = scoreProbabilities([
    { p: 0.5, y: 1 },
    { p: 0.5, y: 0 },
  ]);
  assert.equal(s.n, 2);
  assert.ok(Math.abs(s.brier - 0.25) < 1e-12);
  assert.ok(Math.abs(s.logLoss - Math.log(2)) < 1e-12);
  assert.equal(s.baseRate, 0.5);
});

test("a perfect forecast scores zero and a certain-wrong one blows up log loss", () => {
  const perfect = scoreProbabilities([
    { p: 0.999999, y: 1 },
    { p: 0.000001, y: 0 },
  ]);
  assert.ok(perfect.brier < 1e-10);
  const wrong = scoreProbabilities([{ p: 0.000001, y: 1 }]);
  assert.ok(wrong.brier < 1.0001 && wrong.brier > 0.999);
  assert.ok(wrong.logLoss > 13, "log loss must punish a confident miss far harder than Brier");
});

test("skill is positive when the score beats the reference", () => {
  assert.ok(skill(0.2, 0.25) > 0);
  assert.ok(skill(0.3, 0.25) < 0);
  assert.equal(skill(0.2, 0), null);
});

test("reliability bins predictions and flags real miscalibration", () => {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push({ p: 0.05, y: i < 100 ? 1 : 0 }); // says 5%, happens 25%
  for (let i = 0; i < 400; i++) rows.push({ p: 0.55, y: i < 220 ? 1 : 0 }); // says 55%, happens 55%
  const table = reliability(rows);
  const low = table.find((b) => b.lo === 0);
  const mid = table.find((b) => b.lo === 0.5);
  assert.equal(low.significant, true);
  assert.equal(mid.significant, false);
  assert.ok(Math.abs(low.observed - 0.25) < 1e-9);
});

test("pairedBrierDiff clusters correlated rows and widens the interval", () => {
  // 40 players, 50 near-identical alternate lines each. The naive standard
  // error sees 2000 observations; the clustered one sees 40.
  const rows = [];
  const rnd = mulberry32(99);
  for (let g = 0; g < 40; g++) {
    const y = rnd() < 0.5 ? 1 : 0;
    for (let i = 0; i < 50; i++) {
      rows.push({ p: 0.5, q: 0.45, y, cluster: `g${g}` });
    }
  }
  const r = pairedBrierDiff(rows);
  assert.equal(r.n, 2000);
  assert.equal(r.clusters, 40);
  assert.ok(r.se > r.naiveSe * 5, `clustered se ${r.se} should dwarf naive ${r.naiveSe}`);
  assert.ok(Math.abs(r.z) < Math.abs(r.naiveZ));
});

test("pairedBrierDiff sign says which forecast is better", () => {
  const rows = [
    { p: 0.9, q: 0.5, y: 1, cluster: "a" },
    { p: 0.9, q: 0.5, y: 1, cluster: "b" },
    { p: 0.9, q: 0.5, y: 1, cluster: "c" },
  ];
  assert.ok(pairedBrierDiff(rows).mean < 0, "negative means p beats q");
});

test("clusterKey groups one player's week", () => {
  assert.equal(clusterKey({ week: 3, playerId: "12561" }), "3|12561");
  assert.notEqual(clusterKey({ week: 3, playerId: "1" }), clusterKey({ week: 4, playerId: "1" }));
});

test("walkForward never trains on the week it scores", () => {
  const samples = [
    ...synth({ n: 300, seed: 1, week: 1 }),
    ...synth({ n: 300, seed: 2, week: 2 }),
    ...synth({ n: 300, seed: 3, week: 3 }),
  ];
  const wf = walkForward(samples, "blend");
  assert.equal(wf.folds.length, 2);
  assert.deepEqual(wf.folds.map((f) => f.testWeek), [2, 3]);
  assert.equal(wf.folds[0].trainN, 300);
  assert.equal(wf.folds[1].trainN, 600);
  assert.equal(wf.pooled.length, 600);
});

test("walkForward yields no folds with a single week", () => {
  const wf = walkForward(synth({ n: 100, week: 1 }), "blend");
  assert.deepEqual(wf.folds, []);
  assert.deepEqual(wf.pooled, []);
});

test("the blend cannot be beaten in sample by the model it nests", () => {
  // blend nests marketRecal (b = 0), so with the same prior strength its
  // in-sample log loss must not be worse. A violation means the optimizer is
  // not reaching the optimum.
  const samples = synth({ n: 3000, seed: 21, a: 0.2, c: 1.05, b: 0.5 });
  const scoreOf = (name) => {
    const fit = fitPricingModel(samples, name, { shrinkageK: 1e9 }); // global only
    return scoreProbabilities(samples.map((s) => ({ p: predict(fit, s), y: s.y }))).logLoss;
  };
  assert.ok(scoreOf("blend") <= scoreOf("marketRecal") + 1e-6);
});

// --- distance from a coin flip ---------------------------------------------

test("every market lands in exactly one band", () => {
  // The bands partition [0, 0.5] in distance, so a market can never be counted
  // twice or fall through a gap — either would make the per-band table
  // disagree with the pooled one.
  for (let i = 0; i <= 1000; i++) {
    const p = i / 1000;
    const hits = MONEY_BANDS.filter((b) => {
      const d = distanceFromEven(p);
      return d >= b.lo && d < b.hi;
    });
    assert.equal(hits.length, 1, `p=${p} landed in ${hits.length} bands`);
  }
});

test("band edges are stable under floating point", () => {
  // |0.60 - 0.5| is 0.09999999999999998 in IEEE doubles. Without rounding, a
  // market priced at exactly 60% would be a "coin flip" instead of "near
  // money" for no reason anyone could justify.
  assert.equal(bandOf(0.5).key, "coinflip");
  assert.equal(bandOf(0.6).key, "near");
  assert.equal(bandOf(0.4).key, "near");
  assert.equal(bandOf(0.75).key, "lopsided");
  assert.equal(bandOf(0.9).key, "extreme");
  assert.equal(bandOf(0.01).key, "extreme");
  assert.equal(bandOf(NaN), null);
  assert.equal(bandOf(undefined), null);
});

test("near money is symmetric and excludes its own boundary", () => {
  assert.equal(isNearMoney(0.5), true);
  assert.equal(isNearMoney(0.7), true);
  assert.equal(isNearMoney(0.3), true);
  assert.equal(isNearMoney(0.75), false); // exactly NEAR_MONEY_MAX away
  assert.equal(isNearMoney(0.25), false);
  assert.equal(isNearMoney(0.98), false);
  assert.equal(isNearMoney(null), false);
});

// Rows with one player each, so clusters === rows and nothing is dependent.
function bandRows(n, { pMarket, p, pProj = p, yAt }) {
  return Array.from({ length: n }, (_, i) => ({
    week: 1,
    playerId: `${pMarket}-${i}`,
    pMarket,
    p,
    pProj,
    y: yAt(i),
  }));
}

test("a pooled score hides what the per-band table shows", () => {
  // The point of banding. 2,000 lopsided markets the candidate prices exactly
  // like the market, plus 200 coin flips where it is badly overconfident. The
  // pooled difference is diluted ~10x; the near-money band carries it whole.
  const rows = [
    ...bandRows(2000, { pMarket: 0.01, p: 0.01, yAt: () => 0 }),
    ...bandRows(200, { pMarket: 0.5, p: 0.8, yAt: (i) => (i % 2 ? 1 : 0) }),
  ];
  const pooled = pairedBrierDiff(rows.map((r) => ({ p: r.p, q: r.pMarket, y: r.y, cluster: clusterKey(r) })));
  const bands = compareByBand(rows);
  const coin = bands.find((b) => b.key === "coinflip");
  const extreme = bands.find((b) => b.key === "extreme");

  assert.ok(Math.abs(extreme.blendVsMarket.mean) < 1e-12, "no difference where the candidate matches the market");
  assert.ok(coin.blendVsMarket.mean > 0.05, `coin-flip band should carry the damage, got ${coin.blendVsMarket.mean}`);
  assert.ok(
    coin.blendVsMarket.mean > pooled.mean * 8,
    `pooled ${pooled.mean} should be a fraction of the band's ${coin.blendVsMarket.mean}`
  );
});

test("compareByBand accounts for every row and reports thin bands instead of dropping them", () => {
  const rows = [
    ...bandRows(40, { pMarket: 0.5, p: 0.5, yAt: (i) => i % 2 }),
    ...bandRows(5, { pMarket: 0.99, p: 0.99, yAt: () => 1 }),
  ];
  const bands = compareByBand(rows);
  assert.equal(bands.length, MONEY_BANDS.length);
  assert.equal(bands.reduce((s, b) => s + b.n, 0), rows.length);
  assert.ok(Math.abs(bands.reduce((s, b) => s + b.share, 0) - 1) < 1e-12);
  const extreme = bands.find((b) => b.key === "extreme");
  assert.equal(extreme.n, 5);
  assert.equal(extreme.thin, true, "5 clusters is too few to read");
  // A band nothing fell into still appears, with no score, rather than vanishing.
  const lopsided = bands.find((b) => b.key === "lopsided");
  assert.equal(lopsided.n, 0);
  assert.equal(lopsided.marketBrier, null);
});

test("bands are defined on the market's price, so the projection cannot select its own sample", () => {
  // Two rows with the same market price but wildly different projections must
  // land in the same band. Banding on pProj would select the rows where we
  // are most confident and flatter the projection by construction.
  const a = { week: 1, playerId: "a", pMarket: 0.5, p: 0.5, pProj: 0.01, y: 0 };
  const b = { week: 1, playerId: "b", pMarket: 0.5, p: 0.5, pProj: 0.99, y: 1 };
  const coin = compareByBand([a, b]).find((x) => x.key === "coinflip");
  assert.equal(coin.n, 2);
});
