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
import { seasonForDate, currentNflWeek, projectionWeek } from "./lib/schedule.mjs";

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

const csvRowCount = (csv) => Math.max(0, csv.trim().split("\n").length - 1);

// Write only when the content actually changed, so a daily re-run that produces
// identical projections is a no-op (no needless commits). Returns what happened.
function writeCsvIfChanged(path, csv, a, { guardRollover = false } = {}) {
  const rows = csvRowCount(csv);
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;

  if (prev === csv) {
    console.log(`  unchanged: ${path} (${rows} rows) — no rewrite.`);
    return "unchanged";
  }

  // Guard against a week-rollover / partial feed replacing a good snapshot with
  // a much smaller one. Requesting a finished week can return an emptied set;
  // don't let that clobber the frozen forecast. --force overrides.
  if (guardRollover && prev !== null && !a.force) {
    const prevRows = csvRowCount(prev);
    if (rows < prevRows * 0.5) {
      console.log(
        `  refusing to shrink ${path} from ${prevRows} to ${rows} rows ` +
          `(looks like a week rollover / partial feed). Use --force to override.`
      );
      return "guarded";
    }
  }

  if (a.dryRun) {
    console.log(`  [dry-run] would ${prev === null ? "write" : "update"} ${path} (${rows} rows)`);
    return "dry-run";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
  console.log(`  ${prev === null ? "wrote" : "updated"} ${path} (${rows} rows)`);
  return prev === null ? "created" : "updated";
}

async function ingestProjections(a) {
  const week = a.week ?? projectionWeek(a.season, a.now);
  const path = projPath(a.dataDir, a.season, week);
  const urls = projectionUrls(week);
  console.log(`projections: fetching week ${week} (M/C/F)…`);
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

  const rows = normalizeProjections({ M, C, F }, { season: a.season, week, targetsByPlayer });
  if (rows.length === 0) throw new Error("projections: feeds returned 0 usable rows");
  // Refresh in place: the daily run keeps this week's projection current as
  // injuries and other context land, until the week's games roll it over.
  writeCsvIfChanged(path, toCsv(PROJECTION_COLUMNS, rows), a, { guardRollover: true });
}

async function ingestActuals(a) {
  const week = a.week ?? currentNflWeek(a.season, a.now);
  const startweek = a.startweek ?? week;
  const endweek = a.endweek ?? week;
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
  const rows = mergeActuals({ passing, rushing, receiving }, { season: a.season, week });
  if (rows.length === 0) throw new Error("actuals: feeds returned 0 usable rows");
  writeCsvIfChanged(actualPath(a.dataDir, a.season, week), toCsv(ACTUAL_COLUMNS, rows), a);
}

const HELP = `Ingest RotoWire projections + actuals into per-week snapshot CSVs.

  node scripts/ingest.mjs [options]

  --season <year>       Season to ingest (default: current NFL season by date)
  --week <n>            NFL week number. Default by date: projections use the
                        upcoming/in-progress week, actuals the completed week.
  --only <mode>         projections | actuals | both  (default: both)
  --startweek <n>       Actuals range start (default: resolved week)
  --endweek <n>         Actuals range end   (default: resolved week)
  --data-dir <path>     Output root (default: data)
  --force               Bypass the rollover guard (allow a smaller projection
                        set to replace a larger one)
  --dry-run             Fetch + normalize but do not write files
  -h, --help            Show this help

Projections refresh in place: a daily run keeps the current week's snapshot up
to date as injuries/context land, and is a no-op when nothing changed.

Env: ROTOWIRE_COOKIE (optional Cookie header), SEASON, WEEK.`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }

  a.now = new Date();
  if (a.season === undefined) a.season = Number(process.env.SEASON) || seasonForDate(a.now);
  if (a.week === undefined && process.env.WEEK) a.week = Number(process.env.WEEK);

  if (!Number.isFinite(a.season)) throw new Error(`Invalid season: ${a.season}`);
  if (a.week !== undefined && (!Number.isFinite(a.week) || a.week < 1)) {
    throw new Error(`Invalid week: ${a.week}`);
  }
  if (!["projections", "actuals", "both"].includes(a.only)) {
    throw new Error(`--only must be projections|actuals|both, got "${a.only}"`);
  }

  console.log(
    `Ingesting season=${a.season} week=${a.week ?? "auto"} only=${a.only}` +
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
