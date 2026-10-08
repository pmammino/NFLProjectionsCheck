// Builds public/data/lines/ for the Line Pricer tab: the captured price board,
// compacted so a browser can search it. Runs on predev/prebuild alongside the
// other dataset builds; the output is generated and not committed.
//
// One file per (week, slot) plus an index. See lib/lines-index.mjs for what is
// in a file and why a slot is never merged with another.
//
// ---------------------------------------------------------------------------
// Build time, and why this one is incremental
// ---------------------------------------------------------------------------
// The board is ~105,000 rows per week per capture and reading it costs about
// four seconds a file, so a cold build of a full season's recent weeks is
// close to a minute. That is fine on a deploy and unacceptable on every
// `npm run dev`. Each output is therefore keyed by a fingerprint of everything
// it was built from — the capture, that week's projection snapshot and
// actuals, every earlier week's (the median correction is fitted on them), and
// the source of the builder itself — and is skipped when nothing changed. A
// fresh clone has no cache and builds everything.
//
// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------
// ~3 MB raw (0.5 MB gzipped) per full board per week. A season is 18 weeks and
// up to four captures each, which would put ~200 MB of JSON in public/, so only
// the latest LINES_MAX_WEEKS weeks are built (default 6) and older files are
// removed. Raise it for a longer look-back.
//
// Env: SEASON, LINES_MAX_WEEKS, LINES_DATA_DIR, LINES_OUT_DIR, LINES_CACHE.
// Flag: --force rebuilds everything.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { readPropRow } from "./lib/pricing-dataset.mjs";
import { SLOT_MAIN } from "./lib/slots.mjs";
import { fitFromData, loadSnapshot } from "./lib/median-correction.mjs";
import { buildSlotFile, buildIndex, selectWeeks, LINES_SCHEMA_VERSION } from "./lib/lines-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = process.env.LINES_DATA_DIR ?? join(ROOT, "data");
const OUT_DIR = process.env.LINES_OUT_DIR ?? join(ROOT, "public", "data", "lines");
const CACHE = process.env.LINES_CACHE ?? join(ROOT, "node_modules", ".cache", "nfl-lines-manifest.json");
const MAX_WEEKS = Number(process.env.LINES_MAX_WEEKS ?? 6);
const FORCE = process.argv.includes("--force");

// Source files whose contents change the output. Hashed, so editing the
// builder invalidates the cache without anyone remembering to bump a version.
const BUILDER_SOURCES = [
  "scripts/build-lines-data.mjs",
  "scripts/lib/lines-index.mjs",
  "scripts/lib/median-correction.mjs",
  "scripts/lib/consensus.mjs",
  "scripts/lib/pricing-dataset.mjs",
  "scripts/lib/probability.mjs",
  "scripts/lib/markets.mjs",
  "scripts/lib/books.mjs",
];

const pad2 = (n) => String(n).padStart(2, "0");
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

const builderHash = () =>
  sha1(BUILDER_SOURCES.map((f) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "")).join("\n--\n"));

// size:mtime of a file, or "-" when it does not exist. A missing input is part
// of the fingerprint: a week whose actuals arrive later must rebuild.
const stamp = (path) => {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "-";
  }
};

const weekFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .map((f) => f.match(/^week-(\d+)\.csv$/))
        .filter(Boolean)
        .map((m) => Number(m[1]))
    : [];

// Every capture of a season: the Tuesday drop at the top level, any other slot
// one directory down.
function discoverCaptures(season) {
  const dir = join(DATA_DIR, "props", String(season));
  const out = [];
  if (!existsSync(dir)) return out;
  for (const week of weekFiles(dir)) out.push({ week, slot: SLOT_MAIN, path: join(dir, `week-${pad2(week)}.csv`) });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const week of weekFiles(join(dir, entry.name))) {
      out.push({ week, slot: entry.name, path: join(dir, entry.name, `week-${pad2(week)}.csv`) });
    }
  }
  return out;
}

function resolveSeason() {
  if (process.env.SEASON) return process.env.SEASON;
  const base = join(DATA_DIR, "props");
  if (!existsSync(base)) return null;
  const seasons = readdirSync(base).filter((d) => /^\d{4}$/.test(d)).sort();
  return seasons[seasons.length - 1] ?? null;
}

const fileName = (season, week, slot) => `${season}-w${pad2(week)}-${slot}.json`;

function loadManifest() {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const t0 = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });
  const season = resolveSeason();
  const generatedAt = new Date().toISOString();

  const all = season ? discoverCaptures(season) : [];
  if (!season || all.length === 0) {
    // No captures yet: write an empty index so the tab shows an empty state
    // rather than a 404, the same choice the betting build makes.
    writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(buildIndex({ season: season ? Number(season) : null, entries: [], generatedAt })));
    console.log("lines: no prop captures found — wrote an empty index.");
    return;
  }

  const keepWeeks = new Set(selectWeeks(all.map((c) => c.week), MAX_WEEKS));
  const captures = all.filter((c) => keepWeeks.has(c.week)).sort((a, b) => a.week - b.week || a.slot.localeCompare(b.slot));

  const actualsDir = join(DATA_DIR, "actuals", String(season));
  const projDir = join(DATA_DIR, "projections", String(season));
  const actualsWeeks = new Set(weekFiles(actualsDir));
  const source = builderHash();
  const prev = FORCE ? {} : loadManifest();
  const next = {};
  const entries = [];
  const expected = new Set(["index.json"]);
  let built = 0;
  let skipped = 0;

  for (const c of captures) {
    const file = fileName(season, c.week, c.slot);
    expected.add(file);
    const outPath = join(OUT_DIR, file);

    // Everything this file depends on. The median correction is fitted on every
    // EARLIER week's projections and actuals, so those are inputs too.
    const earlier = [...new Set([...weekFiles(actualsDir), ...weekFiles(projDir)])].filter((w) => w < c.week).sort((a, b) => a - b);
    const fingerprint = sha1(
      [
        LINES_SCHEMA_VERSION,
        source,
        stamp(c.path),
        stamp(join(actualsDir, `week-${pad2(c.week)}.csv`)),
        stamp(join(projDir, `week-${pad2(c.week)}.csv`)),
        ...earlier.flatMap((w) => [stamp(join(actualsDir, `week-${pad2(w)}.csv`)), stamp(join(projDir, `week-${pad2(w)}.csv`))]),
      ].join("|")
    );

    const cached = prev[file];
    if (cached && cached.fingerprint === fingerprint && existsSync(outPath)) {
      next[file] = cached;
      entries.push({ week: c.week, slot: c.slot, file, markets: cached.markets, players: cached.players, bytes: cached.bytes });
      skipped++;
      continue;
    }

    const quotes = readCsv(c.path).map((r) => readPropRow(r, c.slot)).filter(Boolean);
    const snapshot = loadSnapshot(DATA_DIR, season, c.week);
    const actualsPath = join(actualsDir, `week-${pad2(c.week)}.csv`);
    const actuals = existsSync(actualsPath)
      ? new Map(readCsv(actualsPath).map((r) => [String(r.PlayerID), r]))
      : new Map();
    // As of THIS week: weeks strictly before it. A line priced in week 3 is
    // shown with the correction week 3 could have known, never week 4's.
    const { fits } = fitFromData({ dataDir: DATA_DIR, season: Number(season), beforeWeek: c.week });

    const data = buildSlotFile({
      season: Number(season),
      week: c.week,
      slot: c.slot,
      quotes,
      snapshot,
      actuals,
      correction: fits,
      generatedAt,
    });
    const json = JSON.stringify(data);
    writeFileSync(outPath, json);
    const meta = { fingerprint, markets: data.counts.markets, players: data.counts.players, bytes: json.length };
    next[file] = meta;
    entries.push({ week: c.week, slot: c.slot, file, markets: meta.markets, players: meta.players, bytes: meta.bytes });
    built++;
    console.log(`  lines: week ${c.week} ${c.slot.padEnd(10)} ${String(meta.markets).padStart(6)} lines, ${String(meta.players).padStart(3)} players, ${(json.length / 1e6).toFixed(2)} MB`);
  }

  writeFileSync(
    join(OUT_DIR, "index.json"),
    JSON.stringify(buildIndex({ season: Number(season), entries, actualsWeeks, generatedAt }))
  );

  // Remove anything this run did not produce: a week that aged out of the
  // window, or a slot that no longer exists. Otherwise public/ only ever grows.
  let removed = 0;
  for (const f of readdirSync(OUT_DIR)) {
    if (!expected.has(f)) {
      rmSync(join(OUT_DIR, f), { force: true });
      removed++;
    }
  }

  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(next));

  const total = entries.reduce((s, e) => s + e.bytes, 0);
  console.log(
    `lines: ${captures.length} captures over weeks ${[...keepWeeks].sort((a, b) => a - b).join(", ")} — ` +
      `${built} built, ${skipped} unchanged, ${removed} removed; ${(total / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s.`
  );
}

try {
  main();
} catch (err) {
  console.error(`build-lines-data: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}
