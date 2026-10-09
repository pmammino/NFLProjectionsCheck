import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The report is a CLI over data/. The arithmetic is tested in
// lib/backtest-live.test.mjs; these check the wiring that does not need data.
const SCRIPT = fileURLToPath(new URL("./backtest-live.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("--help says what it takes and does not run the report", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--live-slots/);
  assert.match(r.stdout, /--no-counterfactual/);
  assert.doesNotMatch(r.stdout, /Live backtest/);
});

test("an unknown flag is refused rather than ignored", () => {
  const r = run("--nope");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown argument: --nope/);
});

test("a negative minimum edge is refused", () => {
  const r = run("--min-edge", "-1");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--min-edge must be >= 0/);
});

test("with no captures it says so instead of printing an empty report", () => {
  const empty = relative(ROOT, mkdtempSync(join(tmpdir(), "bt-empty-")));
  const r = run("--data-dir", empty);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No prop captures/);
});
