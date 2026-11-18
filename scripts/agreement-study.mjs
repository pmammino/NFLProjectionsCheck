// Should the price move harder when the projection and the sharp books agree?
//
// Paper trading turned up a subset that looks profitable: the projection shows an
// edge AND the sharp books say the price is off too. This is the test of that
// subset, and of the pricing change it suggests, done the way a pricing change has
// to be judged: on rows that were not used to find it, against the price it would
// replace, with errors that know a ladder of lines on one player is one bet.
//
// See scripts/lib/agreement.mjs for the two definitions of "agree" and why there
// are two. The short version: "the sharp books" is Pinnacle/Circa alone on about
// 7% of markets, or the books' lead-weighted pool on all of them.
//
// Usage:
//   npm run agreement-study
//   node scripts/agreement-study.mjs [--season 2026] [--write] [--json]
//                                    [--min-train-weeks 3] [--min-shift 0.03]
//
//   --write   persist data/pricing/{season}/agreement.md and agreement.json
//
// Reads data/props, data/closing, data/actuals. Slow (about a minute): it prices
// every row of every live board.

import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { loadSeason, readPropRow, availableSeasons } from "./lib/pricing-dataset.mjs";
import { loadLiveClosing, withLiveClosing, buildSourceModel, outcomeFrom } from "./lib/source-model.mjs";
import { bookVotes, poolVotes, weightsForStat, SHARE_BAND } from "./lib/source-weights.mjs";
import { median, logit } from "./lib/consensus.mjs";
import { projectionProbOf } from "./lib/backtest-live.mjs";
import { isBettableStat } from "./lib/markets.mjs";
import { buildPaperDataset, indexCloseVotes } from "./lib/paper-data.mjs";
import { slotDir } from "./lib/slots.mjs";
import {
  DEFINITIONS,
  MIN_SHIFT,
  classify,
  closeMove,
  poolVsMedianOnClose,
  differenceOfMeans,
  shareByCell,
  shareOf,
  gatedWalkForward,
  oneBetPerMarket,
  summarizeBets,
} from "./lib/agreement.mjs";
import { americanToDecimal } from "./lib/odds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LIVE_SLOTS = ["main", "thursday", "saturday"];
const SHARP_BOOKS = new Set(["pinnacle", "circasports"]);
const MAX_LOGIT = 6;
const clipLogit = (p) => Math.max(-MAX_LOGIT, Math.min(MAX_LOGIT, logit(p)));

function parseArgs(argv) {
  const a = { season: null, dataDir: join(ROOT, "data"), write: false, json: false, minTrainWeeks: 3, minShift: MIN_SHIFT };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--season": a.season = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--write": a.write = true; break;
      case "--json": a.json = true; break;
      case "--min-train-weeks": a.minTrainWeeks = Number(next()); break;
      case "--min-shift": a.minShift = Number(next()); break;
      case "-h":
      case "--help":
        console.log("Usage: node scripts/agreement-study.mjs [--season Y] [--write] [--json] [--min-train-weeks N] [--min-shift X]");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const boardPaths = (dataDir, season) => {
  const out = [];
  for (const slot of LIVE_SLOTS) {
    const dir = join(dataDir, "props", String(season), slotDir(slot));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^week-\d+\.csv$/.test(x))) {
      out.push({ slot, week: Number(f.match(/week-(\d+)\.csv/)[1]), path: join(dir, f) });
    }
  }
  return out.sort((x, y) => x.week - y.week);
};

// One row per market on a live board: the three prices (as logits of P(over)),
// the later market, and what happened. Over-canonical, like the rest of the
// pricing code.
function buildMarkets(boards, { model, actualsByWeek, closing }) {
  const closeL = new Map();
  const cg = new Map();
  for (const q of closing) {
    const k = `${q.week}|${q.playerId}|${q.stat}|${q.line}`;
    if (!cg.has(k)) cg.set(k, []);
    cg.get(k).push(q);
  }
  for (const [k, g] of cg) {
    const v = bookVotes(g, { assumedHold: model.holdByStat.get(g[0].stat) });
    // Three books at the late board, so the median is a market and not a book.
    if (v.length >= 3) closeL.set(k, median(v.map((x) => x.logit)));
  }

  const out = [];
  for (const b of boards) {
    const m = model.at(b.week);
    const groups = new Map();
    for (const r of readCsv(b.path)) {
      const q = readPropRow(r, b.slot);
      if (!q || !isBettableStat(q.stat)) continue;
      const k = [q.playerId, q.stat, q.line].join("|");
      if (!groups.has(k)) groups.set(k, { q, rows: [], qs: [] });
      groups.get(k).rows.push(r);
      groups.get(k).qs.push(q);
    }
    for (const g of groups.values()) {
      const { stat, playerId, line } = g.q;
      const votes = bookVotes(g.qs, { assumedHold: model.holdByStat.get(stat) });
      if (votes.length < 2) continue;
      const pooled = poolVotes(votes, { weights: weightsForStat(m, stat) });

      let pProj = null;
      for (const r of g.rows) {
        const p = projectionProbOf(r);
        if (p !== null) {
          pProj = r.Side === "under" ? 1 - p : p;
          break;
        }
      }
      if (pProj === null) continue;

      const sharp = votes.filter((v) => SHARP_BOOKS.has(v.book));
      out.push({
        slot: b.slot,
        week: b.week,
        stat,
        cluster: `${b.week}|${playerId}`,
        nBooks: votes.length,
        pBooks: pooled.booksProb,
        lBooks: clipLogit(pooled.booksProb),
        lUnweighted: clipLogit(pooled.unweighted),
        lProj: clipLogit(pProj),
        lSharp: sharp.length ? sharp.reduce((a, v) => a + v.logit, 0) / sharp.length : null,
        y: outcomeFrom(actualsByWeek, g.q),
        lClose: closeL.has(`${b.week}|${playerId}|${stat}|${line}`) ? Math.max(-MAX_LOGIT, Math.min(MAX_LOGIT, closeL.get(`${b.week}|${playerId}|${stat}|${line}`))) : null,
      });
    }
  }
  return out;
}

// Every bettable row on every live board — no edge cut. The paper-trading file
// keeps only rows where some price shows a 3% edge, which makes "the books confirm
// and the projection is against" almost empty by construction.
function buildBets(boards, { model, actualsByWeek, closeIndex }, completeWeeks) {
  const rows = [];
  for (const b of boards) {
    const ds = buildPaperDataset([{ slot: b.slot, week: b.week, rows: readCsv(b.path) }], { model, actualsByWeek, closeIndex, minEdge: -Infinity });
    for (const r of ds.rows) {
      if (!r.bettable || !completeWeeks.has(r.week)) continue;
      const d = americanToDecimal(r.odds);
      if (d === null || d < americanToDecimal(-400) - 1e-9 || d > americanToDecimal(200) + 1e-9) continue;
      rows.push(r);
    }
  }
  return oneBetPerMarket(rows);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const pct = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`);
const pts = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)} pts`);
const num = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const pm = (x, half, d = 3) => (x === null || x === undefined ? "n/a" : half === null || half === undefined ? num(x, d) : `${x >= 0 ? "+" : ""}${x.toFixed(d)} ±${half.toFixed(d)}`);
const row = (cells) => `| ${cells.join(" | ")} |`;
const table = (head, rows) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");

const fmtRoi = (s) => (s.roi.n === 0 ? "n/a" : `${pct(s.roi.mean)} ±${s.roi.half === null ? "?" : (100 * s.roi.half).toFixed(1)}`);
const fmtClv = (s) => (s.clv.n === 0 ? "n/a" : `${pts(s.clv.mean)} ±${s.clv.half === null ? "?" : (100 * s.clv.half).toFixed(2)}`);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
function analyse({ markets, bets, minTrainWeeks, minShift }) {
  const graded = markets.filter((m) => m.y === 0 || m.y === 1);
  const near = (m) => Math.abs(m.pBooks - 0.5) < SHARE_BAND;
  const nearGraded = graded.filter(near);

  const coverage = {
    markets: markets.length,
    graded: graded.length,
    withSharp: markets.filter((m) => m.lSharp !== null).length,
    withClose: markets.filter((m) => m.lClose !== null).length,
    nearGraded: nearGraded.length,
    cells: Object.fromEntries(
      DEFINITIONS.map((d) => {
        const c = { agree: 0, disagree: 0, flat: 0, none: 0 };
        for (const m of nearGraded) c[classify(m, d, { minShift }) ?? "none"]++;
        return [d, c];
      })
    ),
  };

  // Bets: hold the confirming source fixed, vary only the projection.
  const eP = (b) => (b.pProj === null ? null : b.pProj - b.implied);
  const eBooks = (b) => (b.pFair === null ? null : b.pFair - b.implied);
  const eSharp = (b) => (b.pSharp === null ? null : b.pSharp - b.implied);
  const projBands = [
    ["projection edge ≥ 3% (agrees)", (b) => eP(b) !== null && eP(b) >= 0.03],
    ["projection 0–3%", (b) => eP(b) !== null && eP(b) > 0 && eP(b) < 0.03],
    ["projection ≤ 0 (against)", (b) => eP(b) !== null && eP(b) <= 0],
  ];
  const confirmTables = {};
  for (const [name, edge, thresholds] of [
    ["books", eBooks, [0, 0.01, 0.02]],
    ["sharp", eSharp, [0, 0.01, 0.02]],
  ]) {
    confirmTables[name] = thresholds.map((t) => {
      const base = bets.filter((b) => edge(b) !== null && edge(b) >= t);
      return { threshold: t, n: base.length, bands: projBands.map(([label, fn]) => ({ label, ...summarizeBets(base.filter(fn)) })) };
    });
  }
  const projFixed = bets.filter((b) => eP(b) !== null && eP(b) >= 0.03);
  const projVsConfirm = [
    ["books pool says the price is worse than −2%", (b) => eBooks(b) !== null && eBooks(b) < -0.02],
    ["books pool −2% to 0", (b) => eBooks(b) !== null && eBooks(b) >= -0.02 && eBooks(b) < 0],
    ["books pool 0 to +2%", (b) => eBooks(b) !== null && eBooks(b) >= 0 && eBooks(b) < 0.02],
    ["books pool ≥ +2% (confirms)", (b) => eBooks(b) !== null && eBooks(b) >= 0.02],
    ["Pinnacle/Circa quoted, price worse than fair", (b) => eSharp(b) !== null && eSharp(b) < 0],
    ["Pinnacle/Circa confirm (≥ 0)", (b) => eSharp(b) !== null && eSharp(b) >= 0],
  ].map(([label, fn]) => ({ label, ...summarizeBets(projFixed.filter(fn)) }));

  // Price level.
  const byDefinition = {};
  for (const d of DEFINITIONS) {
    const withClose = nearGraded.filter((m) => m.lClose !== null);
    const cellOf = (m) => classify(m, d, { minShift });
    const closeBy = {};
    for (const c of ["agree", "disagree", "flat"]) closeBy[c] = closeMove(withClose.filter((m) => cellOf(m) === c));
    closeBy.all = closeMove(withClose.filter((m) => cellOf(m) !== null));
    byDefinition[d] = {
      share: shareByCell(nearGraded, d, { minShift }),
      close: closeBy,
      walkForward: gatedWalkForward(nearGraded, d, { minTrainWeeks, minShift }),
    };
  }
  const poolVsMedian = poolVsMedianOnClose(nearGraded.filter((m) => m.lClose !== null));
  return { coverage, confirmTables, projVsConfirm, byDefinition, poolVsMedian, projectionShareOverall: shareOf(nearGraded), nBets: bets.length };
}

// The decision rule, written down so it is not chosen after seeing the numbers.
// Moving the price harder is justified only if ALL of:
//   1. out of sample, the cautious (pipeline-rule) gated price beats the pool,
//      clustered z <= -2
//   2. so does the point-estimate gated price — the best the idea can look
//   3. the agree cell's fitted projection share has a 95% interval above zero
// Anything less is "no evidence", which for a price that will be quoted to the
// public means no change.
function decide(analysis) {
  const out = {};
  for (const d of DEFINITIONS) {
    const r = analysis.byDefinition[d];
    const c = r.walkForward.variants.cautious.diff;
    const p = r.walkForward.variants.point.diff;
    const s = r.share.agree;
    const pass1 = c.z !== null && c.z <= -2 && c.mean < 0;
    const pass2 = p.z !== null && p.z <= -2 && p.mean < 0;
    const pass3 = s.half !== null && s.raw - s.half > 0;
    out[d] = { pass1, pass2, pass3, ship: pass1 && pass2 && pass3 };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function render({ season, weeks, analysis, decision, minTrainWeeks, minShift }) {
  const A = analysis;
  const L = [];
  L.push(`# Agreement study — ${season}, weeks ${weeks[0]}–${weeks[weeks.length - 1]}`);
  L.push("");
  L.push(
    "Does the price deserve to move harder when the projection and the sharp books lean the same way? Live boards only (main, thursday, saturday): the prices and the projection that existed at the time. Every interval is cluster-robust on player-week."
  );
  L.push("");

  const anyShip = Object.values(decision).some((d) => d.ship);
  L.push("## Verdict");
  L.push("");
  L.push(
    anyShip
      ? "**At least one definition clears the bar in \`decide()\`** (below). Review the walk-forward before changing a price."
      : "**No definition clears the bar. Do not change the price.** The bar, fixed in \`decide()\` in this script before the walk-forward was run, needs all three of: a cautious gated price that beats the pool out of sample (z ≤ −2), the same for the uncautious point-estimate price, and an agree-cell projection share whose 95% interval sits above zero."
  );
  L.push("");
  L.push(
    table(
      ["definition", "cautious beats pool", "point-estimate beats pool", "agree-cell share > 0", "ship?"],
      DEFINITIONS.map((d) => [d, yn(decision[d].pass1), yn(decision[d].pass2), yn(decision[d].pass3), decision[d].ship ? "**yes**" : "no"])
    )
  );
  L.push("");

  // 1 coverage
  const c = A.coverage;
  L.push("## 1. Coverage — how much of the board can this even be measured on");
  L.push("");
  L.push(
    `${c.markets.toLocaleString()} markets on live boards; ${c.graded.toLocaleString()} graded; **${c.withSharp.toLocaleString()} (${((100 * c.withSharp) / c.markets).toFixed(1)}%) have a Pinnacle or Circa quote**; ${c.withClose.toLocaleString()} have a late board. Pinnacle prices main lines, not the alternate-line ladder, and Circa quotes a fraction of that. ${c.nearGraded.toLocaleString()} graded markets sit near the money, which is where the price is tested.`
  );
  L.push("");
  L.push(
    table(
      ["definition", "agree", "disagree", "flat (not leaning)", "not measurable"],
      DEFINITIONS.map((d) => [d, c.cells[d].agree, c.cells[d].disagree, c.cells[d].flat, c.cells[d].none])
    )
  );
  L.push("");
  L.push(`"Leaning" means the sharp signal sits more than ${minShift} logit (about ${(minShift * 25).toFixed(2)} points of probability at a coin flip) from its reference.`);
  L.push("");

  // 2 bets
  L.push("## 2. Bets at a price — is the profit the projection's, or the books'?");
  L.push("");
  L.push(
    `One bet per market at the best bettable price (−400 to +200), first capture only, ${A.nBets.toLocaleString()} bets in all. **No edge cut**: the paper-trading file stores only rows where some price shows 3%, which empties the "books confirm, projection against" cell by construction. ROI counts an Over on a player the feed omitted as a loss. CLV is the late market's fair price minus the break-even of the price taken (positive = the market moved toward the bet).`
  );
  L.push("");
  for (const [name, label] of [["books", "The books' lead-weighted pool confirms the price"], ["sharp", "Pinnacle/Circa confirm the price"]]) {
    L.push(`### ${label}`);
    L.push("");
    L.push("The confirming source is held fixed and only the projection varies. If the projection were doing the work, the three rows would differ.");
    L.push("");
    for (const t of A.confirmTables[name]) {
      L.push(`**Confirm ≥ ${(100 * t.threshold).toFixed(0)}%** (${t.n.toLocaleString()} bets)`);
      L.push("");
      const diff = differenceOfMeans(t.bands[0].clv, t.bands[2].clv);
      L.push(
        table(
          ["", "bets", "ROI (±95%)", "bets with a close", "CLV (±95%)", "beat the close"],
          [
            ...t.bands.map((b) => [b.label, b.bets, fmtRoi(b), b.clv.n, fmtClv(b), b.beatClose === null ? "n/a" : `${(100 * b.beatClose).toFixed(0)}%`]),
            ["**agrees − against**", "", "", "", diff.mean === null ? "n/a" : `${pts(diff.mean)} ±${(100 * diff.half).toFixed(2)} (z ${num(diff.z, 1)})`, ""],
          ]
        )
      );
      L.push("");
    }
  }
  L.push("### The projection alone, split by what the books say");
  L.push("");
  L.push(
    table(
      ["projection edge ≥ 3%, and…", "bets", "ROI (±95%)", "bets with a close", "CLV (±95%)", "beat the close"],
      A.projVsConfirm.map((b) => [b.label, b.bets, fmtRoi(b), b.clv.n, fmtClv(b), b.beatClose === null ? "n/a" : `${(100 * b.beatClose).toFixed(0)}%`])
    )
  );
  L.push("");

  // 3 share
  L.push("## 3. The price — how much of the projection should be in it, by cell");
  L.push("");
  L.push(
    "Fitted on outcomes, near the money: `logit P(over) = books + share · (projection − books)`. 0 = ignore the projection, 1 = believe it over the books. This is the pipeline's own fit with no shrinkage and no markdown, so it is the raw number and its error."
  );
  L.push("");
  const shareRows = [];
  for (const d of DEFINITIONS) {
    for (const k of ["agree", "disagree", "flat"]) {
      const s = A.byDefinition[d].share[k];
      shareRows.push([d, k, s.n.toLocaleString(), s.clusters, pm(s.raw, s.half)]);
    }
  }
  const o = A.projectionShareOverall;
  shareRows.push(["(all near-the-money markets)", "—", o.n.toLocaleString(), o.clusters, pm(o.raw, o.half)]);
  L.push(table(["definition", "cell", "markets", "player-weeks", "share (±95%)"], shareRows));
  L.push("");

  // 4 close
  L.push("## 4. Where the market goes next");
  L.push("");
  L.push(
    "Outcomes are one coin flip per market; the late board is a price. Regress `close − price` on the projection's gap and on how far the lead-weighted books sit from the median (both in logit points, clustered). **proj** is how far the late market goes toward the projection; **shift** is how far it carries on in the direction the books already lean (negative: it comes back)."
  );
  L.push("");
  const closeRows = [];
  for (const d of DEFINITIONS) {
    for (const k of ["agree", "disagree", "flat", "all"]) {
      const r = A.byDefinition[d].close[k];
      closeRows.push([d, k, r.n.toLocaleString(), r.clusters, r.proj ? pm(r.proj.coef, r.proj.half) : "n/a", r.shift ? pm(r.shift.coef, r.shift.half) : "n/a"]);
    }
  }
  L.push(table(["definition", "cell", "markets", "player-weeks", "proj", "shift"], closeRows));
  L.push("");
  const pm2 = A.poolVsMedian;
  L.push(
    `Side finding: as a predictor of the late board's median, the lead-weighted pool has a mean squared error of ${num(pm2.poolMse, 4)} logit² against ${num(pm2.medianMse, 4)} for the plain median of the same books (difference ${num(pm2.diff.mean, 5)}, z ${num(pm2.diff.z, 1)}, ${pm2.n.toLocaleString()} markets). Positive means the pool is worse. The late median is a median of the same books, which favours a median predictor, so treat the size (about ${(100 * (pm2.poolMse / pm2.medianMse - 1)).toFixed(0)}%) as the finding, not the z.`
  );
  L.push("");

  // 5 walk-forward
  L.push("## 5. Walk-forward — would the gated price have beaten the pool?");
  L.push("");
  L.push(
    `For each week after the first ${minTrainWeeks}: fit the projection's share in the agree cell and in everything else on earlier weeks only, price that week with it, score against the pool as it stands (share 0). Brier difference, **negative = better than the pool**, clustered by player-week. *cautious* is the pipeline's own rule (shrunk to zero, marked down a standard error); *point* takes the fit at face value and is the best the idea can look.`
  );
  L.push("");
  const wfRows = [];
  for (const d of DEFINITIONS) {
    for (const v of ["cautious", "point"]) {
      const r = A.byDefinition[d].walkForward.variants[v];
      const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      wfRows.push([
        d,
        v,
        num(mean(r.shares.map((s) => s.agree))),
        num(mean(r.shares.map((s) => s.other))),
        fmtDiff(r.diff),
        `${fmtDiff(r.diffAgree)}, ${r.diffAgree.n} markets`,
      ]);
    }
  }
  L.push(table(["definition", "variant", "avg share used: agree", "avg share used: other", "Brier vs pool: all markets", "Brier vs pool: agree cell only"], wfRows));
  L.push("");

  // 6 power
  L.push("## 6. What it would take to see it");
  L.push("");
  const worst = DEFINITIONS.map((d) => ({ d, s: A.byDefinition[d].share.agree })).filter((x) => x.s.half !== null);
  for (const { d, s } of worst) {
    L.push(
      `- **${d}**: the agree-cell share is ${num(s.raw)} ±${num(s.half)} on ${s.n.toLocaleString()} markets (${s.clusters} player-weeks). Halving that interval takes about four times the data — roughly ${(s.clusters * 4).toLocaleString()} player-weeks in the cell. A share under ${num(s.half)} cannot be told from zero with what is here.`
    );
  }
  L.push(
    "- Whatever the share, it moves the price by `share × (projection − books)`. Near the money the median gap is about 0.45 logit, so a share of 0.1 is about 1 point of probability. A market maker's overround is 7%."
  );
  L.push("");
  return L.join("\n");
}

const yn = (b) => (b ? "yes" : "no");
// z is undefined when the two prices are identical (every share was zero).
const fmtDiff = (d) => (d.mean === null ? "n/a" : d.se === 0 || d.z === null ? "identical to the pool" : `${num(d.mean, 5)} (z ${num(d.z, 2)})`);

// ---------------------------------------------------------------------------
function main() {
  const a = parseArgs(process.argv.slice(2));
  const seasons = availableSeasons(a.dataDir);
  const season = a.season ?? seasons[seasons.length - 1];
  if (!season) throw new Error(`No prop captures under ${a.dataDir}`);

  const t0 = Date.now();
  const { quotes, actualsByWeek } = loadSeason(season, { dataDir: a.dataDir });
  const closing = loadLiveClosing({ dataDir: a.dataDir, season });
  const model = buildSourceModel(withLiveClosing(quotes, closing), actualsByWeek);
  const closeIndex = indexCloseVotes(closing, model.holdByStat);
  const boards = boardPaths(a.dataDir, season);
  const latest = Math.max(...boards.map((b) => b.week));
  const completeWeeks = new Set([...actualsByWeek.keys()].filter((w) => w < latest));

  const ctx = { model, actualsByWeek, closing, closeIndex };
  const markets = buildMarkets(boards, ctx);
  const bets = buildBets(boards, ctx, completeWeeks);

  const analysis = analyse({ markets, bets, minTrainWeeks: a.minTrainWeeks, minShift: a.minShift });
  const decision = decide(analysis);
  const weeks = [...new Set(markets.map((m) => m.week))].sort((x, y) => x - y);

  if (a.json) {
    console.log(JSON.stringify({ season, weeks, analysis, decision }, null, 2));
    return;
  }
  const md = render({ season, weeks, analysis, decision, minTrainWeeks: a.minTrainWeeks, minShift: a.minShift });
  console.log(md);
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  if (a.write) {
    const dir = join(a.dataDir, "pricing", String(season));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "agreement.md"), md + "\n");
    fs.writeFileSync(join(dir, "agreement.json"), JSON.stringify({ season, weeks, analysis, decision }, null, 2) + "\n");
    console.log(`wrote ${join(dir, "agreement.md")} and agreement.json`);
  }
}

try {
  main();
} catch (err) {
  console.error(`agreement-study: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}
