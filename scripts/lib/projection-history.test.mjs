import test from "node:test";
import assert from "node:assert/strict";
import { snapshotAt, gitSnapshots } from "./projection-history.mjs";

const h = (iso, tag) => ({ date: new Date(iso), snapshot: tag });
const history = [h("2026-10-06T13:00:00Z", "tue-am"), h("2026-10-07T19:00:00Z", "wed"), h("2026-10-10T17:00:00Z", "sat")];

test("a capture gets the last snapshot written before it, not the final one", () => {
  assert.equal(snapshotAt(history, Date.parse("2026-10-06T19:09:00Z")), "tue-am");
  assert.equal(snapshotAt(history, Date.parse("2026-10-10T19:11:00Z")), "sat");
});

test("a snapshot written at the capture's own instant counts; one a second later does not", () => {
  assert.equal(snapshotAt(history, Date.parse("2026-10-07T19:00:00Z")), "wed");
  assert.equal(snapshotAt(history, Date.parse("2026-10-07T18:59:59Z")), "tue-am");
});

test("nothing before the first snapshot, and no history, are both null", () => {
  assert.equal(snapshotAt(history, Date.parse("2026-10-01T00:00:00Z")), null);
  assert.equal(snapshotAt([], Date.now()), null);
});

test("a directory that is not a repository gives no history rather than throwing", () => {
  assert.deepEqual(gitSnapshots({ root: "/", season: 2026, week: 1 }), []);
});
