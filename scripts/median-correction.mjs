// Is the projected "Median" in the right place, should we move it, and did
// moving it help?
//
// Three questions, in the order you should ask them:
//
//   1. WHAT WOULD BE APPLIED NOW. The as-of fit per stat, and for every stat
//      that is not applied, the reason. A report that only listed what it did
//      would hide the passAtt episode: on the week-3 refit passAtt cleared the
//      significance bar and applying it made things worse. The allowlist is
//      what stopped that, and this table is where you can see it working.
//
//   2. WHETHER IT IS STABLE. The same multiplier re-fitted as each week
//      arrives. A correction that wanders is fitting noise; one that holds
//      steady across as-of weeks is measuring something.
//
//   3. WHETHER IT HELPED, OUT OF SAMPLE. Each week re-priced with a fit that
//      saw only earlier weeks, scored against what happened and against the
//      market, near the money — where a bet is decided. This is the only
//      section that can argue for switching `--median-correction auto` on.
//
// It never edits a projection or a price on disk. The capture path applies the
// correction at pricing time and records the multiplier in each row.
//
// Usage:
//   npm run median-correction
//   node scripts/median-correction.mjs [--season 2026] [--as-of-week N]
//                                      [--data-dir data] [--json]

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fitFromData,
  evaluateWalkForward,
  loadTrainingPairs,
  loadSnapshot,
  formatFits,
  CORRECTABLE_STATS,
  SOLID_Z,
  MIN_TRAIN_N,
} from "./lib/median-correction.mjs";
import { loadSeason, buildSamples } from "./lib/pricing-dataset.mjs";
import { STAT_DEFS } from "./lib/markets.mjs";
import { probOverContinuous } from "./lib/probability.mjs";
import { scoreProbabilities, pairedBrierDiff, clusterKey, isNearMoney, NEAR_MONEY_MAX } from "./lib/pricing.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const a = { dataDir: join(ROOT, "data") };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--as-of-week": a.asOf = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  return a;
}

const HELP = `Re-centre the projected Floor/Median/Ceiling — what would apply, whether it holds, whether it helped.

  node scripts/median-correction.mjs [options]

  --season <y>       season to read (default: latest with projections)
  --as-of-week <n>   fit on weeks strictly before n (default: after the last completed week)
  --data-dir <p>     data directory (default: ./data)
  --json             emit the analysis as JSON instead of tables
  -h, --help         show this help

Section 3 is the one that can argue for turning the correction on. In-sample
fits are shown for contrast and are flattering by construction.`;

const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "n/a");
const num = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x, d = 4) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

const weekNumbers = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).map((f) => f.match(/^week-(\d+)\.csv$/)).filter(Boolean).map((m) => Number(m[1])).sort((x, y) => x - y)
    : [];

function run() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }

  const projDir = join(a.dataDir, "projections");
  if (!existsSync(projDir)) throw new Error(`No projection snapshots under ${projDir}`);
  const seasons = readdirSync(projDir).filter((d) => /^\d{4}$/.test(d)).map(Number).sort();
  const season = a.season ?? seasons[seasons.length - 1];
  if (!season) throw new Error(`No seasons under ${projDir}`);

  const projWeeks = new Set(weekNumbers(join(projDir, String(season))));
  const completed = weekNumbers(join(a.dataDir, "actuals", String(season))).filter((w) => projWeeks.has(w));
  if (completed.length === 0) throw new Error(`No week has both a projection snapshot and actuals for ${season}.`);
  const asOf = a.asOf ?? Math.max(...completed) + 1;

  // 1. what applies now
  const now = fitFromData({ dataDir: a.dataDir, season, beforeWeek: asOf });

  // 2. stability: refit as each week arrives
  const stability = completed
    .filter((w) => w >= 2)
    .map((w) => ({ asOf: w, ...fitFromData({ dataDir: a.dataDir, season, beforeWeek: w }) }));

  // 3. out of sample, near the money
  const evalResult = evaluate(a, season, completed);

  if (a.json) {
    console.log(JSON.stringify({ season, asOf, now, stability, evaluation: evalResult }, null, 2));
    return;
  }

  console.log(`Median correction — season ${season}, weeks with results: ${completed.join(", ")}\n`);

  console.log(`1. WHAT WOULD BE APPLIED NOW (fit on weeks ${now.weeksUsed.join(", ") || "none"}; prices week ${asOf})`);
  console.log(
    `   P(<=M) is the share of actuals at or below the projected "Median" — it should be 50%.\n` +
      `   A correction applies only for an eligible stat (${CORRECTABLE_STATS.join(", ")}), on at least\n` +
      `   ${MIN_TRAIN_N} player-weeks, with |z| >= ${SOLID_Z}.\n`
  );
  for (const line of formatFits(now.fits)) console.log(`   ${line}`);

  console.log(`\n2. IS IT STABLE? The median multiplier kM, re-fitted as each week arrives`);
  console.log(`   ${pad("priced week", 13)}${CORRECTABLE_STATS.map((s) => lpad(s + " kM (z)", 20)).join("")}`);
  console.log(`   ${"-".repeat(13 + 20 * CORRECTABLE_STATS.length)}`);
  for (const s of stability) {
    const cells = CORRECTABLE_STATS.map((st) => {
      const f = s.fits[st];
      return lpad(f?.n ? `${f.kM.toFixed(2)} (z ${f.z.toFixed(1)})${f.applied ? "" : " -"}` : "—", 20);
    });
    console.log(`   ${pad("week " + s.asOf, 13)}${cells.join("")}`);
  }
  console.log(`   A trailing "-" means not applied that week. Steady values are a measurement; wandering ones are noise.`);

  if (!evalResult) {
    console.log(`\n3. OUT OF SAMPLE — skipped: no odds captures to score against. Run a capture first.`);
    return;
  }
  printEvaluation(evalResult);
}

// ---- section 3 --------------------------------------------------------------

function evaluate(a, season, completed) {
  let loaded;
  try {
    loaded = loadSeason(season, { dataDir: a.dataDir });
  } catch {
    return null;
  }
  // Retail consensus, continuous stats only: a Poisson stat has no F/M/C band
  // to re-centre.
  const samples = buildSamples(loaded.quotes, loaded.actualsByWeek, { marketSet: "retail" }).samples.filter(
    (s) => STAT_DEFS[s.stat]?.kind === "continuous"
  );

  const snaps = new Map();
  for (const w of completed) snaps.set(w, loadSnapshot(a.dataDir, season, w));
  const fmcOf = (s) => {
    const sp = snaps.get(s.week)?.get(String(s.playerId));
    if (!sp?.F || !sp?.M || !sp?.C) return null;
    const cols = STAT_DEFS[s.stat].projCols;
    const sum = (row) => cols.reduce((t, c) => t + (Number(row[c]) || 0), 0);
    return { F: sum(sp.F), M: sum(sp.M), C: sum(sp.C) };
  };

  // Every completed week's pairs, from the same loader the capture path uses.
  // evaluateWalkForward takes only the weeks strictly before each one it
  // prices, so what is scored is what would have been applied.
  const { pairsByWeek } = loadTrainingPairs({ dataDir: a.dataDir, season });

  const testWeeks = new Set(completed.filter((w) => w >= 2));
  const inScope = samples.filter((s) => testWeeks.has(s.week));
  const all = evaluateWalkForward(inScope, { pairsByWeek, fmcOf, priceFn: probOverContinuous });

  // A row whose stored price does not match the snapshot's F/M/C was priced off
  // a different projection (the Tuesday drop, captured before the final
  // refresh). Re-pricing it from today's snapshot would compare two different
  // projections, so it is excluded and counted.
  const rows = all.filter((r) => r.consistent);
  const excludedBySlot = {};
  for (const r of all) if (!r.consistent) excludedBySlot[r.slot] = (excludedBySlot[r.slot] ?? 0) + 1;
  const near = rows.filter((r) => isNearMoney(r.pMarket));

  const summarize = (subset, pOf) => {
    const sc = scoreProbabilities(subset.map((r) => ({ p: pOf(r), y: r.y })));
    const d = pairedBrierDiff(subset.map((r) => ({ p: pOf(r), q: r.pMarket, y: r.y, cluster: clusterKey(r) })));
    return { n: subset.length, lean: sc.meanPred - sc.baseRate, meanP: sc.meanPred, observed: sc.baseRate, brier: sc.brier, vsMarket: d };
  };

  const byStat = [...new Set(near.map((r) => r.stat))].sort().map((stat) => {
    const sub = near.filter((r) => r.stat === stat);
    return {
      stat,
      n: sub.length,
      applied: sub.filter((r) => r.applied).length,
      raw: scoreProbabilities(sub.map((r) => ({ p: r.pProj, y: r.y }))).brier,
      corrected: scoreProbabilities(sub.map((r) => ({ p: r.pCorrected, y: r.y }))).brier,
      market: scoreProbabilities(sub.map((r) => ({ p: r.pMarket, y: r.y }))).brier,
    };
  });

  return {
    testWeeks: [...testWeeks].sort((x, y) => x - y),
    rowsInScope: inScope.length,
    excludedInconsistent: all.length - rows.length,
    excludedBySlot,
    nearRows: near.length,
    nearAppliedShare: near.length ? near.filter((r) => r.applied).length / near.length : 0,
    raw: summarize(near, (r) => r.pProj),
    corrected: summarize(near, (r) => r.pCorrected),
    market: scoreProbabilities(near.map((r) => ({ p: r.pMarket, y: r.y }))),
    byStat,
  };
}

function printEvaluation(e) {
  console.log(`\n3. DID IT HELP, OUT OF SAMPLE? Each week re-priced with a fit that saw only EARLIER weeks.`);
  console.log(
    `   Near the money only (market within ${NEAR_MONEY_MAX} of 50/50, where a bet is decided), weeks ${e.testWeeks.join(", ")}.\n` +
      `   ${e.nearRows} markets; ${pct(e.nearAppliedShare, 0)} of them took a correction. ` +
      ""
  );
  if (e.excludedInconsistent) {
    const where = Object.entries(e.excludedBySlot).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(
      `   Excluded ${e.excludedInconsistent} rows (${where}): their stored price came from a different projection\n` +
        `   than the frozen snapshot — the Tuesday drop is priced before the week's last refresh, so re-pricing it\n` +
        `   from today's F/M/C would compare two projections. Scored slots were priced from the frozen snapshot.`
    );
  }
  console.log(
    `\n   ${pad("price", 22)}${lpad("mean P(over)", 14)}${lpad("observed", 10)}${lpad("lean", 9)}${lpad("Brier", 9)}${lpad("vs market", 12)}${lpad("z", 7)}`
  );
  console.log(`   ${"-".repeat(83)}`);
  for (const [label, r] of [["raw projection", e.raw], ["corrected", e.corrected]]) {
    console.log(
      `   ${pad(label, 22)}${lpad(pct(r.meanP), 14)}${lpad(pct(r.observed), 10)}${lpad(sgn(r.lean * 100, 1) + "pt", 9)}` +
        `${lpad(num(r.brier), 9)}${lpad(sgn(r.vsMarket.mean, 5), 12)}${lpad(sgn(r.vsMarket.z, 2), 7)}`
    );
  }
  console.log(
    `   ${pad("the market", 22)}${lpad(pct(e.market.meanPred), 14)}${lpad(pct(e.market.baseRate), 10)}` +
      `${lpad(sgn((e.market.meanPred - e.market.baseRate) * 100, 1) + "pt", 9)}${lpad(num(e.market.brier), 9)}`
  );
  console.log(
    `   Positive "vs market" = worse than the book. Clustered by player-week (${e.raw.vsMarket.clusters} clusters).\n` +
      `   Read "lean" against the MARKET's row, not against zero: the observed rate leaves out players who\n` +
      `   recorded nothing (the actuals feed has no all-zero rows), which are the unders, so every price\n` +
      `   reads low against it.`
  );

  const rawGap = e.raw.vsMarket.mean;
  const closed = rawGap > 0 ? (rawGap - e.corrected.vsMarket.mean) / rawGap : NaN;
  if (Number.isFinite(closed)) {
    console.log(
      `\n   The correction closes ${pct(closed, 0)} of the raw projection's gap to the market.` +
        (closed < 0.5
          ? `\n   The rest is not a tilt a multiplier can remove: it is the projection carrying less\n` +
            `   information than the book. Treat this as hygiene, not as an edge.`
          : "")
    );
  }

  console.log(`\n   By stat, near the money (Brier, lower is better):`);
  console.log(
    `   ${pad("stat", 14)}${lpad("n", 8)}${lpad("corrected", 11)}${lpad("raw", 9)}${lpad("corrected", 11)}${lpad("market", 9)}`
  );
  console.log(`   ${pad("", 14)}${lpad("", 8)}${lpad("rows", 11)}${lpad("Brier", 9)}${lpad("Brier", 11)}${lpad("Brier", 9)}`);
  console.log(`   ${"-".repeat(62)}`);
  for (const s of e.byStat) {
    if (s.n < 300) continue;
    console.log(
      `   ${pad(s.stat, 14)}${lpad(s.n, 8)}${lpad(pct(s.applied / s.n, 0), 11)}${lpad(num(s.raw), 9)}${lpad(num(s.corrected), 11)}${lpad(num(s.market), 9)}`
    );
  }
  console.log(
    `\n   A stat that is not eligible reads identically raw and corrected, by design.\n` +
      `   Turn it on with: capture-props --median-correction auto  (default: off)`
  );
}

try {
  run();
} catch (err) {
  console.error(`median-correction: ${err.message}`);
  process.exitCode = 1;
}
