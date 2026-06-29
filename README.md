# NFL Projection Accuracy Dashboard

A live dashboard that compares projected **Floor / Median / Ceiling** ranges to
**actual** results for every player-week, focused on whether the *inputs* to the
projections (volume + efficiency) actually reflect how results play out.

Built with **Next.js (App Router) + Tailwind + Recharts**, deployable to
**Vercel** with zero config.

## What it measures

The projections file gives a Ceiling (`C`), Median (`M`), and Floor (`F`) per
player-week, where **Floor = 25th percentile** and **Ceiling = 75th percentile**
outcomes. So a well-calibrated projection should see actuals land **inside the
band ~50% of the time**.

Per the project requirements, stats are split into:

- **Volume** (compared directly): Pass Attempts, Rush Attempts, Targets.
- **Efficiency** (compared as *rates*, never totals): each split's rate =
  that split's total / that split's volume.
  - Passing: Yards/Att, Completion %, Pass TD/Att
  - Rushing: Yards/Att, Rush TD/Att
  - Receiving: Yards/Target, Catch Rate, Rec TD/Target

> Passing INT efficiency is **not** graded — the actuals file has no INT column.

### Position relevance (requirement #4)

Stats are only evaluated when reasonable for the player's position:

- **QB** → passing + rushing (not receiving)
- **RB / WR / TE** → rushing + receiving (not passing)

Efficiency rates additionally require a minimum volume on **both** the projected
and actual side (default 3) so a 1-carry, 20-yard fluke doesn't distort Y/A.

### In-game injury handling (requirement #3)

There is no snap-count data, so true in-game injuries can't be isolated. As a
proxy, a player-week is flagged `inj?` when the player was projected to carry a
real role (median primary volume above a position threshold) but recorded almost
nothing (actual below half the Floor and below 40% of the Median). This also
catches benchings/ejections — hence it's a *flag* with a toggle to exclude,
not a hard filter. Players inactive *before* a game simply have no actual row
and never produce a false comparison.

## The views

1. **Calibration** — per-metric within-band hit rate vs. the 50% target, plus a
   Below / Within / Above breakdown, median bias vs. projection, and mean error.
   This is the fastest read on whether an input is well-calibrated, too narrow,
   or biased.
2. **Coverage & Intervals** — deeper calibration:
   - **Reliability diagram** — empirical P(actual ≤ Floor / Median / Ceiling)
     vs. the nominal 25 / 50 / 75% targets. Pinpoints *where* a projection is
     miscalibrated (e.g. unbiased median but a too-low ceiling).
   - **Sharpness** — mean band width (a band can cover well but be uselessly
     wide).
   - **Winkler interval score** and **pinball loss** — proper scoring rules for
     the central interval and per-quantile forecasts (lower is better).
   - **Point accuracy of the median** — RMSE, MAE, WAPE, Spearman rank
     correlation (does it get the *ordering* right?), and the OLS slope of
     `actual ~ median` (target 1.0; <1 ⇒ projections too extreme).
3. **Conditional** — where calibration breaks down: within-band & median
   coverage **by week** (season trend), **by projection-magnitude tier**
   (quartiles — are studs vs. low-projected players handled differently?), and
   **by position**.
4. **Projected vs Actual** — scatter of projected Median vs. actual for any
   metric, with a `y = x` reference line; offset from the line reveals
   systematic input bias.
5. **Player-week detail** — sortable table with a visual Floor–Median–Ceiling
   band and where the actual landed, for drill-down.

All views respond to filters: position, week range, team, minimum actual
volume, and exclude-injury-suspect.

## Data join

The two CSVs use different player-ID schemes. They are joined on:

```
actual_games.csv  .ID   ===  weekly_projections.csv  .PlayerID
```

(4,508 player-weeks match across the 2025 season.)

## Local development

```bash
npm install
npm run dev      # predev rebuilds public/data/dashboard.json from the CSVs
```

Open http://localhost:3000.

## How the data is built

`scripts/build-data.mjs` reads the two CSVs from the repo root, pivots
projections into C/F/M per player-week, joins to actuals, computes every
volume/efficiency comparison with the relevance + injury rules above, and writes
a compact `public/data/dashboard.json`. It runs automatically on `predev` and
`prebuild`, so the generated JSON is **not committed** — it's always rebuilt
from the source CSVs.

## Deploying to Vercel

1. Push this repo to GitHub (the two CSVs live at the repo root and ship with it).
2. Import the project in Vercel — framework auto-detected as **Next.js**.
3. No env vars needed. The `prebuild` script regenerates the dataset during
   Vercel's build, so updating projections/actuals is just: replace the CSV,
   commit, redeploy.
