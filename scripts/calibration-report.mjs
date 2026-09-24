// Prints the quantile-calibration report for the built dashboard dataset:
// where each band line actually sits, how far it would have to move to be
// right, and whether that move survives a fit-early / test-late holdout.
//
// Run it before deciding to correct anything. The holdout is the part that
// matters — a fitted multiplier always looks perfect on the data it was fitted
// to, and with only a few weeks of actuals it usually makes later weeks worse.
//
// Usage:
//   npm run calibration-report
//   node scripts/calibration-report.mjs [--scope weekly|season]
//                                       [--metrics targets,rushAtt]
//                                       [--split N]   (fit on first N weeks)
//                                       [--boot N] [--seed N] [--json]
//                                       [--fantasy]   (relevant players only)
//                                       [--data public/data/dashboard.json]
//
// Reads the artifact `npm run build:data` produces, so the numbers match what
// the dashboard is showing rather than a parallel calculation.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, filterFantasyRows, LINES } from "./lib/calibration-report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_DATA = join(ROOT, "public", "data", "dashboard.json");

function parseArgs(argv) {
  const a = { scope: "weekly", boot: 4000, seed: 42, json: false, data: DEFAULT_DATA };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--scope": a.scope = next(); break;
      case "--metrics": a.metrics = new Set(next().split(",").map((s) => s.trim())); break;
      case "--split": a.split = Number(next()); break;
      case "--boot": a.boot = Number(next()); break;
      case "--seed": a.seed = Number(next()); break;
      case "--data": a.data = next(); break;
      case "--fantasy": a.fantasy = true; break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  if (!["weekly", "season", "team"].includes(a.scope)) {
    throw new Error(`--scope must be weekly|season|team, got "${a.scope}"`);
  }
  for (const [flag, v] of [["--boot", a.boot], ["--seed", a.seed]]) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${flag} must be a number, got "${v}"`);
  }
  if (a.split !== undefined && (!Number.isFinite(a.split) || a.split < 1)) {
    throw new Error(`--split must be a positive number of weeks, got "${a.split}"`);
  }
  return a;
}

const HELP = `Quantile-calibration report over the built dashboard dataset.

  node scripts/calibration-report.mjs [options]

  --scope <s>        weekly | season | team   (default: weekly)
                     team = offence-wide totals per team-week
  --metrics <list>   comma-separated metric keys (default: all)
  --split <n>        holdout: fit on the first n weeks, test on the rest
                     (default: first half)
  --boot <n>         bootstrap resamples for the intervals (default: 4000)
  --seed <n>         PRNG seed; intervals are reproducible (default: 42)
  --data <path>      dashboard.json to read (default: public/data/dashboard.json)
  --fantasy          grade only fantasy-relevant players (all QB, top 50 RB /
                     60 WR / 40 TE by PROJECTED PPR — never actual points)
  --json             emit the raw analysis as JSON instead of a table
  -h, --help         show this help

Run \`npm run build:data\` first if the dataset is missing or stale.`;

// ---- Formatting ----------------------------------------------------------
const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "n/a");
const signedPct = (k, d = 0) =>
  Number.isFinite(k) ? `${k >= 1 ? "+" : ""}${((k - 1) * 100).toFixed(d)}%` : "n/a";

function pointTable(reports, scope) {
  console.log("\n0. HOW CLOSE THE MEDIAN CAME");
  if (scope === "team") {
    console.log("   The primary read at team level. A team band is our own construction");
    console.log("   (the feed publishes one per player, none for a team), but a sum of");
    console.log("   medians is a fair estimate of the median of the sum.\n");
  } else {
    console.log("   Point accuracy of the median, independent of the band.\n");
  }
  console.log("   metric           N    mean err     MAE     WAPE   med %bias   rank corr");
  for (const r of reports) {
    const p = r.point;
    if (!p) continue;
    const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
    console.log(
      `   ${r.key.padEnd(14)} ${String(p.n).padStart(4)} ` +
        `${f(p.meanErr).padStart(10)} ${f(p.mae).padStart(7)} ` +
        `${(Number.isFinite(p.wape) ? (100 * p.wape).toFixed(1) + "%" : "n/a").padStart(8)} ` +
        `${(p.medianPctBias === null ? "n/a" : (100 * p.medianPctBias).toFixed(1) + "%").padStart(11)} ` +
        `${f(p.spearman).padStart(11)}`
    );
  }
  console.log("\n   mean err: + = actual came in ABOVE the projection (under-projected).");
  console.log("   WAPE: total absolute miss as a share of total actual. rank corr:");
  console.log("   did the projections order the field correctly (1.0 = perfectly)?");
}

function coverageTable(reports) {
  console.log("\n1. WHERE EACH BAND LINE ACTUALLY SITS");
  console.log("   Floor/Median/Ceiling are the 25th/50th/75th percentiles, so the");
  console.log("   share of actuals at or below each should be 25 / 50 / 75%.\n");
  console.log(
    "   metric        N     P<=F   (vs 25%)      P<=M   (vs 50%)      P<=C   (vs 75%)     within"
  );
  const unbanded = reports.filter((r) => !r.banded).map((r) => r.key);
  for (const r of reports) {
    const c = r.coverage;
    if (!c) continue;
    const cell = (line) => {
      const s = c[line];
      const flag = s.verdict === "solid" ? "**" : s.verdict === "suggestive" ? " *" : "  ";
      return `${pct(s.share).padStart(6)} z${s.z.toFixed(1).padStart(5)}${flag}`;
    };
    console.log(
      `   ${r.key.padEnd(12)} ${String(c.n).padStart(4)}  ` +
        `${cell("floor")}   ${cell("median")}   ${cell("ceiling")}   ` +
        `${pct(c.within).padStart(6)}`
    );
  }
  console.log("\n   ** = |z| >= 2.5 (solid)    * = |z| >= 1.5 (suggestive)    blank = noise");
  console.log("   within = share landing inside the band; should be 50%.");
  if (unbanded.length) {
    console.log(
      `   Omitted as unbanded: ${unbanded.join(", ")} — a ratio's Floor/Ceiling do ` +
        `not\n   order (the ceiling split raises both sides), so there is no band to score.`
    );
  }
}

function fitTable(reports) {
  console.log("\n\n2. HOW FAR EACH LINE WOULD HAVE TO MOVE");
  console.log("   The multiplier putting a line exactly on its target, with a 95%");
  console.log("   bootstrap interval. An interval spanning 0% is not an adjustment.\n");
  console.log("   metric        Floor              Median             Ceiling            inverts");
  for (const r of reports) {
    const f = r.fit;
    if (!f) continue; // unbanded — nothing to move
    const cell = (line) => {
      const m = f[line];
      if (!m) return "n/a".padEnd(18);
      const spans = m.ci.lo <= 1 && m.ci.hi >= 1;
      const txt = `${signedPct(m.k).padStart(5)} [${signedPct(m.ci.lo)},${signedPct(m.ci.hi)}]`;
      return (spans ? txt : txt + " !").padEnd(18);
    };
    console.log(
      `   ${r.key.padEnd(12)} ${cell("floor")} ${cell("median")} ${cell("ceiling")} ` +
        `${f.inversions > 0 ? String(f.inversions) : "-"}`
    );
  }
  console.log("\n   ! = interval excludes 0% (the move is distinguishable from nothing)");
  console.log("   inverts = rows where applying all three would put a line past its");
  console.log("   neighbour; any real implementation has to clamp floor <= median <= ceiling.");
}

function holdoutTable(reports) {
  const withHoldout = reports.filter((r) => r.holdout);
  if (withHoldout.length === 0) {
    console.log("\n\n3. HOLDOUT — skipped (needs at least two weeks of actuals).");
    return;
  }
  console.log("\n\n3. DOES THE CORRECTION SURVIVE DATA IT WASN'T FITTED TO?");
  console.log("   Fit the multipliers on the early weeks, score them on the later ones.");
  console.log("   Error = total distance from 25/50/75, in percentage points.\n");
  const h0 = withHoldout[0].holdout;
  console.log(
    `   fit on weeks [${h0.fitWeeks.join(",")}]  ->  test on weeks [${h0.testWeeks.join(",")}]\n`
  );
  console.log("   metric        fitted F/M/C          test err: as-is -> adjusted   verdict");
  for (const r of withHoldout) {
    const h = r.holdout;
    const fitted = LINES.map(([line]) => signedPct(h.fitted[line]?.k)).join("/");
    const verdict = h.improved ? "improved" : "MADE IT WORSE";
    console.log(
      `   ${r.key.padEnd(12)} ${fitted.padEnd(21)} ` +
        `${h.baselineError.toFixed(0).padStart(11)} -> ${h.adjustedError.toFixed(0).padEnd(8)}  ${verdict}`
    );
  }
  console.log(
    "\n   A correction that makes held-out weeks worse is fitting noise, however\n" +
      "   good it looked in section 2. Only ship the ones that improve here."
  );
}

function run() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }
  if (!existsSync(a.data)) {
    console.error(
      `No dataset at ${a.data}. Run \`npm run build:data\` first (it writes the ` +
        `artifact the dashboard reads).`
    );
    process.exitCode = 1;
    return;
  }

  const ds = JSON.parse(readFileSync(a.data, "utf8"));
  const pick = { weekly: ds, season: ds.season, team: ds.team }[a.scope];
  const metrics = a.scope === "weekly" ? ds.meta.metrics : pick?.metrics;
  const rows = a.scope === "weekly" ? ds.rows : pick?.rows;

  if (a.scope === "team" && !ds.team) {
    console.error(
      "This dataset has no team section — rebuild with `npm run build:data`."
    );
    process.exitCode = 1;
    return;
  }
  if (a.scope === "season" && !ds.season?.available) {
    console.error("Season scope is not available in this dataset (season incomplete).");
    process.exitCode = 1;
    return;
  }
  if (!rows || rows.length === 0) {
    console.error(`No rows in ${a.scope} scope — nothing to report.`);
    process.exitCode = 1;
    return;
  }

  // Team rows are whole offences; a fantasy cut on them is meaningless.
  if (a.fantasy && a.scope === "team") {
    throw new Error("--fantasy does not apply to --scope team (rows are whole offences)");
  }
  const ranks = (a.scope === "season" ? ds.season.fantasyRanks : ds.meta.fantasyRanks) ?? {};
  const graded = a.fantasy ? filterFantasyRows(rows, ranks) : rows;
  if (a.fantasy && graded.length === 0) {
    console.error(
      "No fantasy-relevant rows. This dataset predates the projected-PPR ranks — " +
        "rebuild with `npm run build:data`."
    );
    process.exitCode = 1;
    return;
  }

  const reports = analyze(graded, metrics, {
    only: a.metrics,
    samples: a.boot,
    seed: a.seed,
    split: a.split,
    // Season scope collapses every week into wk 0, so there is nothing to
    // hold out; skip rather than print a meaningless row.
    holdout: a.scope !== "season",
  });

  if (a.json) {
    console.log(JSON.stringify({ scope: a.scope, generatedAt: ds.meta?.generatedAt, reports }, null, 2));
    return;
  }

  console.log(
    `Calibration report — ${a.scope} scope, season ${ds.meta?.season ?? "?"}, ` +
      `source ${ds.meta?.dataSource ?? "?"}, built ${ds.meta?.generatedAt ?? "?"}`
  );
  if (a.scope === "weekly") {
    console.log(`Weeks present: ${(ds.meta?.weeks ?? []).join(", ") || "none"}`);
  }
  if (a.scope === "team") {
    console.log(
      `${ds.team.counts.teamWeeks} team-weeks across ${ds.team.teams.length} teams, ` +
        `weeks ${ds.team.weeks.join(", ")}.`
    );
  }
  console.log(`Bootstrap: ${a.boot} resamples, seed ${a.seed} (reproducible).`);
  if (a.fantasy) {
    const label = Object.entries(ranks)
      .map(([p, cap]) => (cap == null ? `all ${p}` : `top ${cap} ${p}`))
      .join(", ");
    console.log(
      `Fantasy-relevant only: ${label} by projected PPR ` +
        `(${graded.length} of ${rows.length} player-weeks).`
    );
  }
  pointTable(reports, a.scope);
  coverageTable(reports);
  fitTable(reports);
  holdoutTable(reports);
  console.log(
    "\n\nNOTE: this never rewrites a projection. The dashboard reports the upstream\n" +
      "feed's calibration; a band corrected here would report the correction instead.\n" +
      "A multiplier that survives section 3 belongs in the betting path — see the\n" +
      "reasoning already written up in scripts/lib/calibration.mjs.\n"
  );
}

// A bad flag is a typo, not a crash — print the reason, not a stack trace.
try {
  run();
} catch (err) {
  console.error(`calibration-report: ${err.message}`);
  process.exitCode = 1;
}
