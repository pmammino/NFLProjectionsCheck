import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOOKS,
  BETTABLE_BOOKS,
  REFERENCE_BOOKS,
  booksToFetch,
  bookKeySet,
  isBettableBook,
  normalizeBookName,
  resolveBookIds,
} from "./books.mjs";

// Shaped like the real /sportsbooks rows, with the id spellings the API is
// likely to use — deliberately NOT the same strings a human would type.
const LIVE = [
  { id: "draftkings", name: "DraftKings", is_active: true, is_onshore: true },
  { id: "fanduel", name: "FanDuel", is_active: true, is_onshore: true },
  { id: "betmgm", name: "BetMGM", is_active: true, is_onshore: true },
  { id: "caesars", name: "Caesars", is_active: true, is_onshore: true },
  { id: "betrivers", name: "BetRivers", is_active: true, is_onshore: true },
  { id: "hard_rock_bet", name: "Hard Rock Bet", is_active: true, is_onshore: true },
  { id: "thescore_bet", name: "theScore Bet", is_active: true, is_onshore: true },
  { id: "circa_sports", name: "Circa Sports", is_active: true, is_onshore: true },
  // Noise that must not be picked up.
  { id: "bet365", name: "bet365", is_active: true, is_onshore: true },
  { id: "bet99", name: "bet99", is_active: true, is_onshore: true },
  { id: "betano", name: "Betano", is_active: true, is_onshore: true },
  { id: "pinnacle", name: "Pinnacle", is_active: true, is_onshore: false },
];

test("normalization strips case, spaces and underscores", () => {
  assert.equal(normalizeBookName("Hard Rock Bet"), "hardrockbet");
  assert.equal(normalizeBookName("hard_rock_bet"), "hardrockbet");
  assert.equal(normalizeBookName("theScore Bet"), "thescorebet");
  assert.equal(normalizeBookName(null), "");
});

test("the default roster resolves completely against the live list", () => {
  const { ids, missing, ambiguous } = resolveBookIds(DEFAULT_BOOKS, LIVE);
  assert.deepEqual(missing, [], "every default book should resolve");
  assert.equal(ambiguous.size, 0);
  assert.deepEqual(ids.sort(), [
    "betmgm", "betrivers", "caesars", "circa_sports",
    "draftkings", "fanduel", "hard_rock_bet", "thescore_bet",
  ]);
});

test("a shorthand finds the API's longer id", () => {
  // This is the point: nobody should have to know whether it's "hardrock",
  // "hard_rock_bet" or "Hard Rock Bet".
  const { matched } = resolveBookIds(["hardrock", "circa", "thescore"], LIVE);
  assert.equal(matched.get("hardrock"), "hard_rock_bet");
  assert.equal(matched.get("circa"), "circa_sports");
  assert.equal(matched.get("thescore"), "thescore_bet");
});

test("an exact match wins over a containment match", () => {
  // "bet365" is contained in nothing else, but prove exact takes priority when
  // both could apply.
  const live = [
    { id: "bet", name: "Bet" },
    { id: "betmgm", name: "BetMGM" },
  ];
  const { matched } = resolveBookIds(["bet"], live);
  assert.equal(matched.get("bet"), "bet", "exact id should win, not the longer containment");
});

test("an ambiguous shorthand is reported, never guessed", () => {
  // "bet" is inside bet365, bet99, betano, betmgm, betrivers...
  const { ids, ambiguous } = resolveBookIds(["bet"], LIVE);
  assert.equal(ids.length, 0);
  assert.ok(ambiguous.has("bet"));
  assert.ok(ambiguous.get("bet").length > 1);
});

test("an unknown book is reported missing, not silently dropped", () => {
  // The failure this guards: an unrecognised id is not an API error, it just
  // returns no odds — indistinguishable from the book not pricing that week.
  const { ids, missing } = resolveBookIds(["draftkings", "notabook"], LIVE);
  assert.deepEqual(ids, ["draftkings"]);
  assert.deepEqual(missing, ["notabook"]);
});

test("duplicate requests collapse to one id", () => {
  const { ids } = resolveBookIds(["draftkings", "DraftKings", "draft_kings"], LIVE);
  assert.deepEqual(ids, ["draftkings"]);
});

test("matching works when the live list is bare strings", () => {
  const { ids } = resolveBookIds(["draftkings"], ["draftkings", "fanduel"]);
  assert.deepEqual(ids, ["draftkings"]);
});

test("an empty request or empty live list yields nothing, without throwing", () => {
  assert.deepEqual(resolveBookIds([], LIVE).ids, []);
  assert.deepEqual(resolveBookIds(DEFAULT_BOOKS, []).ids, []);
  assert.deepEqual(resolveBookIds(null, null).ids, []);
  assert.equal(resolveBookIds(DEFAULT_BOOKS, []).missing.length, DEFAULT_BOOKS.length);
});

test("blank entries in a request are skipped rather than matching everything", () => {
  const { ids, missing } = resolveBookIds(["", "  ", "draftkings"], LIVE);
  assert.deepEqual(ids, ["draftkings"]);
  assert.deepEqual(missing, []);
});

test("every default book resolves against a live list carrying both Circa ids", () => {
  // Regression test for a silent drop. "circa" matched both circa_sports and
  // circa_vegas once OpticOdds listed both, so resolveBookIds reported it
  // ambiguous and the capture ran with 7 of 8 books for weeks — taking the
  // only sharp book in the roster with it.
  const live = [
    { id: "draftkings", name: "DraftKings" },
    { id: "fanduel", name: "FanDuel" },
    { id: "betmgm", name: "BetMGM" },
    { id: "caesars", name: "Caesars" },
    { id: "betrivers", name: "BetRivers" },
    { id: "hard_rock", name: "Hard Rock" },
    { id: "thescore", name: "theScore" },
    { id: "circa_sports", name: "Circa Sports" },
    { id: "circa_vegas", name: "Circa Vegas" },
  ];
  const r = resolveBookIds(DEFAULT_BOOKS, live);
  assert.deepEqual(r.missing, [], "no default book should fail to resolve");
  assert.deepEqual([...r.ambiguous], [], "no default book should be ambiguous");
  assert.equal(r.ids.length, DEFAULT_BOOKS.length);
  assert.ok(r.ids.includes("circa_sports"));
  // One operator, one vote: the other Circa id must not also come along.
  assert.ok(!r.ids.includes("circa_vegas"));
});

test("booksToFetch is the union, and a book in both lists stays bettable", () => {
  const fetch = booksToFetch({ bettable: ["draftkings", "circa_sports"], reference: ["pinnacle"] });
  assert.deepEqual(fetch, ["draftkings", "circa_sports", "pinnacle"]);
  // A name on both rosters must appear once, as bettable — the stronger claim
  // wins, since a book you can bet at is also one you can price against.
  const both = booksToFetch({ bettable: ["circa_sports"], reference: ["Circa_Sports", "pinnacle"] });
  assert.deepEqual(both, ["circa_sports", "pinnacle"]);
});

test("reference books ride along inside the same request budget", () => {
  // /fixtures/odds takes 5 sportsbooks per request, so 8 books and 10 books
  // both cost two book batches. If this ever fails, adding a reference book
  // has started costing real quota and the roster needs a second look.
  const fetched = booksToFetch();
  assert.ok(fetched.length <= 10, `roster grew to ${fetched.length}, past the 2-batch budget`);
  assert.ok(fetched.length > BETTABLE_BOOKS.length, "no reference book is being pulled at all");
});

test("bookKeySet matches every spelling a capture might write", () => {
  // The 2026 files hold "DraftKings", "draftkings" and "hard_rock" across
  // different weeks, so membership has to survive all of them.
  const live = [
    { id: "hard_rock", name: "Hard Rock" },
    { id: "pinnacle", name: "Pinnacle" },
  ];
  const { resolved } = resolveBookIds(["hardrock"], live);
  const keys = bookKeySet(resolved);
  for (const spelling of ["hardrock", "hard_rock", "Hard Rock", "HARD ROCK"]) {
    assert.equal(isBettableBook(spelling, keys), true, spelling);
  }
});

test("an unknown book is never bettable", () => {
  // A capture returning a book nobody listed is a book with no account behind
  // it. Defaulting it to bettable would put its price into a ledger.
  const keys = bookKeySet([{ requested: "draftkings", id: "draftkings", name: "DraftKings" }]);
  assert.equal(isBettableBook("Pinnacle", keys), false);
  assert.equal(isBettableBook("some_book_nobody_listed", keys), false);
  assert.equal(isBettableBook("", keys), false);
  assert.equal(isBettableBook("DraftKings", undefined), false);
});

test("the reference roster and the bettable roster do not overlap", () => {
  const bettable = new Set(BETTABLE_BOOKS.map(normalizeBookName));
  const overlap = REFERENCE_BOOKS.filter((b) => bettable.has(normalizeBookName(b)));
  assert.deepEqual(overlap, [], "a book listed as both is just bettable; drop it from REFERENCE_BOOKS");
});
