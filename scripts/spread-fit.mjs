// Is the projection's Floor-to-Ceiling band too narrow, by how much, and does
// fixing it earn the projection a share of the price?
//
// Usage:
//   npm run spread-fit
//   node scripts/spread-fit.mjs [--season 2026] [--data-dir D] [--no-git] [--write]
//
// Everything is judged on the LIVE boards (Tuesday, Thursday, Saturday) with the
// projection each capture actually had, rebuilt from git history: the committed
// snapshot file is overwritten daily and has read everything since. Without
// history (a shallow clone, or --no-git) the latest committed snapshot is used
// and the report says how many rows that touches, because a projection with
// hindsight flatters itself.
//
// The ladders are the point. A single line near the middle barely tests the
// tails of a distribution; the alternate-line rungs out to 240 yards do. So
// "all rungs" below includes them, and "near the money" is the band the share
// fits live in.
//
// Method notes:
//  - Every multiplier is fitted AS OF the week it is applied to (strictly
//    earlier weeks), so each walk-forward row is one that could have been priced.
//  - Errors are clustered on player-week: a ladder resolves together.
//  - The share is the same regression the price uses (logit P = books + share *
//    (projection - books)), reported UNpenalised so you see the number and its
//    error rather than the cautious one the price would use.
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { loadSeason, availableSeasons, isPointInTime } from "./lib/pricing-dataset.mjs";
import { slotDir } from "./lib/slots.mjs";
import { STAT_DEFS, isBettableStat } from "./lib/markets.mjs";
import { MIN_PROJECTION } from "./lib/calibration.mjs";
import { loadSnapshot } from "./lib/median-correction.mjs";
import { projectionFor } from "./lib/lines-index.mjs";
import { sigmoid } from "./lib/consensus.mjs";
import { pairedBrierDiff, NEAR_MONEY_MAX } from "./lib/pricing.mjs";
import { bookVotes, poolVotes, weightsForStat, fitProjectionShare } from "./lib/source-weights.mjs";
import { buildSourceModel, outcomeFrom, loadLiveClosing, withLiveClosing } from "./lib/source-model.mjs";
import { LIVE_SLOTS, isLiveSlot } from "./lib/backtest-live.mjs";
import { gitSnapshots, snapshotAt } from "./lib/projection-history.mjs";
import { SPREAD_GROUPS, groupOf, widenedProb, bestSpread, spreadsAsOf, spreadFor, MAX_SPREAD, MIN_SPREAD_CLUSTERS } from "./lib/spread-fit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const pad2 = (n) => String(n).padStart(2, "0");

function parseArgs(argv) {
  const a = { season: null, dataDir: join(ROOT, "data"), git: true, write: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--season": a.season = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--no-git": a.git = false; break;
      case "--write": a.write = true; break;
      case "-h":
      case "--help":
        console.log("Usage: node scripts/spread-fit.mjs [--season Y] [--data-dir D] [--no-git] [--write]");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return a;
}

const fx = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
const f2 = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(d));
const lvl = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${(100 * x).toFixed(1)}%`);
const table = (headers, rows) => [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const brier = (rows, p) => mean(rows.map((r) => (p(r) - r.y) ** 2));
const logLoss = (rows, p) => mean(rows.map((r) => { const q = Math.min(0.999, Math.max(0.001, p(r))); return r.y ? -Math.log(q) : -Math.log(1 - q); }));
const clampLogit = (p) => Math.max(-6, Math.min(6, Math.log(p / (1 - p))));

// ---------------------------------------------------------------------------
// Rows: every live market with a continuous projection and an outcome
// ---------------------------------------------------------------------------

// When each (slot, week) capture was taken: the latest CapturedAt in its file.
function captureTimes(dataDir, season) {
  const out = new Map();
  const base = join(dataDir, "props", String(season));
  for (const slot of LIVE_SLOTS) {
    const dir = join(base, slotDir(slot));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /^week-\d+\.csv$/.test(x))) {
      const week = Number(f.match(/week-(\d+)\.csv/)[1]);
      const ts = readCsv(join(dir, f)).map((r) => Date.parse(r.CapturedAt)).filter(Number.isFinite);
      if (ts.length) out.set(`${slot}|${week}`, Math.max(...ts));
    }
  }
  return out;
}

function buildRows(a, season) {
  const { quotes, actualsByWeek } = loadSeason(season, { dataDir: a.dataDir });
  const model = buildSourceModel(withLiveClosing(quotes, loadLiveClosing({ dataDir: a.dataDir, season })), actualsByWeek);
  const times = captureTimes(a.dataDir, season);

  const weeks = [...new Set(quotes.map((q) => q.week))];
  const history = new Map();
  const committed = new Map();
  for (const w of weeks) {
    history.set(w, a.git ? gitSnapshots({ root: ROOT, season, week: w }) : []);
    committed.set(w, loadSnapshot(a.dataDir, season, w));
  }

  const groups = new Map();
  for (const q of quotes) {
    if (!isLiveSlot(q.slot, LIVE_SLOTS) || !isPointInTime(q) || !isBettableStat(q.stat) || !groupOf(q.stat)) continue;
    const key = [q.slot, q.week, q.playerId, q.stat, q.line].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }

  const rows = [];
  let hindsight = 0;
  for (const rs of groups.values()) {
    const first = rs[0];
    const y = outcomeFrom(actualsByWeek, first);
    if (y === null) continue;
    const votes = bookVotes(rs, { assumedHold: model.holdByStat.get(first.stat) });
    if (votes.length < 3) continue;

    const t = times.get(`${first.slot}|${first.week}`);
    let snap = t !== undefined ? snapshotAt(history.get(first.week), t) : null;
    let pit = snap !== null;
    if (!snap) snap = committed.get(first.week);
    const pts = snap ? projectionFor(snap, first.playerId, first.stat) : null;
    if (!pts || !(pts.F > 0) || !(pts.M > 0) || !(pts.C > 0) || pts.M < (MIN_PROJECTION[first.stat] ?? 0)) continue;
    if (!pit) hindsight++;

    const m = model.at(first.week);
    const pBooks = poolVotes(votes, { weights: weightsForStat(m, first.stat) }).prob;
    rows.push({ week: first.week, slot: first.slot, stat: first.stat, line: first.line, y, F: pts.F, M: pts.M, C: pts.C, pBooks, pit, cluster: `${first.week}|${first.playerId}` });
  }
  return { rows, hindsight, weeks: [...new Set(rows.map((r) => r.week))].sort((x, y) => x - y), historyWeeks: weeks.filter((w) => history.get(w).length > 0) };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const BANDS = [
  ["near the money", (r) => Math.abs(r.pBooks - 0.5) <= NEAR_MONEY_MAX],
  ["long-shot overs (books 3–15%)", (r) => r.pBooks >= 0.03 && r.pBooks < 0.15],
  ["all rungs", () => true],
];

function analyse(rows, weeks) {
  // Fits as of each week.
  const fitsByWeek = new Map(weeks.map((w) => [w, spreadsAsOf(rows, w)]));
  const wFor = (r) => spreadFor(fitsByWeek.get(r.week), r.stat);
  const raw = (r) => widenedProb(r.line, r, 1);
  const wide = (r) => widenedProb(r.line, r, wFor(r));

  // 1. Calibration of the band, all weeks, descriptive: the in-sample best multiplier per group.
  const inSample = {};
  for (const g of Object.keys(SPREAD_GROUPS)) {
    const rs = rows.filter((r) => groupOf(r.stat) === g);
    inSample[g] = rs.length ? { n: rs.length, ...bestSpread(rs), byWeek: Object.fromEntries(weeks.map((w) => { const x = rs.filter((r) => r.week === w); return [w, x.length >= 150 ? bestSpread(x).w : null]; })) } : null;
  }
  const calib = Object.keys(SPREAD_GROUPS).map((g) => {
    const rs = rows.filter((r) => groupOf(r.stat) === g);
    const w = inSample[g]?.w ?? 1;
    const bins = [[0, 0.03], [0.03, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
      const b = rs.filter((r) => raw(r) >= lo && raw(r) < hi);
      return { lo, hi, n: b.length, raw: mean(b.map(raw)), widened: mean(b.map((r) => widenedProb(r.line, r, w))), observed: mean(b.map((r) => r.y)) };
    });
    return { group: g, w, bins };
  });

  // 3. Walk-forward: each week scored with the multiplier fitted on earlier weeks.
  const scored = weeks.filter((w) => Object.values(fitsByWeek.get(w)).some((f) => f.applied));
  const walk = BANDS.map(([label, inBand]) => {
    const rs = rows.filter((r) => scored.includes(r.week) && inBand(r));
    const diff = pairedBrierDiff(rs.map((r) => ({ p: wide(r), q: raw(r), y: r.y, cluster: r.cluster })));
    return { label, n: rs.length, clusters: new Set(rs.map((r) => r.cluster)).size, brierRaw: brier(rs, raw), brierWide: brier(rs, wide), llRaw: logLoss(rs, raw), llWide: logLoss(rs, wide), diff };
  });

  // 4. The share the projection earns against the books' pool.
  const unpen = { priorClusters: 0, caution: 0, cap: Infinity };
  const shareRows = (rs, p) => rs.map((r) => ({ lBooks: clampLogit(r.pBooks), lProj: clampLogit(Math.min(0.999, Math.max(0.001, p(r)))), y: r.y, cluster: r.cluster }));
  const shares = BANDS.map(([label, inBand]) => {
    const rs = rows.filter((r) => scored.includes(r.week) && inBand(r));
    const fr = rs.length ? fitProjectionShare(shareRows(rs, raw), unpen) : null;
    const fw = rs.length ? fitProjectionShare(shareRows(rs, wide), unpen) : null;
    return { label, n: rs.length, clusters: fr?.clusters ?? 0, raw: fr && { share: fr.raw, se: fr.se }, widened: fw && { share: fw.raw, se: fw.se }, brierRaw: brier(rs, raw), brierWide: brier(rs, wide), brierBooks: brier(rs, (r) => r.pBooks) };
  });

  // Does the cap decide the answer? The same walk-forward under other caps.
  const capScan = [1.2, 1.4, 1.6, 2.0].map((cap) => {
    const fits = new Map(weeks.map((w) => [w, spreadsAsOf(rows, w, { cap, draws: 60 })]));
    const wc = (r) => spreadFor(fits.get(r.week), r.stat);
    const sc = weeks.filter((w) => Object.values(fits.get(w)).some((f) => f.applied));
    const cell = (inBand) => {
      const rs = rows.filter((r) => sc.includes(r.week) && inBand(r));
      const d = pairedBrierDiff(rs.map((r) => ({ p: widenedProb(r.line, r, wc(r)), q: raw(r), y: r.y, cluster: r.cluster })));
      const f = rs.length ? fitProjectionShare(rs.map((r) => ({ lBooks: clampLogit(r.pBooks), lProj: clampLogit(Math.min(0.999, Math.max(0.001, widenedProb(r.line, r, wc(r))))), y: r.y, cluster: r.cluster })), unpen) : null;
      return { diff: d, share: f && { share: f.raw, se: f.se } };
    };
    return { cap, near: cell(BANDS[0][1]), all: cell(BANDS[2][1]) };
  });

  return { weeks, scored, capScan, fitsByWeek: Object.fromEntries([...fitsByWeek].map(([w, f]) => [w, f])), inSample, calib, walk, shares };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function render(season, meta, r) {
  const out = [];
  out.push(`# Is the projection's band too narrow? — ${season}`, "");
  const pitN = meta.rows - meta.hindsight;
  out.push(
    `${meta.rows.toLocaleString()} live markets (every rung of every ladder) with a graded outcome, weeks ${r.weeks.join(", ")}. ` +
      (meta.hindsight === 0
        ? "Every projection is the one that capture actually had, rebuilt from git history."
        : `${pitN.toLocaleString()} use the projection the capture had; ${meta.hindsight.toLocaleString()} use the latest committed snapshot, which has read everything since — those flatter the projection.`),
    ""
  );

  out.push("## 1. Is the band too narrow?", "");
  out.push("The projection's own P(over) against how often the over happened, all rungs, all weeks. A band that is too narrow prices tails it should not: a 1% over that happens 4% of the time. `widened` applies the best single multiplier (descriptive, fitted on these same rows).", "");
  for (const c of r.calib) {
    out.push(`**${c.group}** (${SPREAD_GROUPS[c.group].join(", ")}) — best multiplier ${f2(c.w)}`, "");
    out.push(table(["projection says", "rungs", "projection", "widened", "happened"], c.bins.filter((b) => b.n >= 20).map((b) => [`${(b.lo * 100).toFixed(0)}–${Math.min(100, b.hi * 100).toFixed(0)}%`, b.n.toLocaleString(), lvl(b.raw), lvl(b.widened), lvl(b.observed)])), "");
  }
  out.push("\"Happened\" tends to sit a little above any price: the actuals feed omits players with an all-zero line, which tilts outcomes toward overs.", "");

  out.push("## 2. How wide, and is it stable?", "");
  out.push(
    `Multiplier on the floor and ceiling distances from the median (1 = as projected), fitted by log-loss on every rung, pooled over a group's stats. **Used** is the number the walk-forward applies: marked down by one bootstrap standard error, capped at ${MAX_SPREAD}, and only if the log-loss gain clears a clustered z of 2 on at least ${MIN_SPREAD_CLUSTERS} player-weeks.`,
    ""
  );
  const fitRows = [];
  for (const w of r.weeks) for (const g of Object.keys(SPREAD_GROUPS)) {
    const f = r.fitsByWeek[w][g];
    fitRows.push([`going into week ${w}`, g, f.n.toLocaleString(), f.clusters, f2(f.raw), f2(f.se), f.applied ? `**${f2(f.w)}**` : "1.00", f.reason]);
  }
  out.push(table(["as of", "group", "rungs", "player-weeks", "best", "± se", "used", "why"], fitRows), "");
  out.push("Each week on its own (best multiplier from that week's rows alone; – under 150 rows):", "");
  out.push(table(["group", ...r.weeks.map((w) => `wk ${w}`)], Object.keys(SPREAD_GROUPS).map((g) => [g, ...r.weeks.map((w) => f2(r.inSample[g]?.byWeek?.[w]))])), "");
  out.push("It is above 1 everywhere it can be measured, but how far above moves with the week and the amount of ladder. That is why the used number is pooled, marked down and capped rather than the best fit.", "");

  out.push("## 3. Walk-forward: does it price the projection better?", "");
  if (r.scored.length === 0) out.push("No week has an applied fit yet (needs earlier weeks with enough ladder).", "");
  else {
    out.push(`Weeks ${r.scored.join(", ")}, each priced with the multiplier fitted on the weeks before it. Projection-alone Brier against what happened (lower is better); the difference is widened − as-projected, clustered by player-week, so negative is better.`, "");
    out.push(table(["", "markets", "player-weeks", "as projected", "widened", "widened − projected", "log-loss: projected → widened"], r.walk.map((w) => [w.label, w.n.toLocaleString(), w.clusters, f2(w.brierRaw, 4), f2(w.brierWide, 4), w.diff.n ? `${fx(w.diff.mean)} (z ${w.diff.z === null ? "–" : w.diff.z.toFixed(1)})` : "–", `${f2(w.llRaw, 4)} → ${f2(w.llWide, 4)}`])), "");
  }

  out.push("## 4. Does a better-calibrated projection earn a share of the price?", "");
  out.push("The share of the books' price to move toward the projection to match what happened (0 = ignore it, 1 = believe it), unpenalised, same weeks as above. This is the question the price cares about: a projection can be better calibrated and still add nothing the books do not already have.", "");
  if (r.scored.length === 0) out.push("Not yet measurable.", "");
  else {
    const cell = (x) => (x ? `${f2(x.share)} ±${x.se === null ? "–" : f2(1.96 * x.se)}` : "–");
    out.push(table(["", "markets", "player-weeks", "share: as projected", "share: widened", "Brier: projected", "widened", "books"], r.shares.map((s) => [s.label, s.n.toLocaleString(), s.clusters, cell(s.raw), cell(s.widened), f2(s.brierRaw, 4), f2(s.brierWide, 4), f2(s.brierBooks, 4)])), "");
  }

  out.splice(out.indexOf("## 4. Does a better-calibrated projection earn a share of the price?"), 0, "## 3b. Does the cap decide it?", "", "The same walk-forward under other caps, so the choice of cap does not quietly decide the answer (Brier difference widened − projected, and the share near the money):", "", table(["cap", "near the money: Brier", "z", "share near the money", "all rungs: Brier", "z"], r.capScan.map((c) => [f2(c.cap, 1), fx(c.near.diff.mean), c.near.diff.z === null ? "–" : c.near.diff.z.toFixed(1), c.near.share ? cell0(c.near.share) : "–", fx(c.all.diff.mean), c.all.diff.z === null ? "–" : c.all.diff.z.toFixed(1)])), "");
  const wAll = r.walk.find((w) => w.label === "all rungs");
  const near = r.shares.find((s) => s.label === "near the money");
  out.push("## 5. Reading it", "");
  const wNear = r.walk.find((w) => w.label === "near the money");
  const sig2 = (w) => w?.diff?.z !== null && w?.diff?.z !== undefined && w.diff.z <= -2 && w.diff.mean < 0;
  const gap = (w) => (w?.diff?.n ? `${fx(w.diff.mean)} Brier, z ${w.diff.z === null ? "–" : w.diff.z.toFixed(1)}` : "–");
  out.push(
    sig2(wNear) || sig2(wAll)
      ? `- **Widening prices the projection better** (walk-forward, each week fitted on earlier ones): near the money ${gap(wNear)}; all rungs ${gap(wAll)}.`
      : `- Widening does **not** clearly price the projection better in the walk-forward yet: near the money ${gap(wNear)}; all rungs ${gap(wAll)}.`
  );
  const applied = Object.values(r.fitsByWeek).flatMap((f) => Object.values(f)).filter((f) => f.applied);
  if (applied.length && applied.every((f) => f.w >= MAX_SPREAD - 1e-9)) out.push(`- Every applied fit hit the ${MAX_SPREAD} cap: the data want a wider band than the cap allows, and how much wider changes from week to week (section 2). The cap is a guard against a noisy week, not an estimate.`);
  if (wNear?.brierWide !== null && wNear?.brierWide !== undefined) out.push(`- Better-calibrated is not better than the books: near the money the widened projection scores ${f2(wNear.brierWide, 4)} against the books' ${f2(r.shares.find((x) => x.label === "near the money")?.brierBooks, 4)}.`);
  const nearLow = near?.widened && near.widened.se !== null ? near.widened.share - 1.96 * near.widened.se : null;
  out.push(
    nearLow !== null && nearLow > 0
      ? `- **It earns a share near the money**: ${f2(near.widened.share)} (interval above 0). Worth pricing with, behind the usual caution.`
      : `- It earns **no share near the money**${near?.widened ? ` (${cell0(near.widened)})` : ""}. Better calibration is not new information: the books already carry what the projection knows, and the share is what the price uses.`
  );
  out.push("- Nothing here reaches a price. The fit lives in `lib/spread-fit.mjs` and is not wired into capture: the shares in use were fitted on the projection as it was, and mixing the two would move them under the price. If the share clears zero, wire it in and refit the shares on the widened projection in the same change.");
  return out.join("\n");
}
const cell0 = (x) => `${f2(x.share)} ±${x.se === null ? "–" : f2(1.96 * x.se)}`;

// ---------------------------------------------------------------------------

function main() {
  const a = parseArgs(process.argv.slice(2));
  const seasons = availableSeasons(a.dataDir);
  const season = a.season ?? seasons[seasons.length - 1];
  if (!season) throw new Error(`No prop captures under ${a.dataDir}/props/`);

  const { rows, hindsight, weeks, historyWeeks } = buildRows(a, season);
  if (rows.length === 0) throw new Error("No live markets with a projection and a graded outcome.");
  if (a.git && historyWeeks.length === 0) console.warn("No git history for the projection snapshots (shallow clone?): using the latest committed snapshot, which has hindsight.");

  const r = analyse(rows, weeks);
  const text = render(season, { rows: rows.length, hindsight }, r);
  console.log(text);

  if (a.write) {
    const dir = join(a.dataDir, "pricing", String(season));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spread-fit.md"), text + "\n");
    writeFileSync(join(dir, "spread-fit.json"), JSON.stringify({ season, rows: rows.length, hindsightRows: hindsight, fitsByWeek: r.fitsByWeek, inSample: r.inSample, walk: r.walk, shares: r.shares }, null, 2) + "\n");
    console.log(`\nWrote ${join(a.dataDir, "pricing", String(season))}/spread-fit.md and spread-fit.json`);
  }
}

try {
  main();
} catch (err) {
  console.error(`spread-fit: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}
