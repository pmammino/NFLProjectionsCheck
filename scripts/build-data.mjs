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
//  - Touchdowns are NOT in the metric set at all — neither as per-attempt /
//    per-target rates nor as raw counts. Both framings fail here: a TD is a
//    near-binary event, and a floor–median–ceiling band cannot contain the
//    modal outcome of zero (measured on 2025: the projected floor sits above
//    zero in 92% of receiving rows while 85% of them score nothing, dragging
//    the within-band rate to 9.6% against a 50% target — an artefact of the
//    frame, not of the projection). TDs are emitted separately as TD_TYPES
//    below and graded as a PROBABILITY forecast in the app: each projected
//    expected-TD count becomes a Poisson P(>=1 TD), scored against the binary
//    outcome with a reliability curve, Brier skill and log loss.
//  - Stats are only emitted for a row when relevant to the player's position
//    (QBs aren't graded on receiving; non-QBs aren't graded on passing).

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
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
];

// Minimum volume for an efficiency rate to be considered meaningful (avoids
// 1-carry-for-20-yards style noise). Applied to BOTH projected & actual volume.
const MIN_EFF_VOLUME = 3;

// Minimum PROJECTED volume for a COUNT metric to be gradeable at all.
//
// Below roughly one expected event the floor-median-ceiling band is degenerate:
// the floor sits above zero while zero is the modal outcome, so no integer can
// land inside it and the row scores as a miss whichever way it falls. Measured
// on 2025, rows with a projected median under 1 are 0.0% within-band when the
// actual is zero and 1.5% when it isn't — the band is reporting its own shape,
// not the projection. Grading wide receivers on a median of 0.12 carries this
// way dragged Rush Attempts to 15.2% overall (WR 1.0% over 1,351 rows, TE 0.5%
// over 209); gating them out puts it at 32.0%, with QB and RB barely moving.
//
// The gate looks ONLY at the projected volume, never the actual. The previous
// rule ("projected nothing AND recorded nothing") conditioned the sample on the
// outcome, keeping a player's breakout week while dropping his quiet one, which
// biases every coverage number built on top of it.
const MIN_VOL_RELEVANCE = 1;

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

// A cell is "missing" when empty/undefined — e.g. Targets in snapshots taken
// before the projection feeds carried a target count. Treat blank as missing
// and let the caller skip that metric rather than reading it as a real 0.
const isBlank = (v) => v === undefined || v === null || v === "";

function readSplitValue(spec, row) {
  if (typeof spec === "string") {
    return isBlank(row[spec]) ? null : num(row[spec]);
  }
  if (isBlank(row[spec.numer]) || isBlank(row[spec.denom])) return null;
  const d = num(row[spec.denom]);
  if (d <= 0) return null;
  return num(row[spec.numer]) / d;
}

// ---- Season-long config -------------------------------------------------
// The season files use the same stats but different column names. We derive
// the season metric/TD configs from the weekly ones via these field maps so
// the two stay in lockstep.
const SEASON_PROJ_FIELD = {
  PassAttempts: "PassAtt",
  RushAttempts: "RushAtt",
  Targets: "Targets",
  PassCompletions: "PassComp",
  PassYards: "PassYard",
  PassTDs: "PassTD",
  PassInts: "PassInt",
  RushYards: "RushYard",
  RushTDs: "RushTD",
  RecCompletions: "Receptions",
  RecYards: "RecYard",
  RecTDs: "RecTD",
};
const SEASON_ACTUAL_FIELD = {
  PassAtt: "pass_att",
  Rushes: "rush_att",
  Targets: "Targets",
  PassComp: "pass_comp",
  PassYards: "pass_yards",
  PassTD: "pass_td",
  RushYards: "rush_yards",
  RushTD: "rush_td",
  ReceptYds: "rec_yards",
  Receptions: "Receptions",
  RecptTD: "rec_td",
};

const mapProj = (spec) =>
  typeof spec === "string"
    ? SEASON_PROJ_FIELD[spec]
    : { numer: SEASON_PROJ_FIELD[spec.numer], denom: SEASON_PROJ_FIELD[spec.denom] };
const mapActual = (spec) =>
  typeof spec === "string"
    ? SEASON_ACTUAL_FIELD[spec]
    : { numer: SEASON_ACTUAL_FIELD[spec.numer], denom: SEASON_ACTUAL_FIELD[spec.denom] };

const SEASON_METRICS = METRICS.map((m) => ({
  ...m,
  proj: mapProj(m.proj),
  actual: mapActual(m.actual),
  projVol: SEASON_PROJ_FIELD[m.projVol],
  actualVol: SEASON_ACTUAL_FIELD[m.actualVol],
}));

// Season TD opportunity thresholds scale up from per-game to full-season.
const SEASON_TD_MIN_OPP = { passTD: 50, rushTD: 20, recTD: 15 };
const SEASON_TD_TYPES = TD_TYPES.map((t) => ({
  ...t,
  proj: SEASON_PROJ_FIELD[t.proj],
  actual: SEASON_ACTUAL_FIELD[t.actual],
  projVol: SEASON_PROJ_FIELD[t.projVol],
  actualVol: SEASON_ACTUAL_FIELD[t.actualVol],
  minOpp: SEASON_TD_MIN_OPP[t.key],
}));

// Season volumes are full-year totals, so the efficiency noise floor is higher.
const SEASON_MIN_EFF_VOLUME = 25;
// The count-metric floor scales the same way (3 -> 25 is ~8.3x, so 1 -> 8).
// The season Rush Attempts curve has flattened by there (~60% within band).
const SEASON_MIN_VOL_RELEVANCE = 8;

// Legacy season dataset: full-season projection + actual CSVs (2025). Used only
// on the legacy fallback path (no live snapshots), where it's a complete season.
function buildSeasonFromLegacyCsv(teamByPid) {
  const projRows = parseCsv(join(ROOT, "season_projections.csv"));
  const actualRows = parseCsv(join(ROOT, "actual_season_stats.csv"));

  const proj = new Map();
  for (const r of projRows) {
    let e = proj.get(r.NFLNewsID);
    if (!e) {
      e = { C: null, F: null, M: null };
      proj.set(r.NFLNewsID, e);
    }
    e[r.Split] = r;
  }

  const out = [];
  const td = [];
  let matched = 0;

  for (const a of actualRows) {
    const pid = a.PlayerID;
    const pos = a.position;
    const p = proj.get(pid);
    if (!p || !p.C || !p.F || !p.M) continue;
    matched++;
    const team = teamByPid.get(pid) || "";
    const metricsOut = {};

    for (const m of SEASON_METRICS) {
      if (!m.positions.includes(pos)) continue;
      const actualVol = num(a[m.actualVol]);
      const projMedVol = num(p.M[m.projVol]);

      if (m.kind === "efficiency") {
        if (actualVol < SEASON_MIN_EFF_VOLUME || projMedVol < SEASON_MIN_EFF_VOLUME)
          continue;
      } else {
        if (projMedVol < SEASON_MIN_VOL_RELEVANCE) continue;
      }

      const f = readSplitValue(m.proj, p.F);
      const med = readSplitValue(m.proj, p.M);
      const c = readSplitValue(m.proj, p.C);
      const actual = readSplitValue(m.actual, a);
      if (f === null || med === null || c === null || actual === null) continue;

      const lo = Math.min(f, c);
      const hi = Math.max(f, c);
      const err = actual - med;
      metricsOut[m.key] = {
        f: round(f),
        m: round(med),
        c: round(c),
        a: round(actual),
        in: actual >= lo && actual <= hi,
        err: round(err),
        pe: med !== 0 ? round(err / Math.abs(med), 4) : null,
        av: round(actualVol, 1),
        pv: round(projMedVol, 1),
      };
    }

    for (const t of SEASON_TD_TYPES) {
      if (!t.positions.includes(pos)) continue;
      const actualVol = num(a[t.actualVol]);
      const actualTD = num(a[t.actual]);
      if (actualVol < t.minOpp && actualTD === 0) continue;
      td.push({
        type: t.key,
        pid,
        team,
        pos,
        wk: 0,
        inj: false,
        lf: round(num(p.F[t.proj]), 4),
        lm: round(num(p.M[t.proj]), 4),
        lc: round(num(p.C[t.proj]), 4),
        a: actualTD,
        av: round(actualVol, 1),
        pv: round(num(p.M[t.projVol]), 1),
      });
    }

    if (Object.keys(metricsOut).length === 0) continue;
    out.push({ pid, team, pos, wk: 0, inj: false, m: metricsOut });
  }

  return {
    rows: out,
    td,
    counts: {
      actualPlayers: actualRows.length,
      matchedPlayers: matched,
      emittedRows: out.length,
      tdRows: td.length,
    },
  };
}

// ---- Season-long from live weekly snapshots ------------------------------
// There is no season-long projection feed, so a season-long view is built by
// summing the weekly snapshots into per-player season-to-date totals and grading
// them exactly like the weekly rows (same METRICS/TD_TYPES, season thresholds).
// This is only surfaced once the season is complete (see SEASON_COMPLETE_WEEKS);
// mid-season a running-total grade is noise, so the dashboard hides the scope.

// Numeric columns to sum, in each snapshot schema.
const PROJ_NUM_COLS = [
  "PassAttempts", "RushAttempts", "Targets", "PassCompletions", "PassYards",
  "PassTDs", "PassInts", "RushYards", "RushTDs", "RecCompletions", "RecYards", "RecTDs",
];
const ACTUAL_NUM_COLS = [
  "Rushes", "RushYards", "PassComp", "PassAtt", "PassYards", "Receptions",
  "ReceptYds", "PassTD", "RecptTD", "RushTD", "Targets",
];

// A full regular season. Season-long grading stays hidden until this many
// distinct weeks of actuals exist (override with SEASON_LONG=on|off).
const SEASON_COMPLETE_WEEKS = 18;

// Sum each column across rows; a column with no non-blank value stays blank so
// unprojected fields remain "missing" and skip, rather than reading as 0.
function aggregateSum(rows, columns) {
  const out = {};
  for (const col of columns) {
    let sum = 0;
    let seen = false;
    for (const r of rows) {
      const v = r[col];
      if (v === undefined || v === "") continue;
      const n = parseFloat(v);
      if (Number.isFinite(n)) {
        sum += n;
        seen = true;
      }
    }
    out[col] = seen ? String(sum) : "";
  }
  return out;
}

function buildSeasonFromWeekly(projRows, actualRows) {
  // Group weekly projection rows per player, keeping each split's rows.
  const projByPid = new Map();
  for (const r of projRows) {
    let e = projByPid.get(r.PlayerID);
    if (!e) {
      e = { team: (r.Team || "").toUpperCase(), C: [], F: [], M: [] };
      projByPid.set(r.PlayerID, e);
    }
    if (e[r.Split]) e[r.Split].push(r);
  }
  // Group weekly actual rows per player.
  const actByPid = new Map();
  for (const a of actualRows) {
    let e = actByPid.get(a.ID);
    if (!e) {
      e = { pos: a.position, team: (a.NFLTeamID || "").toUpperCase(), rows: [] };
      actByPid.set(a.ID, e);
    }
    e.rows.push(a);
  }
  const weeksWithActuals = new Set(actualRows.map((a) => a.Week)).size;

  const out = [];
  const td = [];
  let matched = 0;

  for (const [pid, ag] of actByPid) {
    const p = projByPid.get(pid);
    if (!p || !p.C.length || !p.F.length || !p.M.length) continue;
    matched++;
    const pos = ag.pos;
    const team = p.team || ag.team;

    // Season-to-date totals, per split for projections and once for actuals.
    const projS = {
      C: aggregateSum(p.C, PROJ_NUM_COLS),
      F: aggregateSum(p.F, PROJ_NUM_COLS),
      M: aggregateSum(p.M, PROJ_NUM_COLS),
    };
    const actS = aggregateSum(ag.rows, ACTUAL_NUM_COLS);

    const metricsOut = {};
    for (const m of METRICS) {
      if (!m.positions.includes(pos)) continue;
      const actualVol = num(actS[m.actualVol]);
      const projMedVol = num(projS.M[m.projVol]);
      if (m.kind === "efficiency") {
        if (actualVol < SEASON_MIN_EFF_VOLUME || projMedVol < SEASON_MIN_EFF_VOLUME) continue;
      } else {
        if (projMedVol < SEASON_MIN_VOL_RELEVANCE) continue;
      }
      const f = readSplitValue(m.proj, projS.F);
      const med = readSplitValue(m.proj, projS.M);
      const c = readSplitValue(m.proj, projS.C);
      const actual = readSplitValue(m.actual, actS);
      if (f === null || med === null || c === null || actual === null) continue;
      const lo = Math.min(f, c);
      const hi = Math.max(f, c);
      const err = actual - med;
      metricsOut[m.key] = {
        f: round(f), m: round(med), c: round(c), a: round(actual),
        in: actual >= lo && actual <= hi,
        err: round(err),
        pe: med !== 0 ? round(err / Math.abs(med), 4) : null,
        av: round(actualVol, 1),
        pv: round(projMedVol, 1),
      };
    }

    for (const t of TD_TYPES) {
      if (!t.positions.includes(pos)) continue;
      const actualVol = num(actS[t.actualVol]);
      const actualTD = num(actS[t.actual]);
      if (actualVol < SEASON_TD_MIN_OPP[t.key] && actualTD === 0) continue;
      td.push({
        type: t.key, pid, team, pos, wk: 0, inj: false,
        lf: round(num(projS.F[t.proj]), 4),
        lm: round(num(projS.M[t.proj]), 4),
        lc: round(num(projS.C[t.proj]), 4),
        a: actualTD,
        av: round(actualVol, 1),
        pv: round(num(projS.M[t.projVol]), 1),
      });
    }

    if (Object.keys(metricsOut).length === 0) continue;
    out.push({ pid, team, pos, wk: 0, inj: false, m: metricsOut });
  }

  const available =
    process.env.SEASON_LONG === "on"
      ? true
      : process.env.SEASON_LONG === "off"
      ? false
      : weeksWithActuals >= SEASON_COMPLETE_WEEKS && out.length > 0;

  return {
    rows: out,
    td,
    available,
    weeksWithActuals,
    counts: {
      actualPlayers: actByPid.size,
      matchedPlayers: matched,
      emittedRows: out.length,
      tdRows: td.length,
    },
  };
}

// Collect per-week snapshot CSVs written by scripts/ingest.mjs.
// Layout: data/<kind>/<season>/week-NN.csv   (kind = projections | actuals)
function listSnapshotSeasons(dataDir, kind) {
  const base = join(ROOT, dataDir, kind);
  if (!existsSync(base)) return new Map(); // season -> [paths]
  const bySeason = new Map();
  for (const season of readdirSync(base)) {
    const seasonDir = join(base, season);
    if (!statSync(seasonDir).isDirectory()) continue;
    const files = readdirSync(seasonDir)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => join(seasonDir, f));
    if (files.length) bySeason.set(season, files);
  }
  return bySeason;
}

// Prefer live-ingested snapshots when present; otherwise fall back to the
// legacy hand-uploaded CSVs so the dashboard keeps building with no ingest run.
// When snapshots span multiple seasons the weekly view targets one season
// (env SEASON, else the latest present) to avoid cross-season week collisions.
function loadWeeklySources(dataDir = "data") {
  const projSeasons = listSnapshotSeasons(dataDir, "projections");
  const actualSeasons = listSnapshotSeasons(dataDir, "actuals");

  if (projSeasons.size > 0) {
    const available = [...projSeasons.keys()].sort();
    const target =
      (process.env.SEASON && projSeasons.has(process.env.SEASON) && process.env.SEASON) ||
      available[available.length - 1];
    const projRows = projSeasons.get(target).flatMap((p) => parseCsv(p));
    const actualRows = (actualSeasons.get(target) || []).flatMap((p) => parseCsv(p));
    if (actualRows.length === 0) {
      console.warn(
        `build-data: ${target} has projection snapshots but NO actuals yet — the ` +
          `weekly view will be empty until actuals are ingested (they appear as ` +
          `games complete). Season-long scope is unaffected.`
      );
    }
    return {
      projRows,
      actualRows,
      source: `snapshots(${target})`,
      season: Number(target),
    };
  }

  return {
    projRows: parseCsv(join(ROOT, "weekly_projections.csv")),
    actualRows: parseCsv(join(ROOT, "actual_games.csv")),
    source: "legacy-csv",
    season: 2025,
  };
}

function main() {
  const weekly = loadWeeklySources();
  const { projRows, actualRows } = weekly;

  // Pivot projections: key = `${PlayerID}|${GameWeek}` -> { C, F, M, team }
  const proj = new Map();
  const teamByPid = new Map(); // pid -> team (for the season dataset, which lacks teams)
  for (const r of projRows) {
    const key = `${r.PlayerID}|${r.GameWeek}`;
    const upperTeam = (r.Team || "").toUpperCase();
    let e = proj.get(key);
    if (!e) {
      e = { team: upperTeam, C: null, F: null, M: null };
      proj.set(key, e);
    }
    e[r.Split] = r;
    if (upperTeam && !teamByPid.has(r.PlayerID)) teamByPid.set(r.PlayerID, upperTeam);
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
        // Count: gradeable only when a real forecast was made. See
        // MIN_VOL_RELEVANCE — never gate on the actual, that biases coverage.
        if (projMedVol < MIN_VOL_RELEVANCE) continue;
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
        pv: round(projMedVol, 1), // projected median volume (for min-projected filtering)
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
        av: round(actualVol, 1), // actual opportunity volume
        pv: round(num(p.M[t.projVol]), 1), // projected median opportunity volume
      });
    }

    if (Object.keys(metricsOut).length === 0) continue;

    out.push({ pid, team, pos, wk: Number(week), inj, m: metricsOut });
  }

  const weeks = [...new Set(out.map((r) => r.wk))].sort((x, y) => x - y);
  const teams = [...new Set(out.map((r) => r.team))].filter(Boolean).sort();

  // Season-long source follows the weekly source: the legacy fallback uses the
  // complete 2025 season CSVs; the live path aggregates the weekly snapshots and
  // stays hidden until the season is complete.
  let season;
  let seasonAvailable;
  if (weekly.source === "legacy-csv") {
    season = buildSeasonFromLegacyCsv(teamByPid);
    seasonAvailable = process.env.SEASON_LONG === "off" ? false : season.rows.length > 0;
  } else {
    season = buildSeasonFromWeekly(projRows, actualRows);
    seasonAvailable = season.available;
  }
  // Don't ship a half-graded running total; keep the payload lean when hidden.
  if (!seasonAvailable) {
    season = { ...season, rows: [], td: [] };
  }

  const metricMeta = METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    group: m.group,
    kind: m.kind,
    unit: m.unit || (m.kind === "volume" ? "count" : "rate"),
    positions: m.positions,
  }));
  const tdTypeMeta = TD_TYPES.map((t) => ({
    key: t.key,
    label: t.label,
    positions: t.positions,
    volLabel: t.volLabel,
    minOpp: t.minOpp,
  }));

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      season: weekly.season,
      dataSource: weekly.source,
      weeks,
      teams,
      positions: ["QB", "RB", "WR", "TE"],
      minEffVolume: MIN_EFF_VOLUME,
      minVolRelevance: MIN_VOL_RELEVANCE,
      metrics: metricMeta,
      tdTypes: tdTypeMeta,
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
    season: {
      // Season metrics/TD types share keys+labels with the weekly set.
      available: seasonAvailable,
      metrics: metricMeta,
      tdTypes: tdTypeMeta.map((t) => ({
        ...t,
        minOpp: SEASON_TD_MIN_OPP[t.key],
      })),
      minEffVolume: SEASON_MIN_EFF_VOLUME,
      minVolRelevance: SEASON_MIN_VOL_RELEVANCE,
      teams: [...new Set(season.rows.map((r) => r.team))].filter(Boolean).sort(),
      counts: season.counts,
      rows: season.rows,
      td: season.td,
    },
  };

  const outDir = join(ROOT, "public", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "dashboard.json");
  writeFileSync(outPath, JSON.stringify(payload));
  const kb = (readFileSync(outPath).length / 1024).toFixed(0);
  console.log(
    `build-data: source=${weekly.source}; weekly ${out.length} rows / ${td.length} TD (${matched} matched); ` +
      `season ${seasonAvailable ? `${season.rows.length} rows / ${season.td.length} TD` : "hidden (season not complete)"} -> ${outPath} (${kb} KB)`
  );
}

main();
