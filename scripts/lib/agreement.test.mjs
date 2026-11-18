import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  clusterMean,
  olsCluster,
  closeMove,
  shareByCell,
  gatedWalkForward,
  oneBetPerMarket,
  betProfit,
  summarizeBets,
  decimal,
  MIN_SHIFT,
} from "./agreement.mjs";
import { sigmoid } from "./consensus.mjs";

// A small deterministic generator so the synthetic worlds are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// ---------------------------------------------------------------------------
test("classify (books): the projection agrees when it sits on the same side of the median as the weighted books", () => {
  const base = { lUnweighted: 0, lBooks: 0.2 };
  assert.equal(classify({ ...base, lProj: 0.6 }, "books"), "agree");
  assert.equal(classify({ ...base, lProj: -0.6 }, "books"), "disagree");
  assert.equal(classify({ lUnweighted: 0, lBooks: 0.01, lProj: 0.6 }, "books"), "flat"); // not leaning
  assert.equal(classify({ lUnweighted: 0, lBooks: -0.2, lProj: -0.4 }, "books"), "agree");
});

test("classify (sharp): measured against the pool, null without a sharp quote", () => {
  assert.equal(classify({ lBooks: 0, lSharp: 0.1, lProj: 0.5 }, "sharp"), "agree");
  assert.equal(classify({ lBooks: 0, lSharp: 0.1, lProj: -0.5 }, "sharp"), "disagree");
  assert.equal(classify({ lBooks: 0, lSharp: 0.02, lProj: 0.5 }, "sharp"), "flat");
  assert.equal(classify({ lBooks: 0, lSharp: null, lProj: 0.5 }, "sharp"), null);
  assert.throws(() => classify({}, "nonsense"));
});

test("classify: the lean threshold is exclusive and a zero-gap projection does not back it", () => {
  assert.equal(classify({ lBooks: MIN_SHIFT, lUnweighted: 0, lProj: 1 }, "books"), "flat");
  assert.equal(classify({ lBooks: 0.2, lUnweighted: 0, lProj: 0 }, "books"), "disagree");
});

// ---------------------------------------------------------------------------
test("clusterMean: rows on one player-week count once, so the interval is wider than the naive one", () => {
  // Ten clusters of five perfectly correlated rows. Naively 50 observations; in
  // fact 10. The cluster-robust standard error must be sqrt(5) larger.
  const items = [];
  const r = rng(3);
  for (let c = 0; c < 10; c++) {
    const v = gauss(r);
    for (let i = 0; i < 5; i++) items.push({ v, c });
  }
  const clustered = clusterMean(items, (x) => x.v, (x) => x.c);
  const naive = clusterMean(items, (x) => x.v, (x) => `${x.c}-${Math.random()}`);
  assert.equal(clustered.n, 50);
  assert.equal(clustered.clusters, 10);
  assert.ok(clustered.se > naive.se * 2, `clustered ${clustered.se} vs naive ${naive.se}`);
});

test("clusterMean: drops null/NaN values rather than counting them as zero, and reports no SE for one cluster", () => {
  const m = clusterMean([{ v: 1, c: "a" }, { v: null, c: "b" }, { v: NaN, c: "c" }, { v: 3, c: "d" }], (x) => x.v, (x) => x.c);
  assert.equal(m.n, 2);
  assert.equal(m.mean, 2);
  const one = clusterMean([{ v: 1, c: "a" }, { v: 2, c: "a" }], (x) => x.v, (x) => x.c);
  assert.equal(one.se, null);
  assert.equal(clusterMean([], (x) => x, () => 1).n, 0);
});

// ---------------------------------------------------------------------------
test("olsCluster recovers known coefficients", () => {
  const r = rng(11);
  const X = [];
  const y = [];
  const cl = [];
  for (let i = 0; i < 4000; i++) {
    const a = gauss(r);
    const b = gauss(r);
    X.push([1, a, b]);
    y.push(0.5 + 2 * a - 1 * b + 0.1 * gauss(r));
    cl.push(i % 200);
  }
  const fit = olsCluster(X, y, cl);
  assert.ok(Math.abs(fit.beta[0] - 0.5) < 0.02);
  assert.ok(Math.abs(fit.beta[1] - 2) < 0.02);
  assert.ok(Math.abs(fit.beta[2] + 1) < 0.02);
  assert.ok(fit.se.every((s) => s > 0 && s < 0.02));
});

test("olsCluster returns null on a singular design", () => {
  const X = [[1, 1], [1, 1], [1, 1]];
  assert.equal(olsCluster(X, [1, 2, 3], [1, 2, 3]), null);
});

test("closeMove: a late market that follows the projection gives a positive projection coefficient", () => {
  const r = rng(5);
  const rows = [];
  for (let i = 0; i < 3000; i++) {
    const lUnweighted = 0.3 * gauss(r);
    const lBooks = lUnweighted + 0.1 * gauss(r);
    const lProj = lBooks + 0.6 * gauss(r);
    rows.push({ lBooks, lUnweighted, lProj, lClose: lBooks + 0.25 * (lProj - lBooks) + 0.05 * gauss(r), cluster: `c${i % 300}` });
  }
  const m = closeMove(rows);
  assert.ok(Math.abs(m.proj.coef - 0.25) < 0.03, String(m.proj.coef));
  assert.ok(m.proj.half > 0);
  assert.ok(Math.abs(m.shift.coef) < 0.1);
});

// ---------------------------------------------------------------------------
// A synthetic world where the projection is informative ONLY when the weighted
// books lean its way, and one where it is never informative. The walk-forward
// has to find the first and has to NOT find the second — the whole point of
// running it instead of reading a subset's ROI.
function world({ informativeWhenAgree, weeks = 8, perWeek = 1500, seed = 1 }) {
  const r = rng(seed);
  const out = [];
  for (let w = 1; w <= weeks; w++) {
    for (let i = 0; i < perWeek; i++) {
      const lUnweighted = 0.4 * gauss(r);
      const lBooks = lUnweighted + 0.15 * gauss(r);
      const lProj = lBooks + 0.5 * gauss(r);
      const agree = Math.abs(lBooks - lUnweighted) > 0.03 && Math.sign(lBooks - lUnweighted) === Math.sign(lProj - lUnweighted);
      // truth: the books, plus half the projection's gap — but only in the cell
      const truth = agree && informativeWhenAgree ? lBooks + 0.5 * (lProj - lBooks) : lBooks;
      out.push({ week: w, slot: "saturday", stat: "recYds", cluster: `${w}|${i}`, lBooks, lUnweighted, lProj, lSharp: null, y: r() < sigmoid(truth) ? 1 : 0 });
    }
  }
  return out;
}

test("shareByCell finds a share in the cell where the projection is informative and none elsewhere", () => {
  const s = shareByCell(world({ informativeWhenAgree: true }), "books");
  assert.ok(s.agree.raw > 0.3 && s.agree.raw < 0.7, `agree ${s.agree.raw}`);
  assert.ok(Math.abs(s.disagree.raw) < 0.15, `disagree ${s.disagree.raw}`);
  assert.ok(s.agree.half > 0);
});

test("gatedWalkForward beats the pool when the gating is real", () => {
  const wf = gatedWalkForward(world({ informativeWhenAgree: true }), "books", { minTrainWeeks: 3 });
  assert.deepEqual(wf.weeks, [4, 5, 6, 7, 8]);
  const d = wf.variants.point.diffAgree;
  assert.ok(d.mean < 0, `agree-cell Brier diff ${d.mean}`);
  assert.ok(d.z < -3, `z ${d.z}`);
});

test("gatedWalkForward does NOT beat the pool when the projection says nothing", () => {
  const wf = gatedWalkForward(world({ informativeWhenAgree: false, seed: 9 }), "books", { minTrainWeeks: 3 });
  for (const v of Object.values(wf.variants)) {
    // The cautious rule must leave the pool alone; the point estimate may wobble
    // but cannot be significantly better than a price that is already true.
    assert.ok(!(v.diff.z < -2), `unexpected gain: z ${v.diff.z}`);
  }
  const shares = wf.variants.cautious.shares;
  assert.ok(shares.every((s) => s.agree < 0.15 && s.other < 0.15), JSON.stringify(shares));
});

test("gatedWalkForward fits each week only on earlier weeks", () => {
  const samples = world({ informativeWhenAgree: true, weeks: 5, perWeek: 400 });
  const wf = gatedWalkForward(samples, "books", { minTrainWeeks: 2 });
  for (const row of wf.variants.cautious.shares) {
    const prior = samples.filter((s) => s.week < row.week).length;
    assert.equal(row.nAgree + row.nOther, prior);
  }
});

// ---------------------------------------------------------------------------
const bet = (o) => ({ slot: "thursday", week: 5, playerId: "1", stat: "recYds", line: 50.5, side: "over", odds: 100, implied: 0.5, closeFair: 0.52, status: "won", ...o });

test("oneBetPerMarket: best price within a capture, then the first capture only", () => {
  const rows = [
    bet({ odds: -110, book: "a" }),
    bet({ odds: 105, book: "b" }),
    bet({ slot: "saturday", odds: 120 }), // later capture of the same market — dropped
    bet({ line: 60.5, slot: "saturday", odds: 100 }), // a different line — kept
  ];
  const kept = oneBetPerMarket(rows);
  assert.equal(kept.length, 2);
  const same = kept.find((r) => r.line === 50.5);
  assert.equal(same.odds, 105);
  assert.equal(same.slot, "thursday");
});

test("betProfit: conservative settlement loses an Over on a player the feed omitted, voids an Under", () => {
  assert.equal(betProfit(bet({ status: "won", odds: 150 })), 1.5);
  assert.equal(betProfit(bet({ status: "lost" })), -1);
  assert.equal(betProfit(bet({ status: "pending", side: "over" })), -1);
  assert.equal(betProfit(bet({ status: "pending", side: "over" }), { conservative: false }), null);
  assert.equal(betProfit(bet({ status: "pending", side: "under" })), null);
  assert.equal(betProfit(bet({ status: "push" })), null);
});

test("decimal handles both signs", () => {
  assert.equal(decimal(100), 2);
  assert.equal(decimal(-200), 1.5);
  assert.ok(Number.isNaN(decimal(0)));
});

test("summarizeBets: CLV is the closing fair price minus the break-even probability, per cluster", () => {
  const bets = [
    bet({ playerId: "1", closeFair: 0.54, implied: 0.5 }),
    bet({ playerId: "2", closeFair: 0.5, implied: 0.5 }),
    bet({ playerId: "3", closeFair: null }),
    bet({ playerId: "4", closeFair: 0.46, implied: 0.5, status: "lost" }),
  ];
  const s = summarizeBets(bets);
  assert.equal(s.bets, 4);
  assert.equal(s.clv.n, 3);
  assert.ok(Math.abs(s.clv.mean - 0) < 1e-9);
  assert.ok(Math.abs(s.beatClose - 1 / 3) < 1e-9);
});

// ---------------------------------------------------------------------------
import { poolVsMedianOnClose, differenceOfMeans } from "./agreement.mjs";

test("poolVsMedianOnClose: positive when the pool's offset is not followed by the late board", () => {
  const r = rng(21);
  const rows = [];
  for (let i = 0; i < 2000; i++) {
    const lUnweighted = gauss(r) * 0.3;
    const lBooks = lUnweighted + 0.1 * gauss(r); // the pool wanders off the median
    rows.push({ lBooks, lUnweighted, lClose: lUnweighted + 0.02 * gauss(r), cluster: `c${i % 400}` });
  }
  const m = poolVsMedianOnClose(rows);
  assert.ok(m.diff.mean > 0 && m.diff.z > 5, `z ${m.diff.z}`);
  assert.ok(m.poolMse > m.medianMse);
});

test("differenceOfMeans combines standard errors and refuses a missing one", () => {
  const d = differenceOfMeans({ mean: 0.02, se: 0.003 }, { mean: 0.005, se: 0.004 });
  assert.ok(Math.abs(d.mean - 0.015) < 1e-12);
  assert.ok(Math.abs(d.half - 1.96 * 0.005) < 1e-12);
  assert.equal(differenceOfMeans({ mean: 1, se: null }, { mean: 0, se: 1 }).mean, null);
});
