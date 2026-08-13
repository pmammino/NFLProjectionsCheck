// Verifies the date -> NFL-week heuristics, especially the projection-week
// rollover boundary that keeps a daily refresh from overwriting a finished week.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonForDate, currentNflWeek, projectionWeek } from "./schedule.mjs";

// 2025 Week 1 opener is Thursday 2025-09-04. Build dates off that anchor.
const d = (iso) => new Date(iso + "T12:00:00Z");

test("seasonForDate treats Jan/Feb as the prior year's season", () => {
  assert.equal(seasonForDate(d("2025-09-10")), 2025);
  assert.equal(seasonForDate(d("2026-01-15")), 2025);
  assert.equal(seasonForDate(d("2026-02-08")), 2025);
  assert.equal(seasonForDate(d("2026-03-01")), 2026);
});

test("currentNflWeek maps a Thu→Wed window to one week", () => {
  assert.equal(currentNflWeek(2025, d("2025-09-04")), 1); // Thu opener
  assert.equal(currentNflWeek(2025, d("2025-09-07")), 1); // Sun
  assert.equal(currentNflWeek(2025, d("2025-09-08")), 1); // Mon
  assert.equal(currentNflWeek(2025, d("2025-09-10")), 1); // Wed (still wk1)
  assert.equal(currentNflWeek(2025, d("2025-09-11")), 2); // next Thu -> wk2
});

test("currentNflWeek clamps before the season and into the playoffs", () => {
  assert.equal(currentNflWeek(2025, d("2025-08-01")), 1); // preseason
  assert.equal(currentNflWeek(2025, d("2026-06-01")), 22); // clamps at 22
});

test("projectionWeek stays on the week through Monday, rolls forward Tue/Wed", () => {
  // Week 1 game days -> still projecting week 1.
  assert.equal(projectionWeek(2025, d("2025-09-04")), 1); // Thu
  assert.equal(projectionWeek(2025, d("2025-09-07")), 1); // Sun
  assert.equal(projectionWeek(2025, d("2025-09-08")), 1); // Mon (MNF)
  // After MNF the next games are week 2 -> roll forward.
  assert.equal(projectionWeek(2025, d("2025-09-09")), 2); // Tue
  assert.equal(projectionWeek(2025, d("2025-09-10")), 2); // Wed
  assert.equal(projectionWeek(2025, d("2025-09-11")), 2); // Thu (wk2 games)
});

test("actuals default (currentNflWeek) on Tuesday points at the finished week", () => {
  // Tuesday after Week 1 -> actuals for week 1, while projections roll to week 2.
  const tue = d("2025-09-09");
  assert.equal(currentNflWeek(2025, tue), 1);
  assert.equal(projectionWeek(2025, tue), 2);
});
