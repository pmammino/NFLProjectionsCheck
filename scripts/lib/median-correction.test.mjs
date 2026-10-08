import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quantile,
  fitStat,
  assess,
  fitCorrection,
  adjustedPoints,
  multiplierFor,
  evaluateWalkForward,
  loadTrainingPairs,
  fitFromData,
  formatFits,
  CORRECTABLE_STATS,
  MIN_TRAIN_N,
  SOLID_Z,
} from "./median-correction.mjs";
import { probOverContinuous } from "./probability.mjs";
import { MIN_PROJECTION } from "./calibration.mjs";

// Deterministic PRNG: a test whose data changes between runs cannot fail usefully.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box-Muller, so the outcome distribution has a known median and skew.
function gauss(rnd) {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

// Player-weeks whose outcome is lognormal with median `medianRatio` x M: a
// right-skewed stat whose projected "Median" is really higher than its median.
// With medianRatio = 1 and sigma small the middle value IS the median.
function skewedPairs(n, { medianRatio, sigma = 0.5, seed = 1, week = 1 } = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const M = 20 + rnd() * 60;
    const actual = M * medianRatio * Math.exp(sigma * gauss(rnd));
    out.push({ week, playerId: `p${seed}-${i}`, F: M * 0.7, M, C: M * 1.3, actual });
  }
  return out;
}

// --- quantile -------------------------------------------------------------------

test("quantile interpolates and does not mutate its input", () => {
  const xs = [4, 1, 3, 2];
  assert.equal(quantile(xs, 0.5), 2.5);
  assert.equal(quantile(xs, 0), 1);
  assert.equal(quantile(xs, 1), 4);
  assert.deepEqual(xs, [4, 1, 3, 2]);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

// --- the fit --------------------------------------------------------------------

test("fitStat recovers a known median multiplier from skewed outcomes", () => {
  // Median of actual/M is 0.8 by construction, and P(actual <= M) is
  // Phi(-ln(0.8)/0.5) = Phi(0.446) ~ 0.672.
  const fit = fitStat(skewedPairs(6000, { medianRatio: 0.8 }));
  assert.ok(Math.abs(fit.kM - 0.8) < 0.03, `kM = ${fit.kM}`);
  assert.ok(Math.abs(fit.pBelowM - 0.672) < 0.02, `P(actual<=M) = ${fit.pBelowM}`);
  assert.ok(fit.z > SOLID_Z, `z = ${fit.z}`);
  assert.equal(fit.n, 6000);
});

test("fitStat reports an unbiased stat as unbiased", () => {
  const fit = fitStat(skewedPairs(6000, { medianRatio: 1, sigma: 0.2, seed: 2 }));
  assert.ok(Math.abs(fit.kM - 1) < 0.02, `kM = ${fit.kM}`);
  assert.ok(Math.abs(fit.z) < 2.5, `z = ${fit.z}`);
});

test("fitStat skips rows it cannot take a ratio against", () => {
  // A ratio against a zero point is undefined. Those are the rows the support
  // floor already refuses to price, so they are not this module's problem.
  const pairs = [
    ...skewedPairs(50, { medianRatio: 1 }),
    { F: 0, M: 10, C: 20, actual: 5 },
    { F: 5, M: 0, C: 20, actual: 5 },
    { F: 5, M: 10, C: 20, actual: NaN },
    { F: 5, M: 10, C: 20, actual: null },
  ];
  assert.equal(fitStat(pairs).n, 50);
  assert.equal(fitStat([]), null);
  assert.equal(fitStat(undefined), null);
});

// --- the decision ------------------------------------------------------------------

const solid = (over = {}) => ({ n: 500, pBelowM: 0.62, z: 5.4, kF: 0.7, kM: 0.8, kC: 0.95, ...over });

test("assess applies a solid, plausible fit on an eligible stat", () => {
  assert.deepEqual(assess("rushYds", solid()), { applied: true, reason: "applied" });
  assert.deepEqual(assess("recYds", solid()), { applied: true, reason: "applied" });
});

test("assess refuses a stat with no mechanism, however strong the fit looks", () => {
  // The reason the allowlist exists. On the week-3 refit passAtt cleared the
  // z bar (2.5) and applying it moved near-the-money Brier from 0.2332 to
  // 0.2472 — worse, because there was no bias, only a noisy week.
  for (const stat of ["passAtt", "passYds", "completions", "receptions", "rushAtt"]) {
    assert.equal(assess(stat, solid({ z: 6 })).reason, "not-correctable", stat);
    assert.equal(assess(stat, solid({ z: 6 })).applied, false);
  }
  assert.deepEqual([...CORRECTABLE_STATS].sort(), ["recYds", "rushYds"]);
});

test("assess refuses a thin fit", () => {
  assert.equal(assess("rushYds", solid({ n: MIN_TRAIN_N - 1 })).reason, "too-few-rows");
  assert.equal(assess("rushYds", solid({ n: MIN_TRAIN_N })).applied, true);
  assert.equal(assess("rushYds", null).reason, "too-few-rows");
});

test("assess refuses a correction that is not significant", () => {
  assert.equal(assess("rushYds", solid({ z: SOLID_Z - 0.01 })).reason, "not-solid");
  assert.equal(assess("rushYds", solid({ z: -(SOLID_Z - 0.01) })).reason, "not-solid");
  // Symmetric: a median that is too LOW is just as solid a finding.
  assert.equal(assess("rushYds", solid({ z: -4, kM: 1.2 })).applied, true);
});

test("assess refuses an implausible multiplier rather than clamping it", () => {
  // A clamped number looks like a result. A median multiplier of 0.3 is a unit
  // mismatch or a corrupt snapshot, and the honest response is to do nothing
  // and say why.
  assert.equal(assess("rushYds", solid({ kM: 0.3 })).reason, "implausible");
  assert.equal(assess("rushYds", solid({ kM: 1.7 })).reason, "implausible");
  assert.equal(assess("rushYds", solid({ kC: 2.5 })).reason, "implausible");
  assert.equal(assess("rushYds", solid({ kF: 0.1 })).reason, "implausible");
  assert.equal(assess("rushYds", solid({ kF: NaN })).reason, "implausible");
});

test("a noisy floor multiplier does not veto a solid median correction", () => {
  // Regression test. On the 2026 data recYds' floor multiplier was 0.48 when
  // fitted on week 1 alone, under a shared [0.5, 1.5] bound, and that refused
  // the whole correction although the median multiplier was a stable ~0.85
  // with z up to 3.7. The tails get a looser bound than the median.
  assert.deepEqual(assess("recYds", solid({ kF: 0.48, kM: 0.84, z: 3.5 })), { applied: true, reason: "applied" });
  assert.deepEqual(assess("recYds", solid({ kF: 0.55, kM: 0.86, z: 3.7 })), { applied: true, reason: "applied" });
  // ...while the median stays tightly guarded.
  assert.equal(assess("recYds", solid({ kF: 0.48, kM: 0.45 })).reason, "implausible");
});

test("fitCorrection reports every stat it was given, including empty ones", () => {
  const out = fitCorrection({ rushYds: skewedPairs(400, { medianRatio: 0.8 }), recYds: [], passYds: skewedPairs(200, { medianRatio: 1 }) });
  assert.equal(out.rushYds.applied, true);
  assert.equal(out.recYds.applied, false);
  assert.equal(out.recYds.reason, "too-few-rows");
  assert.equal(out.recYds.n, 0);
  assert.equal(out.passYds.reason, "not-correctable");
  // A Map works the same.
  const m = fitCorrection(new Map([["rushYds", skewedPairs(400, { medianRatio: 0.8 })]]));
  assert.equal(m.rushYds.applied, true);
});

// --- applying it -------------------------------------------------------------------

test("adjustedPoints is the identity when nothing applies", () => {
  const pts = { F: 10, M: 20, C: 30 };
  assert.deepEqual(adjustedPoints(pts, undefined, "rushYds"), pts);
  assert.deepEqual(adjustedPoints(pts, {}, "rushYds"), pts);
  assert.deepEqual(adjustedPoints(pts, { rushYds: { applied: false, kF: 0.5, kM: 0.5, kC: 0.5 } }, "rushYds"), pts);
  // A correction for another stat does not leak.
  assert.deepEqual(adjustedPoints(pts, { recYds: { applied: true, kF: 0.5, kM: 0.5, kC: 0.5 } }, "rushYds"), pts);
});

test("adjustedPoints rescales each point by its own multiplier", () => {
  const adj = adjustedPoints({ F: 10, M: 20, C: 30 }, { rushYds: { applied: true, kF: 0.6, kM: 0.8, kC: 0.9 } }, "rushYds");
  assert.ok(Math.abs(adj.F - 6) < 1e-12 && Math.abs(adj.M - 16) < 1e-12 && Math.abs(adj.C - 27) < 1e-12);
});

test("adjustedPoints keeps the points ordered when independent fits disagree", () => {
  // The three multipliers are fitted separately and can cross on a thin
  // sample. A distribution whose floor sits above its median is not one.
  const adj = adjustedPoints({ F: 10, M: 20, C: 30 }, { rushYds: { applied: true, kF: 1.5, kM: 0.5, kC: 0.5 } }, "rushYds");
  assert.ok(adj.F <= adj.M && adj.M <= adj.C, JSON.stringify(adj));
  assert.ok(adj.F > 0);
});

test("a correction lowers P(over) at the old median, which is the point", () => {
  const line = 40;
  const raw = probOverContinuous(line, 28, 40, 52);
  const adj = adjustedPoints({ F: 28, M: 40, C: 52 }, { rushYds: { applied: true, kF: 0.7, kM: 0.8, kC: 0.95 } }, "rushYds");
  const corrected = probOverContinuous(line, adj.F, adj.M, adj.C);
  assert.ok(Math.abs(raw - 0.5) < 1e-9, "uncorrected, a line at the median is a coin flip");
  assert.ok(corrected < 0.4, `corrected P(over) = ${corrected}`);
});

test("multiplierFor reports what is actually in force", () => {
  const fits = { rushYds: { applied: true, kM: 0.81 }, recYds: { applied: false, kM: 0.9 } };
  assert.equal(multiplierFor(fits, "rushYds"), 0.81);
  assert.equal(multiplierFor(fits, "recYds"), null);
  assert.equal(multiplierFor(fits, "passYds"), null);
  assert.equal(multiplierFor(undefined, "rushYds"), null);
});

// --- walk-forward ------------------------------------------------------------------

// One sample per pair, priced at a line equal to M, resolved by the actual.
function buildWorld({ stat, perWeek, weeks, medianRatioByWeek, seed = 10 }) {
  const pairsByWeek = new Map();
  const samples = [];
  const fmc = new Map();
  for (const week of weeks) {
    const pairs = skewedPairs(perWeek, { medianRatio: medianRatioByWeek[week], seed: seed + week, week });
    pairsByWeek.set(week, new Map([[stat, pairs]]));
    for (const p of pairs) {
      fmc.set(`${week}|${p.playerId}|${stat}`, { F: p.F, M: p.M, C: p.C });
      samples.push({
        week,
        playerId: p.playerId,
        stat,
        line: p.M,
        pProj: probOverContinuous(p.M, p.F, p.M, p.C),
        y: p.actual > p.M ? 1 : 0,
      });
    }
  }
  return { pairsByWeek, samples, fmcOf: (s) => fmc.get(`${s.week}|${s.playerId}|${s.stat}`) ?? null };
}

test("walk-forward never fits on the week it prices", () => {
  // Weeks 1-2 have a median ratio of 0.8; week 3 is wildly different (0.5).
  // If week 3 leaked into its own fit the multiplier would sit well below 0.8.
  const w = buildWorld({ stat: "rushYds", perWeek: 250, weeks: [1, 2, 3], medianRatioByWeek: { 1: 0.8, 2: 0.8, 3: 0.5 } });
  const out = evaluateWalkForward(w.samples, { ...w, priceFn: probOverContinuous });

  const wk3 = out.filter((s) => s.week === 3 && s.applied);
  assert.ok(wk3.length > 0);
  assert.ok(Math.abs(wk3[0].multiplier - 0.8) < 0.05, `week 3 used ${wk3[0].multiplier}, not the 0.8 of weeks 1-2`);

  // Week 1 has nothing before it to learn from, so it is never corrected.
  assert.ok(out.filter((s) => s.week === 1).every((s) => !s.applied && s.pCorrected === s.pProj));
});

test("walk-forward improves out-of-sample Brier on a biased stat", () => {
  const w = buildWorld({ stat: "recYds", perWeek: 400, weeks: [1, 2, 3, 4], medianRatioByWeek: { 1: 0.8, 2: 0.8, 3: 0.8, 4: 0.8 } });
  const out = evaluateWalkForward(w.samples, { ...w, priceFn: probOverContinuous }).filter((s) => s.week >= 2);
  const brier = (f) => out.reduce((a, s) => a + (f(s) - s.y) ** 2, 0) / out.length;
  const raw = brier((s) => s.pProj);
  const corrected = brier((s) => s.pCorrected);
  assert.ok(corrected < raw - 0.02, `corrected ${corrected.toFixed(4)} should clearly beat raw ${raw.toFixed(4)}`);
  // And it removes the lean it was built to remove.
  const lean = (f) => out.reduce((a, s) => a + f(s), 0) / out.length - out.reduce((a, s) => a + s.y, 0) / out.length;
  assert.ok(Math.abs(lean((s) => s.pCorrected)) < Math.abs(lean((s) => s.pProj)) / 3);
});

test("walk-forward leaves an unbiased stat exactly as it was", () => {
  const w = buildWorld({ stat: "passYds", perWeek: 300, weeks: [1, 2, 3], medianRatioByWeek: { 1: 1, 2: 1, 3: 1 } });
  const out = evaluateWalkForward(w.samples, { ...w, priceFn: probOverContinuous });
  assert.ok(out.every((s) => !s.applied && s.pCorrected === s.pProj));
});

test("walk-forward does not apply a correction to noise on an eligible stat", () => {
  // rushYds is allowed, but unbiased outcomes produce a z that stays under the
  // bar, so the significance gate must hold even on an eligible stat.
  const w = buildWorld({ stat: "rushYds", perWeek: 300, weeks: [1, 2, 3], medianRatioByWeek: { 1: 1, 2: 1, 3: 1 } });
  const out = evaluateWalkForward(w.samples, { ...w, priceFn: probOverContinuous });
  assert.ok(out.every((s) => !s.applied), "no solid bias, so no correction");
});

test("walk-forward flags a sample whose stored price came from a different projection", () => {
  // The main slot is priced from whatever snapshot existed on capture day,
  // which can differ from the frozen one. Re-pricing such a row from today's
  // F/M/C would compare two different projections, so it is flagged.
  const w = buildWorld({ stat: "rushYds", perWeek: 120, weeks: [1, 2], medianRatioByWeek: { 1: 0.8, 2: 0.8 } });
  const tampered = w.samples.map((s, i) => (i === 130 ? { ...s, pProj: s.pProj + 0.2 } : s));
  const out = evaluateWalkForward(tampered, { ...w, priceFn: probOverContinuous });
  assert.equal(out.filter((s) => !s.consistent).length, 1);
  assert.equal(out[130].consistent, false);
  // A sample with no snapshot at all is also inconsistent, not silently fine.
  const missing = evaluateWalkForward([{ week: 1, playerId: "nobody", stat: "rushYds", line: 10, pProj: 0.5, y: 1 }], { ...w, priceFn: probOverContinuous });
  assert.equal(missing[0].consistent, false);
  assert.equal(missing[0].pCorrected, 0.5);
});

// --- I/O: loading and the no-look-ahead guarantee ---------------------------------

const PROJ_HEAD = "Season,GameWeek,Split,Team,PlayerID,PassAttempts,RushAttempts,Targets,PassCompletions,PassYards,PassTDs,PassInts,RushYards,RushTDs,RecCompletions,RecYards,RecTDs";
const ACT_HEAD = "PlayerID,ID,position,Season,Week,NFLTeamID,Rushes,RushYards,PassComp,PassAtt,PassYards,Receptions,ReceptYds,PassTD,RecptTD,RushTD,Targets";

function projRows(week, pid, { rushF, rushM, rushC }) {
  const row = (split, rush) => `2026,${week},${split},KC,${pid},0,10,0,0,0,0,0,${rush},0,0,0,0`;
  return [row("F", rushF), row("M", rushM), row("C", rushC)];
}
const actRow = (week, pid, rushYards) => `${pid},${pid},RB,2026,${week},KC,10,${rushYards},0,0,0,0,0,0,0,0,0`;

function fixture(weeks) {
  const dir = mkdtempSync(join(tmpdir(), "median-correction-"));
  mkdirSync(join(dir, "projections", "2026"), { recursive: true });
  mkdirSync(join(dir, "actuals", "2026"), { recursive: true });
  for (const w of weeks) {
    const proj = [PROJ_HEAD];
    const act = [ACT_HEAD];
    for (const p of w.players) {
      proj.push(...projRows(w.week, p.id, { rushF: p.F, rushM: p.M, rushC: p.C }));
      if (p.actual !== undefined) act.push(actRow(w.week, p.id, p.actual));
    }
    const name = `week-${String(w.week).padStart(2, "0")}.csv`;
    writeFileSync(join(dir, "projections", "2026", name), proj.join("\n") + "\n");
    if (w.actuals !== false) writeFileSync(join(dir, "actuals", "2026", name), act.join("\n") + "\n");
  }
  return dir;
}

test("loadTrainingPairs uses only weeks strictly before the one asked for", () => {
  const dir = fixture([
    { week: 1, players: [{ id: 1, F: 20, M: 40, C: 60, actual: 30 }] },
    { week: 2, players: [{ id: 1, F: 20, M: 40, C: 60, actual: 35 }] },
    { week: 3, players: [{ id: 1, F: 20, M: 40, C: 60, actual: 10 }] },
  ]);
  try {
    const { pairsByWeek, weeksUsed } = loadTrainingPairs({ dataDir: dir, season: 2026, beforeWeek: 3, stats: ["rushYds"] });
    assert.deepEqual(weeksUsed, [1, 2]);
    assert.deepEqual([...pairsByWeek.keys()], [1, 2]);
    const all = [...pairsByWeek.values()].flatMap((m) => m.get("rushYds"));
    assert.deepEqual(all.map((p) => p.actual).sort((a, b) => a - b), [30, 35]);
    // Asking for week 1 means there is nothing to learn from.
    assert.deepEqual(loadTrainingPairs({ dataDir: dir, season: 2026, beforeWeek: 1, stats: ["rushYds"] }).weeksUsed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTrainingPairs treats a player absent from the actuals as unknown, not zero", () => {
  // The feed carries no all-zero rows, so absence cannot be told apart from a
  // player who did not play. Counting it as 0 would put an under win into the
  // fit for every inactive player.
  const dir = fixture([{ week: 1, players: [{ id: 1, F: 20, M: 40, C: 60, actual: 30 }, { id: 2, F: 20, M: 40, C: 60 }] }]);
  try {
    const { pairsByWeek } = loadTrainingPairs({ dataDir: dir, season: 2026, stats: ["rushYds"] });
    assert.deepEqual(pairsByWeek.get(1).get("rushYds").map((p) => p.playerId), ["1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTrainingPairs applies the support floor and skips weeks without actuals", () => {
  const floor = MIN_PROJECTION.rushYds;
  const dir = fixture([
    { week: 1, players: [{ id: 1, F: 1, M: floor - 0.5, C: 9, actual: 0 }, { id: 2, F: 20, M: 40, C: 60, actual: 30 }] },
    { week: 2, actuals: false, players: [{ id: 3, F: 20, M: 40, C: 60 }] },
  ]);
  try {
    const { pairsByWeek, weeksUsed } = loadTrainingPairs({ dataDir: dir, season: 2026, stats: ["rushYds"] });
    assert.deepEqual(weeksUsed, [1], "week 2 has a snapshot but no results yet");
    assert.deepEqual(pairsByWeek.get(1).get("rushYds").map((p) => p.playerId), ["2"], "below the support floor is excluded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fitFromData end to end: a biased stat is corrected and the week asked about is excluded", () => {
  const rnd = mulberry32(5);
  const mkWeek = (week, ratio) => ({
    week,
    players: Array.from({ length: 150 }, (_, i) => {
      const M = 20 + rnd() * 60;
      return { id: week * 1000 + i, F: M * 0.7, M, C: M * 1.3, actual: Math.round(M * ratio * Math.exp(0.5 * gauss(rnd)) * 10) / 10 };
    }),
  });
  const dir = fixture([mkWeek(1, 0.8), mkWeek(2, 0.8), mkWeek(3, 0.8)]);
  try {
    const { fits, weeksUsed } = fitFromData({ dataDir: dir, season: 2026, beforeWeek: 3 });
    assert.deepEqual(weeksUsed, [1, 2]);
    assert.equal(fits.rushYds.n, 300);
    assert.equal(fits.rushYds.applied, true);
    assert.ok(Math.abs(fits.rushYds.kM - 0.8) < 0.08, `kM = ${fits.rushYds.kM}`);
    assert.equal(multiplierFor(fits, "rushYds"), fits.rushYds.kM);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatFits says what happened to every stat and why", () => {
  const fits = fitCorrection({
    rushYds: skewedPairs(400, { medianRatio: 0.8 }),
    recYds: [],
    passYds: skewedPairs(200, { medianRatio: 1 }),
  });
  const lines = formatFits(fits);
  assert.equal(lines.length, 3);
  assert.match(lines.find((l) => l.startsWith("rushYds")), /APPLIED/);
  assert.match(lines.find((l) => l.startsWith("recYds")), /too few rows/);
  assert.match(lines.find((l) => l.startsWith("passYds")), /not eligible/);
  assert.deepEqual(formatFits(undefined), []);
});
