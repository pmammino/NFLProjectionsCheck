import test from "node:test";
import assert from "node:assert/strict";
import { SLOT_MAIN, slotDir, isValidSlot, assertValidSlot, slotOf } from "./slots.mjs";

test("the main slot keeps the original paths", () => {
  // Every committed file and every existing reader depends on this: the
  // Tuesday drop must stay at data/props/{season}/week-NN.csv.
  assert.equal(slotDir(SLOT_MAIN), "");
  assert.equal(slotDir(""), "");
  assert.equal(slotDir(undefined), "");
});

test("any other slot nests one level deeper", () => {
  assert.equal(slotDir("thursday"), "thursday");
  assert.equal(slotDir("t-48h"), "t-48h");
});

test("a slot name must be directory-safe", () => {
  assert.equal(isValidSlot("thursday"), true);
  assert.equal(isValidSlot("t-48h"), true);
  assert.equal(isValidSlot("2026-09-25T18-00-00-000Z"), true);
  // Anything that could escape the data directory or confuse a path.
  assert.equal(isValidSlot("../main"), false);
  assert.equal(isValidSlot("a/b"), false);
  assert.equal(isValidSlot(".hidden"), false);
  assert.equal(isValidSlot(""), false);
  assert.equal(isValidSlot(undefined), false);
  assert.throws(() => assertValidSlot("../main"), /directory-safe/);
  assert.equal(assertValidSlot("thursday"), "thursday");
});

test("a row written before slots existed is the Tuesday drop", () => {
  // Every committed props/edges/ledger row predates the Slot column, and all
  // of them came from the one capture that existed.
  assert.equal(slotOf({}), SLOT_MAIN);
  assert.equal(slotOf({ Slot: "" }), SLOT_MAIN);
  assert.equal(slotOf({ Slot: "thursday" }), "thursday");
  assert.equal(slotOf(undefined), SLOT_MAIN);
});
