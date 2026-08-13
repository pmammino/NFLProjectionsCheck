// Pure normalizers that map RotoWire's live JSON feeds into the two CSV schemas
// the dashboard pipeline already understands (weekly_projections.csv +
// actual_games.csv). Keeping the output identical to the legacy hand-uploaded
// CSVs means build-data.mjs and every dashboard view keep working unchanged —
// only the *source* of the data changes.
//
// No I/O here on purpose: everything is a pure transform so it can be unit
// tested against captured sample records with no network (see rotowire.test.mjs).
//
// ---------------------------------------------------------------------------
// Feed field reference (captured from the live endpoints)
// ---------------------------------------------------------------------------
// Projections — weekly-projections.php (Median) and
//   projections-ceil-floor-weekly.php?ceilFloor=C|F (Ceiling/Floor).
//   All three share one schema, keyed by `playerid` (the RotoWire player id,
//   i.e. the trailing number in the player URL):
//     playerid, player, team, position, opponent,
//     offpassyard, offpasscomp, offpassatt, offpasstd, offpassint, passpct,
//     offrushatt, offrushyard, offrushtd,
//     offrecatt, offrecyard, offrectd,      <- offrecatt == receptions
//     fantasy, ppr, custpts
//   Note: the projection feed's receiving volume is RECEPTIONS (offrecatt) plus
//   yards and TDs. It does NOT project a target count, so the target-denominated
//   metrics (Targets volume, Rec Yds/Target, Catch Rate, Rec TD/Target) can't be
//   derived from these endpoints alone. The Targets column is emitted blank and
//   the dashboard skips those metrics until a separate targets source is merged
//   into it (see TARGETS_SOURCE below). Projected receptions/yards/TDs ARE here.
//
// Player stats — player-stats.php?view=passing|rushing|receiving, keyed by
//   `pid` (same RotoWire id space as `playerid`, so projections and actuals
//   join directly with no crosswalk):
//     passing:   pid, team, pos, passcomp, passatt, passyards, passtd, int,
//                rushatt, rushyards, rushtd, ...  (QB rush stats live here too)
//     rushing:   pid, team, pos, rushatt, rushyards, rushtd, ...
//     receiving: pid, team, pos, receptions, recyards, rectd, targets, ...

// ---- weekly_projections.csv --------------------------------------------------
export const PROJECTION_COLUMNS = [
  "Season",
  "GameWeek",
  "Split",
  "Team",
  "PlayerID",
  "PassAttempts",
  "RushAttempts",
  "Targets",
  "PassCompletions",
  "PassYards",
  "PassTDs",
  "PassInts",
  "RushYards",
  "RushTDs",
  "RecCompletions",
  "RecYards",
  "RecTDs",
];

// ---- actual_games.csv --------------------------------------------------------
export const ACTUAL_COLUMNS = [
  "PlayerID",
  "ID",
  "position",
  "Season",
  "Week",
  "NFLTeamID",
  "Rushes",
  "RushYards",
  "PassComp",
  "PassAtt",
  "PassYards",
  "Receptions",
  "ReceptYds",
  "PassTD",
  "RecptTD",
  "RushTD",
  "Targets",
];

// Valid projection split codes -> normalized Split column value.
export const SPLIT_CODES = { M: "M", C: "C", F: "F" };

// Unwrap a parsed feed payload into an array of records. RotoWire's table
// endpoints return a bare array, but tolerate a { data: [...] } wrapper too.
export function asRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  throw new Error(
    "Unexpected feed shape: expected an array (or { data: [...] }), got " +
      (payload === null ? "null" : typeof payload)
  );
}

const pick = (row, key) => {
  const v = row?.[key];
  return v === undefined || v === null ? "" : String(v).trim();
};
// Numeric field, defaulting to "0" when the source is missing/blank (matches
// how the legacy actuals encode "did not record this stat").
const numOr0 = (row, key) => {
  const v = pick(row, key);
  return v === "" ? "0" : v;
};

// TARGETS_SOURCE: the projection endpoints don't project targets, so Targets is
// blank by default. When a separate targets source is located, pass a lookup to
// normalizeProjections via `targetsByPlayer` to fill the column and re-enable
// the target-denominated metrics. The lookup is a Map keyed by playerid whose
// value is either a single number (used for every split) or a per-split object
// like { M, C, F }. Anything missing stays blank.
function resolveTargets(lookup, playerId, code) {
  if (!lookup) return "";
  const v = lookup.get(playerId);
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    const s = v[code];
    return s === undefined || s === null ? "" : String(s);
  }
  return String(v);
}

// ---- Projections -------------------------------------------------------------
// One projection record (from any of the three split feeds) -> one CSV row.
export function normalizeProjectionRecord(rec, { season, week, split, targetsByPlayer }) {
  const code = SPLIT_CODES[split];
  if (!code) throw new Error(`Unknown projection split: ${split}`);
  const playerId = pick(rec, "playerid");
  if (!playerId) return null; // skip malformed rows with no id to join on
  return {
    Season: String(season),
    GameWeek: String(week),
    Split: code,
    Team: pick(rec, "team").toUpperCase(),
    PlayerID: playerId,
    PassAttempts: numOr0(rec, "offpassatt"),
    RushAttempts: numOr0(rec, "offrushatt"),
    // Targets aren't in these feeds; filled only from an external source.
    Targets: resolveTargets(targetsByPlayer, playerId, code),
    PassCompletions: numOr0(rec, "offpasscomp"),
    PassYards: numOr0(rec, "offpassyard"),
    PassTDs: numOr0(rec, "offpasstd"),
    PassInts: numOr0(rec, "offpassint"),
    RushYards: numOr0(rec, "offrushyard"),
    RushTDs: numOr0(rec, "offrushtd"),
    RecCompletions: numOr0(rec, "offrecatt"), // offrecatt == projected receptions
    RecYards: numOr0(rec, "offrecyard"),
    RecTDs: numOr0(rec, "offrectd"),
  };
}

// Combine the three split feeds for a single week into weekly_projections rows.
// `feeds` = { M: [...], C: [...], F: [...] } (each an array of raw records).
// `targetsByPlayer` (optional) fills the Targets column — see TARGETS_SOURCE.
export function normalizeProjections(feeds, { season, week, targetsByPlayer }) {
  const rows = [];
  for (const split of ["M", "C", "F"]) {
    const list = feeds[split];
    if (!list) throw new Error(`Missing "${split}" projection feed`);
    for (const rec of asRecords(list)) {
      const row = normalizeProjectionRecord(rec, { season, week, split, targetsByPlayer });
      if (row) rows.push(row);
    }
  }
  return rows;
}

// ---- Actuals -----------------------------------------------------------------
// Merge the passing / rushing / receiving stat feeds into one actual_games row
// per player. A player can appear in several feeds (a QB in passing + rushing,
// a RB in rushing + receiving), so we merge by `pid` rather than concatenating.
//
// Field authority:
//   passing  -> passcomp/passatt/passyards/passtd/int (and QB rush as fallback)
//   rushing  -> rushatt/rushyards/rushtd (authoritative; overrides passing)
//   receiving-> receptions/recyards/rectd/targets
export function mergeActuals(feeds, { season, week }) {
  const byPid = new Map();
  const slot = (pid) => {
    if (!byPid.has(pid)) byPid.set(pid, {});
    return byPid.get(pid);
  };
  const ingest = (list, kind) => {
    for (const rec of asRecords(list || [])) {
      const pid = pick(rec, "pid");
      if (!pid) continue;
      slot(pid)[kind] = rec;
    }
  };
  ingest(feeds.passing, "passing");
  ingest(feeds.rushing, "rushing");
  ingest(feeds.receiving, "receiving");

  const rows = [];
  for (const [pid, f] of byPid) {
    const passing = f.passing;
    const rushing = f.rushing;
    const receiving = f.receiving;

    // Each feed reports the player's true position, so any source works.
    const pos = pick(passing, "pos") || pick(rushing, "pos") || pick(receiving, "pos");
    const team =
      pick(passing, "team") || pick(rushing, "team") || pick(receiving, "team");

    // Prefer the dedicated rushing feed; fall back to the rush columns the
    // passing feed carries for QBs (so a scrambling QB absent from the rushing
    // table still gets his carries).
    const rushSource = rushing || passing;

    rows.push({
      PlayerID: pid,
      ID: pid,
      position: pos,
      Season: String(season),
      Week: String(week),
      NFLTeamID: team,
      Rushes: numOr0(rushSource, "rushatt"),
      RushYards: numOr0(rushSource, "rushyards"),
      PassComp: numOr0(passing, "passcomp"),
      PassAtt: numOr0(passing, "passatt"),
      PassYards: numOr0(passing, "passyards"),
      Receptions: numOr0(receiving, "receptions"),
      ReceptYds: numOr0(receiving, "recyards"),
      PassTD: numOr0(passing, "passtd"),
      RecptTD: numOr0(receiving, "rectd"),
      RushTD: numOr0(rushSource, "rushtd"),
      Targets: numOr0(receiving, "targets"),
    });
  }
  return rows;
}

// ---- CSV ---------------------------------------------------------------------
// Values are plain numbers / short codes with no commas or quotes, so a naive
// join is safe and keeps the output byte-compatible with parseCsv in build-data.
export function toCsv(columns, rows) {
  const out = [columns.join(",")];
  for (const row of rows) {
    out.push(columns.map((c) => (row[c] === undefined ? "" : row[c])).join(","));
  }
  return out.join("\n") + "\n";
}
