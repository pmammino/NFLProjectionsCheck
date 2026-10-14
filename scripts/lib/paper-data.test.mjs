import test from "node:test";
import assert from "node:assert/strict";
import { candidatesForBoard, buildPaperDataset, settle, closeFairFor, indexCloseVotes, isLiveBoard, MIN_CANDIDATE_EDGE, ODDS_FLOOR, ODDS_CEILING } from "./paper-data.mjs";
import { readPropRow } from "./pricing-dataset.mjs";
import { americanToProb } from "./odds.mjs";

const model = { holdByStat: new Map(), at: () => ({ weights: {}, statWeights: {}, shares: {} }) };

// A props CSV row. Every row in a board is for one side of one quote.
let id = 0;
const csv = ({ book = "FanDuel", line = 50.5, side = "over", odds = -110, opposite = -110, proj = 0.5, stat = "recYds", player = "100", bettable = 1, week = 5, ...o } = {}) => ({
  Season: "2026", Week: String(week), PlayerID: player, Name: "Player " + player, Team: "TB", Pos: "WR", Opp: "at DAL", Stat: stat, Book: book,
  Line: String(line), Side: side, Proj: "60", Odds: String(odds), OppositeOdds: opposite === null ? "" : String(opposite),
  ImpliedProb: String(americanToProb(odds)), FairProb: String(americanToProb(odds)), Hold: "", OneSided: opposite === null ? "1" : "0",
  OurProb: String(proj), ProjProb: String(proj), Edge: String(proj - americanToProb(odds)), ModelEdge: String(proj - americanToProb(odds)),
  EdgeBasis: "ev", DevigMethod: "none", PriceModel: "projection", Slot: "main", Bettable: String(bettable), LineSource: "live",
  FixtureID: "20261012X", CapturedAt: "2026-10-06T19:00:00Z", _id: id++, ...o,
});

// Five books quote 50.5 at -110/-110 (fair 50%); Hard Rock is off-market on the over.
const board = (extra = []) => ({
  slot: "main",
  week: 5,
  rows: [
    ...["FanDuel", "DraftKings", "Caesars", "BetMGM"].flatMap((b) => [csv({ book: b, side: "over", proj: 0.6 }), csv({ book: b, side: "under", proj: 0.4 })]),
    csv({ book: "Pinnacle", side: "over", proj: 0.6, bettable: 0 }),
    csv({ book: "Pinnacle", side: "under", proj: 0.4, bettable: 0 }),
    csv({ book: "Hard Rock", side: "over", odds: 130, opposite: -160, proj: 0.6 }),
    ...extra,
  ],
});
const actuals = (stat = 70) => new Map([[5, new Map([["100", { PlayerID: "100", ReceptYds: String(stat) }]])]]);
const ctx = (extra = {}) => ({ model, actualsByWeek: actuals(), closeIndex: new Map(), ...extra });

test("only rows with an edge under some price become candidates", () => {
  const { rows } = candidatesForBoard(board(), ctx());
  // The projection says 60% on the over, so every over at -110 has a 7+ point projection edge; the unders do not.
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.pProj - r.implied >= MIN_CANDIDATE_EDGE || (r.pPool ?? -1) - r.implied >= MIN_CANDIDATE_EDGE || (r.pSharp ?? -1) - r.implied >= MIN_CANDIDATE_EDGE));
  assert.ok(rows.some((r) => r.side === "over"));
  assert.ok(!rows.some((r) => r.side === "under" && r.pProj - r.implied < MIN_CANDIDATE_EDGE && (r.pSharp ?? 0) - r.implied < MIN_CANDIDATE_EDGE && r.pPool - r.implied < MIN_CANDIDATE_EDGE));
});

test("a candidate carries the market around it: how many books, and what the rest say", () => {
  const { rows } = candidatesForBoard(board(), ctx());
  const hr = rows.find((r) => r.book === "hardrock" && r.side === "over");
  assert.ok(hr, "the stale Hard Rock over is there");
  assert.equal(hr.nBooks, 6);
  assert.equal(hr.nSharp, 1, "Pinnacle is the sharp quote");
  assert.ok(Math.abs(hr.pSharp - 0.5) < 0.02, `sharp fair ${hr.pSharp}`);
  assert.ok(Math.abs(hr.pFair - 0.5) < 0.05, `consensus fair ${hr.pFair}`);
  assert.equal(hr.odds, 130);
  assert.equal(hr.rung, 0);
  assert.equal(hr.mainLine, 50.5);
  assert.equal(hr.live, true);
  assert.equal(hr.bettable, true);
  assert.equal(hr.bookLabel, "Hard Rock");
  // The beat against the sharp price needs no projection at all.
  assert.ok(hr.pSharp - hr.implied > 0.05, "+130 on a coin flip is about a 6.5 point edge over the sharps");
});

test("a reference book is a candidate but is flagged as not bettable", () => {
  const { rows } = candidatesForBoard(board(), ctx());
  const pin = rows.find((r) => r.book === "pinnacle" && r.side === "over");
  assert.ok(pin);
  assert.equal(pin.bettable, false);
});

test("the side of an under is the complement of the over's probability", () => {
  const { rows } = candidatesForBoard(board([csv({ book: "Hard Rock", side: "under", odds: 130, opposite: -160, proj: 0.4 })]), ctx());
  const u = rows.find((r) => r.book === "hardrock" && r.side === "under");
  assert.ok(u, "the under at +130 is a candidate against a 50% consensus");
  assert.ok(Math.abs(u.pSharp - 0.5) < 0.02);
  assert.ok(Math.abs(u.pProj - 0.4) < 1e-3, "the row's projection price is for ITS side");
});

test("ladders: the line most books quote is the main one, and rungs count away from it", () => {
  const rungs = [
    csv({ book: "Hard Rock", line: 80.5, odds: 400, opposite: -600, proj: 0.4 }),
    csv({ book: "Hard Rock", line: 30.5, odds: -300, opposite: 220, proj: 0.9 }),
  ];
  const { rows } = candidatesForBoard(board(rungs), ctx());
  const high = rows.find((r) => r.line === 80.5);
  const low = rows.find((r) => r.line === 30.5);
  assert.equal(high.mainLine, 50.5);
  assert.equal(high.rung, 1);
  assert.equal(low.rung, -1);
  assert.equal(high.nBooks, 1);
});

test("odds outside the dataset's range are not carried", () => {
  const out = candidatesForBoard(board([csv({ book: "Hard Rock", line: 90.5, odds: ODDS_CEILING + 1, opposite: null, proj: 0.9 }), csv({ book: "Hard Rock", line: 10.5, odds: ODDS_FLOOR - 1, opposite: null, proj: 0.99 })]), ctx());
  assert.ok(!out.rows.some((r) => r.line === 90.5 || r.line === 10.5));
});

test("settlement: won, lost, push, and pending when there is no stat line", () => {
  const w = (act, line, side) => settle(actuals(act), { week: 5, playerId: "100", stat: "recYds", line, side });
  assert.deepEqual(w(70, 50.5, "over"), { status: "won", actual: 70 });
  assert.equal(w(70, 50.5, "under").status, "lost");
  assert.equal(w(50, 50, "over").status, "push");
  assert.deepEqual(settle(new Map(), { week: 5, playerId: "100", stat: "recYds", line: 50.5, side: "over" }), { status: "pending", actual: null });
  assert.equal(settle(actuals(), { week: 5, playerId: "999", stat: "recYds", line: 50.5, side: "over" }).status, "pending", "a player absent from the feed");
});

test("candidates are settled against the actuals", () => {
  const { rows } = candidatesForBoard(board(), ctx({ actualsByWeek: actuals(70) }));
  assert.ok(rows.filter((r) => r.side === "over").every((r) => r.status === "won"));
  const none = candidatesForBoard(board(), ctx({ actualsByWeek: new Map() }));
  assert.ok(none.rows.every((r) => r.status === "pending"));
});

test("market CLV leaves the bet's own book out and needs two others", () => {
  const closing = ["DraftKings", "Caesars", "BetMGM"].flatMap((b) => [csv({ book: b, side: "over", odds: -150, opposite: 130 })].map((r) => readPropRow(r, "closing")));
  const index = indexCloseVotes(closing);
  const key = { week: 5, playerId: "100", stat: "recYds", line: 50.5 };
  const over = closeFairFor(index, { ...key, book: "FanDuel", side: "over" });
  assert.ok(over > 0.55 && over < 0.65, `close fair ${over}`);
  assert.ok(Math.abs(closeFairFor(index, { ...key, book: "FanDuel", side: "under" }) - (1 - over)) < 1e-9);
  assert.equal(closeFairFor(index, { ...key, book: "FanDuel", side: "over" }, { minOthers: 4 }), null, "fewer than the minimum");
  assert.equal(closeFairFor(index, { ...key, line: 99.5, book: "FanDuel", side: "over" }), null, "a different line is a different market");
  // Own book is excluded: DraftKings sees only two others.
  assert.ok(closeFairFor(index, { ...key, book: "DraftKings", side: "over" }, { minOthers: 2 }) !== null);
  assert.equal(closeFairFor(index, { ...key, book: "DraftKings", side: "over" }, { minOthers: 3 }), null);
});

test("a closing board has no CLV against itself", () => {
  const closing = { slot: "closing", week: 5, rows: board().rows.map((r) => ({ ...r, Slot: "closing", LineSource: "closing" })) };
  const index = indexCloseVotes(closing.rows.map((r) => readPropRow(r, "closing")));
  const { rows } = candidatesForBoard(closing, ctx({ closeIndex: index }));
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.closeFair === null));
  assert.ok(rows.every((r) => r.live === false));
});

test("live captures are live and the reconstructions are not", () => {
  for (const s of ["main", "thursday", "saturday"]) assert.equal(isLiveBoard(s), true);
  for (const s of ["opening", "closing"]) assert.equal(isLiveBoard(s), false);
});

test("the dataset gathers every board and the players on them", () => {
  const ds = buildPaperDataset([board(), { ...board(), slot: "saturday" }], ctx());
  assert.deepEqual([...new Set(ds.rows.map((r) => r.slot))].sort(), ["main", "saturday"]);
  assert.equal(ds.players.length, 1);
  assert.equal(ds.players[0].name, "Player 100");
});

test("on a lopsided market the under's consensus is the complement of the over's", () => {
  const books = ["FanDuel", "DraftKings", "Caesars", "BetMGM", "Pinnacle"];
  const rows = books.flatMap((b) => [
    csv({ book: b, side: "over", odds: -150, opposite: 130, proj: 0.7, bettable: b === "Pinnacle" ? 0 : 1 }),
    csv({ book: b, side: "under", odds: 130, opposite: -150, proj: 0.3, bettable: b === "Pinnacle" ? 0 : 1 }),
  ]);
  rows.push(csv({ book: "Hard Rock", side: "under", odds: 250, opposite: -350, proj: 0.3 }));
  const { rows: out } = candidatesForBoard({ slot: "main", week: 5, rows }, ctx());
  const u = out.find((r) => r.book === "hardrock" && r.side === "under");
  assert.ok(u, "the +250 under is a candidate");
  // The books say the over is ~58%, so the under is ~42%; +250 implies 28.6%.
  assert.ok(u.pSharp > 0.38 && u.pSharp < 0.46, `under sharp fair ${u.pSharp}`);
  assert.ok(u.pFair > 0.38 && u.pFair < 0.46, `under consensus fair ${u.pFair}`);
  assert.ok(Math.abs(u.pProj - 0.3) < 1e-3);
  const o = out.find((r) => r.book === "fanduel" && r.side === "over");
  assert.ok(!o || (o.pSharp > 0.54 && o.pSharp < 0.62), "and the over keeps its own side");
});
