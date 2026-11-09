import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lnGamma,
  gammaP,
  gammaPpf,
  normCdf,
  normPpf,
  fitGammaExact,
  fitGammaToQuantiles,
  gammaFitCdf,
  gammaLawFit,
  tweedieParams,
  tweedieCdf,
  probOver,
  massAt,
  fitLaw,
  meanFromQuantile,
  rng,
  normalLawCdf,
} from "./dist-lab.mjs";

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

test("lnGamma matches known values", () => {
  close(lnGamma(1), 0, 1e-12);
  close(lnGamma(5), Math.log(24), 1e-11);
  close(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-11);
});

test("gammaP: shape 1 is the exponential, shape 2 has a closed form", () => {
  for (const x of [0.1, 1, 3, 10]) {
    close(gammaP(1, x), 1 - Math.exp(-x), 1e-12, "k=1");
    close(gammaP(2, x), 1 - Math.exp(-x) * (1 + x), 1e-12, "k=2");
  }
  assert.equal(gammaP(3, 0), 0);
  assert.equal(gammaP(3, -1), 0);
  close(gammaP(50, 50), 0.5188, 5e-4, "k=50 near the mean");
});

test("gammaPpf inverts gammaP across shapes, including tiny and huge", () => {
  for (const k of [0.2, 0.7, 1, 4, 30, 400, 2500]) {
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      const x = gammaPpf(p, k);
      close(gammaP(k, x), p, 1e-9, `k=${k} p=${p}`);
    }
  }
});

test("normal cdf/ppf round trip", () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.959964), 0.975, 2e-7);
  for (const p of [0.001, 0.1, 0.5, 0.9, 0.999]) close(normCdf(normPpf(p)), p, 2e-7);
});

test("fitGammaExact reproduces F, M and C", () => {
  for (const pts of [
    { F: 40, M: 60, C: 90 },
    { F: 3.1, M: 4.4, C: 6.0 },
    { F: 170, M: 230, C: 320 },
  ]) {
    const fit = fitGammaExact(pts);
    const cdf = gammaFitCdf(fit);
    close(cdf(pts.F), 0.25, 1e-6, "F");
    close(cdf(pts.M), 0.5, 1e-6, "M");
    close(cdf(pts.C), 0.75, 1e-6, "C");
  }
});

test("fitGammaExact: a more right-skewed band gives a smaller shape", () => {
  const sym = fitGammaExact({ F: 40, M: 60, C: 81 });
  const skew = fitGammaExact({ F: 40, M: 60, C: 120 });
  assert.ok(skew.k < sym.k);
});

test("fitGammaExact falls back to the near-symmetric limit for a left-skewed band", () => {
  const fit = fitGammaExact({ F: 30, M: 60, C: 70 });
  assert.equal(fit.clamped, true);
  const cdf = gammaFitCdf(fit);
  close(cdf(60), 0.5, 1e-6);
});

test("fitGammaExact refuses a degenerate band", () => {
  assert.equal(fitGammaExact({ F: 0, M: 5, C: 9 }), null);
  assert.equal(fitGammaExact({ F: 5, M: 5, C: 9 }), null);
});

test("fitGammaToQuantiles recovers a known gamma from its own quantiles", () => {
  const k = 3.2;
  const theta = 18;
  const points = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => ({ x: theta * gammaPpf(p, k), p }));
  const fit = fitGammaToQuantiles(points);
  close(fit.k, k, 0.05 * k);
  close(fit.theta, theta, 0.05 * theta);
});

test("gammaLawFit has the requested mean and variance", () => {
  const f = gammaLawFit(50, 3, 1.5);
  close(f.k * f.theta, 50, 1e-9);
  close(f.k * f.theta * f.theta, 3 * Math.pow(50, 1.5), 1e-6);
});

test("tweedie: moments, atom at zero, monotone CDF", () => {
  const mu = 4;
  const phi = 2;
  const p = 1.5;
  const { lambda } = tweedieParams(mu, phi, p);
  const cdf = tweedieCdf(mu, phi, p);
  close(cdf(0), Math.exp(-lambda), 1e-12, "atom");
  assert.equal(cdf(-1), 0);
  let prev = 0;
  for (let x = 0; x <= 80; x += 0.5) {
    const c = cdf(x);
    assert.ok(c >= prev - 1e-12, `monotone at ${x}`);
    prev = c;
  }
  close(cdf(1e6), 1, 1e-9);
  // mean by integrating the survival function
  let m = 0;
  const dx = 0.05;
  for (let x = 0; x < 120; x += dx) m += (1 - cdf(x + dx / 2)) * dx;
  close(m, mu, 0.03, "mean");
});

test("tweedie approaches a gamma-like shape as p -> 2 (no atom)", () => {
  const cdf = tweedieCdf(40, 0.6, 1.95);
  assert.ok(cdf(0) < 1e-3);
});

test("probOver: half lines are 1-cdf, whole lines condition out the push", () => {
  const cdf = (x) => (x < 0 ? 0 : 1 - Math.exp(-x / 10)); // continuous exponential
  close(probOver(cdf, 12.5), Math.exp(-1.25), 1e-12);
  const pushMass = cdf(10.5) - cdf(9.5);
  close(probOver(cdf, 10), (1 - cdf(10.5)) / (1 - pushMass), 1e-12);
  const allAtFive = (x) => (x <= 4.5 ? 0 : 1); // all the mass is the push
  assert.equal(probOver(allAtFive, 5), 0.5);
});

test("massAt is the mass in [a-1/2, a+1/2) and never zero", () => {
  const cdf = (x) => (x < 0 ? 0 : 1 - Math.exp(-x / 10));
  close(massAt(cdf, 7), cdf(7.5) - cdf(6.5), 1e-15);
  assert.ok(massAt(() => 0, 3) > 0);
});

test("meanFromQuantile: the median of the resulting forecast sits at the line", () => {
  const mu = meanFromQuantile(60, 0.5, 4, 1.4);
  const f = gammaLawFit(mu, 4, 1.4);
  const cdf = gammaFitCdf(f);
  close(cdf(60), 0.5, 0.01);
  const mu2 = meanFromQuantile(60, 0.8, 4, 1.4);
  assert.ok(mu2 < mu, "a line at the 80th percentile implies a lower mean");
});

test("fitLaw recovers the exponent of a synthetic gamma law", () => {
  const rand = rng(11);
  const truePhi = 5;
  const trueP = 1.5;
  const pairs = [];
  for (let i = 0; i < 700; i++) {
    const mu = 20 + 80 * rand();
    const f = gammaLawFit(mu, truePhi, trueP);
    // sample gamma by inverse-cdf on a uniform
    const x = f.theta * gammaPpf(Math.min(0.9999, Math.max(0.0001, rand())), f.k);
    pairs.push({ mu, a: Math.round(x) });
  }
  const fit = fitLaw(pairs, "gamma");
  assert.ok(fit);
  close(fit.p, trueP, 0.5, "p");
  // implied variance at a typical mean is what matters, and it should be close
  const at = 50;
  const vTrue = truePhi * Math.pow(at, trueP);
  const vFit = fit.phi * Math.pow(at, fit.p);
  assert.ok(vFit / vTrue > 0.7 && vFit / vTrue < 1.4, `variance ratio ${vFit / vTrue}`);
});

test("fitLaw refuses a tiny sample", () => {
  assert.equal(fitLaw([{ mu: 5, a: 4 }], "gamma"), null);
});

test("normalLawCdf has the law's variance and is centred on the mean", () => {
  const cdf = normalLawCdf(50, 4, 1.5);
  close(cdf(50), 0.5, 1e-7);
  const sd = Math.sqrt(4 * Math.pow(50, 1.5));
  close(cdf(50 + sd), 0.8413, 5e-4);
});

test("fitLaw works for the normal family too", () => {
  const rand = rng(5);
  const pairs = [];
  for (let i = 0; i < 400; i++) {
    const mu = 150 + 120 * rand();
    // two uniforms -> a normal draw (Box-Muller) with variance 400 * mu^0.5
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    pairs.push({ mu, a: Math.round(mu + z * Math.sqrt(400 * Math.pow(mu, 0.5))) });
  }
  const fit = fitLaw(pairs, "normal");
  assert.ok(fit);
  const at = 200;
  const ratio = (fit.phi * Math.pow(at, fit.p)) / (400 * Math.pow(at, 0.5));
  assert.ok(ratio > 0.7 && ratio < 1.4, `variance ratio ${ratio}`);
});
