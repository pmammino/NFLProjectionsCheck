// Build script: joins weekly_projections.csv + actual_games.csv into a compact
// JSON the dashboard consumes. Runs on `predev` / `prebuild` so Vercel always
// has fresh data without committing the generated artifact.
//
// Join key: actual_games.ID (col 2) === weekly_projections.PlayerID
// Splits:   C = Ceiling (75th pct), M = Median (50th), F = Floor (25th pct)
//
// Comparison philosophy (per project requirements):
//  - Volume stats (Pass Att, Rush Att, Targets) compared directly.
//  - Efficiency stats compared as RATES (e.g. Yards/Target), never totals.
//    Each split's rate = that split's total / that split's volume.
//  - Stats are only emitted for a row when relevant to the player's position
//    (QBs aren't graded on receiving; non-QBs aren't graded on passing).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseCsv(path) {
  const text = readFileSync(path, "utf8").replace(/\r/g, "");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = cells[j];
    rows.push(obj);
  }
  return rows;
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (n, d = 3) => {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
};

// ---- Metric definitions -------------------------------------------------
// kind: "volume" | "efficiency"
// proj: how to read the projected value from a split's projection row.
//   volume  -> field name (raw total/count)
//   eff     -> { numer, denom } rate within the split
// actual: how to read the actual value from an actual row (same shape).
// vol: the volume field used for relevance + min-volume filtering.
const METRICS = [
  // ---- Volume ----
  {
    key: "passAtt",
    label: "Pass Attempts",
    group: "Passing",
    kind: "volume",
    positions: ["QB"],
    proj: "PassAttempts",
    actual: "PassAtt",
    projVol: "PassAttempts",
    actualVol: "PassAtt",
  },
  {
    key: "rushAtt",
    label: "Rush Attempts",
    group: "Rushing",
    kind: "volume",
    positions: ["QB", "RB", "WR", "TE"],
    proj: "RushAttempts",
    actual: "Rushes",
    projVol: "RushAttempts",
    actualVol: "Rushes",
  },
  {
    key: "targets",
    label: "Targets",
    group: "Receiving",
    kind: "volume",
    positions: ["RB", "WR", "TE"],
    proj: "Targets",
    actual: "Targets",
    projVol: "Targets",
    actualVol: "Targets",
  },
  // ---- Passing efficiency (QB only) ----
  {
    key: "passYpa",
    label: "Pass Yards / Attempt",
    group: "Passing",
    kind: "efficiency",
    unit: "yds",
    positions: ["QB"],
    proj: { numer: "PassYards", denom: "PassAttempts" },
    actual: { numer: "PassYards", denom: "PassAtt" },
    projVol: "PassAttempts",
    actualVol: "PassAtt",
  },
  {
    key: "compPct",
    label: "Completion %",
    group: "Passing",
    kind: "efficiency",
    unit: "pct",
    positions: ["QB"],
    proj: { numer: "PassCompletions", denom: "PassAttempts" },
    actual: { numer: "PassComp", denom: "PassAtt" },
    projVol: "PassAttempts",
    actualVol: "PassAtt",
  },
  {
    key: "passTdRate",
    label: "Pass TD / Attempt",
    group: "Passing",
    kind: "efficiency",
    unit: "rate",
    positions: ["QB"],
    proj: { numer: "PassTDs", denom: "PassAttempts" },
    actual: { numer: "PassTD", denom: "PassAtt" },
    projVol: "PassAttempts",
    actualVol: "PassAtt",
  },
  // ---- Rushing efficiency ----
  {
    key: "rushYpc",
    label: "Rush Yards / Attempt",
    group: "Rushing",
    kind: "efficiency",
    unit: "yds",
    positions: ["QB", "RB", "WR", "TE"],
    proj: { numer: "RushYards", denom: "RushAttempts" },
    actual: { numer: "RushYards", denom: "Rushes" },
    projVol: "RushAttempts",
    actualVol: "Rushes",
  },
  {
    key: "rushTdRate",
    label: "Rush TD / Attempt",
    group: "Rushing",
    kind: "efficiency",
    unit: "rate",
    positions: ["QB", "RB", "WR", "TE"],
    proj: { numer: "RushTDs", denom: "RushAttempts" },
    actual: { numer: "RushTD", denom: "Rushes" },
    projVol: "RushAttempts",
    actualVol: "Rushes",
  },
  // ---- Receiving efficiency ----
  {
    key: "recYpt",
    label: "Rec Yards / Target",
    group: "Receiving",
    kind: "efficiency",
    unit: "yds",
    positions: ["RB", "WR", "TE"],
    proj: { numer: "RecYards", denom: "Targets" },
    actual: { numer: "ReceptYds", denom: "Targets" },
    projVol: "Targets",
    actualVol: "Targets",
  },
  {
    key: "catchRate",
    label: "Catch Rate",
    group: "Receiving",
    kind: "efficiency",
    unit: "pct",
    positions: ["RB", "WR", "TE"],
    proj: { numer: "RecCompletions", denom: "Targets" },
    actual: { numer: "Receptions", denom: "Targets" },
    projVol: "Targets",
    actualVol: "Targets",
  },
  {
    key: "recTdRate",
    label: "Rec TD / Target",
    group: "Receiving",
    kind: "efficiency",
    unit: "rate",
    positions: ["RB", "WR", "TE"],
    proj: { numer: "RecTDs", denom: "Targets" },
    actual: { numer: "RecptTD", denom: "Targets" },
    projVol: "Targets",
    actualVol: "Targets",
  },
];

// Minimum volume for an efficiency rate to be considered meaningful (avoids
// 1-carry-for-20-yards style noise). Applied to BOTH projected & actual volume.
const MIN_EFF_VOLUME = 3;

// Primary volume field per position, used for the in-game injury proxy.
const PRIMARY_VOL = {
  QB: { proj: "PassAttempts", actual: "PassAtt", expect: 15 },
  RB: { proj: "RushAttempts", actual: "Rushes", expect: 8 },
  WR: { proj: "Targets", actual: "Targets", expect: 5 },
  TE: { proj: "Targets", actual: "Targets", expect: 4 },
};

// Touchdowns are rare count events (actuals are essentially 0/1/2 per game), so
// a continuous "rate band" comparison is the wrong frame. Instead we emit the
// projected EXPECTED TD COUNT (the model's own TD total per split) and the
// ACTUAL TD COUNT, and evaluate them with rare-event calibration in the app
// (expected-vs-actual binning + Poisson P(>=1 TD) reliability / Brier / log-loss).
const TD_TYPES = [
  {
    key: "passTD",
    label: "Passing TDs",
    positions: ["QB"],
    proj: "PassTDs",
    actual: "PassTD",
    projVol: "PassAttempts",
    actualVol: "PassAtt",
    volLabel: "pass attempts",
    minOpp: 5,
  },
  {
    key: "rushTD",
    label: "Rushing TDs",
    positions: ["QB", "RB", "WR", "TE"],
    proj: "RushTDs",
    actual: "RushTD",
    projVol: "RushAttempts",
    actualVol: "Rushes",
    volLabel: "rush attempts",
    minOpp: 2,
  },
  {
    key: "recTD",
    label: "Receiving TDs",
    positions: ["RB", "WR", "TE"],
    proj: "RecTDs",
    actual: "RecptTD",
    projVol: "Targets",
    actualVol: "Targets",
    volLabel: "targets",
    minOpp: 2,
  },
];

function readSplitValue(spec, row) {
  if (typeof spec === "string") return num(row[spec]);
  const d = num(row[spec.denom]);
  if (d <= 0) return null;
  return num(row[spec.numer]) / d;
}

function main() {
  const projRows = parseCsv(join(ROOT, "weekly_projections.csv"));
  const actualRows = parseCsv(join(ROOT, "actual_games.csv"));

  // Pivot projections: key = `${PlayerID}|${GameWeek}` -> { C, F, M, team }
  const proj = new Map();
  for (const r of projRows) {
    const key = `${r.PlayerID}|${r.GameWeek}`;
    let e = proj.get(key);
    if (!e) {
      e = { team: (r.Team || "").toUpperCase(), C: null, F: null, M: null };
      proj.set(key, e);
    }
    e[r.Split] = r;
  }

  const out = [];
  const td = [];
  let matched = 0;
  let injSuspect = 0;

  for (const a of actualRows) {
    const pid = a.ID;
    const week = a.Week;
    const pos = a.position;
    const key = `${pid}|${week}`;
    const p = proj.get(key);
    if (!p || !p.C || !p.F || !p.M) continue; // no projection for this player-week
    matched++;

    const team = p.team || (a.NFLTeamID || "").toUpperCase();
    const metricsOut = {};

    for (const m of METRICS) {
      if (!m.positions.includes(pos)) continue;

      const actualVol = num(a[m.actualVol]);
      const projMedVol = num(p.M[m.projVol]);

      if (m.kind === "efficiency") {
        // Need meaningful volume on both sides for a fair rate comparison.
        if (actualVol < MIN_EFF_VOLUME || projMedVol < MIN_EFF_VOLUME) continue;
      } else {
        // Volume: relevant if there was expected usage OR actual usage.
        if (projMedVol <= 0 && actualVol <= 0) continue;
      }

      const f = readSplitValue(m.proj, p.F);
      const med = readSplitValue(m.proj, p.M);
      const c = readSplitValue(m.proj, p.C);
      const actual = readSplitValue(m.actual, a);
      if (f === null || med === null || c === null || actual === null) continue;

      const lo = Math.min(f, c);
      const hi = Math.max(f, c);
      const within = actual >= lo && actual <= hi;
      // Signed error vs median, and as a % of median for cross-stat comparison.
      const err = actual - med;
      const pctErr = med !== 0 ? err / Math.abs(med) : null;

      metricsOut[m.key] = {
        f: round(f),
        m: round(med),
        c: round(c),
        a: round(actual),
        in: within,
        err: round(err),
        pe: pctErr === null ? null : round(pctErr, 4),
        av: round(actualVol, 1), // actual volume (for min-volume UI filtering)
      };
    }

    // In-game injury proxy: expected to play a real role but recorded almost
    // nothing. Can't distinguish injury from benching/ejection with this data.
    let inj = false;
    const pv = PRIMARY_VOL[pos];
    if (pv) {
      const projMed = num(p.M[pv.proj]);
      const projFloor = num(p.F[pv.proj]);
      const act = num(a[pv.actual]);
      if (
        projMed >= pv.expect &&
        act < projFloor * 0.5 &&
        act < projMed * 0.4
      ) {
        inj = true;
        injSuspect++;
      }
    }

    // Touchdown rows (count/rare-event framing) — collected independently of
    // the rate metrics above so the dedicated TD calibration view has clean data.
    for (const t of TD_TYPES) {
      if (!t.positions.includes(pos)) continue;
      const actualVol = num(a[t.actualVol]);
      const actualTD = num(a[t.actual]);
      // Evaluate only games where the player had a real opportunity to score.
      if (actualVol < t.minOpp && actualTD === 0) continue;
      td.push({
        type: t.key,
        pid,
        team,
        pos,
        wk: Number(week),
        inj,
        lf: round(num(p.F[t.proj]), 4), // projected expected TDs — floor
        lm: round(num(p.M[t.proj]), 4), // projected expected TDs — median
        lc: round(num(p.C[t.proj]), 4), // projected expected TDs — ceiling
        a: actualTD, // actual TD count
        av: round(actualVol, 1),
      });
    }

    if (Object.keys(metricsOut).length === 0) continue;

    out.push({ pid, team, pos, wk: Number(week), inj, m: metricsOut });
  }

  const weeks = [...new Set(out.map((r) => r.wk))].sort((x, y) => x - y);
  const teams = [...new Set(out.map((r) => r.team))].filter(Boolean).sort();

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      season: 2025,
      weeks,
      teams,
      positions: ["QB", "RB", "WR", "TE"],
      minEffVolume: MIN_EFF_VOLUME,
      metrics: METRICS.map((m) => ({
        key: m.key,
        label: m.label,
        group: m.group,
        kind: m.kind,
        unit: m.unit || (m.kind === "volume" ? "count" : "rate"),
        positions: m.positions,
      })),
      tdTypes: TD_TYPES.map((t) => ({
        key: t.key,
        label: t.label,
        positions: t.positions,
        volLabel: t.volLabel,
        minOpp: t.minOpp,
      })),
      counts: {
        actualRows: actualRows.length,
        matchedPlayerWeeks: matched,
        emittedRows: out.length,
        tdRows: td.length,
        injurySuspect: injSuspect,
      },
    },
    rows: out,
    td,
  };

  const outDir = join(ROOT, "public", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "dashboard.json");
  writeFileSync(outPath, JSON.stringify(payload));
  const kb = (readFileSync(outPath).length / 1024).toFixed(0);
  console.log(
    `build-data: ${out.length} rows, ${td.length} TD rows (${matched} matched, ${injSuspect} injury-suspect) -> ${outPath} (${kb} KB)`
  );
}

main();
