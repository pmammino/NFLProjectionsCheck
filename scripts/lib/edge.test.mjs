import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeBucket } from "./edge.mjs";

test("edgeBucket: boundaries", () => {
  assert.equal(edgeBucket(0.03), "3-5%");
  assert.equal(edgeBucket(0.049), "3-5%");
  assert.equal(edgeBucket(0.05), "5-10%");
  assert.equal(edgeBucket(0.099), "5-10%");
  assert.equal(edgeBucket(0.1), "10-15%");
  assert.equal(edgeBucket(0.15), "15%+");
  assert.equal(edgeBucket(0.5), "15%+");
});
