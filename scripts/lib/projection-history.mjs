// The projection a capture actually had, from git history.
//
// data/projections/{season}/week-NN.csv is overwritten by every ingest, so the
// committed file is the LATEST snapshot of a week, which has read everything
// that happened after any earlier capture was taken. The earlier versions exist
// only as commits. Evaluating how the projection would have priced a market at
// the moment it was captured means finding the last commit before that moment.
//
// A shallow clone has no such history; callers get an empty list and must fall
// back to the committed file and say so.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSnapshot } from "./median-correction.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });

// Every committed version of a week's projection file, oldest first:
// [{ date: Date, snapshot: Map playerId -> { F, M, C } }].
export function gitSnapshots({ root, season, week }) {
  const rel = `data/projections/${season}/week-${String(week).padStart(2, "0")}.csv`;
  let log;
  try {
    log = git(root, "log", "--reverse", "--format=%H\t%aI", "--", rel).trim();
  } catch {
    return [];
  }
  if (!log) return [];
  const out = [];
  const base = mkdtempSync(join(tmpdir(), "proj-hist-"));
  try {
    for (const line of log.split("\n")) {
      const [hash, date] = line.split("\t");
      let text;
      try {
        text = git(root, "show", `${hash}:${rel}`);
      } catch {
        continue;
      }
      const dir = join(base, hash.slice(0, 10), "projections", String(season));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `week-${String(week).padStart(2, "0")}.csv`), text);
      const snapshot = loadSnapshot(join(base, hash.slice(0, 10)), season, week);
      if (snapshot) out.push({ date: new Date(date), snapshot });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  return out;
}

// The latest snapshot written at or before `time` (ms since epoch), or null.
export function snapshotAt(history, time) {
  let pick = null;
  for (const h of history) if (h.date.getTime() <= time) pick = h;
  return pick ? pick.snapshot : null;
}
