import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probOverContinuous } from "./probability.mjs";
import { probOverTweedie, projectionMean, fitSpreadLaws, formatLaws, SPREAD_STATS } from "./spread-law.mjs";
import { rng } from "./dist-lab.mjs";

const PROJ_COLS = "Season,GameWeek,Split,Team,PlayerID,PassAttempts,RushAttempts,Targets,PassCompletions,PassYards,PassTDs,PassInts,RushYards,RushTDs,RecCompletions,RecYards,RecTDs";
const ACT_COLS = "PlayerID,ID,position,Season,Week,NFLTeamID,Rushes,RushYards,PassComp,PassAtt,PassYards,Receptions,ReceptYds,PassTD,RecptTD,RushTD,Targets";

function fixture(weeks, perWeek) {
  const dir = mkdtempSync(join(tmpdir(), "spread-law-"));
  mkdirSync(join(dir, "projections", "2026"), { recursive: true });
  mkdirSync(join(dir, "actuals", "2026"), { recursive: true });
  const rand = rng(3);
  for (const w of weeks) {
    const p = [PROJ_COLS];
    const a = [ACT_COLS];
    for (let i = 0; i < perWeek; i++) {
      const M = 20 + 60 * rand();
      const id = 1000 + i;
      const row = (split, v) => `2026,${w},${split},AAA,${id},0,0,0,0,0,0,0,0,0,0,${v.toFixed(2)},0`;
      p.push(row("F", 0.7 * M), row("M", M), row("C", 1.35 * M));
      // outcomes wider than the band says
      const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
      const actual = Math.max(0, Math.round(M + z * 0.9 * M));
      a.push(`${id},${id},WR,2026,${w},AAA,0,0,0,0,0,0,${actual},0,0,0,0`);
    }
    const pad = String(w).padStart(2, "0");
    writeFileSync(join(dir, "projections", "2026", `week-${pad}.csv`), p.join("\n") + "\n");
    writeFileSync(join(dir, "actuals", "2026", `week-${pad}.csv`), a.join("\n") + "\n");
  }
  return dir;
}

test("with no law the price is exactly the two-piece normal", () => {
  const pts = { F: 40, M: 60, C: 85 };
  assert.equal(probOverTweedie(55.5, pts, null), probOverContinuous(55.5, pts.F, pts.M, pts.C));
  assert.equal(probOverTweedie(55.5, pts, { phi: 5, p: 2.4 }), probOverContinuous(55.5, pts.F, pts.M, pts.C));
  assert.equal(probOverTweedie(55.5, { F: 0, M: 60, C: 85 }, { phi: 5, p: 1.5 }), probOverContinuous(55.5, 0, 60, 85));
});

test("with a law the price is a proper decreasing probability and widens the tails", () => {
  const pts = { F: 40, M: 60, C: 85 };
  const law = { phi: 30, p: 1.4 };
  let prev = 1;
  for (const line of [10.5, 30.5, 55.5, 60.5, 90.5, 140.5, 250.5]) {
    const p = probOverTweedie(line, pts, law);
    assert.ok(p <= prev + 1e-12 && p >= 0.001 && p <= 0.999, `line ${line}: ${p}`);
    prev = p;
  }
  // a far line the band calls near-impossible keeps real probability under a wide law
  assert.ok(probOverTweedie(200.5, pts, law) > 3 * probOverContinuous(200.5, 40, 60, 85));
});

test("the mean sits near the median for a mildly skewed band", () => {
  const m = projectionMean({ F: 40, M: 60, C: 85 });
  assert.ok(m > 58 && m < 75, `${m}`);
});

test("laws are fitted as of the week: strictly earlier weeks only", () => {
  const dir = fixture([1, 2, 3], 90);
  try {
    const first = fitSpreadLaws({ dataDir: dir, season: 2026, beforeWeek: 1 });
    assert.equal(first.weeksUsed.length, 0);
    assert.equal(first.laws.recYds, null);
    const second = fitSpreadLaws({ dataDir: dir, season: 2026, beforeWeek: 2 });
    assert.deepEqual(second.weeksUsed, [1]);
    assert.ok(second.laws.recYds && second.laws.recYds.n === 90);
    assert.equal(second.laws.passYds, null, "a stat with no pairs stays unfitted");
    const third = fitSpreadLaws({ dataDir: dir, season: 2026, beforeWeek: 3 });
    assert.deepEqual(third.weeksUsed, [1, 2]);
    assert.ok(third.laws.recYds.p > 1 && third.laws.recYds.p < 2);
    assert.equal(formatLaws(third.laws).length, SPREAD_STATS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
