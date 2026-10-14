// Builds the data behind the Filtered Paper Trading tab:
//
//   public/data/paper.json         every candidate bet on the LIVE captures
//   public/data/paper-recon.json   the same for the reconstructed opening and
//                                  closing boards, fetched only if asked for
//
// Runs on predev/prebuild alongside the other builders; the output is not
// committed. See scripts/lib/paper-data.mjs for what a row is and lib/paper-filter.mjs
// for how the tab filters them.
//
// It is the slowest of the builders (the weights are refit as of each week and
// every board is re-priced under the pool: about a minute and a half), so it
// skips itself when its output is newer than every input. --force rebuilds.
//
// Usage: node scripts/build-paper-data.mjs [--season 2026] [--data-dir data] [--force]

import { readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { loadSeason, availableSeasons } from "./lib/pricing-dataset.mjs";
import { buildSourceModel, loadLiveClosing, withLiveClosing } from "./lib/source-model.mjs";
import { buildPaperDataset, indexCloseVotes, isLiveBoard, MIN_CANDIDATE_EDGE, ODDS_FLOOR, ODDS_CEILING, SHARP_SET } from "./lib/paper-data.mjs";
import { MARKET_SETS } from "./lib/consensus.mjs";
import { pack } from "./lib/paper-filter.mjs";
import { slotDir } from "./lib/slots.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "public", "data");
const pad2 = (n) => String(n).padStart(2, "0");

function parseArgs(argv) {
  const a = { season: null, dataDir: "data", force: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--season": a.season = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--force": a.force = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return a;
}

// Every file under `dir`, recursively, with its mtime.
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

const weekFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).map((f) => f.match(/^week-(\d+)\.csv$/)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b) : [];

function boardsFor(dataDir, season) {
  const base = join(ROOT, dataDir, "props", String(season));
  const out = [];
  for (const slot of ["main", "thursday", "saturday", "opening", "closing"]) {
    const dir = join(base, slotDir(slot));
    for (const week of weekFiles(dir)) out.push({ slot, week, path: join(dir, `week-${pad2(week)}.csv`) });
  }
  return out.sort((x, y) => x.week - y.week);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const dataRoot = join(ROOT, a.dataDir);
  const seasons = availableSeasons(dataRoot);
  const season = a.season ?? seasons[seasons.length - 1];
  const livePath = join(OUT_DIR, "paper.json");
  const reconPath = join(OUT_DIR, "paper-recon.json");

  if (!season) {
    mkdirSync(OUT_DIR, { recursive: true });
    const empty = { meta: { generatedAt: new Date().toISOString(), season: null, empty: true }, players: [], tables: {}, columns: [], rows: [] };
    writeFileSync(livePath, JSON.stringify(empty));
    writeFileSync(reconPath, JSON.stringify(empty));
    console.log("paper: no prop captures; wrote empty datasets.");
    return;
  }

  if (!a.force && existsSync(livePath) && existsSync(reconPath)) {
    const outTime = Math.min(statSync(livePath).mtimeMs, statSync(reconPath).mtimeMs);
    const inTime = Math.max(...["props", "closing", "actuals", "projections"].map((d) => newestMtime(join(dataRoot, d, String(season)))));
    if (outTime > inTime) {
      console.log("paper: output is newer than every input; skipping (--force to rebuild).");
      return;
    }
  }

  const t0 = Date.now();
  const { quotes, actualsByWeek } = loadSeason(season, { dataDir: dataRoot });
  const closing = loadLiveClosing({ dataDir: dataRoot, season });
  const model = buildSourceModel(withLiveClosing(quotes, closing), actualsByWeek);
  const closeIndex = indexCloseVotes(closing, model.holdByStat);

  const boards = boardsFor(a.dataDir, season).map((b) => ({ ...b, rows: readCsv(b.path) }));
  const latestWeek = Math.max(...boards.map((b) => b.week));
  const completeWeeks = [...actualsByWeek.keys()].filter((w) => w < latestWeek).sort((x, y) => x - y);

  const build = (set) => buildPaperDataset(set, { model, actualsByWeek, closeIndex });
  const live = build(boards.filter((b) => isLiveBoard(b.slot)));
  const recon = build(boards.filter((b) => !isLiveBoard(b.slot)));

  const meta = (ds, set) => ({
    generatedAt: new Date().toISOString(),
    season,
    weeks: [...new Set(ds.rows.map((r) => r.week))].sort((x, y) => x - y),
    completeWeeks,
    slots: [...new Set(set.map((b) => b.slot))],
    candidates: ds.rows.length,
    minCandidateEdge: MIN_CANDIDATE_EDGE,
    oddsRange: [ODDS_FLOOR, ODDS_CEILING],
    sharpBooks: MARKET_SETS[SHARP_SET],
  });

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, ds, set] of [[livePath, live, boards.filter((b) => isLiveBoard(b.slot))], [reconPath, recon, boards.filter((b) => !isLiveBoard(b.slot))]]) {
    const packed = pack(ds.rows);
    writeFileSync(path, JSON.stringify({ meta: meta(ds, set), players: ds.players, ...packed }));
  }
  const kb = (p) => (statSync(p).size / 1024).toFixed(0);
  console.log(`paper: season ${season}: ${live.rows.length.toLocaleString()} live candidates (${kb(livePath)} KB), ${recon.rows.length.toLocaleString()} reconstructed (${kb(reconPath)} KB), ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
}

try {
  main();
} catch (err) {
  console.error(`build-paper-data: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}
