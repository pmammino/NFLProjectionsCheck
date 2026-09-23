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
  ROSTER_COLUMNS,
  normalizeProjections,
  buildRoster,
  backfillTargets,
  mergeActuals,
  asRecords,
  toCsv,
} from "./lib/rotowire.mjs";
import { readCsv } from "./lib/csv.mjs";
import { seasonForDate, currentNflWeek, projectionWeek } from "./lib/schedule.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const POS = "QBRBWRTE";
const BASE = "https://www.rotowire.com/football/tables";

// Sanity thresholds. A full projection slate is hundreds of QB/RB/WR/TE; far
// fewer means RotoWire served its unauthenticated preview (needs a cookie).
const MIN_EXPECTED_PROJ_PLAYERS = 40;
const MIN_EXPECTED_ACTUAL_ROWS = 15;

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
const rosterPath = (dir, season) => join(ROOT, dir, "players", `${season}.csv`);

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

  // TARGETS_SOURCE: the feeds now project targets, read straight off each
  // record (see TARGET_FIELDS in lib/rotowire.mjs). This override stays for the
  // case where a better targets source turns up or the feed drops the column:
  // build a Map keyed by RotoWire playerid (value: a number, or a per-split
  // { M, C, F }) and it wins over the feed value.
  const targetsByPlayer = undefined;

  const rows = normalizeProjections({ M, C, F }, { season: a.season, week, targetsByPlayer });
  if (rows.length === 0) {
    console.warn("projections: feeds returned 0 rows — skipping write.");
    return;
  }
  // Targets drive the Targets volume metric plus every per-target receiving
  // rate, so an empty column means the feed renamed the field (or dropped it)
  // and a chunk of the dashboard goes quiet. Say so rather than silently
  // shipping blanks.
  const withTargets = rows.filter((r) => r.Targets !== "").length;
  if (withTargets === 0) {
    console.warn(
      `projections: no record carried a target projection — the feed field is ` +
        `missing or renamed. Add its name to TARGET_FIELDS in ` +
        `scripts/lib/rotowire.mjs (or supply targetsByPlayer); until then the ` +
        `Targets volume and per-target receiving rates are skipped.`
    );
  } else {
    console.log(`  targets projected for ${withTargets}/${rows.length} rows.`);
  }
  // RotoWire returns a small (~top-10) preview to unauthenticated requests and
  // the full slate only to a logged-in session. A full week is hundreds of
  // players across QB/RB/WR/TE; a tiny result almost always means no/expired
  // ROTOWIRE_COOKIE. Warn loudly — the row count makes the gate obvious in logs.
  const players = Math.round(rows.length / 3);
  if (players < MIN_EXPECTED_PROJ_PLAYERS) {
    console.warn(
      `projections: only ${players} players (${rows.length} rows) returned — this is ` +
        `RotoWire's unauthenticated preview. Set the ROTOWIRE_COOKIE secret to a ` +
        `logged-in session cookie to get the full slate.`
    );
  }
  // Refresh in place: the daily run keeps this week's projection current as
  // injuries and other context land, until the week's games roll it over.
  writeCsvIfChanged(path, toCsv(PROJECTION_COLUMNS, rows), a, { guardRollover: true });

  // Capture the name -> id crosswalk the OpticOdds join depends on. The
  // projection snapshot itself is keyed on PlayerID with no name, and this is
  // the only point in the pipeline where the feed's `player` field is still in
  // hand. Season-scoped and accumulating: a player who appears in any week
  // stays in the roster, so a mid-season capture can still resolve someone
  // whose team has since changed or who has dropped off the projection slate.
  const roster = buildRoster({ M, C, F });
  if (roster.length > 0) {
    const rPath = rosterPath(a.dataDir, a.season);
    const merged = mergeRoster(rPath, roster);
    writeCsvIfChanged(rPath, toCsv(ROSTER_COLUMNS, merged), a);
  }
}

// Merge this week's roster into whatever is already on disk. Newly-seen
// players are added; an existing player's name/team/position are refreshed to
// the latest (teams change mid-season, and the current team is what OpticOdds
// will be reporting).
function mergeRoster(path, roster) {
  const byId = new Map();
  if (existsSync(path)) {
    for (const row of readCsv(path)) {
      if (row.PlayerID) byId.set(row.PlayerID, row);
    }
  }
  for (const row of roster) byId.set(row.PlayerID, row);
  return [...byId.values()].sort((a, b) => Number(a.PlayerID) - Number(b.PlayerID));
}

// Back-fill the Targets column on already-frozen snapshots for weeks captured
// before the projection feeds carried a target count. Safe only because
// backfillTargets refuses to touch a week whose other columns have moved — see
// the note on that function. Never writes anything but the Targets column.
async function backfillProjectionTargets(a) {
  const startweek = a.startweek ?? a.week;
  const endweek = a.endweek ?? a.week;
  if (!Number.isFinite(startweek) || !Number.isFinite(endweek)) {
    throw new Error("--only backfill-targets needs --week (or --startweek/--endweek)");
  }

  let failures = 0;
  for (let week = startweek; week <= endweek; week++) {
    const path = projPath(a.dataDir, a.season, week);
    if (!existsSync(path)) {
      console.warn(`  week ${week}: no snapshot at ${path} — nothing to back-fill.`);
      continue;
    }
    const existing = readCsv(path);
    const blanks = existing.filter((r) => !r.Targets).length;
    if (blanks === 0) {
      console.log(`  week ${week}: every row already has targets — skipping.`);
      continue;
    }

    console.log(`  week ${week}: re-fetching to back-fill ${blanks} blank targets…`);
    const urls = projectionUrls(week);
    const [M, C, F] = await Promise.all([
      fetchJson(urls.M),
      fetchJson(urls.C),
      fetchJson(urls.F),
    ]);
    const feedRows = normalizeProjections({ M, C, F }, { season: a.season, week });
    const r = backfillTargets(existing, feedRows);

    // Any disagreement outside Targets means the endpoint is serving a revised
    // (post-game) forecast, not the one frozen here. Writing it would silently
    // corrupt the calibration baseline, so refuse and show what moved.
    if (r.conflicts.length > 0) {
      const cols = [...new Set(r.conflicts.map((c) => c.column))].join(", ");
      console.error(
        `  week ${week}: REFUSING to back-fill — the feed no longer matches the ` +
          `frozen snapshot in ${r.conflicts.length} value(s) across [${cols}]. ` +
          `The endpoint has revised this week, so its targets do not belong to ` +
          `the pre-game forecast. Examples:`
      );
      for (const c of r.conflicts.slice(0, 5)) {
        console.error(`    ${c.key} ${c.column}: frozen=${c.frozen} fetched=${c.fetched}`);
      }
      failures++;
      continue;
    }
    if (r.matched === 0) {
      console.error(`  week ${week}: feed matched none of the frozen rows — skipping.`);
      failures++;
      continue;
    }
    if (r.filled === 0) {
      console.error(
        `  week ${week}: feed matched ${r.matched} rows but carried no targets on ` +
          `any of them — the target field is missing or renamed (see TARGET_FIELDS).`
      );
      failures++;
      continue;
    }

    console.log(
      `  week ${week}: verified ${r.matched} rows unchanged; filling ${r.filled} ` +
        `targets (${r.missingFromFeed} rows absent from the feed keep blanks, ` +
        `${r.newInFeed} new feed rows ignored).`
    );
    writeCsvIfChanged(path, toCsv(PROJECTION_COLUMNS, r.rows), a);
  }
  if (failures > 0) throw new Error(`${failures} week(s) could not be back-filled`);
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
  if (rows.length === 0) {
    // Normal early in a week (no games completed yet) — don't fail the run.
    console.warn(
      `actuals: 0 rows for ${a.season} week ${week} — likely no completed games yet. Skipping write.`
    );
    return;
  }
  if (rows.length < MIN_EXPECTED_ACTUAL_ROWS) {
    console.warn(
      `actuals: only ${rows.length} rows — expected if just a game or two has been ` +
        `played, but if a full slate is done the stats feed may need ROTOWIRE_COOKIE.`
    );
  }
  writeCsvIfChanged(actualPath(a.dataDir, a.season, week), toCsv(ACTUAL_COLUMNS, rows), a);
}

const HELP = `Ingest RotoWire projections + actuals into per-week snapshot CSVs.

  node scripts/ingest.mjs [options]

  --season <year>       Season to ingest (default: current NFL season by date)
  --week <n>            NFL week number. Default by date: projections use the
                        upcoming/in-progress week, actuals the completed week.
  --only <mode>         projections | actuals | both | backfill-targets
                        (default: both). backfill-targets re-fetches an
                        already-captured week and writes ONLY its Targets
                        column, and only after verifying every other column
                        still matches the frozen snapshot. For weeks captured
                        before the feeds projected targets. Refuses the write
                        if the endpoint has revised the week.
  --startweek <n>       Actuals / back-fill range start (default: resolved week)
  --endweek <n>         Actuals / back-fill range end   (default: resolved week)
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
  if (!["projections", "actuals", "both", "backfill-targets"].includes(a.only)) {
    throw new Error(
      `--only must be projections|actuals|both|backfill-targets, got "${a.only}"`
    );
  }

  console.log(
    `Ingesting season=${a.season} week=${a.week ?? "auto"} only=${a.only}` +
      (a.dryRun ? " (dry-run)" : "")
  );

  // A back-fill is a repair of past weeks, not part of the normal capture, so
  // it runs alone and never alongside a fresh ingest.
  if (a.only === "backfill-targets") {
    try {
      await backfillProjectionTargets(a);
    } catch (err) {
      console.error("backfill-targets failed:", err.message);
      process.exitCode = 1;
    }
    console.log("Done.");
    return;
  }

  // Run each artifact independently so a fetch error in one (or an empty feed)
  // never blocks the other — the workflow commits whatever was written.
  let failures = 0;
  if (a.only === "projections" || a.only === "both") {
    try {
      await ingestProjections(a);
    } catch (err) {
      console.error("projections failed:", err.message);
      failures++;
    }
  }
  if (a.only === "actuals" || a.only === "both") {
    try {
      await ingestActuals(a);
    } catch (err) {
      console.error("actuals failed:", err.message);
      failures++;
    }
  }

  console.log("Done.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ingest failed:", err.message);
  process.exit(1);
});
