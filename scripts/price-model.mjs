// Prices every captured market off the projections AND the books, and scores
// the result against what actually happened.
//
// The question this answers is not "where do we disagree with the market"
// (that is capture-props, and disagreement is not evidence). It is: given a
// player's Floor/Median/Ceiling and the prices a set of books are showing,
// what is the best available estimate of P(actual > line) — and is it better
// than either input alone?
//
// Read the report bottom-up. The walk-forward section is the only one that can
// argue for shipping anything; everything above it is in-sample and therefore
// flattering by construction, exactly as in calibration-report.mjs.
//
// Usage:
//   npm run price-model
//   node scripts/price-model.mjs [--season 2026]
//                                [--market-set retail|sharp|all|both]
//                                [--stats recYds,rushYds]
//                                [--devig-method multiplicative]
//                                [--shrinkage-k 200]
//                                [--min-books 1]
//                                [--include-retired]
//                                [--write]   persist the fit for capture-props
//                                [--json]
//
// Reads data/props/{season}/ and data/actuals/{season}/ directly — the
// committed record of what the books were showing and what happened — so it
// does not depend on the dashboard build.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeason, buildSamples, availableSeasons } from "./lib/pricing-dataset.mjs";
import {
  fitPricingModel,
  predict,
  walkForward,
  scoreProbabilities,
  reliability,
  skill,
  pairedBrierDiff,
  clusterKey,
} from "./lib/pricing.mjs";
import { MARKET_SET_NAMES } from "./lib/consensus.mjs";
import { DEVIG_METHODS, DEFAULT_DEVIG_METHOD } from "./lib/devig.mjs";
import { americanToDecimal } from "./lib/odds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// The order models are reported in: weakest baseline first, so the table reads
// as a ladder and the last row is the thing being argued for.
const REPORT_MODELS = ["baseRate", "projRecal", "marketRecal", "blend"];

function parseArgs(argv) {
  const a = {
    marketSet: "both",
    devigMethod: DEFAULT_DEVIG_METHOD,
    shrinkageK: 200,
    minBooks: 1,
    dataDir: join(ROOT, "data"),
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--market-set": a.marketSet = next(); break;
      case "--stats": a.stats = new Set(next().split(",").map((s) => s.trim()).filter(Boolean)); break;
      case "--devig-method": a.devigMethod = next(); break;
      case "--shrinkage-k": a.shrinkageK = Number(next()); break;
      case "--min-books": a.minBooks = Number(next()); break;
      case "--include-retired": a.includeRetired = true; break;
      case "--data-dir": a.dataDir = next(); break;
      case "--write": a.write = true; break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  if (a.marketSet !== "both" && !MARKET_SET_NAMES.includes(a.marketSet)) {
    throw new Error(`--market-set must be one of: ${MARKET_SET_NAMES.join(", ")}, both`);
  }
  if (!DEVIG_METHODS.includes(a.devigMethod)) {
    throw new Error(`--devig-method must be one of: ${DEVIG_METHODS.join(", ")}`);
  }
  if (!Number.isFinite(a.shrinkageK) || a.shrinkageK < 0) throw new Error("--shrinkage-k must be >= 0");
  if (!Number.isFinite(a.minBooks) || a.minBooks < 1) throw new Error("--min-books must be >= 1");
  return a;
}

const HELP = `Price every captured market off the projections AND the books, then score it.

  node scripts/price-model.mjs [options]

  --season <y>          season to read (default: latest with captures)
  --market-set <s>      retail | sharp | all | both   (default: both)
                        retail = the recreational board you can bet at
                        sharp  = limit-taking books used as a fair-value anchor
  --stats <list>        comma-separated stat keys (default: all bettable)
  --devig-method <m>    ${DEVIG_METHODS.join(" | ")}
  --shrinkage-k <n>     per-stat sample size worth half the global fit (200)
  --min-books <n>       drop markets quoted by fewer books than this (1)
  --include-retired     include markets with bet:false (anytimeTD)
  --write               persist the fitted model to data/pricing/{season}/
  --json                emit the analysis as JSON instead of tables
  -h, --help            show this help

The walk-forward section is the one that matters. In-sample scores are
reported for contrast and are flattering by construction.`;

// ---- Formatting ----------------------------------------------------------
const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "n/a");
const num = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

// ---- Analysis ------------------------------------------------------------

// Everything the report needs for one market set, so `--market-set both` is
// just this function twice and the two can be printed side by side.
function analyzeSet(quotes, actualsByWeek, a, marketSet) {
  const built = buildSamples(quotes, actualsByWeek, {
    includeRetired: a.includeRetired,
    marketSet,
    devigMethod: a.devigMethod,
    minBooks: a.minBooks,
  });
  let samples = built.samples;
  if (a.stats) samples = samples.filter((s) => a.stats.has(s.stat));

  // The raw inputs, scored as-is. These are not models — nothing was fitted —
  // and they are the honest description of where the project stands today:
  // `projRaw` IS the current OurProb, and `marketRaw` is what you get by
  // simply believing the books.
  // Computed below over the same row set as the fitted models; see the note
  // there. Placeholder assigned after `inSampleRows` exists.
  let rawScores;

  // Every model is scored over exactly the same markets. Scoring two models
  // on different row sets is the easiest way to manufacture a skill number
  // that is really a difference between samples — and the sets genuinely can
  // diverge, since each model reads different inputs and a row missing one of
  // them is predictable by some models and not others.
  //
  // The blend needs the most (both a projection and a market prior), so its
  // row set is the common denominator.
  const fits = {};
  const predsByModel = {};
  for (const m of REPORT_MODELS) {
    const fit = fitPricingModel(samples, m, { shrinkageK: a.shrinkageK });
    fits[m] = fit;
    const byKey = new Map();
    for (const s of samples) {
      const p = predict(fit, s);
      if (p !== null) byKey.set(s.key, p);
    }
    predsByModel[m] = byKey;
  }
  const inSampleKeys = new Set([...predsByModel.blend.keys()]);
  const inSampleRows = samples.filter((s) => inSampleKeys.has(s.key));
  rawScores = {
    projRaw: scoreProbabilities(inSampleRows.map((s) => ({ p: s.pProj, y: s.y }))),
    marketRaw: scoreProbabilities(inSampleRows.map((s) => ({ p: s.pMarket, y: s.y }))),
  };
  const inSample = {};
  for (const m of REPORT_MODELS) {
    inSample[m] = scoreProbabilities(
      inSampleRows.map((s) => ({ p: predsByModel[m].get(s.key), y: s.y }))
    );
  }

  const walks = {};
  for (const m of REPORT_MODELS) {
    walks[m] = walkForward(samples, m, { shrinkageK: a.shrinkageK });
  }
  const blendKeys = new Set(walks.blend.pooled.map((s) => s.key));
  const oosRows = samples.filter((s) => blendKeys.has(s.key));

  const oos = {};
  for (const m of REPORT_MODELS) {
    const pooled = walks[m].pooled.filter((s) => blendKeys.has(s.key));
    oos[m] = {
      score: scoreProbabilities(pooled.map((s) => ({ p: s.p, y: s.y }))),
      folds: walks[m].folds.map((f) => ({
        testWeek: f.testWeek,
        trainN: f.trainN,
        testN: f.preds.filter((s) => blendKeys.has(s.key)).length,
        score: scoreProbabilities(
          f.preds.filter((s) => blendKeys.has(s.key)).map((s) => ({ p: s.p, y: s.y }))
        ),
      })),
      pooled,
    };
  }

  const oosMarketRaw = scoreProbabilities(oosRows.map((s) => ({ p: s.pMarket, y: s.y })));
  const oosProjRaw = scoreProbabilities(oosRows.map((s) => ({ p: s.pProj, y: s.y })));

  return {
    marketSet,
    dropped: built.dropped,
    samples,
    counts: countBy(samples),
    rawScores,
    fits,
    inSample,
    oos,
    oosMarketRaw,
    oosProjRaw,
    oosRows,
  };
}

function countBy(samples) {
  const byStat = new Map();
  const byWeek = new Map();
  const bySource = new Map();
  const playersByWeek = new Map();
  for (const s of samples) {
    byStat.set(s.stat, (byStat.get(s.stat) ?? 0) + 1);
    byWeek.set(s.week, (byWeek.get(s.week) ?? 0) + 1);
    bySource.set(s.probSource, (bySource.get(s.probSource) ?? 0) + 1);
    if (!playersByWeek.has(s.week)) playersByWeek.set(s.week, new Set());
    playersByWeek.get(s.week).add(s.playerId);
  }
  return {
    total: samples.length,
    // The number that actually bounds the evidence: one player's one game,
    // however many alternate lines were quoted on him.
    clusters: new Set(samples.map(clusterKey)).size,
    byStat: [...byStat].sort((x, y) => y[1] - x[1]),
    byWeek: [...byWeek].sort((x, y) => x[0] - y[0]),
    byWeekPlayers: [...playersByWeek].map(([w, set]) => [w, set.size]).sort((x, y) => x[0] - y[0]),
    bySource: [...bySource].sort((x, y) => y[1] - x[1]),
  };
}

// Mean market probability and realized rate, split by how the market
// probability was obtained. A de-vigged consensus and one inferred from an
// assumed hold are different measurements and should not be pooled without
// looking at whether they agree.
function bySourceScores(samples) {
  const groups = new Map();
  for (const s of samples) {
    if (!groups.has(s.probSource)) groups.set(s.probSource, []);
    groups.get(s.probSource).push(s);
  }
  return [...groups]
    .map(([source, rows]) => ({
      source,
      n: rows.length,
      clusters: new Set(rows.map(clusterKey)).size,
      market: scoreProbabilities(rows.map((r) => ({ p: r.pMarket, y: r.y }))),
      proj: scoreProbabilities(rows.map((r) => ({ p: r.pProj, y: r.y }))),
    }))
    .sort((a, b) => b.n - a.n);
}

// What a probability improvement is worth in money, at the best price on
// offer. Deliberately reported as a diagnostic and not as an ROI claim: it is
// the EV the model *thinks* it has, computed at prices we did not have to
// beat anyone to get, over a sample far too small for the realized number to
// mean anything (see build-betting-data.mjs on exactly this point).
function evAtBestPrice(rows, probOf) {
  const evs = [];
  const clusters = new Set();
  let sumRealized = 0;
  for (const s of rows) {
    const dec = americanToDecimal(s.bestOverOdds);
    const p = probOf(s);
    if (dec === null || !Number.isFinite(p)) continue;
    const ev = p * (dec - 1) - (1 - p);
    if (ev <= 0) continue; // only bets the model would actually place
    evs.push(ev);
    clusters.add(clusterKey(s));
    sumRealized += s.y ? dec - 1 : -1;
  }
  const n = evs.length;
  const sorted = [...evs].sort((a, b) => a - b);
  return {
    n,
    clusters: clusters.size,
    meanEv: n ? evs.reduce((a, b) => a + b, 0) / n : null,
    // The median is the number to look at. A handful of +2500 alternate lines
    // dominate the mean and say nothing about the typical bet.
    medianEv: n ? sorted[sorted.length >> 1] : null,
    realizedRoi: n ? sumRealized / n : null,
  };
}

// ---- Report sections -----------------------------------------------------

function datasetSection(res, season, weeks) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`DATASET — season ${season}, market set "${res.marketSet}"`);
  console.log("=".repeat(78));
  console.log(
    `Weeks captured: ${weeks.map((w) => `${w.week}${w.hasActuals ? "" : " (no actuals)"}`).join(", ")}`
  );
  console.log(
    `Gradable markets: ${res.counts.total}, drawn from ${res.counts.clusters} player-weeks.`
  );
  console.log(
    `  THE SECOND NUMBER IS THE SAMPLE SIZE. Every alternate line on one player\n` +
      `  resolves off the same game, so 300 quoted lines on Lamar Jackson are one\n` +
      `  observation about whether we price him correctly, not 300.`
  );
  console.log(
    `  by week:   ${res.counts.byWeek
      .map(([w, n]) => {
        const players = res.counts.byWeekPlayers.find(([ww]) => ww === w)?.[1] ?? 0;
        return `wk${w}=${n} (${players} players)`;
      })
      .join("  ") || "none"}`
  );
  console.log(
    `  by stat:   ${res.counts.byStat.map(([s, n]) => `${s}=${n}`).join("  ") || "none"}`
  );
  console.log(
    `  market prob from: ${res.counts.bySource.map(([s, n]) => `${s}=${n}`).join("  ") || "none"}`
  );
  const d = res.dropped;
  console.log(
    `Dropped: retired market ${d.retired}, no actuals ${d.noActual}, push ${d.push}, ` +
      `no book in set ${d.noConsensus}, too few books ${d.fewBooks}` +
      (d.inconsistentProj ? `, inconsistent projection ${d.inconsistentProj}` : "")
  );
  if (d.noActual > 0) {
    console.log(
      `\n  READ THE "no actuals" DROP AS A BIAS, NOT AS MISSING DATA. The RotoWire\n` +
        `  actuals feed carries no all-zero rows — a player who dressed and recorded\n` +
        `  nothing in every tracked stat is simply absent from it, indistinguishable\n` +
        `  from one who was inactive. Those are precisely the player-weeks where the\n` +
        `  UNDER won, so dropping them conditions the sample on the outcome and\n` +
        `  pushes the observed over-rate up. It is visible in the fitted intercept.\n` +
        `  The correction is a source of played/did-not-play status, which this\n` +
        `  project does not currently have; until then the intercept a is carrying\n` +
        `  a selection effect as well as any real market tilt, and should not be\n` +
        `  shipped into a live price on its own.`
    );
  }
  const src = bySourceScores(res.samples);
  if (src.length > 1) {
    console.log(`\n  Market probability by how it was obtained:`);
    console.log(
      `  ${pad("source", 14)}${lpad("n", 7)}${lpad("clusters", 10)}${lpad("mean p", 9)}${lpad("observed", 10)}${lpad("Brier", 9)}`
    );
    for (const g of src) {
      console.log(
        `  ${pad(g.source, 14)}${lpad(g.n, 7)}${lpad(g.clusters, 10)}${lpad(pct(g.market.meanPred), 9)}` +
          `${lpad(pct(g.market.baseRate), 10)}${lpad(num(g.market.brier), 9)}`
      );
    }
  }
  if (res.counts.total === 0) {
    console.log(
      `\n  Nothing to fit. Every market was dropped — most likely no book in the\n` +
        `  "${res.marketSet}" set quoted this season's captures.`
    );
  } else if (res.counts.byWeek.length < 2) {
    console.log(
      `\n  Only one gradable week in this set, so there is nothing to hold out and\n` +
        `  no out-of-sample number below. For the "sharp" set that is the expected\n` +
        `  state right now: the only sharp book in the captures is Circa, it appears\n` +
        `  in week 1 alone, and lib/books.mjs does not pull Pinnacle by default.\n` +
        `  Run capture-props with --include-offshore to build this set up.`
    );
  }
}

function scoreTable(title, rows, note) {
  console.log(`\n${title}`);
  if (note) console.log(`  ${note}`);
  console.log(
    `  ${pad("model", 14)}${lpad("n", 7)}${lpad("Brier", 9)}${lpad("log loss", 11)}` +
      `${lpad("vs market", 11)}${lpad("vs base", 10)}${lpad("mean p", 9)}${lpad("observed", 10)}`
  );
  console.log(`  ${"-".repeat(71)}`);
  for (const r of rows) {
    console.log(
      `  ${pad(r.label, 14)}${lpad(r.score.n ?? 0, 7)}${lpad(num(r.score.brier), 9)}` +
        `${lpad(num(r.score.logLoss), 11)}${lpad(r.vsMarket === null ? "—" : sgn(r.vsMarket), 11)}` +
        `${lpad(r.vsBase === null ? "—" : sgn(r.vsBase), 10)}` +
        `${lpad(pct(r.score.meanPred), 9)}${lpad(pct(r.score.baseRate), 10)}`
    );
  }
}

function buildScoreRows(scores, marketRef, baseRef) {
  return scores.map(({ label, score }) => ({
    label,
    score,
    vsMarket: marketRef?.brier ? skill(score.brier, marketRef.brier) : null,
    vsBase: baseRef?.brier ? skill(score.brier, baseRef.brier) : null,
  }));
}

function coefficientSection(fit) {
  console.log(`\nFITTED WEIGHTS — logit(p) = a + c*logit(p_mkt) + b*[logit(p_proj) - logit(p_mkt)]`);
  console.log(
    `  b is how much of our disagreement with the book to believe. b = 0 means\n` +
      `  price off the book and ignore the projection; b = 1 means take the\n` +
      `  projection at face value. c near 1 says the consensus is already a\n` +
      `  calibrated probability, as it should be.`
  );
  console.log(
    `  ${pad("stat", 14)}${lpad("n", 7)}${lpad("own wt", 9)}${lpad("a", 9)}${lpad("c (mkt)", 10)}${lpad("b (disagree)", 14)}`
  );
  console.log(`  ${"-".repeat(64)}`);
  console.log(
    `  ${pad("GLOBAL", 14)}${lpad(fit.n, 7)}${lpad("—", 9)}${lpad(sgn(fit.global[0]), 9)}` +
      `${lpad(sgn(fit.global[1]), 10)}${lpad(sgn(fit.global[2]), 14)}`
  );
  for (const [stat, s] of Object.entries(fit.stats).sort((x, y) => y[1].n - x[1].n)) {
    console.log(
      `  ${pad(stat, 14)}${lpad(s.n, 7)}${lpad(s.ownWeight.toFixed(2), 9)}${lpad(sgn(s.coef[0]), 9)}` +
        `${lpad(sgn(s.coef[1]), 10)}${lpad(sgn(s.coef[2]), 14)}`
    );
  }
  console.log(
    `  own wt is the share of each stat's fit carried by its own rows rather\n` +
      `  than by the global prior (0 = global only, 1 = own rows only).`
  );
}

function reliabilitySection(title, pairs) {
  const table = reliability(pairs);
  console.log(`\n${title}`);
  console.log(
    `  ${pad("bucket", 12)}${lpad("n", 7)}${lpad("predicted", 11)}${lpad("observed", 10)}${lpad("95% CI", 18)}  flag`
  );
  console.log(`  ${"-".repeat(64)}`);
  for (const b of table) {
    console.log(
      `  ${pad(`${pct(b.lo, 0)}-${pct(b.hi, 0)}`, 12)}${lpad(b.n, 7)}${lpad(pct(b.meanPred), 11)}` +
        `${lpad(pct(b.observed), 10)}${lpad(`[${pct(b.ci.lo)}, ${pct(b.ci.hi)}]`, 18)}  ${b.significant ? "MISCALIBRATED" : ""}`
    );
  }
  console.log(
    `  MISCALIBRATED = the prediction lies outside the Wilson interval on the\n` +
      `  observed rate, i.e. the gap is larger than sampling noise.`
  );
}

function walkForwardSection(res) {
  console.log(`\n${"-".repeat(78)}`);
  console.log(`WALK-FORWARD (out of sample) — market set "${res.marketSet}"`);
  console.log("-".repeat(78));
  console.log(
    `Fit on weeks < k, predict week k, pooled over every k. This is the only\n` +
      `section that can argue for shipping the blend.`
  );

  const rows = buildScoreRows(
    [
      { label: "projRaw", score: res.oosProjRaw },
      { label: "marketRaw", score: res.oosMarketRaw },
      ...REPORT_MODELS.map((m) => ({ label: m, score: res.oos[m].score })),
    ],
    res.oosMarketRaw,
    res.oos.baseRate.score
  );
  scoreTable(
    "Pooled out-of-sample scores",
    rows,
    `scored over the ${res.oosRows.length} markets the blend could predict on, for every model`
  );

  console.log(`\n  Per fold (blend vs the market it has to beat):`);
  console.log(
    `  ${pad("test week", 12)}${lpad("train n", 9)}${lpad("test n", 8)}${lpad("blend Brier", 13)}${lpad("market Brier", 14)}${lpad("skill", 9)}`
  );
  console.log(`  ${"-".repeat(64)}`);
  for (const f of res.oos.blend.folds) {
    const weekRows = res.oosRows.filter((s) => s.week === f.testWeek);
    const mkt = scoreProbabilities(weekRows.map((s) => ({ p: s.pMarket, y: s.y })));
    console.log(
      `  ${pad(`wk ${f.testWeek}`, 12)}${lpad(f.trainN, 9)}${lpad(f.testN, 8)}` +
        `${lpad(num(f.score.brier), 13)}${lpad(num(mkt.brier), 14)}${lpad(sgn(skill(f.score.brier, mkt.brier)), 9)}`
    );
  }
}

function verdictSection(res) {
  const blend = res.oos.blend.score;
  const mkt = res.oosMarketRaw;
  const proj = res.oosProjRaw;

  console.log(`\n${"=".repeat(78)}`);
  console.log(`VERDICT — market set "${res.marketSet}"`);
  console.log("=".repeat(78));

  if (blend.n === 0) {
    console.log("Not enough out-of-sample data to say anything. Capture more weeks.");
    return;
  }

  console.log(
    `Out of sample: blend Brier ${num(blend.brier)}, market ${num(mkt.brier)}, ` +
      `projection alone ${num(proj.brier)}.`
  );

  // Two comparisons, and conflating them is the easiest way to misread this
  // whole report.
  //
  //   blend vs marketRaw     — is our price better than the book's?
  //   blend vs marketRecal   — do the PROJECTIONS contribute anything, or is
  //                            the whole gain a recalibration of the book?
  //
  // The first can be comfortably positive while the second is zero, and that
  // is a completely different business: correcting a market-wide tilt is not
  // the same product as a projection edge, and it does not survive the market
  // correcting itself.
  const byKeyBlend = new Map(res.oos.blend.pooled.map((p2) => [p2.key, p2.p]));
  const byKeyMktRecal = new Map(res.oos.marketRecal.pooled.map((p2) => [p2.key, p2.p]));

  const vsMarket = pairedBrierDiff(
    res.oosRows.map((r) => ({ p: byKeyBlend.get(r.key), q: r.pMarket, y: r.y, cluster: clusterKey(r) }))
  );
  const vsRecal = pairedBrierDiff(
    res.oosRows.map((r) => ({
      p: byKeyBlend.get(r.key),
      q: byKeyMktRecal.get(r.key),
      y: r.y,
      cluster: clusterKey(r),
    }))
  );

  console.log(
    `\n  ${pad("comparison", 30)}${lpad("diff", 11)}${lpad("clustered se", 14)}${lpad("z", 8)}${lpad("naive z", 10)}   asks`
  );
  console.log(`  ${"-".repeat(74)}`);
  for (const [label, r, asks] of [
    ["blend vs market", vsMarket, "is our price better than the book's?"],
    ["blend vs recalibrated market", vsRecal, "do the projections add anything?"],
  ]) {
    console.log(
      `  ${pad(label, 30)}${lpad(sgn(r.mean, 5), 11)}${lpad(num(r.se, 5), 14)}` +
        `${lpad(sgn(r.z, 2), 8)}${lpad(sgn(r.naiveZ, 2), 10)}   ${asks}`
    );
  }
  console.log(
    `\n  Negative diff = better. ${vsMarket.clusters} clusters (player-weeks) over ` +
      `${vsMarket.n} markets.\n` +
      `  The naive z ignores clustering and is shown only to make the size of that\n` +
      `  mistake visible — it is not the number to act on.`
  );

  const [, globalC, globalB] = res.fits.blend.global;
  console.log(
    `\n  Fitted globally: market weight c = ${sgn(globalC)}, disagreement weight ` +
      `b = ${sgn(globalB)}.\n  b = 0 means the projections are adding nothing on top of the book.`
  );

  // The conclusion, stated at the confidence the clustered standard error
  // actually supports.
  const beatsMarket = Number.isFinite(vsMarket.z) && vsMarket.z < -2;
  const worseThanMarket = Number.isFinite(vsMarket.z) && vsMarket.z > 2;
  const projAdds = Number.isFinite(vsRecal.z) && vsRecal.z < -2;

  console.log("");
  if (worseThanMarket) {
    console.log(
      `  The blend is WORSE than simply believing the books. Do not ship it.`
    );
  } else if (beatsMarket && projAdds) {
    console.log(
      `  The blend beats the market, and it still beats the market after the\n` +
        `  market has been recalibrated — so the projections are carrying real\n` +
        `  information. This is the result that would justify pricing off the blend.`
    );
  } else if (beatsMarket) {
    console.log(
      `  The blend beats the raw market price, but NOT a simply recalibrated\n` +
        `  market. So the gain is a correction to the consensus itself, not a\n` +
        `  projection edge — and on this sample part of that correction is the\n` +
        `  selection effect described above rather than anything about the books.\n` +
        `  Worth knowing; not yet a reason to price props off the projections.`
    );
  } else {
    console.log(
      `  Inconclusive at the sample size actually available. The blend and the\n` +
        `  market are within 2 clustered standard errors of each other. What this\n` +
        `  needs is more player-weeks, not a more complex model.`
    );
  }

  const ev = evAtBestPrice(res.oosRows, (row) => byKeyBlend.get(row.key));
  if (ev.n) {
    console.log(
      `\n  Money view: of ${res.oosRows.length} out-of-sample markets the blend calls\n` +
        `  ${ev.n} +EV at the best book price, median EV ${pct(ev.medianEv)} ` +
        `(mean ${pct(ev.meanEv)}); those\n  bets returned ${pct(ev.realizedRoi)} over ${ev.clusters} player-weeks.\n` +
        `  Do not read any of this as a return. The mean EV is dragged by longshot\n` +
        `  alternate lines where best-of-N picks the most generous quote on the\n` +
        `  board — the exact distortion lib/books.mjs exists to limit — and the\n` +
        `  realized figure rests on ${ev.clusters} independent games.`
    );
  }
}

// ---- Main ----------------------------------------------------------------

function run() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }

  const seasons = availableSeasons(a.dataDir);
  const season = a.season ?? seasons[seasons.length - 1];
  if (!season) throw new Error(`No prop captures under ${join(a.dataDir, "props")}`);

  const { quotes, actualsByWeek, weeks } = loadSeason(season, { dataDir: a.dataDir });
  const setNames = a.marketSet === "both" ? ["retail", "sharp"] : [a.marketSet];
  const results = setNames.map((s) => analyzeSet(quotes, actualsByWeek, a, s));

  if (a.json) {
    console.log(
      JSON.stringify(
        {
          season,
          weeks,
          options: { marketSet: a.marketSet, devigMethod: a.devigMethod, shrinkageK: a.shrinkageK, minBooks: a.minBooks },
          sets: results.map((r) => ({
            marketSet: r.marketSet,
            counts: r.counts,
            dropped: r.dropped,
            rawScores: r.rawScores,
            inSample: r.inSample,
            outOfSample: Object.fromEntries(REPORT_MODELS.map((m) => [m, r.oos[m].score])),
            oosMarketRaw: r.oosMarketRaw,
            oosProjRaw: r.oosProjRaw,
            fits: r.fits,
          })),
        },
        null,
        2
      )
    );
    if (a.write) writeFit(results, season, a);
    return;
  }

  console.log(
    `Pricing model report — season ${season}, de-vig ${a.devigMethod}, ` +
      `shrinkage K=${a.shrinkageK}, min books ${a.minBooks}` +
      (a.includeRetired ? ", including retired markets" : "")
  );

  for (const res of results) {
    datasetSection(res, season, weeks);
    if (res.counts.total === 0) continue;

    scoreTable(
      "IN-SAMPLE scores (flattering by construction — for contrast only)",
      buildScoreRows(
        [
          { label: "projRaw", score: res.rawScores.projRaw },
          { label: "marketRaw", score: res.rawScores.marketRaw },
          ...REPORT_MODELS.map((m) => ({ label: m, score: res.inSample[m] })),
        ],
        res.rawScores.marketRaw,
        res.inSample.baseRate
      ),
      "projRaw is today's OurProb, unchanged. marketRaw is simply believing the books."
    );

    coefficientSection(res.fits.blend);
    if (res.oos.blend.pooled.length === 0) {
      console.log(`\n(No out-of-sample weeks in this set — skipping the sections that need one.)`);
      continue;
    }
    reliabilitySection(
      "RELIABILITY — today's projection-only price (projRaw), in sample",
      res.samples.map((s) => ({ p: s.pProj, y: s.y }))
    );
    reliabilitySection(
      "RELIABILITY — blended price, out of sample",
      res.oos.blend.pooled.map((s) => ({ p: s.p, y: s.y }))
    );
    walkForwardSection(res);
    verdictSection(res);
  }

  if (a.write) writeFit(results, season, a);

  console.log(
    `\n\nNOTE: this report does not change what capture-props prices. To use a\n` +
      `fitted blend there, run with --write and pass --price-model blend to\n` +
      `capture-props; the default stays the projection-only price.\n`
  );
}

// Persist the fit so capture-props can price off it without re-running the
// report. Only the blend is written — the other models exist to be beaten.
//
// The fit is committed data, like the captures it came from: a price that
// cannot be reproduced later is not auditable, and "which model priced this
// bet" is exactly the question a ledger has to answer months afterwards.
function writeFit(results, season, a) {
  const payload = {
    season,
    generatedAt: new Date().toISOString(),
    options: {
      devigMethod: a.devigMethod,
      shrinkageK: a.shrinkageK,
      minBooks: a.minBooks,
      includeRetired: !!a.includeRetired,
    },
    sets: Object.fromEntries(
      results.map((r) => [
        r.marketSet,
        {
          fit: r.fits.blend,
          trainedOnWeeks: r.counts.byWeek.map(([w]) => w),
          n: r.counts.total,
          outOfSample: { blend: r.oos.blend.score, marketRaw: r.oosMarketRaw, projRaw: r.oosProjRaw },
        },
      ])
    ),
  };
  const path = join(a.dataDir, "pricing", String(season), "model.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  console.log(`\nWrote ${path}`);
}

// A bad flag is a typo, not a crash — print the reason, not a stack trace.
try {
  run();
} catch (err) {
  console.error(`price-model: ${err.message}`);
  process.exitCode = 1;
}
