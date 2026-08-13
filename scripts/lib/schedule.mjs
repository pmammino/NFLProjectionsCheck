// Pure date → NFL-week helpers used by the ingest CLI. Kept separate (and
// side-effect free) so the heuristics can be unit tested without touching the
// network. Explicit --week always overrides these.

// NFL Week-1 kickoff (the Thursday opener) per season. Add new seasons here so
// the scheduled ingest can resolve a week with no manual input.
export const SEASON_START = {
  2024: "2024-09-05",
  2025: "2025-09-04",
  2026: "2026-09-10",
};

export const DAY_MS = 86400_000;

// The season a date belongs to. The season spans Sep–Feb, so Jan/Feb dates
// belong to the prior calendar year's season.
export function seasonForDate(d) {
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// Best-effort NFL week for a date, clamped to 1..22 (18 regular + playoffs).
// Week N's window runs Thursday→Wednesday.
export function currentNflWeek(season, d) {
  const start = SEASON_START[season];
  if (!start) return 1;
  const startMs = Date.parse(start + "T00:00:00Z");
  const week = Math.floor((d.getTime() - startMs) / (7 * DAY_MS)) + 1;
  return Math.min(22, Math.max(1, week));
}

// The week to (re)project on a given day. During a week's game days (Thu–Mon)
// this is that week; from Tuesday it rolls to the NEXT week, whose games are now
// the upcoming ones — so the daily refresh never overwrites a finished week's
// frozen snapshot. (Shifting +2 days moves Tue/Wed into the next Thu–Wed window.)
export function projectionWeek(season, d) {
  return currentNflWeek(season, new Date(d.getTime() + 2 * DAY_MS));
}
