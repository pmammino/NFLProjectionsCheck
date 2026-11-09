// Distribution lab: gamma and process models against the two-piece normal, and
// the standard deviation each book is really quoting, judged on actuals.
//
// Usage:
//   npm run dist-lab
//   node scripts/dist-lab.mjs [--season 2026] [--data-dir D] [--no-git] [--max-ladders N] [--cache FILE] [--write]
//
// Three questions, one per section of the report:
//
//  1. SHAPE.  Given only the projection's Floor/Median/Ceiling, is a gamma (or a
//     process model) a better description of how the stat lands than the
//     two-piece normal in probability.mjs? Scored on every player-week, and on
//     the live-board rungs the price is actually used on.
//  2. PRICE.  Does a better shape earn the projection a bigger share of the
//     price (logit P = books + share * (projection - books)), and does the
//     blended price beat the books? Same walk-forward machinery as spread-fit.
//  3. BOOKS.  What standard deviation is each book quoting, what did the actuals
//     say it should have been, and what does a variance law fitted on actuals
//     say the spread of each stat is at a typical mean?
//
// Everything that is fitted is fitted AS OF the week it is applied to (strictly
// earlier weeks), as in spread-fit.mjs and median-correction.mjs.
//
// Nothing here reaches a price. It is a lab: the findings decide whether to wire
// a model into lib/probability.mjs and refit the shares on it in the same change.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeason, availableSeasons, isPointInTime, actualFor } from "./lib/pricing-dataset.mjs";
import { isBettableStat } from "./lib/markets.mjs";
import { MIN_PROJECTION } from "./lib/calibration.mjs";
import { loadSnapshot } from "./lib/median-correction.mjs";
import { projectionFor } from "./lib/lines-index.mjs";
import { sigmoid, bookFairProb, estimateHoldByStat, DEFAULT_ASSUMED_HOLD } from "./lib/consensus.mjs";
import { canonicalBookKey } from "./lib/books.mjs";
import { pairedBrierDiff, NEAR_MONEY_MAX } from "./lib/pricing.mjs";
import { bookVotes, poolVotes, weightsForStat, fitProjectionShare } from "./lib/source-weights.mjs";
import { buildSourceModel, outcomeFrom, loadLiveClosing, withLiveClosing } from "./lib/source-model.mjs";
import { LIVE_SLOTS, isLiveSlot } from "./lib/backtest-live.mjs";
import { gitSnapshots, snapshotAt } from "./lib/projection-history.mjs";
import {
  fitGammaToQuantiles,
  fitGammaExact,
  gammaFitCdf,
  gammaLawCdf,
  normalLawCdf,
  tweedieCdf,
  tpnCdf,
  probOver,
  massAt,
  pitMid,
  fitLaw,
  meanFromQuantile,
  gammaP,
  mean,
  brier,
  logLoss,
} from "./lib/dist-lab.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// The continuous stats, i.e. the ones the two-piece normal prices. TDs and
// interceptions are Poisson counts and are not part of this comparison.
const STATS = ["passYds", "passAtt", "completions", "rushYds", "rushAtt", "receptions", "recYds"];
const GROUP = { passYds: "yards", rushYds: "yards", recYds: "yards", passAtt: "counts", completions: "counts", rushAtt: "counts", receptions: "counts" };
const MODELS = ["tpn", "tpnWide", "normalLaw", "gammaExact", "gammaLS", "gammaLaw", "tweedie"];
const LABEL = {
  tpn: "two-piece normal (today)",
  tpnWide: "two-piece normal, band widened by a multiplier fitted on earlier weeks (control)",
  normalLaw: "normal with the SAME variance law as gammaLaw (control: isolates shape)",
  gammaExact: "gamma through F/M/C (shifted)",
  gammaLS: "gamma, least squares to F/M/C (from zero)",
  gammaLaw: "gamma, variance law from actuals (Feller/CIR-type)",
  tweedie: "compound Poisson-gamma (Tweedie), variance law (Levy-type, atom at zero)",
};
// A variance law needs this many earlier player-weeks of a stat before it is used.
const MIN_TRAIN = 60;
// The slot order a book's "latest board" is read in.
const SLOT_RANK = { opening: 0, main: 1, thursday: 2, saturday: 3, closing: 4 };

function parseArgs(argv) {
  const a = { season: null, dataDir: join(ROOT, "data"), git: true, write: false, maxLadders: 2500, cache: null, reading: "" };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--season": a.season = Number(next()); break;
      case "--data-dir": a.dataDir = next(); break;
      case "--no-git": a.git = false; break;
      case "--max-ladders": a.maxLadders = Number(next()); break;
      case "--write": a.write = true; break;
      case "--cache": a.cache = next(); break;
      case "-h":
      case "--help":
        console.log("Usage: node scripts/dist-lab.mjs [--season Y] [--data-dir D] [--no-git] [--max-ladders N] [--cache FILE] [--write]");
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
const pct = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${(100 * x).toFixed(d)}%`);
const table = (headers, rows) => [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const clampLogit = (p) => Math.max(-6, Math.min(6, Math.log(p / (1 - p))));
const clampP = (p) => Math.min(0.999, Math.max(0.001, p));
const timeIt = (label, fn) => {
  const t = Date.now();
  const out = fn();
  console.error(`  [${((Date.now() - t) / 1000).toFixed(1)}s] ${label}`);
  return out;
};

// ---------------------------------------------------------------------------
// Player-week pairs: the projection's band against what the player did
// ---------------------------------------------------------------------------

// One record per (week, player, stat) with a usable band and an actual. These
// are NOT market rows: a ladder of 20 rungs on one player is one pair here, so
// the fit of a variance law is not weighted by how many rungs a book listed.
function buildPairs(dataDir, season, actualsByWeek) {
  const out = [];
  for (const [week, byPlayer] of actualsByWeek) {
    const snap = loadSnapshot(dataDir, season, week);
    if (!snap) continue;
    for (const playerId of snap.keys()) {
      const row = byPlayer.get(String(playerId));
      if (!row) continue;
      for (const stat of STATS) {
        const a = actualFor(row, stat);
        const pts = projectionFor(snap, playerId, stat);
        if (a === null || !pts || !(pts.F > 0 && pts.M > 0 && pts.C > 0) || pts.M < (MIN_PROJECTION[stat] ?? 0)) continue;
        out.push(withCentre({ week, playerId: String(playerId), stat, a, F: pts.F, M: pts.M, C: pts.C }));
      }
    }
  }
  return out;
}

// A projection's gamma fits, computed once: the mean mu0 every law-based model
// is centred on, and the exact three-point fit.
const centreCache = new Map();
function centreOf(F, M, C) {
  const key = `${F}|${M}|${C}`;
  let c = centreCache.get(key);
  if (!c) {
    const ls = fitGammaToQuantiles([{ x: F, p: 0.25 }, { x: M, p: 0.5 }, { x: C, p: 0.75 }]);
    const exact = fitGammaExact({ F, M, C });
    c = { ls, exact, mu0: ls ? ls.mean : M };
    centreCache.set(key, c);
  }
  return c;
}
function withCentre(rec) {
  const c = centreOf(rec.F, rec.M, rec.C);
  return { ...rec, ls: c.ls, exact: c.exact, mu0: c.mu0 };
}

// The variance law as it stood going into `week`, per stat and family, from
// earlier weeks' pairs only.
function lawsAsOf(pairs) {
  const memo = new Map();
  return (week, family) => {
    const key = `${week}|${family}`;
    if (!memo.has(key)) {
      const out = {};
      for (const stat of STATS) {
        const tr = pairs.filter((p) => p.week < week && p.stat === stat).map((p) => ({ mu: p.mu0, a: p.a }));
        out[stat] = tr.length >= MIN_TRAIN ? fitLaw(tr, family) : null;
      }
      memo.set(key, out);
    }
    return memo.get(key);
  };
}

// The multiplier on the band that maximises the log-probability of the actuals,
// per stat, from earlier weeks only. Uncapped and unshrunk on purpose: this is
// the most favourable version of the two-piece normal, the one to beat.
function widthsAsOf(pairs) {
  const memo = new Map();
  return (week) => {
    if (!memo.has(week)) {
      const out = {};
      for (const stat of STATS) {
        const tr = pairs.filter((p) => p.week < week && p.stat === stat);
        if (tr.length < MIN_TRAIN) {
          out[stat] = null;
          continue;
        }
        let best = 1;
        let bestLl = -Infinity;
        for (const w of SPREAD_GRID) {
          let ll = 0;
          for (const r of tr) ll += Math.log(massAt(tpnCdf(widenPoints(r, w)), r.a));
          if (ll > bestLl) {
            bestLl = ll;
            best = w;
          }
        }
        out[stat] = best;
      }
      memo.set(week, out);
    }
    return memo.get(week);
  };
}

// The CDF of `model` for one projection record in `week`. null where the model
// is not available (a law not yet fitted); callers score only the rows every
// model can price.
function makeCdfs(lawAt, widthAt) {
  const cache = new Map();
  return (model, rec, week) => {
    if (model === "tpn") return tpnCdf(rec);
    if (model === "tpnWide") {
      const w = widthAt(week)[rec.stat];
      return w ? tpnCdf(widenPoints(rec, w)) : null;
    }
    if (model === "gammaLS") return rec.ls ? gammaFitCdf({ ...rec.ls, loc: 0 }) : null;
    if (model === "gammaExact") return rec.exact ? gammaFitCdf(rec.exact) : rec.ls ? gammaFitCdf({ ...rec.ls, loc: 0 }) : null;
    const family = model === "gammaLaw" ? "gamma" : model === "normalLaw" ? "normal" : "tweedie";
    const law = lawAt(week, family)[rec.stat];
    if (!law) return null;
    const key = `${model}|${week}|${rec.stat}|${rec.mu0}`;
    let c = cache.get(key);
    if (!c) {
      c = family === "gamma" ? gammaLawCdf(rec.mu0, law.phi, law.p) : family === "normal" ? normalLawCdf(rec.mu0, law.phi, law.p) : tweedieCdf(rec.mu0, law.phi, law.p);
      cache.set(key, c);
    }
    return c;
  };
}

// ---------------------------------------------------------------------------
// Section 1: shape, scored on every player-week
// ---------------------------------------------------------------------------

const priceable = (lawAt, widthAt, week, stat) =>
  !!(lawAt(week, "gamma")[stat] && lawAt(week, "tweedie")[stat] && lawAt(week, "normal")[stat] && widthAt(week)[stat]);

function shapeSection(pairs, cdfOf, lawAt, widthAt) {
  const weeks = [...new Set(pairs.map((p) => p.week))].sort((a, b) => a - b);
  // Weeks every model can price: the law-based ones need earlier weeks.
  const scoredWeeks = weeks.filter((w) => STATS.some((s) => priceable(lawAt, widthAt, w, s)));
  const rows = pairs.filter((p) => scoredWeeks.includes(p.week) && priceable(lawAt, widthAt, p.week, p.stat));

  const perStat = {};
  for (const stat of STATS) {
    const rs = rows.filter((r) => r.stat === stat);
    if (rs.length < 30) continue;
    perStat[stat] = { n: rs.length };
    for (const m of MODELS) {
      let ll = 0;
      let inBand = 0;
      let tails = 0;
      let below = 0;
      let nn = 0;
      let starved = 0;
      for (const r of rs) {
        const cdf = cdfOf(m, r, r.week);
        if (!cdf) continue;
        nn++;
        const mass = massAt(cdf, r.a);
        if (mass < 1e-3) starved++;
        ll += Math.log(mass);
        const u = pitMid(cdf, r.a);
        if (u >= 0.25 && u <= 0.75) inBand++;
        if (u < 0.05 || u > 0.95) tails++;
        if (u < 0.5) below++;
      }
      perStat[stat][m] = { ll: ll / nn, central: inBand / nn, tails: tails / nn, below: below / nn, starved: starved / nn };
    }
  }
  const total = {};
  for (const m of MODELS) {
    const xs = Object.entries(perStat).map(([s, v]) => [v.n, v[m].ll]);
    total[m] = xs.reduce((a, [n, l]) => a + n * l, 0) / xs.reduce((a, [n]) => a + n, 0);
  }
  // Paired difference in log-probability of the actual against the two-piece
  // normal, every record, clustered on player-week (one player's stats in one
  // game are not independent).
  const diffs = {};
  for (const m of MODELS) {
    if (m === "tpn") continue;
    const d = rows.map((r) => ({ d: Math.log(massAt(cdfOf(m, r, r.week), r.a)) - Math.log(massAt(cdfOf("tpn", r, r.week), r.a)), c: `${r.week}|${r.playerId}` }));
    const mu = mean(d.map((x) => x.d));
    const by = new Map();
    for (const x of d) by.set(x.c, (by.get(x.c) ?? 0) + (x.d - mu));
    let ss = 0;
    for (const v of by.values()) ss += v * v;
    const G = by.size;
    const se = Math.sqrt(((G > 1 ? G / (G - 1) : 1) * ss) / (d.length * d.length));
    diffs[m] = { mean: mu, se, z: se > 0 ? mu / se : null };
  }
  return { weeks: scoredWeeks, n: rows.length, perStat, total, diffs };
}

// ---------------------------------------------------------------------------
// Market rows: every live rung with a projection, a pool of the books and an outcome
// ---------------------------------------------------------------------------

function captureTimes(dataDir, season, readCsv) {
  const out = new Map();
  const base = join(dataDir, "props", String(season));
  for (const slot of LIVE_SLOTS) {
    const dir = slot === "main" ? base : join(base, slot);
    if (!existsSync(dir)) continue;
    for (const f of readdirSyncSafe(dir).filter((x) => /^week-\d+\.csv$/.test(x))) {
      const week = Number(f.match(/week-(\d+)\.csv/)[1]);
      const ts = readCsv(join(dir, f)).map((r) => Date.parse(r.CapturedAt)).filter(Number.isFinite);
      if (ts.length) out.set(`${slot}|${week}`, Math.max(...ts));
    }
  }
  return out;
}

import { readdirSync, readFileSync } from "node:fs";
import { readCsv } from "./lib/csv.mjs";
import { widenPoints, SPREAD_GRID } from "./lib/spread-fit.mjs";
const readdirSyncSafe = (d) => readdirSync(d);

function buildMarketRows(a, season, quotesAll, actualsByWeek) {
  const model = buildSourceModel(quotesAll, actualsByWeek);
  const times = captureTimes(a.dataDir, season, readCsv);
  const weeks = [...new Set(quotesAll.map((q) => q.week))];
  const history = new Map();
  const committed = new Map();
  for (const w of weeks) {
    history.set(w, a.git ? gitSnapshots({ root: ROOT, season, week: w }) : []);
    committed.set(w, loadSnapshot(a.dataDir, season, w));
  }

  const groups = new Map();
  for (const q of quotesAll) {
    if (!isLiveSlot(q.slot, LIVE_SLOTS) || !isPointInTime(q) || !isBettableStat(q.stat) || !STATS.includes(q.stat)) continue;
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
    const pit = snap !== null;
    if (!snap) snap = committed.get(first.week);
    const pts = snap ? projectionFor(snap, first.playerId, first.stat) : null;
    if (!pts || !(pts.F > 0) || !(pts.M > 0) || !(pts.C > 0) || pts.M < (MIN_PROJECTION[first.stat] ?? 0)) continue;
    if (!pit) hindsight++;

    const m = model.at(first.week);
    const pBooks = poolVotes(votes, { weights: weightsForStat(m, first.stat) }).prob;
    rows.push(withCentre({ week: first.week, slot: first.slot, stat: first.stat, line: first.line, y, F: pts.F, M: pts.M, C: pts.C, pBooks, pit, playerId: first.playerId, cluster: `${first.week}|${first.playerId}` }));
  }
  return { rows, hindsight, weeks: [...new Set(rows.map((r) => r.week))].sort((x, y) => x - y) };
}

const BANDS = [
  ["near the money", (r) => Math.abs(r.pBooks - 0.5) <= NEAR_MONEY_MAX],
  ["long-shot overs (books 3–15%)", (r) => r.pBooks >= 0.03 && r.pBooks < 0.15],
  ["all rungs", () => true],
];

// ---------------------------------------------------------------------------
// Sections 1b and 2: the rungs, and the share
// ---------------------------------------------------------------------------

function priceSection(rows, cdfOf, lawAt, widthAt) {
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  const scoredWeeks = weeks.filter((w) => STATS.some((s) => priceable(lawAt, widthAt, w, s)));
  const use = rows.filter((r) => scoredWeeks.includes(r.week) && priceable(lawAt, widthAt, r.week, r.stat));

  // P(over) for every model, once per row.
  for (const r of use) {
    r.p = {};
    for (const m of MODELS) {
      const cdf = cdfOf(m, r, r.week);
      r.p[m] = cdf ? clampP(probOver(cdf, r.line)) : null;
    }
  }
  const ok = use.filter((r) => MODELS.every((m) => r.p[m] !== null));

  const bands = BANDS.map(([label, inBand]) => {
    const rs = ok.filter(inBand);
    const per = {};
    for (const m of MODELS) {
      per[m] = {
        brier: brier(rs, (r) => r.p[m]),
        ll: logLoss(rs, (r) => r.p[m]),
        diff: m === "tpn" ? null : pairedBrierDiff(rs.map((r) => ({ p: r.p[m], q: r.p.tpn, y: r.y, cluster: r.cluster }))),
        diffWide: m === "tpn" || m === "tpnWide" ? null : pairedBrierDiff(rs.map((r) => ({ p: r.p[m], q: r.p.tpnWide, y: r.y, cluster: r.cluster }))),
        diffNormal: ["gammaLaw", "tweedie"].includes(m) ? pairedBrierDiff(rs.map((r) => ({ p: r.p[m], q: r.p.normalLaw, y: r.y, cluster: r.cluster }))) : null,
      };
    }
    // Share of the price each projection model earns (unpenalised, as spread-fit reports it).
    const unpen = { priorClusters: 0, caution: 0, cap: Infinity };
    for (const m of MODELS) {
      const fr = rs.length ? fitProjectionShare(rs.map((r) => ({ lBooks: clampLogit(r.pBooks), lProj: clampLogit(r.p[m]), y: r.y, cluster: r.cluster })), unpen) : null;
      per[m].share = fr && { share: fr.raw, se: fr.se };
    }
    return { label, n: rs.length, clusters: new Set(rs.map((r) => r.cluster)).size, brierBooks: brier(rs, (r) => r.pBooks), llBooks: logLoss(rs, (r) => r.pBooks), per };
  });

  // Walk-forward blend, the way a price would use it: a share per stat group
  // fitted on earlier weeks' near-the-money rows (the pricing path's own
  // penalised, marked-down fit), applied to this week's rows.
  const blendWeeks = scoredWeeks.filter((w) => scoredWeeks.some((x) => x < w));
  const blend = {};
  for (const m of MODELS) {
    const scored = [];
    for (const w of blendWeeks) {
      for (const g of ["yards", "counts"]) {
        const train = ok.filter((r) => r.week < w && GROUP[r.stat] === g && BANDS[0][1](r));
        const fit = train.length ? fitProjectionShare(train.map((r) => ({ lBooks: clampLogit(r.pBooks), lProj: clampLogit(r.p[m]), y: r.y, cluster: r.cluster }))) : null;
        const b = fit ? fit.share : 0;
        for (const r of ok.filter((x) => x.week === w && GROUP[x.stat] === g && BANDS[0][1](x))) {
          const lB = clampLogit(r.pBooks);
          scored.push({ week: w, y: r.y, cluster: r.cluster, pBooks: r.pBooks, pBlend: sigmoid(lB + b * (clampLogit(r.p[m]) - lB)), share: b });
        }
      }
    }
    blend[m] = scored;
  }
  const blendRows = blend.tpn;
  const blendOut = {};
  for (const m of MODELS) {
    blendOut[m] = {
      n: blend[m].length,
      brier: brier(blend[m], (r) => r.pBlend),
      meanShare: mean(blend[m].map((r) => r.share)),
      vsBooks: pairedBrierDiff(blend[m].map((r) => ({ p: r.pBlend, q: r.pBooks, y: r.y, cluster: r.cluster }))),
      vsTpn: m === "tpn" ? null : pairedBrierDiff(blend[m].map((r, i) => ({ p: r.pBlend, q: blendRows[i].pBlend, y: r.y, cluster: r.cluster }))),
    };
  }
  const blendBooks = blendRows.length ? brier(blendRows, (r) => r.pBooks) : null;

  // Reliability of the tails: where the price says 1–10%, what happened.
  const tail = {};
  for (const m of MODELS) {
    tail[m] = [[0, 0.03], [0.03, 0.1], [0.1, 0.25], [0.75, 0.9], [0.9, 0.97], [0.97, 1.01]].map(([lo, hi]) => {
      const b = ok.filter((r) => r.p[m] >= lo && r.p[m] < hi);
      return { lo, hi, n: b.length, said: mean(b.map((r) => r.p[m])), happened: mean(b.map((r) => r.y)) };
    });
  }
  return { weeks: scoredWeeks, n: ok.length, bands, blend: blendOut, blendBooks, blendWeeks, tail };
}

// ---------------------------------------------------------------------------
// Section 3: the standard deviation each book is quoting
// ---------------------------------------------------------------------------

// P(over) of one quote, one row per quote, whichever side it was written from.
function quotePOver(q, hold) {
  const underOnly = q.overOdds === null && q.underOdds !== null;
  const fp = bookFairProb({ overOdds: q.overOdds, underOdds: q.underOdds, side: underOnly ? "under" : "over", assumedHold: hold });
  if (!fp) return null;
  const p = underOnly ? 1 - fp.fairProb : fp.fairProb;
  return p > 0 && p < 1 ? { p, twoSided: fp.source === "devig" } : null;
}

// Per (book, week, player, stat), the latest slot's rungs.
function bookBoards(quotes, actualsByWeek) {
  const holdByStat = estimateHoldByStat(quotes.filter((q) => isBettableStat(q.stat)));
  const byBoard = new Map();
  for (const q of quotes) {
    if (!STATS.includes(q.stat) || !isBettableStat(q.stat)) continue;
    const book = canonicalBookKey(q.book);
    if (!book) continue;
    const key = [book, q.week, q.playerId, q.stat].join("|");
    let b = byBoard.get(key);
    if (!b) byBoard.set(key, (b = { book, week: q.week, playerId: q.playerId, stat: q.stat, bySlot: new Map() }));
    const slot = q.slot || "main";
    if (!b.bySlot.has(slot)) b.bySlot.set(slot, new Map());
    const rung = b.bySlot.get(slot);
    if (!rung.has(q.line)) {
      const pr = quotePOver(q, holdByStat.get(q.stat) ?? DEFAULT_ASSUMED_HOLD);
      if (pr) rung.set(q.line, { line: q.line, ...pr });
    }
  }
  const boards = [];
  for (const b of byBoard.values()) {
    const actual = actualFor(actualsByWeek.get(b.week)?.get(b.playerId), b.stat);
    if (actual === null) continue;
    const slots = [...b.bySlot.entries()].filter(([, r]) => r.size > 0).sort((x, y) => (SLOT_RANK[y[0]] ?? -1) - (SLOT_RANK[x[0]] ?? -1));
    if (!slots.length) continue;
    // Ladder: the latest slot with three or more usable rungs. Single line: the latest slot at all.
    const ladderSlot = slots.find(([, r]) => [...r.values()].filter((x) => x.p > 0.02 && x.p < 0.98).length >= 3);
    const [slot, rungs] = slots[0];
    const near = [...rungs.values()].sort((x, y) => Math.abs(x.p - 0.5) - Math.abs(y.p - 0.5))[0];
    boards.push({ book: b.book, week: b.week, playerId: b.playerId, stat: b.stat, actual, slot, near, ladder: ladderSlot ? [...ladderSlot[1].values()].filter((x) => x.p > 0.02 && x.p < 0.98).sort((x, y) => x.line - y.line) : null });
  }
  return boards;
}

// E1: gamma fitted to each book's own ladder -> implied mean and SD; then the
// actual against it.
function ladderSDs(boards, maxLadders) {
  const out = {};
  const perBook = {};
  const groups = new Map();
  for (const b of boards) {
    if (!b.ladder) continue;
    const key = `${b.book}|${b.stat}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  for (const [key, list] of groups) {
    // Deterministic thinning: every k-th ladder, so a book with 30k does not dominate the runtime.
    const step = Math.max(1, Math.ceil(list.length / maxLadders));
    const picked = list.filter((_, i) => i % step === 0);
    const fits = [];
    for (const b of picked) {
      // A ladder has to span the distribution to say anything about its width:
      // rungs bunched near 50% fit any SD equally well.
      const ps = b.ladder.map((r) => r.p);
      if (b.ladder.length < 4 || Math.max(...ps) - Math.min(...ps) < 0.3) continue;
      const fit = fitGammaToQuantiles(b.ladder.map((r) => ({ x: r.line, p: 1 - r.p })));
      if (!fit || !(fit.mean > 0)) continue;
      // Reject fits that do not describe the ladder, and ones whose mean is
      // nowhere near the lines the book actually posted.
      const rel = Math.sqrt(fit.sse / b.ladder.length) / fit.mean;
      const mid = median(b.ladder.map((r) => r.line));
      if (rel > 0.12 || fit.mean < 0.5 * mid || fit.mean > 2 * mid) continue;
      const z = (b.actual - fit.mean) / fit.sd;
      const u = pitMid((x) => (x > 0 ? gammaP(fit.k, x / fit.theta) : 0), b.actual);
      fits.push({ mean: fit.mean, sd: fit.sd, cv: fit.sd / fit.mean, z, u, resid: b.actual - fit.mean });
    }
    if (fits.length >= 25) perBook[key] = { fits, boards: list.length };
  }
  // Every book pooled, per stat: the market's SD, whoever quoted it.
  for (const s of STATS) {
    const mine = Object.entries(perBook).filter(([k]) => k.endsWith(`|${s}`));
    const all = mine.flatMap(([, v]) => v.fits);
    if (all.length >= 25) perBook[`ALL BOOKS|${s}`] = { fits: all, boards: mine.reduce((a, [, v]) => a + v.boards, 0) };
  }
  for (const [key, { fits, boards }] of Object.entries(perBook)) {
    const zs = fits.map((f) => f.z);
    const mz = median(zs);
    out[key] = {
      boards,
      used: fits.length,
      impliedMean: median(fits.map((f) => f.mean)),
      impliedSD: median(fits.map((f) => f.sd)),
      impliedCV: median(fits.map((f) => f.cv)),
      // Realised: the standard deviation of the actual about the book's own mean, in the stat's units.
      realisedSD: sd(fits.map((f) => f.resid)),
      // The same in the book's own units: 1.00 means the book's SD was right on
      // average. The RMS is dragged by one blown ladder; the MAD-based one is not.
      ratio: Math.sqrt(mean(zs.map((z) => z * z))),
      ratioRobust: median(zs.map((z) => Math.abs(z - mz))) * 1.4826,
      bias: mean(zs),
      central: fits.filter((f) => f.u >= 0.25 && f.u <= 0.75).length / fits.length,
      tails: fits.filter((f) => f.u < 0.05 || f.u > 0.95).length / fits.length,
    };
  }
  return out;
}

// E2: centre every book on its own line, fit a variance law to the actuals, and
// read the SD at a common mean. Works for single-line books too.
function lawSDs(boards, refMean, startLaw) {
  const out = {};
  const groups = new Map();
  for (const b of boards) {
    const key = `${b.book}|${b.stat}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  // Pick the quote closest to 50% and keep it only if it is near enough that
  // "the line is roughly the median" is not asking much of the law.
  for (const [key, list] of groups) {
    const stat = key.split("|")[1];
    const usable = list.filter((b) => b.near && b.near.p >= 0.3 && b.near.p <= 0.7 && b.near.line > 0);
    if (usable.length < MIN_TRAIN) continue;
    let law = startLaw[stat] ?? { phi: 5, p: 1.5 };
    let pairs = [];
    for (let iter = 0; iter < 2; iter++) {
      pairs = usable.map((b) => ({ mu: meanFromQuantile(b.near.line, 1 - b.near.p, law.phi, law.p), a: b.actual })).filter((x) => x.mu > 0);
      const fit = fitLaw(pairs, "gamma");
      if (!fit) break;
      law = fit;
    }
    if (!pairs.length) continue;
    const mu = refMean[stat];
    const resid = pairs.map((x) => x.a - x.mu);
    const overs = usable.filter((b) => b.actual > b.near.line).length / usable.length;
    out[key] = {
      n: pairs.length,
      phi: law.phi,
      p: law.p,
      sdAtRef: Math.sqrt(law.phi * Math.pow(mu, law.p)),
      cvAtRef: Math.sqrt(law.phi * Math.pow(mu, law.p)) / mu,
      rmse: Math.sqrt(mean(resid.map((r) => r * r))),
      meanMu: mean(pairs.map((x) => x.mu)),
      ll: law.ll,
      bias: mean(usable.map((b) => b.actual - b.near.line)),
      overRate: overs,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const zs = (d) => (d?.n ? `${fx(d.mean)} (z ${d.z === null ? "–" : d.z.toFixed(1)})` : "–");

function render(season, meta, shape, price, ladders, lawBooks, projLaw) {
  const out = [];
  out.push(`# Distribution lab — ${season}`, "");
  out.push(
    `Weeks scored: ${shape.weeks.join(", ")} (every fit is as of the week it is applied to, so the earliest weeks only train). ` +
      `${shape.n.toLocaleString()} player-week/stat records and ${price.n.toLocaleString()} live-board rungs. ` +
      (meta.hindsight === 0
        ? "Every projection is the one that capture actually had, rebuilt from git history."
        : `${(meta.rows - meta.hindsight).toLocaleString()} rungs use the projection the capture had; ${meta.hindsight.toLocaleString()} use the latest committed snapshot, which has read everything since and flatters the projection. That is the same for every model below, so it does not tilt the comparison between them, but it does flatter all of them against the books.`),
    ""
  );
  out.push("Models:", "");
  for (const m of MODELS) out.push(`- **${m}** — ${LABEL[m]}`);
  out.push(
    "",
    "Counts and yardage totals are integers, so every model is read on the same lattice: integer *a* is the interval [a − ½, a + ½), and a whole-number line prices P(over | no push). The law-based models are centred on the mean of the gamma fitted to Floor/Median/Ceiling; only the spread (and shape) differs, so any gain over `tpn` is about spread and shape, not location.",
    "",
    "The two controls matter. `tpnWide` gives the current model the best single band multiplier per stat from earlier weeks; `normalLaw` gives a normal exactly the variance law that `gammaLaw` uses. Credit goes to the gamma/Tweedie *shape* only for what they earn over `normalLaw`, and to the *variance law* only for what `normalLaw` earns over `tpnWide`.",
    ""
  );

  out.push("## 1. Shape: how well does each model describe where the stat lands?", "");
  out.push("Average log-probability the model gave the actual outcome, higher is better, with the difference from the two-piece normal in parentheses. Each player-week-stat counts once.", "");
  const rowsS = [];
  for (const [stat, v] of Object.entries(shape.perStat)) rowsS.push([stat, v.n, ...MODELS.map((m) => (m === "tpn" ? f2(v[m].ll, 3) : `${f2(v[m].ll, 3)} (${fx(v[m].ll - v.tpn.ll, 3)})`))]);
  rowsS.push(["**all (weighted)**", shape.n, ...MODELS.map((m) => (m === "tpn" ? f2(shape.total[m], 3) : `${f2(shape.total[m], 3)} (${fx(shape.total[m] - shape.total.tpn, 3)})`))]);
  rowsS.push(["paired vs tpn (clustered z)", "", ...MODELS.map((m) => (m === "tpn" ? "—" : `z ${shape.diffs[m].z === null ? "–" : shape.diffs[m].z.toFixed(1)}`))]);
  out.push(table(["stat", "n", ...MODELS], rowsS), "");
  out.push("Calibration of the PIT: how often the actual landed in the middle 50% (target 50%) / outside the 5–95% range (target 10%) / was given under 0.1% (a model that rules the outcome out):", "");
  out.push(table(["stat", ...MODELS], Object.entries(shape.perStat).map(([stat, v]) => [stat, ...MODELS.map((m) => `${pct(v[m].central, 0)} / ${pct(v[m].tails, 0)} / ${pct(v[m].starved, 1)}`)])), "");
  out.push("`gammaExact` is shifted: through all three of Floor/Median/Ceiling the lower bound usually lands above zero, so any outcome under it has no probability at all. That last column is the cost.", "");

  out.push("### The variance law fitted on actuals", "");
  out.push("`Var = φ · mean^p`. p near 1 is Poisson-like (a Feller/CIR diffusion from zero has a gamma terminal law with exactly this; so does a compound Poisson process); p near 2 is a constant coefficient of variation (a geometric-type diffusion). In-sample on all graded weeks, for reading. A narrow range of means (quarterbacks) cannot identify p, so read the SD, not the exponent. SD is at the stat's median projected mean.", "");
  out.push(table(["stat", "n", "median mean", "gamma p", "gamma φ", "SD at median mean", "CV", "Tweedie p", "normal p"], STATS.map((st) => {
    const g = projLaw.gamma[st];
    if (!g) return [st, "–", "–", "–", "–", "–", "–", "–", "–"];
    const mu = projLaw.ref[st];
    const sdv = Math.sqrt(g.phi * Math.pow(mu, g.p));
    return [st, g.n, f2(mu, 1), f2(g.p), f2(g.phi, 2), f2(sdv, 1), pct(sdv / mu, 0), projLaw.tweedie[st] ? f2(projLaw.tweedie[st].p) : "–", projLaw.normal[st] ? f2(projLaw.normal[st].p) : "–"];
  })), "");
  out.push("The projection's own Floor-to-Ceiling band implies an SD of about (C − F) / 1.35. Against that, the SD the actuals say (above) is what the books are really up against.", "");
  out.push(table(["stat", "band-implied SD (median)", "actuals-implied SD at median mean", "ratio"], STATS.map((st) => {
    const g = projLaw.gamma[st];
    const b = projLaw.bandSD[st];
    if (!g || b === null) return [st, "–", "–", "–"];
    const sdv = Math.sqrt(g.phi * Math.pow(projLaw.ref[st], g.p));
    return [st, f2(b, 1), f2(sdv, 1), f2(sdv / b)];
  })), "");

  out.push("## 2. Price: does a better shape earn a bigger share of the price?", "");
  out.push("Live-board rungs, every model on the same rows. Brier is the projection-alone price against what happened. Δ columns are Brier of this model − the reference, clustered by player-week (negative is better). *Share* is how far to move from the books toward the projection to match what happened (0 ignore it, 1 believe it), unpenalised.", "");
  for (const b of price.bands) {
    out.push(`**${b.label}** — ${b.n.toLocaleString()} rungs, ${b.clusters.toLocaleString()} player-weeks; the books alone score Brier ${f2(b.brierBooks, 4)}`, "");
    out.push(table(["model", "Brier", "Δ vs tpn", "Δ vs tpnWide", "Δ vs normalLaw", "log-loss", "share ± 95%"], MODELS.map((m) => {
      const x = b.per[m];
      return [m, f2(x.brier, 4), x.diff ? zs(x.diff) : "—", x.diffWide ? zs(x.diffWide) : "—", x.diffNormal ? zs(x.diffNormal) : "—", f2(x.ll, 4), x.share ? `${f2(x.share.share)} ±${x.share.se === null ? "–" : f2(1.96 * x.share.se)}` : "–"];
    })), "");
  }
  out.push("### Tails: what happened when the model said …", "");
  const tailCols = price.tail.tpn.map((t) => `${(t.lo * 100).toFixed(0)}–${Math.min(100, t.hi * 100).toFixed(0)}%`);
  out.push(table(["model", ...tailCols], MODELS.map((m) => [m, ...price.tail[m].map((t) => (t.n >= 20 ? `${pct(t.said)} → ${pct(t.happened)} (${t.n.toLocaleString()})` : "–"))])), "");
  out.push("### Walk-forward blend", "");
  out.push(`The price as the pipeline would build it: near the money, a share per stat group fitted on earlier weeks (the pricing path's own penalised, marked-down fit), applied to the week in question. Weeks ${price.blendWeeks.join(", ")}. Books alone: Brier ${f2(price.blendBooks, 4)}.`, "");
  out.push(table(["model", "rungs", "mean share used", "blend Brier", "blend − books", "blend − tpn blend"], MODELS.map((m) => {
    const x = price.blend[m];
    return [m, x.n.toLocaleString(), f2(x.meanShare), f2(x.brier, 4), zs(x.vsBooks), m === "tpn" ? "—" : zs(x.vsTpn)];
  })), "");

  out.push("## 3. Books: what standard deviation is each one quoting?", "");
  out.push("Books are keyed by canonical name (`Hard Rock` and `hardrock` are one). Each book's latest board per player-week is used; a price is de-vigged where both sides were quoted and stripped of an assumed hold otherwise.", "");
  out.push("### 3a. From each book's own alternate-line ladder", "");
  out.push(
    "A gamma is fitted to the book's ladder (rungs between 2% and 98%; at least four rungs spanning at least 30 points of probability; a fit that tracks the ladder and sits near its lines), which gives the book's **implied mean and SD**. The actual is read against it. **Ratio** is the root-mean-square of (actual − implied mean) / implied SD: 1.00 means the book's SD was right on average, above 1 means it quoted too tight. **Robust ratio** is the same from the MAD, which one blown ladder cannot move. **Realised SD** is the standard deviation of the actual about the book's mean, in the stat's units. *Central / tails* are PIT coverage (targets 50% / 10%). A cell needs 25 usable ladders.",
    ""
  );
  const lk = Object.entries(ladders).sort((x, y) => (x[0].startsWith("ALL") ? 1 : 0) - (y[0].startsWith("ALL") ? 1 : 0) || x[0].localeCompare(y[0]));
  out.push(table(["book", "stat", "ladders", "implied mean", "implied SD", "implied CV", "realised SD", "ratio", "robust ratio", "bias (z)", "central / tails"], lk.map(([k, v]) => {
    const [book, stat] = k.split("|");
    return [book === "ALL BOOKS" ? "**all books**" : book, stat, v.used.toLocaleString(), f2(v.impliedMean, 1), f2(v.impliedSD, 1), pct(v.impliedCV, 0), f2(v.realisedSD, 1), `**${f2(v.ratio)}**`, f2(v.ratioRobust), fx(v.bias, 2), `${pct(v.central, 0)} / ${pct(v.tails, 0)}`];
  })), "");

  // Per-book roll-up across stats: median robust ratio.
  const byBook = new Map();
  for (const [k, v] of Object.entries(ladders)) {
    const [book] = k.split("|");
    if (book === "ALL BOOKS") continue;
    if (!byBook.has(book)) byBook.set(book, []);
    byBook.get(book).push(v);
  }
  out.push("Per book, across the stats it has enough ladders for:", "");
  out.push(table(["book", "stats", "ladders", "median ratio", "median robust ratio", "range of ratio"], [...byBook.entries()].sort().map(([book, vs]) => [book, vs.length, vs.reduce((a, v) => a + v.used, 0).toLocaleString(), f2(median(vs.map((v) => v.ratio))), f2(median(vs.map((v) => v.ratioRobust))), `${f2(Math.min(...vs.map((v) => v.ratio)))}–${f2(Math.max(...vs.map((v) => v.ratio)))}`])), "");

  out.push("### 3b. From a variance law fitted to each book's centre", "");
  out.push(
    "Works for books that only post a main line. Each book's quote nearest 50% (kept if between 30% and 70%) is its centre: the line is placed at its quoted quantile of a gamma whose variance follows `φ · mean^p`, and the law is fitted to the actuals by maximum likelihood. **SD at the reference mean** is that book's SD for a player whose mean is the stat's median projection, which makes books directly comparable. *Mean (actual − line)* and *over rate* say whether the book's centre ran high or low. *ll* is the log-likelihood per record: how good the book's *centre* is, on the same footing as the RotoWire projection's own `projection` row.",
    ""
  );
  out.push(`Reference means: ${STATS.filter((st) => projLaw.gamma[st]).map((st) => `${st} ${f2(projLaw.ref[st], 1)}`).join(", ")}.`, "");
  const lb = Object.entries(lawBooks).sort((x, y) => (x[0].startsWith("projection") ? -1 : 0) - (y[0].startsWith("projection") ? -1 : 0) || x[0].localeCompare(y[0]));
  out.push(table(["book", "stat", "n", "p", "φ", "SD at ref mean", "CV", "RMSE", "mean (actual − line)", "over rate", "ll"], lb.map(([k, v]) => {
    const [book, stat] = k.split("|");
    return [book, stat, v.n.toLocaleString(), f2(v.p), f2(v.phi, 2), f2(v.sdAtRef, 1), pct(v.cvAtRef, 0), f2(v.rmse, 1), fx(v.bias, 2), pct(v.overRate, 0), f2(v.ll, 3)];
  })), "");

  out.push("## 4. What this says, and what it does not", "");
  return { text: out.join("\n"), out };
}

// ---------------------------------------------------------------------------

function loadRows(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const seasons = availableSeasons(a.dataDir);
  const season = a.season ?? seasons[seasons.length - 1];
  if (!season) throw new Error(`No prop captures under ${a.dataDir}/props/`);

  console.error("Loading captures …");
  const { quotes, actualsByWeek } = timeIt("loadSeason", () => loadSeason(season, { dataDir: a.dataDir }));
  const quotesAll = withLiveClosing(quotes, loadLiveClosing({ dataDir: a.dataDir, season }));

  const pairs = timeIt("player-week pairs", () => buildPairs(a.dataDir, season, actualsByWeek));
  const lawAt = lawsAsOf(pairs);
  const widthAt = widthsAsOf(pairs);
  const cdfOf = makeCdfs(lawAt, widthAt);

  const shape = timeIt("shape", () => shapeSection(pairs, cdfOf, lawAt, widthAt));
  if (shape.n === 0) throw new Error("No week has enough earlier weeks to fit a variance law.");

  // Rebuilding the market rows replays git history and the source-weight model,
  // by far the slowest step; --cache keeps them between runs while iterating.
  let built = a.cache ? loadRows(a.cache) : null;
  if (built) console.error(`  using cached market rows from ${a.cache}`);
  else {
    built = timeIt("market rows", () => buildMarketRows(a, season, quotesAll, actualsByWeek));
    if (a.cache) writeFileSync(a.cache, JSON.stringify(built));
  }
  const { rows, hindsight } = built;
  const price = timeIt("price", () => priceSection(rows, cdfOf, lawAt, widthAt));

  // In-sample law per stat, for reading and for starting the per-book fit.
  const projLaw = { gamma: {}, tweedie: {}, normal: {}, ref: {}, bandSD: {} };
  for (const st of STATS) {
    const tr = pairs.filter((p) => p.stat === st);
    const mp = tr.map((p) => ({ mu: p.mu0, a: p.a }));
    projLaw.ref[st] = median(tr.map((p) => p.mu0));
    projLaw.bandSD[st] = tr.length ? median(tr.map((p) => (p.C - p.F) / 1.349)) : null;
    for (const fam of ["gamma", "tweedie", "normal"]) projLaw[fam][st] = tr.length >= MIN_TRAIN ? fitLaw(mp, fam) : null;
  }

  const boards = timeIt("book boards", () => bookBoards(quotesAll, actualsByWeek));
  const ladders = timeIt("ladder SDs", () => ladderSDs(boards, a.maxLadders));
  const lawBooks = timeIt("book law fits", () => lawSDs(boards, projLaw.ref, projLaw.gamma));
  // The projection itself, on the same footing as a book (its median as the centre).
  for (const st of STATS) {
    const tr = pairs.filter((p) => p.stat === st);
    if (tr.length < MIN_TRAIN) continue;
    const g = projLaw.gamma[st];
    const pp = tr.map((p) => ({ mu: meanFromQuantile(p.M, 0.5, g.phi, g.p), a: p.a })).filter((x) => x.mu > 0);
    const fit = fitLaw(pp, "gamma");
    if (!fit) continue;
    const mu = projLaw.ref[st];
    lawBooks[`projection|${st}`] = {
      n: pp.length, phi: fit.phi, p: fit.p, sdAtRef: Math.sqrt(fit.phi * Math.pow(mu, fit.p)), cvAtRef: Math.sqrt(fit.phi * Math.pow(mu, fit.p)) / mu,
      rmse: Math.sqrt(mean(tr.map((p) => (p.a - p.M) ** 2))), bias: mean(tr.map((p) => p.a - p.M)), overRate: tr.filter((p) => p.a > p.M).length / tr.length, ll: fit.ll,
    };
  }

  const { text, out } = render(season, { rows: rows.length, hindsight }, shape, price, ladders, lawBooks, projLaw);
  const full = text + "\n" + (a.reading ?? "");
  console.log(full);

  if (a.write) {
    const dir = join(a.dataDir, "pricing", String(season));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dist-lab.md"), full + "\n");
    writeFileSync(join(dir, "dist-lab.json"), JSON.stringify({ season, hindsightRows: hindsight, shape, price, projLaw, ladders, lawBooks }, null, 2) + "\n");
    console.error(`\nWrote ${dir}/dist-lab.md and dist-lab.json`);
  }
}

try {
  main();
} catch (err) {
  console.error(`dist-lab: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}
