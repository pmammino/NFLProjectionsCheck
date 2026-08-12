// Weekly ingestion CLI: fetch RotoWire's live projection + player-stats feeds
// for a given season/week, normalize them into the dashboard's CSV schemas, and
// write per-week snapshot files under data/. Those snapshots are the durable
// record — once a completed week is committed, the numbers stay put even after
// RotoWire rolls its endpoints forward to the next week.
//
// Why snapshots (and why projections are captured once):
//   The projection endpoints take a `week` param but no `season` param, so they
//   only ever serve the *current* season and are effectively forward-looking.
//   You cannot re-fetch a past week's pre-game projection after the fact — hence
//   we capture projections early in the week and never overwrite them. The
//   player-stats endpoints DO take season+week, so actuals can be (re)fetched
//   and are rewritten to pick up stat corrections.
//
// Usage:
//   node scripts/ingest.mjs [--season 2025] [--week 1]
//                           [--only projections|actuals|both]
//                           [--startweek N --endweek N]   (actuals range; default = week)
//                           [--data-dir data] [--force] [--dry-run]
//
// Env:
//   ROTOWIRE_COOKIE   optional Cookie header, if the feeds require a session.
//   SEASON / WEEK     fallback values for --season / --week.
//
// Exit codes: 0 on success (including "nothing to do"), 1 on fetch/parse error.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECTION_COLUMNS,
  ACTUAL_COLUMNS,
  normalizeProjections,
  mergeActuals,
  asRecords,
  toCsv,
} from "./lib/rotowire.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const POS = "QBRBWRTE";
const BASE = "https://www.rotowire.com/football/tables";

// ---- Feed URLs ---------------------------------------------------------------
const projectionUrls = (week) => ({
  M: `${BASE}/weekly-projections.php?pos=${POS}&week=${week}`,
  C: `${BASE}/projections-ceil-floor-weekly.php?pos=${POS}&week=${week}&ceilFloor=C`,
  F: `${BASE}/projections-ceil-floor-weekly.php?pos=${POS}&week=${week}&ceilFloor=F`,
});
// timeperiod = start week, endweek = end week; start=end=week isolates one week.
const statsUrls = (season, startweek, endweek) => {
  const q = (view) =>
    `${BASE}/player-stats.php?view=${view}&type=basic&scoring=standard` +
    `&season=${season}&timeperiod=${startweek}&pergame=totals&endweek=${endweek}&position=ALL`;
  return { passing: q("passing"), rushing: q("rushing"), receiving: q("receiving") };
};

// ---- Arg parsing -------------------------------------------------------------
function parseArgs(argv) {
  const a = { only: "both", force: false, dryRun: false, dataDir: "data" };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--season": a.season = Number(next()); break;
      case "--week": a.week = Number(next()); break;
      case "--startweek": a.startweek = Number(next()); break;
      case "--endweek": a.endweek = Number(next()); break;
      case "--only": a.only = next(); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--force": a.force = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Unknown argument: ${t}`);
    }
  }
  return a;
}

// NFL Week-1 kickoff (Thursday) per season. Add new seasons here so the cron can
// resolve the current week without a manual --week. Explicit --week always wins.
const SEASON_START = {
  2024: "2024-09-05",
  2025: "2025-09-04",
  2026: "2026-09-10",
};

// The season a given date belongs to (the season spans Sep–Feb, so Jan/Feb
// dates belong to the prior calendar year's season).
function seasonForDate(d) {
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// Best-effort "current NFL week" for a date, clamped to 1..18. Heuristic only —
// use --week for anything that must be exact.
function currentNflWeek(season, d) {
  const start = SEASON_START[season];
  if (!start) return 1;
  const startMs = Date.parse(start + "T00:00:00Z");
  const week = Math.floor((d.getTime() - startMs) / (7 * 86400_000)) + 1;
  return Math.min(18, Math.max(1, week));
}

async function fetchJson(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: "https://www.rotowire.com/football/",
  };
  if (process.env.ROTOWIRE_COOKIE) headers.Cookie = process.env.ROTOWIRE_COOKIE;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON response from ${url} (first 200 chars): ${text.slice(0, 200)}`
    );
  }
}

const pad2 = (n) => String(n).padStart(2, "0");
const projPath = (dir, season, week) =>
  join(ROOT, dir, "projections", String(season), `week-${pad2(week)}.csv`);
const actualPath = (dir, season, week) =>
  join(ROOT, dir, "actuals", String(season), `week-${pad2(week)}.csv`);

function writeCsv(path, csv, { dryRun }) {
  if (dryRun) {
    console.log(`  [dry-run] would write ${path} (${csv.split("\n").length - 2} rows)`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
  console.log(`  wrote ${path} (${csv.split("\n").length - 2} rows)`);
}

async function ingestProjections(a) {
  const path = projPath(a.dataDir, a.season, a.week);
  if (existsSync(path) && !a.force) {
    console.log(
      `projections: ${path} already exists — keeping the captured forecast (use --force to overwrite).`
    );
    return;
  }
  const urls = projectionUrls(a.week);
  console.log(`projections: fetching week ${a.week} (M/C/F)…`);
  const [M, C, F] = await Promise.all([
    fetchJson(urls.M),
    fetchJson(urls.C),
    fetchJson(urls.F),
  ]);

  // TARGETS_SOURCE: these feeds project receptions, not targets. When a targets
  // source is located, fetch it here and build a Map keyed by RotoWire playerid
  // (value: a number, or a per-split { M, C, F }); passing it below fills the
  // Targets column and re-enables the target-denominated receiving metrics.
  const targetsByPlayer = undefined;

  const rows = normalizeProjections(
    { M, C, F },
    { season: a.season, week: a.week, targetsByPlayer }
  );
  if (rows.length === 0) throw new Error("projections: feeds returned 0 usable rows");
  writeCsv(path, toCsv(PROJECTION_COLUMNS, rows), a);
}

async function ingestActuals(a) {
  const startweek = a.startweek ?? a.week;
  const endweek = a.endweek ?? a.week;
  const urls = statsUrls(a.season, startweek, endweek);
  console.log(
    `actuals: fetching ${a.season} weeks ${startweek}-${endweek} (passing/rushing/receiving)…`
  );
  const [passing, rushing, receiving] = await Promise.all([
    fetchJson(urls.passing),
    fetchJson(urls.rushing),
    fetchJson(urls.receiving),
  ]);
  // Sanity-check the feeds parsed to arrays before merging.
  asRecords(passing);
  const rows = mergeActuals({ passing, rushing, receiving }, {
    season: a.season,
    week: a.week,
  });
  if (rows.length === 0) throw new Error("actuals: feeds returned 0 usable rows");
  writeCsv(actualPath(a.dataDir, a.season, a.week), toCsv(ACTUAL_COLUMNS, rows), a);
}

const HELP = `Ingest RotoWire projections + actuals into per-week snapshot CSVs.

  node scripts/ingest.mjs [options]

  --season <year>       Season to ingest (default: current NFL season by date)
  --week <n>            NFL week number (default: current week by date)
  --only <mode>         projections | actuals | both  (default: both)
  --startweek <n>       Actuals range start (default: --week)
  --endweek <n>         Actuals range end   (default: --week)
  --data-dir <path>     Output root (default: data)
  --force               Overwrite an existing projections snapshot
  --dry-run             Fetch + normalize but do not write files
  -h, --help            Show this help

Env: ROTOWIRE_COOKIE (optional Cookie header), SEASON, WEEK.`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }

  const now = new Date();
  if (a.season === undefined) a.season = Number(process.env.SEASON) || seasonForDate(now);
  if (a.week === undefined)
    a.week = Number(process.env.WEEK) || currentNflWeek(a.season, now);

  if (!Number.isFinite(a.season) || !Number.isFinite(a.week) || a.week < 1) {
    throw new Error(`Invalid season/week: season=${a.season} week=${a.week}`);
  }
  if (!["projections", "actuals", "both"].includes(a.only)) {
    throw new Error(`--only must be projections|actuals|both, got "${a.only}"`);
  }

  console.log(
    `Ingesting season=${a.season} week=${a.week} only=${a.only}` +
      (a.dryRun ? " (dry-run)" : "")
  );

  if (a.only === "projections" || a.only === "both") await ingestProjections(a);
  if (a.only === "actuals" || a.only === "both") await ingestActuals(a);

  console.log("Done.");
}

main().catch((err) => {
  console.error("ingest failed:", err.message);
  process.exit(1);
});
