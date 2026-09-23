// Verifies the RotoWire feed -> CSV normalizers against real sample records
// captured from the live endpoints. Runs with `node --test` — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECTION_COLUMNS,
  ACTUAL_COLUMNS,
  normalizeProjectionRecord,
  normalizeProjections,
  buildRoster,
  backfillTargets,
  ROSTER_COLUMNS,
  mergeActuals,
  asRecords,
  toCsv,
} from "./rotowire.mjs";

// ---- Captured samples --------------------------------------------------------
const MEDIAN_QB = {
  playerid: "12561",
  player: "Lamar Jackson",
  team: "BAL",
  position: "QB",
  opponent: "BUF",
  offpassyard: "228.30",
  offpasscomp: "18.97",
  offpassatt: "28.32",
  offpasstd: "1.82",
  offpassint: "0.73",
  passpct: "67.0",
  offrushatt: "9.38",
  offrushyard: "59.63",
  offrushtd: "0.27",
  offrecatt: "0.00",
  offtargets: "0.00",
  offrecyard: "0.00",
  offrectd: "0.00",
  fantasy: "22.17",
};
const CEIL_QB = { ...MEDIAN_QB, playerid: "14416", team: "PHI", offpassatt: "33.07" };
const FLOOR_QB = { ...MEDIAN_QB, offpassatt: "23.60", offpassyard: "173.01" };

// A WR-style projection to exercise the receiving mapping: offrecatt ->
// RecCompletions (receptions) and offtargets -> Targets. These are different
// numbers on the same record and must not be conflated.
const MEDIAN_WR = {
  playerid: "16919",
  player: "Zay Flowers",
  team: "bal",
  position: "WR",
  offpassatt: "0.00",
  offrushatt: "0.30",
  offrushyard: "2.1",
  offrushtd: "0.00",
  offrecatt: "7.4",
  offtargets: "10.9",
  offrecyard: "78.5",
  offrectd: "0.45",
};
// The same receiver from a feed carrying no target projection, and one whose
// only target-ish field is a DIFFERENT name we must not guess at.
const MEDIAN_WR_NO_TARGETS = (() => {
  const { offtargets, ...rest } = MEDIAN_WR;
  return rest;
})();
const MEDIAN_WR_WRONG_FIELD = { ...MEDIAN_WR_NO_TARGETS, offrectarget: "99.9", targets: "88.8" };

const PASS_QB = {
  pid: "12483",
  player: "Josh Allen",
  team: "BUF",
  pos: "QB",
  passcomp: "33",
  passatt: "46",
  passtd: "2",
  passyards: "394",
  int: "0",
  rushatt: "14",
  rushyards: "30",
  rushtd: "2",
};
const RUSH_RB = {
  pid: "10819",
  player: "Derrick Henry",
  team: "BAL",
  pos: "RB",
  rushatt: "18",
  rushyards: "169",
  rushtd: "2",
};
// Same QB present in the rushing feed too — must not double-count.
const RUSH_QB = { pid: "12483", team: "BUF", pos: "QB", rushatt: "14", rushyards: "30", rushtd: "2" };
const REC_WR = {
  pid: "16919",
  player: "Zay Flowers",
  team: "BAL",
  pos: "WR",
  receptions: "7",
  recyards: "143",
  rectd: "1",
  targets: "9",
};
// A pass-catching RB, present in both rushing and receiving feeds.
const RUSH_RB2 = { pid: "555", team: "SF", pos: "RB", rushatt: "12", rushyards: "60", rushtd: "1" };
const REC_RB2 = { pid: "555", team: "SF", pos: "RB", receptions: "5", recyards: "40", rectd: "0", targets: "6" };

// ---- Projections -------------------------------------------------------------
test("projection record maps every column with the right split", () => {
  const row = normalizeProjectionRecord(MEDIAN_QB, { season: 2025, week: 1, split: "M" });
  assert.equal(row.Season, "2025");
  assert.equal(row.GameWeek, "1");
  assert.equal(row.Split, "M");
  assert.equal(row.Team, "BAL");
  assert.equal(row.PlayerID, "12561");
  assert.equal(row.PassAttempts, "28.32");
  assert.equal(row.PassCompletions, "18.97");
  assert.equal(row.PassYards, "228.30");
  assert.equal(row.PassTDs, "1.82");
  assert.equal(row.PassInts, "0.73");
  assert.equal(row.RushAttempts, "9.38");
  assert.equal(row.RushYards, "59.63");
  assert.equal(row.RushTDs, "0.27");
  // offrecatt -> RecCompletions (receptions), offtargets -> Targets.
  assert.equal(row.RecCompletions, "0.00");
  assert.equal(row.RecYards, "0.00");
  assert.equal(row.RecTDs, "0.00");
  assert.equal(row.Targets, "0.00");
});

test("receiving volume splits into receptions and targets for a receiver", () => {
  const row = normalizeProjectionRecord(MEDIAN_WR, { season: 2025, week: 1, split: "M" });
  assert.equal(row.RecCompletions, "7.4"); // offrecatt == receptions
  assert.equal(row.Targets, "10.9"); // offtargets == targets
  assert.equal(row.RecYards, "78.5");
  assert.equal(row.RecTDs, "0.45");
  assert.equal(row.Team, "BAL"); // lowercased source is upcased
});

test("Targets comes from offtargets only — no guessing at other field names", () => {
  // Resolving a list of candidate spellings by order would happily read a
  // similarly-named field that means something else. Only the confirmed one.
  const row = normalizeProjectionRecord(MEDIAN_WR_WRONG_FIELD, {
    season: 2025,
    week: 1,
    split: "M",
  });
  assert.equal(row.Targets, "");
});

test("offtargets (targets) is not confused with offrecatt (receptions)", () => {
  const row = normalizeProjectionRecord(MEDIAN_WR, { season: 2025, week: 1, split: "M" });
  assert.equal(row.Targets, "10.9"); // offtargets
  assert.equal(row.RecCompletions, "7.4"); // offrecatt
  assert.notEqual(row.Targets, row.RecCompletions);
});

test("Targets stays blank when the feed carries no target field", () => {
  const row = normalizeProjectionRecord(MEDIAN_WR_NO_TARGETS, {
    season: 2025,
    week: 1,
    split: "M",
  });
  assert.equal(row.Targets, "");
});

test("targetsByPlayer overrides Targets (number = all splits, object = per-split)", () => {
  const flat = new Map([["16919", 8.2]]);
  assert.equal(
    normalizeProjectionRecord(MEDIAN_WR, { season: 2025, week: 1, split: "M", targetsByPlayer: flat }).Targets,
    "8.2"
  );
  const perSplit = new Map([["16919", { M: 8, C: 11, F: 5 }]]);
  assert.equal(
    normalizeProjectionRecord(MEDIAN_WR, { season: 2025, week: 1, split: "C", targetsByPlayer: perSplit }).Targets,
    "11"
  );
  // Player absent from the lookup falls back to the feed's own projection.
  assert.equal(
    normalizeProjectionRecord(MEDIAN_QB, { season: 2025, week: 1, split: "M", targetsByPlayer: flat }).Targets,
    "0.00"
  );
  // …and to blank when the feed has none either.
  assert.equal(
    normalizeProjectionRecord(MEDIAN_WR_NO_TARGETS, {
      season: 2025,
      week: 1,
      split: "M",
      targetsByPlayer: new Map(),
    }).Targets,
    ""
  );
});

test("normalizeProjections combines M/C/F feeds into split-tagged rows", () => {
  const rows = normalizeProjections(
    { M: [MEDIAN_QB], C: [CEIL_QB], F: [FLOOR_QB] },
    { season: 2025, week: 1 }
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.Split),
    ["M", "C", "F"]
  );
  assert.equal(rows.find((r) => r.Split === "C").PassAttempts, "33.07");
  assert.equal(rows.find((r) => r.Split === "F").PassYards, "173.01");
});

test("projection rows with no playerid are dropped", () => {
  const rows = normalizeProjections(
    { M: [MEDIAN_QB, { player: "ghost" }], C: [CEIL_QB], F: [FLOOR_QB] },
    { season: 2025, week: 1 }
  );
  assert.equal(rows.filter((r) => r.Split === "M").length, 1);
});

// ---- Actuals -----------------------------------------------------------------
test("mergeActuals joins passing+rushing+receiving by pid without double-counting", () => {
  const rows = mergeActuals(
    { passing: [PASS_QB], rushing: [RUSH_QB, RUSH_RB], receiving: [REC_WR] },
    { season: 2025, week: 1 }
  );
  const byId = Object.fromEntries(rows.map((r) => [r.ID, r]));

  // QB: passing stats from passing feed; rush stats resolved once (18 vs... not doubled).
  const qb = byId["12483"];
  assert.equal(qb.position, "QB");
  assert.equal(qb.PassAtt, "46");
  assert.equal(qb.PassComp, "33");
  assert.equal(qb.PassYards, "394");
  assert.equal(qb.PassTD, "2");
  assert.equal(qb.Rushes, "14"); // single count, not 28
  assert.equal(qb.RushYards, "30");
  assert.equal(qb.RushTD, "2");
  assert.equal(qb.Receptions, "0");
  assert.equal(qb.Targets, "0");

  // RB: rushing only.
  const rb = byId["10819"];
  assert.equal(rb.position, "RB");
  assert.equal(rb.Rushes, "18");
  assert.equal(rb.RushYards, "169");
  assert.equal(rb.PassAtt, "0");

  // WR: receiving only; targets + receptions distinct.
  const wr = byId["16919"];
  assert.equal(wr.position, "WR");
  assert.equal(wr.Receptions, "7");
  assert.equal(wr.ReceptYds, "143");
  assert.equal(wr.RecptTD, "1");
  assert.equal(wr.Targets, "9");
  assert.equal(wr.Rushes, "0");
});

test("mergeActuals falls back to passing-feed rush columns when QB absent from rushing feed", () => {
  const rows = mergeActuals({ passing: [PASS_QB], rushing: [], receiving: [] }, {
    season: 2025,
    week: 1,
  });
  assert.equal(rows[0].Rushes, "14");
  assert.equal(rows[0].RushTD, "2");
});

test("mergeActuals merges a pass-catching RB across rushing+receiving", () => {
  const rows = mergeActuals(
    { passing: [], rushing: [RUSH_RB2], receiving: [REC_RB2] },
    { season: 2025, week: 3 }
  );
  assert.equal(rows.length, 1);
  const rb = rows[0];
  assert.equal(rb.Rushes, "12");
  assert.equal(rb.Receptions, "5");
  assert.equal(rb.Targets, "6");
  assert.equal(rb.Week, "3");
});

// ---- CSV ---------------------------------------------------------------------
test("toCsv emits the exact legacy header order, Targets included", () => {
  const rows = normalizeProjections({ M: [MEDIAN_WR], C: [MEDIAN_WR], F: [MEDIAN_WR] }, {
    season: 2025,
    week: 1,
  });
  const csv = toCsv(PROJECTION_COLUMNS, rows);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], PROJECTION_COLUMNS.join(","));
  assert.equal(lines[1].split(",").length, PROJECTION_COLUMNS.length);
  // Targets is column 8 (index 7) and carries the feed's projection.
  assert.equal(lines[1].split(",")[7], "10.9");
});

test("toCsv keeps the full column width when a feed omits targets", () => {
  const rows = normalizeProjections(
    { M: [MEDIAN_WR_NO_TARGETS], C: [MEDIAN_WR_NO_TARGETS], F: [MEDIAN_WR_NO_TARGETS] },
    { season: 2025, week: 1 }
  );
  const lines = toCsv(PROJECTION_COLUMNS, rows).trim().split("\n");
  assert.equal(lines[1].split(",").length, PROJECTION_COLUMNS.length);
  assert.equal(lines[1].split(",")[7], "");
});

test("toCsv actuals header matches actual_games schema", () => {
  const rows = mergeActuals({ passing: [PASS_QB], rushing: [], receiving: [] }, {
    season: 2025,
    week: 1,
  });
  const csv = toCsv(ACTUAL_COLUMNS, rows);
  assert.equal(csv.split("\n")[0], ACTUAL_COLUMNS.join(","));
});

test("asRecords unwraps arrays and object envelopes", () => {
  // Bare array (projection feeds).
  assert.equal(asRecords([1, 2]).length, 2);
  // Known wrapper keys.
  assert.equal(asRecords({ data: [1] }).length, 1);
  assert.equal(asRecords({ players: [1, 2, 3] }).length, 3);
  // Unknown key but an array value present -> take the longest array.
  assert.deepEqual(asRecords({ meta: [1], list: [1, 2, 3] }), [1, 2, 3]);
  // A map of record objects keyed by id -> its values.
  const map = { "12483": { pid: "12483" }, "10819": { pid: "10819" } };
  assert.deepEqual(
    asRecords(map)
      .map((r) => r.pid)
      .sort(),
    ["10819", "12483"]
  );
  // Datatables-style envelope with header + rows.
  assert.equal(asRecords({ recordsTotal: 2, data: [{ pid: "1" }, { pid: "2" }] }).length, 2);
});

test("asRecords throws with the object's keys when no records are found", () => {
  assert.throws(() => asRecords({ error: "login required" }), /error/);
  assert.throws(() => asRecords(null), /got null/);
});

test("mergeActuals works when a feed is wrapped in a { data: [...] } object", () => {
  const rows = mergeActuals(
    {
      passing: { data: [PASS_QB] },
      rushing: { data: [RUSH_RB] },
      receiving: { data: [REC_WR] },
    },
    { season: 2026, week: 1 }
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.ID === "12483").PassAtt, "46");
});

// ---- buildRoster -------------------------------------------------------------
// The name -> id crosswalk that the OpticOdds join depends on. The projection
// SNAPSHOT drops the player name, so this captures it from the feed first.

const ROSTER_FEED = [
  { playerid: "14442", player: "Joe Burrow", team: "cin", position: "qb" },
  { playerid: "16965", player: "Andrei Iosivas", team: "CIN", position: "WR" },
  { playerid: "", player: "No Id", team: "CIN", position: "WR" },
  { playerid: "99999", player: "", team: "CIN", position: "WR" },
];

test("buildRoster extracts id, name, team and position from a projection feed", () => {
  const roster = buildRoster({ M: ROSTER_FEED });
  assert.equal(roster.length, 2);
  assert.deepEqual(roster[0], { PlayerID: "14442", Name: "Joe Burrow", Team: "CIN", Pos: "QB" });
  assert.deepEqual(Object.keys(roster[0]), ROSTER_COLUMNS);
});

test("buildRoster skips rows with no id or no name", () => {
  const roster = buildRoster({ M: ROSTER_FEED });
  assert.ok(!roster.some((r) => r.PlayerID === "" || r.PlayerID === "99999"));
});

test("buildRoster deduplicates a player across the three splits", () => {
  // M/C/F all carry the same roster; the result must not triple.
  const roster = buildRoster({ M: ROSTER_FEED, C: ROSTER_FEED, F: ROSTER_FEED });
  assert.equal(roster.length, 2);
});

test("buildRoster sorts by id so the committed file has a stable diff", () => {
  const roster = buildRoster({ M: ROSTER_FEED });
  const ids = roster.map((r) => Number(r.PlayerID));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test("buildRoster strips commas, which the unquoted CSV writer cannot carry", () => {
  // A comma in a name would shift every later column on that row.
  const roster = buildRoster({ M: [{ playerid: "1", player: "Smith, Jr.", team: "CIN", position: "RB" }] });
  assert.equal(roster[0].Name, "Smith Jr.");
  assert.ok(!toCsv(ROSTER_COLUMNS, roster).split("\n")[1].startsWith("1,Smith,"));
});

test("buildRoster accepts an array of feeds as well as a split map", () => {
  assert.equal(buildRoster([ROSTER_FEED]).length, 2);
  assert.equal(buildRoster([]).length, 0);
  assert.equal(buildRoster({}).length, 0);
});

// ---- Targets back-fill -------------------------------------------------------
// A frozen snapshot row (blank Targets) and the same row as the feed now
// serves it, with a target count added.
const frozen = (over = {}) => ({
  Season: "2026", GameWeek: "1", Split: "M", Team: "BAL", PlayerID: "16919",
  PassAttempts: "0.00", RushAttempts: "0.30", Targets: "",
  PassCompletions: "0.00", PassYards: "0.00", PassTDs: "0.00", PassInts: "0.00",
  RushYards: "2.10", RushTDs: "0.00", RecCompletions: "7.40", RecYards: "78.50",
  RecTDs: "0.45", ...over,
});
const refetched = (over = {}) => ({ ...frozen(), Targets: "10.9", ...over });

test("backfillTargets fills Targets when every other column still matches", () => {
  const r = backfillTargets([frozen()], [refetched()]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.matched, 1);
  assert.equal(r.filled, 1);
  assert.equal(r.rows[0].Targets, "10.9");
  // Nothing else moved.
  assert.equal(r.rows[0].RecYards, "78.50");
  assert.equal(r.rows[0].RushAttempts, "0.30");
});

test("backfillTargets refuses when the feed has revised another column", () => {
  // RotoWire re-projected the week after the games — exactly what must not be
  // written over a frozen pre-game forecast.
  const r = backfillTargets([frozen()], [refetched({ RecYards: "91.20" })]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].column, "RecYards");
  assert.equal(r.conflicts[0].frozen, "78.50");
  assert.equal(r.conflicts[0].fetched, "91.20");
});

test("backfillTargets treats pure reformatting as unchanged", () => {
  const r = backfillTargets([frozen()], [refetched({ RecYards: "78.5", RushAttempts: "0.3" })]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.filled, 1);
});

test("backfillTargets never confuses a blank with a zero", () => {
  const r = backfillTargets([frozen({ RecCompletions: "" })], [refetched()]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].column, "RecCompletions");
});

test("backfillTargets keeps rows the feed no longer carries, and adds none", () => {
  const dropped = frozen({ PlayerID: "99999" });
  const added = refetched({ PlayerID: "55555" });
  const r = backfillTargets([frozen(), dropped], [refetched(), added]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.rows.length, 2); // never grows
  assert.equal(r.missingFromFeed, 1);
  assert.equal(r.newInFeed, 1);
  assert.equal(r.rows.find((x) => x.PlayerID === "99999").Targets, ""); // still blank
});

test("backfillTargets matches on split, not player alone", () => {
  const m = frozen({ Split: "M" });
  const c = frozen({ Split: "C" });
  const r = backfillTargets([m, c], [refetched({ Split: "M", Targets: "10.9" })]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.filled, 1);
  assert.equal(r.rows.find((x) => x.Split === "M").Targets, "10.9");
  assert.equal(r.rows.find((x) => x.Split === "C").Targets, ""); // untouched
});

test("backfillTargets reports filled=0 when the feed carries no targets", () => {
  const r = backfillTargets([frozen()], [refetched({ Targets: "" })]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.matched, 1);
  assert.equal(r.filled, 0);
});
