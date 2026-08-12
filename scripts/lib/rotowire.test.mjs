// Verifies the RotoWire feed -> CSV normalizers against real sample records
// captured from the live endpoints. Runs with `node --test` — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECTION_COLUMNS,
  ACTUAL_COLUMNS,
  normalizeProjectionRecord,
  normalizeProjections,
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
  offrecyard: "0.00",
  offrectd: "0.00",
  fantasy: "22.17",
};
const CEIL_QB = { ...MEDIAN_QB, playerid: "14416", team: "PHI", offpassatt: "33.07" };
const FLOOR_QB = { ...MEDIAN_QB, offpassatt: "23.60", offpassyard: "173.01" };

// A WR-style projection to exercise the receiving mapping (offrecatt -> Targets).
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
  offrecyard: "78.5",
  offrectd: "0.45",
};

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
  // offrecatt -> RecCompletions (receptions); targets aren't in these feeds.
  assert.equal(row.RecCompletions, "0.00");
  assert.equal(row.RecYards, "0.00");
  assert.equal(row.RecTDs, "0.00");
  assert.equal(row.Targets, "");
});

test("offrecatt maps to RecCompletions (receptions) for a receiver", () => {
  const row = normalizeProjectionRecord(MEDIAN_WR, { season: 2025, week: 1, split: "M" });
  assert.equal(row.RecCompletions, "7.4");
  assert.equal(row.RecYards, "78.5");
  assert.equal(row.RecTDs, "0.45");
  assert.equal(row.Targets, ""); // pending a separate targets source
  assert.equal(row.Team, "BAL"); // lowercased source is upcased
});

test("targetsByPlayer fills Targets (number = all splits, object = per-split)", () => {
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
  // Player absent from the lookup stays blank.
  assert.equal(
    normalizeProjectionRecord(MEDIAN_QB, { season: 2025, week: 1, split: "M", targetsByPlayer: flat }).Targets,
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
test("toCsv emits the exact legacy header order with a blank Targets column", () => {
  const rows = normalizeProjections({ M: [MEDIAN_QB], C: [CEIL_QB], F: [FLOOR_QB] }, {
    season: 2025,
    week: 1,
  });
  const csv = toCsv(PROJECTION_COLUMNS, rows);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], PROJECTION_COLUMNS.join(","));
  // Full 17-column width preserved even though Targets is blank.
  assert.equal(lines[1].split(",").length, PROJECTION_COLUMNS.length);
  // Targets is column 8 (index 7) and is blank.
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

test("asRecords unwraps arrays and { data: [...] } envelopes", () => {
  assert.equal(asRecords([1, 2]).length, 2);
  assert.equal(asRecords({ data: [1] }).length, 1);
  assert.throws(() => asRecords({ nope: true }));
});
