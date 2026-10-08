import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSlotFile, buildIndex, selectWeeks, canonicalBookKey, bookLabel, projectionFor, MARKET_SOURCES, LINES_SCHEMA_VERSION } from "./lines-index.mjs";
import { probOverContinuous } from "./probability.mjs";
import { adjustedPoints } from "./median-correction.mjs";

// A quote as readPropRow() produces it.
const quote = (o = {}) => ({
  slot: "opening",
  season: 2026,
  week: 4,
  playerId: "1",
  name: "Test Back",
  team: "KC",
  pos: "RB",
  opp: "vs LV",
  stat: "rushYds",
  line: 49.5,
  side: "over",
  book: "DraftKings",
  odds: -110,
  overOdds: -110,
  underOdds: -110,
  hold: 0.048,
  bettable: true,
  proj: 50,
  probOver: 0.5,
  medianAdj: null,
  ...o,
});

// The frozen projection snapshot, as loadSnapshot() shapes it.
const snap = (id, { F, M, C }) =>
  new Map([[String(id), { F: { RushYards: String(F) }, M: { RushYards: String(M) }, C: { RushYards: String(C) } }]]);

const build = (quotes, extra = {}) =>
  buildSlotFile({ season: 2026, week: 4, slot: "opening", quotes, generatedAt: "t", ...extra });

const lines = (file, id = "1", stat = "rushYds") => file.players.find((p) => p.id === id).stats[stat].lines;

// --- books --------------------------------------------------------------------

test("book spellings that drift across captures are one book", () => {
  // The 2026 files hold "mgm" and "BetMGM", "circasports" and "circa". Counting
  // them twice would show a book that is not there.
  assert.equal(canonicalBookKey("mgm"), canonicalBookKey("BetMGM"));
  assert.equal(canonicalBookKey("circa"), canonicalBookKey("circasports"));
  assert.equal(canonicalBookKey("Hard Rock"), canonicalBookKey("hard_rock"));
  assert.equal(bookLabel("mgm"), "BetMGM");
  assert.equal(bookLabel("someNewBook"), "someNewBook");
});

test("the book table lists bettable books first, then reference books, deterministically", () => {
  const f = build([
    quote({ book: "Pinnacle", bettable: false }),
    quote({ book: "mgm" }),
    quote({ book: "BetMGM" }),
    quote({ book: "DraftKings" }),
  ]);
  assert.deepEqual(f.books.map((b) => b.label), ["BetMGM", "DraftKings", "Pinnacle"]);
  assert.deepEqual(f.books.map((b) => b.t), [1, 1, 0]);
});

test("a book is bettable if any of its rows says so", () => {
  const f = build([quote({ book: "DraftKings", bettable: false }), quote({ book: "DraftKings", bettable: true })]);
  assert.equal(f.books.find((b) => b.label === "DraftKings").t, 1);
});

// --- markets ---------------------------------------------------------------------

test("books quoting one line become one line, and different lines stay separate and sorted", () => {
  const f = build([
    quote({ line: 74.5, book: "DraftKings" }),
    quote({ line: 49.5, book: "DraftKings" }),
    quote({ line: 49.5, book: "FanDuel" }),
  ]);
  const ls = lines(f);
  assert.deepEqual(ls.map((l) => l.l), [49.5, 74.5]);
  assert.equal(ls[0].b.length, 2);
  assert.equal(ls[1].b.length, 1);
  assert.equal(f.counts.markets, 2);
});

test("a book's Over row and Under row merge into one entry carrying both prices", () => {
  const f = build([
    quote({ book: "DraftKings", side: "over", odds: -120, overOdds: -120, underOdds: 100 }),
    quote({ book: "DraftKings", side: "under", odds: 100, overOdds: -120, underOdds: 100 }),
  ]);
  const b = lines(f)[0].b;
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].slice(1), [-120, 100]);
});

test("a one-sided quote keeps its missing side missing", () => {
  const f = build([quote({ overOdds: 250, underOdds: null, odds: 250 })]);
  assert.deepEqual(lines(f)[0].b[0].slice(1), [250, null]);
});

test("consensus: retail is populated, sharp is null unless a sharp book quoted it", () => {
  const retailOnly = lines(build([quote({ book: "DraftKings" }), quote({ book: "FanDuel" })]))[0];
  assert.ok(retailOnly.m > 0.45 && retailOnly.m < 0.55);
  assert.equal(retailOnly.s, null);

  const withSharp = lines(build([quote({ book: "DraftKings" }), quote({ book: "Pinnacle", bettable: false })]))[0];
  assert.ok(withSharp.s !== null && withSharp.s > 0.4 && withSharp.s < 0.6);
});

test("players are sorted by name and stats follow the stat order", () => {
  const f = build([
    quote({ playerId: "2", name: "Zed Runner", stat: "recYds" }),
    quote({ playerId: "2", name: "Zed Runner", stat: "rushYds" }),
    quote({ playerId: "3", name: "Abe Back" }),
  ]);
  assert.deepEqual(f.players.map((p) => p.name), ["Abe Back", "Zed Runner"]);
  assert.deepEqual(Object.keys(f.players[1].stats), ["rushYds", "recYds"]);
});

test("the file does not depend on the order quotes arrive in", () => {
  // Reproducibility is the point of building from committed captures: the same
  // board must always produce the same bytes.
  // The fixture is built so a reversal CHANGES the order in which both lines
  // and books are first seen (74.5 before 49.5; DraftKings before FanDuel
  // forward, the reverse backward). A fixture that comes out the same both ways
  // would pass even with every sort deleted, which is how this test once
  // failed to notice that.
  const qs = [];
  for (const [pid, line, book] of [["1", 74.5, "FanDuel"], ["1", 49.5, "DraftKings"], ["2", 30.5, "Caesars"], ["1", 49.5, "FanDuel"], ["2", 30.5, "mgm"]]) {
    qs.push(quote({ playerId: pid, name: `P${pid}`, line, book }));
  }
  const a = JSON.stringify(build(qs));
  const b = JSON.stringify(build([...qs].reverse()));
  const c = JSON.stringify(build([qs[2], qs[0], qs[4], qs[1], qs[3]]));
  assert.equal(a, b);
  assert.equal(a, c);
});

// --- projection, correction, result -----------------------------------------------

const F = 28, M = 40, C = 52;
const raw = probOverContinuous(40, F, M, C); // 0.5 exactly
const APPLIED = { rushYds: { applied: true, reason: "applied", n: 300, kF: 0.7, kM: 0.8, kC: 0.95, z: 4.1 } };

test("the median-corrected price is given when it is honest to give one", () => {
  const f = build([quote({ line: 40, probOver: raw, proj: M })], { snapshot: snap(1, { F, M, C }), correction: APPLIED });
  const l = lines(f)[0];
  const adj = adjustedPoints({ F, M, C }, APPLIED, "rushYds");
  assert.equal(l.p, Math.round(raw * 1e4) / 1e4);
  assert.equal(l.a, Math.round(probOverContinuous(40, adj.F, adj.M, adj.C) * 1e4) / 1e4);
  assert.ok(l.a < 0.4, `corrected P(over 40) = ${l.a}`);
  const st = f.players[0].stats.rushYds;
  assert.deepEqual(st.proj, { F, M, C });
  assert.deepEqual(st.adj, { F: 19.6, M: 32, C: 49.4 });
});

test("no corrected price when the correction does not apply", () => {
  const notApplied = { rushYds: { ...APPLIED.rushYds, applied: false, reason: "not-solid" } };
  const f = build([quote({ line: 40, probOver: raw, proj: M })], { snapshot: snap(1, { F, M, C }), correction: notApplied });
  assert.equal(lines(f)[0].a, null);
  assert.equal(f.players[0].stats.rushYds.adj, null);
  assert.equal(lines(build([quote({ line: 40, probOver: raw, proj: M })], { snapshot: snap(1, { F, M, C }) }))[0].a, null);
});

test("no corrected price for a capture that was already corrected", () => {
  // Correcting it again would apply the multiplier twice.
  const f = build([quote({ line: 40, probOver: 0.3, proj: M, medianAdj: 0.8 })], { snapshot: snap(1, { F, M, C }), correction: APPLIED });
  assert.equal(lines(f)[0].a, null);
});

test("no corrected price when the stored price came from a different projection", () => {
  // The Tuesday drop is priced before the week's last refresh, so re-pricing it
  // from the frozen snapshot would compare two projections.
  const f = build([quote({ line: 40, probOver: 0.71, proj: 55 })], { snapshot: snap(1, { F, M, C }), correction: APPLIED });
  assert.equal(lines(f)[0].a, null);
  assert.equal(f.players[0].stats.rushYds.stale, true, "priced median 55 vs snapshot 40 must be flagged");
});

test("a priced median that matches the snapshot is not stale", () => {
  const f = build([quote({ line: 40, probOver: raw, proj: 40.01 })], { snapshot: snap(1, { F, M, C }) });
  assert.equal(f.players[0].stats.rushYds.stale, false);
});

test("the actual result is attached, and an absent player has none", () => {
  const actuals = new Map([["1", { RushYards: "82" }]]);
  const f = build([quote(), quote({ playerId: "9", name: "Ghost" })], { actuals });
  assert.equal(f.players.find((p) => p.id === "1").stats.rushYds.actual, 82);
  assert.equal(f.players.find((p) => p.id === "9").stats.rushYds.actual, null);
});

test("the header reports only the eligible stats' correction state", () => {
  const f = build([quote()], { correction: { ...APPLIED, passYds: { applied: false, reason: "not-correctable", n: 127, kF: 1, kM: 1, kC: 1, z: 0.1 } } });
  assert.deepEqual(Object.keys(f.correction), ["rushYds"]);
  assert.equal(f.correction.rushYds.applied, true);
  assert.equal(build([quote()]).correction, null);
});

test("projectionFor sums the projection columns and tolerates a missing player", () => {
  assert.deepEqual(projectionFor(snap(1, { F, M, C }), "1", "rushYds"), { F, M, C });
  assert.equal(projectionFor(snap(1, { F, M, C }), "2", "rushYds"), null);
  assert.equal(projectionFor(null, "1", "rushYds"), null);
});

// --- the index --------------------------------------------------------------------

test("selectWeeks keeps the latest weeks and tolerates nonsense", () => {
  assert.deepEqual(selectWeeks([3, 1, 2, 5, 4, 5], 3), [3, 4, 5]);
  assert.deepEqual(selectWeeks([1, 2], 6), [1, 2]);
  assert.deepEqual(selectWeeks([1, 2, 3], 0), [1, 2, 3]);
  assert.deepEqual(selectWeeks([1, 2, 3], NaN), [1, 2, 3]);
});

test("buildIndex defaults each week to its fullest board, deterministically", () => {
  const e = (week, slot, markets) => ({ week, slot, file: `${week}-${slot}.json`, markets, players: 1, bytes: 1 });
  const idx = buildIndex({
    season: 2026,
    entries: [e(4, "main", 9000), e(4, "opening", 38000), e(4, "closing", 38000), e(5, "main", 10000)],
    actualsWeeks: new Set([4]),
    generatedAt: "t",
  });
  assert.equal(idx.defaultWeek, 5);
  assert.deepEqual(idx.weeks.map((w) => w.week), [4, 5]);
  // opening and closing tie on size; the name breaks it, so the choice is stable.
  assert.equal(idx.weeks[0].defaultSlot, "closing");
  assert.equal(idx.weeks[0].hasActuals, true);
  assert.equal(idx.weeks[1].hasActuals, false);
  assert.equal(idx.weeks[1].defaultSlot, "main");
  assert.deepEqual(buildIndex({ season: 2026, entries: [], generatedAt: "t" }).weeks, []);
  assert.equal(buildIndex({ season: 2026, entries: [], generatedAt: "t" }).defaultWeek, null);
});

test("the market price says whether it was measured or inferred", () => {
  // Two-sided quotes: the books' own no-vig price.
  const measured = lines(build([quote({ book: "DraftKings" }), quote({ book: "FanDuel" })]))[0];
  assert.equal(MARKET_SOURCES[measured.q], "devig");
  // One-sided quotes: an assumed margin is stripped, so the price is inferred
  // and must not look like one the book implied.
  const inferred = lines(build([quote({ book: "DraftKings", overOdds: 250, underOdds: null, odds: 250 })]))[0];
  assert.equal(MARKET_SOURCES[inferred.q], "assumed-hold");
  const mixed = lines(build([quote({ book: "DraftKings" }), quote({ book: "FanDuel", overOdds: 120, underOdds: null, odds: 120 })]))[0];
  assert.equal(MARKET_SOURCES[mixed.q], "mixed");
});

test("a line no retail book quoted has no market price and no source", () => {
  const l = lines(build([quote({ book: "Pinnacle", bettable: false })]))[0];
  assert.equal(l.m, null);
  assert.equal(l.q, null);
  assert.ok(l.s !== null, "the sharp consensus still exists");
});

test("the browser's copy of MARKET_SOURCES matches the builder's", () => {
  // lib/lines.ts cannot import lines-index.mjs (it pulls in Node-only code), so
  // it keeps a mirror. If the two drift, every "inferred" dagger in the UI
  // points at the wrong source.
  const ts = readFileSync(new URL("../../lib/lines.ts", import.meta.url), "utf8");
  const m = ts.match(/MARKET_SOURCES\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, "lib/lines.ts must define MARKET_SOURCES");
  const mirror = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(mirror, [...MARKET_SOURCES]);
});

test("the browser's copy of the schema version matches the builder's", () => {
  // If these drift, the page either refuses good files or accepts stale ones.
  const ts = readFileSync(new URL("../../lib/lines.ts", import.meta.url), "utf8");
  const m = ts.match(/LINES_SCHEMA\s*=\s*(\d+)/);
  assert.ok(m, "lib/lines.ts must define LINES_SCHEMA");
  assert.equal(Number(m[1]), LINES_SCHEMA_VERSION);
});

test("every file and the index carry the schema version", () => {
  const f = build([quote()]);
  assert.equal(f.schema, LINES_SCHEMA_VERSION);
  assert.equal(buildIndex({ season: 2026, entries: [], generatedAt: "t" }).schema, LINES_SCHEMA_VERSION);
});
