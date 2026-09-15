import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOOKS, normalizeBookName, resolveBookIds } from "./books.mjs";

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
