import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLiveClosing, loadLiveClosing, buildSourceModel } from "./source-model.mjs";
import { buildLeadPairs } from "./source-weights.mjs";
import { isPointInTime } from "./pricing-dataset.mjs";

const BOOKS = ["DraftKings", "FanDuel", "Caesars"];
const quote = ({ book, slot, week = 5, playerId = "p1", line = 50.5, overOdds = -110, underOdds = -110, lineSource = "live" }) => ({
  book, slot, week, playerId, stat: "recYds", line, overOdds, underOdds, lineSource, probOver: 0.5,
});
const board = (slot, extra = {}) => BOOKS.map((book) => quote({ book, slot, ...extra }));

test("live closing fills a market that has no backfilled closing board", () => {
  const early = board("main");
  const live = board("closing", { overOdds: -130, underOdds: 110 });
  const merged = withLiveClosing(early, live);
  assert.equal(merged.length, 6);
  assert.equal(buildLeadPairs(merged).length, 1);
  assert.equal(buildLeadPairs(early).length, 0);
});

test("a market with a backfilled close keeps it — live closing is not stacked on top", () => {
  const quotes = [...board("main"), ...board("closing", { lineSource: "closing" })];
  const live = board("closing");
  const merged = withLiveClosing(quotes, live);
  assert.equal(merged.length, quotes.length);
  assert.equal(buildLeadPairs(merged)[0].late.length, 3); // not 6 votes
});

test("the fill is per market: a covered market is untouched, an uncovered one is filled", () => {
  const quotes = [...board("main", { playerId: "a" }), ...board("closing", { playerId: "a", lineSource: "closing" }), ...board("main", { playerId: "b" })];
  const live = [...board("closing", { playerId: "a" }), ...board("closing", { playerId: "b" })];
  const merged = withLiveClosing(quotes, live);
  assert.equal(merged.length, quotes.length + 3);
  const pairs = buildLeadPairs(merged);
  assert.deepEqual(pairs.map((p) => p.playerId).sort(), ["a", "b"]);
  assert.ok(pairs.every((p) => p.late.length === 3));
});

test("a live-closing quote can never carry a projection into a pair", () => {
  const live = board("closing");
  const pairs = buildLeadPairs(withLiveClosing(board("main"), live));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].slot, "main"); // the early board, not the closing one
  assert.ok(live.every((q) => q.slot === "closing")); // never "main": cannot be point-in-time
});

test("nothing to add returns the same quotes", () => {
  const q = board("main");
  assert.equal(withLiveClosing(q, []), q);
  assert.equal(withLiveClosing(q, undefined), q);
});

test("loadLiveClosing reads data/closing as closing quotes, and tolerates a missing dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "closing-"));
  try {
    assert.deepEqual(loadLiveClosing({ dataDir: dir, season: 2026 }), []);
    mkdirSync(join(dir, "closing", "2026"), { recursive: true });
    const header = "Season,Week,PlayerID,Name,Team,Pos,Opp,Stat,Book,Line,Side,Proj,Odds,OppositeOdds,OurProb,Slot,LineSource,FixtureID";
    writeFileSync(
      join(dir, "closing", "2026", "week-05.csv"),
      [header, "2026,5,17784,A B,TB,RB,at DAL,recYds,DraftKings,50.5,over,40,-120,100,0.5,main,live,2026100942D78F91", "2026,5,1,X,TB,RB,at DAL,notastat,DraftKings,1,over,1,-110,-110,0.5,main,live,x"].join("\n") + "\n"
    );
    const q = loadLiveClosing({ dataDir: dir, season: 2026 });
    assert.equal(q.length, 1);
    assert.equal(q[0].slot, "closing"); // whatever the file's Slot column says
    assert.equal(q[0].week, 5);
    assert.equal(isPointInTime(q[0]), false); // the file says "live"; as a late board it must not feed the share fit
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a week with only a live close now teaches the weights (it used to be invisible)", () => {
  const quotes = [...board("main", { week: 2 }), ...board("main", { week: 3 })];
  assert.deepEqual(buildSourceModel(quotes, new Map()).weeks, []);
  const withClose = withLiveClosing(quotes, [...board("closing", { week: 2 }), ...board("closing", { week: 3 })]);
  assert.deepEqual(buildSourceModel(withClose, new Map()).weeks, [2, 3]);
});
