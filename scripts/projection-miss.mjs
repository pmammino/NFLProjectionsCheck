// Where does the projection lose to the books — and why does it earn so little of
// the price?
//
// Four separate causes, each with a different remedy, are told apart here:
//
//   TIMING     the books price news the projection has not read yet. Tested by
//              scoring every daily snapshot of a week against the same markets.
//   LOCATION   the projected middle is in the wrong place (see median-correction).
//   SPREAD     the band is too narrow, so the projection is overconfident.
//   TAILS      the far tails are too thin.
//
// and what is left once those are repaired is what the projection simply knows
// less about than the books do.
//
// Usage:
//   npm run projection-miss
//   node scripts/projection-miss.mjs [--season 2026] [--weeks 2,3,4] [--no-git]
//
// Sections 2-4 need the DAILY projection snapshots, which exist only in git
// history (the committed file is overwritten each day). Without history — a
// shallow clone, or --no-git — the report says so and runs section 1 on the
// latest snapshot alone.
//
// Method notes, because the comparison is easy to get wrong:
//  - Every Brier gap is against the book at the SAME moment: the projection of
//    the first snapshot of the week against the opening board, the last snapshot
//    before kickoff against the closing board.
//  - "Near the money" is defined on the BOOK's price, never ours or the outcome.
//  - Errors are clustered on (week, player): the lines of one ladder resolve
//    together.
//  - The actuals feed omits players who recorded nothing, so every outcome rate is
//    biased up. Only paired differences against the book are read; the same
//    outcome sits on both sides of the subtraction.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeason, availableSeasons } from "./lib/pricing-dataset.mjs";
import { loadSnapshot } from "./lib/median-correction.mjs";
import { projectionFor } from "./lib/lines-index.mjs";
import { STAT_DEFS, isBettableStat } from "./lib/markets.mjs";
import { estimateHoldByStat, median, sigmoid } from "./lib/consensus.mjs";
import { pairedBrierDiff, NEAR_MONEY_MAX } from "./lib/pricing.mjs";
import { bookVotes, fitProjectionShare } from "./lib/source-weights.mjs";
import { outcomeFrom } from "./lib/source-model.mjs";
import { probOverVariant, curvePosition, POSITION_BINS, binOf, bestOnGrid, brier, mean } from "./lib/projection-diagnosis.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const a = { season: null, dataDir: join(ROOT, "data"), weeks: null, git: true };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--season": a.season = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--weeks": a.weeks = new Set(next().split(",").map(Number)); break;
      case "--no-git": a.git = false; break;
      case "-h":
      case "--help":
        console.log("Usage: node scripts/projection-miss.mjs [--season Y] [--weeks 2,3,4] [--no-git] [--data-dir D]");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return a;
}

const f = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? "      -" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const clampL = (p) => Math.max(-6, Math.min(6, Math.log(p / (1 - p))));

// ---------------------------------------------------------------------------
// Daily snapshots from git
// ---------------------------------------------------------------------------

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });

// Every committed version of a week's projection file, oldest first, each as a
// loaded snapshot with the time it was written. Empty when there is no history.
function gitSnapshots(a, season, week) {
  const rel = `data/projections/${season}/week-${String(week).padStart(2, "0")}.csv`;
  let log;
  try {
    log = git(ROOT, "log", "--reverse", "--format=%H\t%aI", "--", rel).trim();
  } catch {
    return [];
  }
  if (!log) return [];
  const out = [];
  const base = mkdtempSync(join(tmpdir(), "proj-snap-"));
  for (const line of log.split("\n")) {
    const [hash, date] = line.split("\t");
    let text;
    try {
      text = git(ROOT, "show", `${hash}:${rel}`);
    } catch {
      continue;
    }
    const dir = join(base, hash.slice(0, 10), "projections", String(season));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `week-${String(week).padStart(2, "0")}.csv`), text);
    const snapshot = loadSnapshot(join(base, hash.slice(0, 10)), season, week);
    if (snapshot) out.push({ date: new Date(date), snapshot });
  }
  return out;
}

// The game date from a fixture id (YYYYMMDD…), as the start of that UTC day plus
// 16 hours: before any kickoff of the day. A snapshot written before this is one
// the projection genuinely had on hand.
function kickoffCutoff(fixtureId) {
  const m = String(fixtureId ?? "").match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 16)) : null;
}

// ---------------------------------------------------------------------------
// Market rows
// ---------------------------------------------------------------------------

// One row per market on one board: the books' consensus (equal-weight median of
// every book's de-vigged price, at least three of them), and the outcome.
function boardRows(quotes, actualsByWeek, holdByStat, slot, weeks) {
  const groups = new Map();
  for (const q of quotes) {
    if (q.slot !== slot || !isBettableStat(q.stat) || STAT_DEFS[q.stat]?.kind !== "continuous") continue;
    if (weeks && !weeks.has(q.week)) continue;
    const key = [q.week, q.playerId, q.stat, q.line].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const out = new Map();
  for (const [key, rows] of groups) {
    const first = rows[0];
    const y = outcomeFrom(actualsByWeek, first);
    if (y === null) continue;
    const books = bookVotes(rows, { assumedHold: holdByStat.get(first.stat) });
    if (books.length < 3) continue;
    out.set(key, {
      key,
      week: first.week,
      playerId: first.playerId,
      stat: first.stat,
      line: first.line,
      fixtureId: first.fixtureId,
      pBook: sigmoid(median(books.map((b) => b.logit))),
      y,
      cluster: `${first.week}|${first.playerId}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

function gapRow(rows, price, bookKey = "pBook") {
  const d = pairedBrierDiff(rows.map((r) => ({ p: price(r), q: r[bookKey], y: r.y, cluster: r.cluster })));
  return d;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const seasons = availableSeasons(a.dataDir);
  const season = a.season ?? seasons[seasons.length - 1];
  const { quotes, actualsByWeek, weeks: weekInfo } = loadSeason(season, { dataDir: a.dataDir });
  const holdByStat = estimateHoldByStat(quotes);
  const weeks = a.weeks ?? new Set(weekInfo.filter((w) => w.hasActuals && w.week >= 2).map((w) => w.week));

  const open = boardRows(quotes, actualsByWeek, holdByStat, "opening", weeks);
  const close = boardRows(quotes, actualsByWeek, holdByStat, "closing", weeks);
  const both = [...open.keys()].filter((k) => close.has(k));

  console.log(`PROJECTION MISS — season ${season}, weeks ${[...weeks].sort((x, y) => x - y).join(", ")}, continuous stats`);
  console.log(`${open.size.toLocaleString()} markets on the opening board, ${close.size.toLocaleString()} on the closing board, ${both.length.toLocaleString()} on both; ≥3 books, graded.\n`);

  // Snapshots.
  const snaps = new Map();
  let haveGit = false;
  if (a.git) {
    for (const w of weeks) {
      const list = gitSnapshots(a, season, w);
      if (list.length >= 2) haveGit = true;
      snaps.set(w, list);
    }
  }
  const finalSnap = (w) => loadSnapshot(a.dataDir, season, w);
  const first = (w) => snaps.get(w)?.[0]?.snapshot ?? null;
  // The latest snapshot written before the game: what the projection had at kickoff.
  const preKickoff = (w, fixtureId) => {
    const list = snaps.get(w) ?? [];
    const cut = kickoffCutoff(fixtureId);
    if (!cut || list.length === 0) return null;
    let pick = null;
    for (const s of list) if (s.date < cut) pick = s;
    return pick?.snapshot ?? null;
  };

  const triple = (snap, r) => (snap ? projectionFor(snap, r.playerId, r.stat) : null);
  const priced = (snap, r) => {
    const t = triple(snap, r);
    return t && t.F !== null && t.C !== null ? probOverVariant(r.line, t) : null;
  };

  // 1. Where on the curve -----------------------------------------------------
  console.log("1. WHERE ON THE CURVE DOES THE PROJECTION LOSE?");
  console.log("   Each line's position in the projection's own standard deviations from its median, scored against the book on the");
  console.log("   closing board using the latest snapshot. Positive gap = projection worse.\n");
  {
    const rows = [];
    for (const k of close.keys()) {
      const r = close.get(k);
      const t = triple(finalSnap(r.week), r);
      if (!t || t.F === null || t.C === null) continue;
      rows.push({ ...r, pProj: probOverVariant(r.line, t), z: curvePosition(r.line, t) });
    }
    console.log(`   ${pad("line vs projection", 28)}${lpad("n", 7)}${lpad("players", 9)}${lpad("P(proj)", 9)}${lpad("P(book)", 9)}${lpad("outcome", 9)}${lpad("gap", 10)}${lpad("z", 6)}`);
    POSITION_BINS.forEach((bin, i) => {
      const rs = rows.filter((r) => binOf(r.z) === i);
      if (rs.length < 30) return;
      const d = gapRow(rs, (r) => r.pProj);
      console.log(`   ${pad(bin.label, 28)}${lpad(rs.length, 7)}${lpad(d.clusters, 9)}${lpad(mean(rs.map((r) => r.pProj)).toFixed(3), 9)}${lpad(mean(rs.map((r) => r.pBook)).toFixed(3), 9)}${lpad(mean(rs.map((r) => r.y)).toFixed(3), 9)}${lpad(f(d.mean), 10)}${lpad(d.z === null ? "-" : d.z.toFixed(1), 6)}`);
    });
    const all = gapRow(rows, (r) => r.pProj);
    console.log(`   ${pad("ALL", 28)}${lpad(rows.length, 7)}${lpad(all.clusters, 9)}${" ".repeat(27)}${lpad(f(all.mean), 10)}${lpad(all.z === null ? "-" : all.z.toFixed(1), 6)}`);
    console.log("\n   By stat (all lines | near the money):");
    for (const stat of [...new Set(rows.map((r) => r.stat))]) {
      const rs = rows.filter((r) => r.stat === stat);
      const nm = rs.filter((r) => Math.abs(r.pBook - 0.5) <= NEAR_MONEY_MAX);
      const d = gapRow(rs, (r) => r.pProj);
      const dn = gapRow(nm, (r) => r.pProj);
      console.log(`   ${pad(stat, 14)}n ${lpad(rs.length, 6)} ${f(d.mean)} (z ${d.z === null ? "-" : d.z.toFixed(1)})   | near money n ${lpad(nm.length, 5)} ${f(dn.mean)} (z ${dn.z === null ? "-" : dn.z.toFixed(1)})`);
    }
    console.log("\n   The tails are miscalibrated in the obvious direction — the projection puts the far Over at a few percent where the");
    console.log("   book and the outcomes say ten — but they are few rows at small Brier weight; see 3 for what repairing them buys.");
  }

  if (!haveGit) {
    console.log("\n   Sections 2-4 need the daily snapshots from git history, which this checkout does not have (or --no-git).");
    console.log("   Run in a full clone: git fetch --unshallow.");
    return;
  }

  // The sample for 2-4: markets on both boards, near the money by the opening book,
  // with a snapshot for every timing.
  const sample = [];
  for (const k of both) {
    const o = open.get(k);
    const c = close.get(k);
    if (Math.abs(o.pBook - 0.5) > NEAR_MONEY_MAX) continue;
    const tue = first(o.week);
    const pre = preKickoff(o.week, o.fixtureId);
    if (!tue || !pre) continue;
    const tT = triple(tue, o);
    const tP = triple(pre, o);
    if (!tT || !tP || tT.F === null || tP.F === null || tT.C === null || tP.C === null) continue;
    sample.push({ ...o, pOpen: o.pBook, pClose: c.pBook, tT, tP });
  }

  // 2. Timing -------------------------------------------------------------------
  console.log("\n2. WHEN IN THE WEEK?   (the same markets, near the money by the opening book)");
  console.log(`   ${sample.length.toLocaleString()} markets, ${new Set(sample.map((r) => r.cluster)).size} player-weeks. Brier of the book: opening ${brier(sample, (r) => r.pOpen).toFixed(4)}, closing ${brier(sample, (r) => r.pClose).toFixed(4)}.\n`);
  console.log(`   ${pad("projection snapshot", 36)}${lpad("Brier", 8)}${lpad("gap to closing book", 22)}${lpad("z", 6)}`);
  for (const [label, key] of [["first of the week (Tuesday)", "tT"], ["last one before the game", "tP"]]) {
    const d = pairedBrierDiff(sample.map((r) => ({ p: probOverVariant(r.line, r[key]), q: r.pClose, y: r.y, cluster: r.cluster })));
    console.log(`   ${pad(label, 36)}${lpad(brier(sample, (r) => probOverVariant(r.line, r[key])).toFixed(4), 8)}${lpad(f(d.mean), 22)}${lpad(d.z === null ? "-" : d.z.toFixed(1), 6)}`);
  }
  console.log("\n   Per week, every snapshot (Brier; the book is the last column):");
  for (const w of [...weeks].sort((x, y) => x - y)) {
    const list = snaps.get(w) ?? [];
    const rs = sample.filter((r) => r.week === w);
    if (!rs.length || list.length === 0) continue;
    const cells = list.map((s) => {
      const b = mean(rs.map((r) => {
        const t = projectionFor(s.snapshot, r.playerId, r.stat);
        return t && t.F !== null && t.C !== null ? (probOverVariant(r.line, t) - r.y) ** 2 : null;
      }).filter((x) => x !== null));
      return `${s.date.toISOString().slice(5, 10)} ${b === null ? "  -  " : b.toFixed(4)}`;
    });
    console.log(`   week ${w} (n ${rs.length}): ${cells.join("  ")}   | book ${brier(rs, (r) => r.pOpen).toFixed(4)} open, ${brier(rs, (r) => r.pClose).toFixed(4)} close`);
  }
  console.log("\n   The projection improves every day, and by kickoff it has recovered much of the gap: what separates it from the book");
  console.log("   at the Tuesday drop is largely news it has not read yet, which the books have been pricing since the lines opened.");

  // 3. What repairing each candidate recovers --------------------------------------
  console.log("\n3. WHAT WOULD REPAIRING EACH CANDIDATE RECOVER?   (gap to the closing book, Brier; smaller is better)");
  const stats = ["ALL", ...new Set(sample.map((r) => r.stat))];
  const KS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  for (const [label, key] of [["Tuesday snapshot", "tT"], ["last snapshot before the game", "tP"]]) {
    console.log(`\n   ${label}`);
    const gap = (rs, price) => gapRow(rs, price, "pClose");
    const base = gap(sample, (r) => probOverVariant(r.line, r[key]));
    console.log(`   ${pad("as it is (two-piece normal)", 52)}${f(base.mean)}  (z ${base.z.toFixed(1)})`);
    for (const nu of [5, 3]) {
      const d = gap(sample, (r) => probOverVariant(r.line, r[key], { nu }));
      console.log(`   ${pad(`heavier tails, Student-t ν=${nu}, same quartiles`, 52)}${f(d.mean)}  (z ${d.z.toFixed(1)})`);
    }
    const best = bestOnGrid(sample, KS, (r, k) => probOverVariant(r.line, r[key], { spreadMult: k }));
    const dk = gap(sample, (r) => probOverVariant(r.line, r[key], { spreadMult: best.best }));
    console.log(`   ${pad(`wider band, ×${best.best} (best in-sample)`, 52)}${f(dk.mean)}  (z ${dk.z.toFixed(1)})`);
    console.log(`   by stat, best band multiplier and the gap it leaves:`);
    for (const stat of stats.filter((s) => s !== "ALL")) {
      const rs = sample.filter((r) => r.stat === stat);
      if (rs.length < 150) continue;
      const b = bestOnGrid(rs, KS, (r, k) => probOverVariant(r.line, r[key], { spreadMult: k }));
      const d0 = gap(rs, (r) => probOverVariant(r.line, r[key]));
      const d1 = gap(rs, (r) => probOverVariant(r.line, r[key], { spreadMult: b.best }));
      console.log(`     ${pad(stat, 12)}n ${lpad(rs.length, 5)}   ×${pad(b.best, 5)} gap ${f(d0.mean)} -> ${f(d1.mean)}`);
    }
  }
  console.log("\n   Tail weight barely matters to Brier — near-the-money markets are not where the tails live. The width of the band does:");
  console.log("   a projection that is right about WHERE a player lands but too sure of it prices every line too far from a coin flip.");
  console.log("   Location is the median-correction module's job (npm run median-correction), and is not repeated here.");

  // 4. Share of the price ---------------------------------------------------------
  console.log("\n4. HOW MUCH OF THE PRICE DOES THE PROJECTION EARN?   (fitted against outcomes; share of the logit)");
  console.log("   0 = ignore it, 1 = believe it over the books. Fitted on the same markets, near the money by the closing book.\n");
  console.log(`   ${pad("stat", 14)}${lpad("n", 6)}${lpad("players", 9)}   Tuesday snapshot vs opening book     last snapshot vs closing book`);
  const nearClose = sample.filter((r) => Math.abs(r.pClose - 0.5) <= NEAR_MONEY_MAX);
  const nearOpen = sample;
  const shareOf = (rs, key, book) =>
    fitProjectionShare(
      rs.map((r) => ({ lBooks: clampL(r[book]), lProj: clampL(probOverVariant(r.line, r[key])), y: r.y, cluster: r.cluster })),
      { priorClusters: 0, caution: 0 }
    );
  const cell = (c) => `${f(c.raw, 2)} ± ${(1.96 * (c.se ?? NaN)).toFixed(2)} (z ${c.z === null ? "-" : c.z.toFixed(1)})`;
  for (const stat of stats) {
    const o = stat === "ALL" ? nearOpen : nearOpen.filter((r) => r.stat === stat);
    const c = stat === "ALL" ? nearClose : nearClose.filter((r) => r.stat === stat);
    if (c.length < 150) continue;
    const t = shareOf(o, "tT", "pOpen");
    const p = shareOf(c, "tP", "pClose");
    console.log(`   ${pad(stat, 14)}${lpad(c.length, 6)}${lpad(p.clusters, 9)}   ${pad(cell(t), 36)} ${cell(p)}`);
  }
  console.log("\n   With Tuesday's snapshot the projection earns about nothing anywhere. With a fresh one it earns something on the volume");
  console.log("   stats (receptions, receiving yards) and NEGATIVE weight on passing yards. Hence the pool prices the projection's share per");
  console.log("   stat and per capture slot, not as one number. These are a few weeks and several cells each; read them as direction.");
}

try {
  main();
} catch (err) {
  console.error(`projection-miss: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}

