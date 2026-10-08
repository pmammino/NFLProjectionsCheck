// Assesses every price source — each book, and our own projection — on one
// question, and turns the answers into the weights of a consensus.
//
//   When this source disagreed with the rest of the market at the open, how
//   much of that disagreement had the rest of the market adopted by the close?
//
// See scripts/lib/source-weights.mjs for why that slope is a weight, why the
// source is left out of its own target, and why the projection is handled as
// it is. This script is the reporting around that module: the assessment as of
// each week, whether weighting actually helps out of sample, and the file
// capture-props reads.
//
// Usage:
//   npm run source-weights
//   node scripts/source-weights.mjs [--season 2026]
//                                   [--prior-clusters 150] [--prior-weight 0.15]
//                                   [--include-retired]
//                                   [--write]   persist data/pricing/{season}/source-weights.json
//                                   [--json]
//
// Reads data/props/ and data/actuals/ directly.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeason, availableSeasons, actualFor } from "./lib/pricing-dataset.mjs";
import { gradeOutcome } from "./lib/grading.mjs";
import { bookInSet, median, sigmoid } from "./lib/consensus.mjs";
import { pairedBrierDiff, NEAR_MONEY_MAX } from "./lib/pricing.mjs";
import { buildSourceModel } from "./lib/source-model.mjs";
import {
  PROJECTION_SOURCE,
  PRIOR_WEIGHT,
  PRIOR_CLUSTERS,
  MAX_PROJECTION_SHARE,
  assessSources,
  fitSourceWeights,
  poolVotes,
  shareFor,
  fitProjectionShares,
} from "./lib/source-weights.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const a = {
    season: null,
    dataDir: join(ROOT, "data"),
    priorClusters: PRIOR_CLUSTERS,
    priorWeight: PRIOR_WEIGHT,
    includeRetired: false,
    write: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--season": a.season = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--prior-clusters": a.priorClusters = Number(next()); break;
      case "--prior-weight": a.priorWeight = Number(next()); break;
      case "--include-retired": a.includeRetired = true; break;
      case "--write": a.write = true; break;
      case "--json": a.json = true; break;
      case "-h":
      case "--help":
        console.log(readFileHeader());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!(a.priorClusters >= 0)) throw new Error("--prior-clusters must be >= 0");
  if (!(a.priorWeight > 0)) throw new Error("--prior-weight must be > 0");
  return a;
}

function readFileHeader() {
  return `Usage: node scripts/source-weights.mjs [--season Y] [--prior-clusters N] [--prior-weight W] [--include-retired] [--write] [--json]`;
}

const f = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "    -" : (x >= 0 ? " " : "") + x.toFixed(d));
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyse(quotes, actualsByWeek, a) {
  const model = buildSourceModel(quotes, actualsByWeek, { includeRetired: a.includeRetired, priorClusters: a.priorClusters, priorWeight: a.priorWeight });
  const { pairs, samples, weeks } = model;
  const opts = { priorClusters: a.priorClusters, priorWeight: a.priorWeight };

  // 1. The assessment on everything seen, and the weights it implies.
  const overall = assessSources(pairs);
  const overallFit = fitSourceWeights(overall, opts);

  // 2. The model as it stood going into each week, plus the week after the last
  //    (the live one).
  const asOf = weeks.concat([Math.max(...weeks) + 1]).map((w) => model.at(w));

  // 3. The projection's share on everything seen.
  const overallShares = fitProjectionShares(samples, opts);

  // 4. Out of sample.
  const heldOut = evaluateHeldOut(pairs, asOf);
  const outcomes = evaluateOutcomes(pairs, asOf, actualsByWeek);

  const projPairs = pairs.filter((p) => p.projection !== null).length;
  return { pairs: pairs.length, weeks, overall, overallFit, asOf, overallShares, shareSamples: samples.length, heldOut, outcomes, projPairs };
}

const weightsFor = (asOf, week) => asOf.find((x) => x.week === week)?.weights ?? {};
const sharesFor = (asOf, week) => asOf.find((x) => x.week === week)?.shares ?? {};

// A target that is NOT in the pool being tested. The pool is built from the
// retail books at the early board; the target is a sharp book's own price at
// the close. Neither the pool's inputs nor its weights have seen that price
// (the weights come from earlier weeks), so a better prediction of it is a
// better estimate of where the market went and cannot be explained by
// sticky quotes agreeing with themselves.
function evaluateHeldOut(pairs, asOf) {
  const out = [];
  for (const target of ["pinnacle", "circasports"]) {
    const rows = [];
    for (const p of pairs) {
      if (p.week < 2) continue;
      const t = p.late.find((v) => v.book === target && v.twoSided);
      if (!t) continue;
      const retail = p.early.filter((v) => bookInSet(v.book, "retail"));
      if (retail.length < 3) continue;
      const base = median(retail.map((v) => v.logit));
      if (Math.abs(sigmoid(base) - 0.5) > 0.4) continue;
      const pooled = poolVotes(retail, { weights: weightsFor(asOf, p.week) });
      const wl = Math.log(pooled.prob / (1 - pooled.prob));
      rows.push({ base: (base - t.logit) ** 2, weighted: (wl - t.logit) ** 2, cluster: p.cluster });
    }
    if (rows.length === 0) continue;
    const n = rows.length;
    const d = rows.map((r) => r.weighted - r.base);
    const mean = d.reduce((x, y) => x + y, 0) / n;
    const by = new Map();
    rows.forEach((r, i) => by.set(r.cluster, (by.get(r.cluster) ?? 0) + d[i] - mean));
    const G = by.size;
    let ss = 0;
    for (const s of by.values()) ss += s * s;
    const se = G > 1 ? Math.sqrt(ss * (G / (G - 1))) / n : null;
    out.push({
      target,
      n,
      clusters: G,
      mseMedian: rows.reduce((x, r) => x + r.base, 0) / n,
      mseWeighted: rows.reduce((x, r) => x + r.weighted, 0) / n,
      diff: mean,
      z: se ? mean / se : null,
    });
  }
  return out;
}

// Brier against what happened. Weak by nature (a few weeks, markets near 50/50
// where every price scores ~0.248), reported because it is the thing the
// consensus is ultimately for, and so that nobody has to wonder whether it was
// skipped.
function evaluateOutcomes(pairs, asOf, actualsByWeek) {
  const graded = [];
  for (const p of pairs) {
    if (p.week < 2) continue;
    const act = actualFor(actualsByWeek.get(p.week)?.get(p.playerId), p.stat);
    if (act === null) continue;
    const o = gradeOutcome(act, p.line, "over");
    if (o === "push") continue;
    graded.push({ p, y: o === "won" ? 1 : 0 });
  }

  const cmp = (label, rows, baseKey, testKey) => {
    const usable = rows.filter((r) => r[baseKey] !== null && r[testKey] !== null);
    const all = pairedBrierDiff(usable.map((r) => ({ p: r[testKey], q: r[baseKey], y: r.y, cluster: r.cluster })));
    const near = pairedBrierDiff(
      usable.filter((r) => Math.abs(r[baseKey] - 0.5) <= NEAR_MONEY_MAX).map((r) => ({ p: r[testKey], q: r[baseKey], y: r.y, cluster: r.cluster }))
    );
    return { label, all, near };
  };

  // Books only, on every early board.
  const booksRows = graded.map(({ p, y }) => {
    const retail = p.early.filter((v) => bookInSet(v.book, "retail"));
    if (retail.length < 3) return { median: null, pool: null, y, cluster: p.cluster };
    const pooled = poolVotes(p.early, { weights: weightsFor(asOf, p.week) });
    return { median: sigmoid(median(retail.map((v) => v.logit))), pool: pooled.prob, y, cluster: p.cluster };
  });

  // The projection as a source — only where it is the projection we had.
  const projRows = graded
    .filter(({ p }) => p.projection !== null)
    .map(({ p, y }) => {
      const retail = p.early.filter((v) => bookInSet(v.book, "retail"));
      if (retail.length < 3) return { median: null, pool: null, withProj: null, proj: null, y, cluster: p.cluster };
      const w = weightsFor(asOf, p.week);
      const share = shareFor(sharesFor(asOf, p.week), p.stat, p.slot);
      return {
        median: sigmoid(median(retail.map((v) => v.logit))),
        pool: poolVotes(p.early, { weights: w }).prob,
        withProj: poolVotes(p.early, { weights: w, projectionProb: p.projection, projectionShare: share }).prob,
        proj: p.projection,
        y,
        cluster: p.cluster,
      };
    });

  return [
    cmp("weighted books vs retail median (every early board)", booksRows, "median", "pool"),
    cmp("books + projection share vs retail median (live boards)", projRows, "median", "withProj"),
    cmp("books + projection share vs weighted books (live boards)", projRows, "pool", "withProj"),
    cmp("projection alone vs retail median (live boards)", projRows, "median", "proj"),
  ];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(season, r, a) {
  console.log(`SOURCE WEIGHTS — season ${season}`);
  console.log(
    `${r.pairs.toLocaleString()} early/closing market pairs over weeks ${r.weeks.join(", ")}; ` +
      `${r.shareSamples.toLocaleString()} live near-the-money markets with an outcome for the projection's share.\n`
  );

  console.log("1. THE BOOKS: WHAT EACH ONE'S EARLY PRICE TOLD THE MARKET   (all weeks; in-sample, descriptive)");
  console.log("   lead = share of the source's early disagreement that the OTHER books had adopted by the close.");
  console.log("   0 = ignored, 1 = fully followed. The source is excluded from its own target.\n");
  console.log(`   ${pad("source", 18)}${lpad("markets", 9)}${lpad("players", 9)}${lpad("lead", 8)}${lpad("±95%", 8)}${lpad("z", 7)}${lpad("weight", 9)}`);
  // A source seen on a handful of player-weeks has a lead that is mostly
  // noise and a weight that is mostly its prior; listing it adds clutter.
  const THIN = 10;
  const thin = Object.keys(r.overall).filter((k) => r.overall[k].clusters < THIN && k !== PROJECTION_SOURCE);
  const keys = Object.keys(r.overall)
    .filter((k) => !thin.includes(k))
    .sort((x, y) => (r.overall[y].lead ?? -9) - (r.overall[x].lead ?? -9));
  for (const k of keys) {
    const s = r.overall[k];
    const w = r.overallFit.weights[k];
    const flag = k === PROJECTION_SOURCE ? "  <- our projection (diagnostic only: see 3)" : "";
    console.log(`   ${pad(k, 18)}${lpad(s.n, 9)}${lpad(s.clusters, 9)}${lpad(f(s.lead, 2), 8)}${lpad(s.se ? f(1.96 * s.se, 2) : "-", 8)}${lpad(f(s.z, 1), 7)}${lpad(w === undefined ? "-" : f(w, 3), 9)}${flag}`);
  }
  if (thin.length) console.log(`   (not shown, under ${THIN} player-weeks: ${thin.join(", ")} — held at the prior)`);
  console.log(`\n   Prior weight ${a.priorWeight} for a book; evidence outweighs the prior at ${a.priorClusters} player-weeks.`);

  console.log("\n2. THE BOOKS' WEIGHTS AS THEY STOOD GOING INTO EACH WEEK   (fitted on earlier weeks only)");
  const sources = Object.keys(r.overallFit.weights)
    .filter((k) => !thin.includes(k))
    .sort((x, y) => (r.overallFit.weights[y] ?? 0) - (r.overallFit.weights[x] ?? 0));
  console.log(`   ${pad("source", 18)}${r.asOf.map((x) => lpad(`wk ${x.week}`, 8)).join("")}`);
  for (const k of sources) {
    console.log(`   ${pad(k, 18)}${r.asOf.map((x) => lpad(x.weights[k] === undefined ? "prior" : f(x.weights[k], 3), 8)).join("")}`);
  }
  console.log(`   ${pad("(trained on weeks)", 18)}${r.asOf.map((x) => lpad(x.trainedOnWeeks.length ? `${x.trainedOnWeeks[0]}-${x.trainedOnWeeks[x.trainedOnWeeks.length - 1]}` : "-", 8)).join("")}`);

  console.log("\n3. THE PROJECTION'S SHARE OF THE PRICE   (per stat and capture slot; fitted against OUTCOMES)");
  console.log("   logit P(over) = L_books + share · (L_proj − L_books). 0 = ignore the projection, 1 = believe it over the books.");
  console.log("   Live captures only — the projection we actually had on the day. A negative fit is reported, and priced as 0.\n");
  const cells = Object.keys(r.overallShares).sort();
  console.log(`   ${pad("stat | slot", 24)}${lpad("markets", 9)}${lpad("players", 9)}${lpad("fitted", 9)}${lpad("±95%", 8)}${lpad("z", 7)}${lpad("used", 8)}   as-of: ${r.asOf.map((x) => lpad(`wk ${x.week}`, 7)).join("")}`);
  for (const k of cells) {
    const c = r.overallShares[k];
    const [stat, slot] = k.split("|");
    console.log(
      `   ${pad(k.replace("|", " | "), 24)}${lpad(c.n, 9)}${lpad(c.clusters, 9)}${lpad(f(c.raw, 2), 9)}${lpad(c.se ? f(1.96 * c.se, 2) : "-", 8)}${lpad(f(c.z, 1), 7)}${lpad(f(c.share, 2), 8)}   ` +
        `        ${r.asOf.map((x) => lpad(f(shareFor(x.shares, stat, slot), 2), 7)).join("")}`
    );
  }
  const lead = r.overall[PROJECTION_SOURCE];
  if (lead) {
    console.log(
      `\n   For comparison, the books' yardstick (lead) puts the projection at ${f(lead.lead, 2)} (z ${f(lead.z, 1)}) on ${lead.clusters} player-weeks:\n` +
        `   it asks whether the market FOLLOWED the projection, which a daily-written projection read on Tuesday can only fail.`
    );
  }
  console.log(`   Shares are pulled toward 0 by a prior worth ${a.priorClusters} player-weeks and capped at ${MAX_PROJECTION_SHARE}; a cell with no live data prices on the books alone.`);

  console.log("\n4. DOES IT WORK?   (walk-forward: every week priced with weights and shares fitted on earlier weeks only)");
  console.log("   a) Held-out target. A pool of the RETAIL books at the early board, scored on how far it is from");
  console.log("      a sharp book's own price at the close — a price neither the pool nor its weights ever saw.");
  console.log(`      ${pad("target", 14)}${lpad("markets", 9)}${lpad("players", 9)}${lpad("MSE median", 12)}${lpad("MSE weighted", 14)}${lpad("diff", 10)}${lpad("z", 7)}`);
  for (const h of r.heldOut) {
    console.log(`      ${pad(h.target, 14)}${lpad(h.n, 9)}${lpad(h.clusters, 9)}${lpad(f(h.mseMedian, 4), 12)}${lpad(f(h.mseWeighted, 4), 14)}${lpad(f(h.diff, 4), 10)}${lpad(f(h.z, 1), 7)}`);
  }
  console.log("      negative diff = the weighted pool is closer to where the market went.\n");

  console.log("   b) Brier against what happened (paired difference, negative = better; clustered by player-week).");
  console.log(`      ${pad("comparison", 62)}${lpad("n", 7)}${lpad("diff", 10)}${lpad("z", 6)}   | near the money (market within ${NEAR_MONEY_MAX} of 50/50):${lpad("n", 7)}${lpad("diff", 10)}${lpad("z", 6)}`);
  for (const c of r.outcomes) {
    console.log(
      `      ${pad(c.label, 62)}${lpad(c.all.n, 7)}${lpad(f(c.all.mean, 5), 10)}${lpad(f(c.all.z, 1), 6)}   |${lpad("", 51)}${lpad(c.near.n, 7)}${lpad(f(c.near.mean, 5), 10)}${lpad(f(c.near.z, 1), 6)}`
    );
  }
  console.log(
    "\n   Read (b) as a check that weighting does no harm, not as evidence it helps: a Brier difference of 0.0005 needs far more\n" +
      "   player-weeks than a handful of weeks provide. The held-out price target in (a) is where the signal is."
  );
}

// ---------------------------------------------------------------------------
// The file capture-props reads
// ---------------------------------------------------------------------------

function buildPayload(season, r, a) {
  const byWeek = {};
  for (const x of r.asOf) {
    byWeek[String(x.week)] = {
      weights: x.weights,
      projectionShare: Object.fromEntries(Object.entries(x.shares).map(([k, c]) => [k, c.share])),
      trainedOnWeeks: x.trainedOnWeeks,
      shareWeeks: x.shareWeeks,
    };
  }
  return {
    season,
    generatedAt: new Date().toISOString(),
    params: { priorClusters: a.priorClusters, priorWeight: a.priorWeight, maxProjectionShare: MAX_PROJECTION_SHARE },
    // One entry per week, fitted on the weeks before it. A capture for week W
    // reads byWeek[W]; a backfill of an old week therefore prices with what that
    // week could have known, never later ones. The last entry is the live one.
    // capture-props computes the same thing from data/ when no file is given, so
    // this file is for auditing or pinning, not a dependency.
    byWeek,
    sources: Object.fromEntries(
      Object.entries(r.overall).map(([k, s]) => [k, { n: s.n, clusters: s.clusters, lead: s.lead, se: s.se, z: s.z, weight: r.overallFit.weights[k] ?? null }])
    ),
    projectionShares: r.overallShares,
  };
}

// ---------------------------------------------------------------------------

function main() {
  const a = parseArgs(process.argv.slice(2));
  const seasons = availableSeasons(a.dataDir);
  const season = a.season ?? seasons[seasons.length - 1];
  if (!season) throw new Error(`No prop captures under ${a.dataDir}/props/`);

  const { quotes, actualsByWeek } = loadSeason(season, { dataDir: a.dataDir });
  const r = analyse(quotes, actualsByWeek, a);
  if (r.pairs === 0) throw new Error("No early/closing pairs: needs a closing capture alongside an earlier one (see README, backfilling).");

  if (a.json) {
    console.log(JSON.stringify(buildPayload(season, r, a), null, 2));
  } else {
    printReport(season, r, a);
  }

  if (a.write) {
    const path = join(a.dataDir, "pricing", String(season), "source-weights.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(buildPayload(season, r, a), null, 2) + "\n");
    if (!a.json) console.log(`\nWrote ${path}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`source-weights: ${err.message}`);
  process.exitCode = 1;
}

