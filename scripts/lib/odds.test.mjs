import { test } from "node:test";
import assert from "node:assert/strict";
import { americanToProb, americanToDecimal, kellyFraction } from "./odds.mjs";

test("americanToProb: favorite and underdog", () => {
  assert.ok(Math.abs(americanToProb(-110) - 0.5238) < 1e-3);
  assert.ok(Math.abs(americanToProb(150) - 0.4) < 1e-9);
  assert.equal(americanToProb(100), 0.5);
});

test("americanToProb: invalid input", () => {
  assert.equal(americanToProb(0), null);
  assert.equal(americanToProb(NaN), null);
  assert.equal(americanToProb(undefined), null);
});

test("americanToDecimal", () => {
  assert.ok(Math.abs(americanToDecimal(150) - 2.5) < 1e-9);
  assert.ok(Math.abs(americanToDecimal(-110) - 1.909090909) < 1e-6);
  assert.ok(Math.abs(americanToDecimal(100) - 2.0) < 1e-9);
});

test("kellyFraction: no edge -> 0", () => {
  // -110 implies p=0.5238; betting exactly at the fair price has zero edge.
  const fair = 100 / (110 + 100);
  assert.ok(kellyFraction(fair, americanToDecimal(-110)) < 1e-9);
});

test("kellyFraction: positive edge scales with edge size", () => {
  const decimalOdds = americanToDecimal(100); // even money, b=1
  // p=0.6 at even money: f* = (1*0.6 - 0.4)/1 = 0.2
  assert.ok(Math.abs(kellyFraction(0.6, decimalOdds) - 0.2) < 1e-9);
  // Bigger edge -> bigger stake.
  assert.ok(kellyFraction(0.7, decimalOdds) > kellyFraction(0.6, decimalOdds));
});

test("kellyFraction: negative edge clamps to 0", () => {
  const decimalOdds = americanToDecimal(100);
  assert.equal(kellyFraction(0.4, decimalOdds), 0);
});
