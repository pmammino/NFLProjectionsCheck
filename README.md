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
   - **Brier score (exceedance)** — proper score over the Floor/Median/Ceiling
     exceedance forecasts (implied probabilities 0.75/0.50/0.25). Lower is
     better; the best achievable with these fixed probabilities is ≈ 0.208.
   - **95% Wilson confidence intervals** on every coverage proportion —
     summary cards flag when a target (e.g. 50%) lies *outside* the interval
     (a statistically significant miscalibration), and the reliability diagram
     draws CI whiskers on each point.
3. **Conditional** — where calibration breaks down: within-band & median
   coverage **by week** (season trend), **by projection-magnitude tier**
   (quartiles — are studs vs. low-projected players handled differently?), and
   **by position**. Magnitude bars and the position table carry 95% Wilson
   confidence intervals so apparent differences can be read as real or noise.
4. **Touchdowns** — TDs are rare count events (0/1/2 per game), so a continuous
   rate band is the wrong frame. This tab treats them as a rare-event forecast:
   - **Expected vs. actual TDs** — player-weeks binned by projected TD count,
     comparing mean projected to mean observed (assumption-free; the binary
     noise averages out).
   - **Scoring-probability reliability** — each projection converted to
     P(≥1 TD) via Poisson, plotted against the empirical scoring rate with CIs.
   - **Brier score, log loss, and Brier skill** vs. a base-rate baseline, plus
     projected-vs-actual season TD totals.
5. **Projected vs Actual** — scatter of projected Median vs. actual for any
   metric, with a `y = x` reference line; offset from the line reveals
   systematic input bias.
6. **Player-week detail** — sortable table with a visual Floor–Median–Ceiling
   band and where the actual landed, for drill-down.

Every tab carries a collapsible **plain-English explainer** describing what the
view shows, how to read it, and what you can learn.

## Weekly vs. Season-long scope

A top-right **Weekly / Season-long** toggle switches the entire dashboard
between two datasets:

- **Weekly** — per-game projections vs. weekly actuals (`weekly_projections.csv`
  + `actual_games.csv`), one row per player-week.
- **Season-long** — full-season projections vs. season totals
  (`season_projections.csv` + `actual_season_stats.csv`, joined on
  `NFLNewsID` ↔ `PlayerID`), one row per player.

All analysis tabs work in both scopes. Scope-specific differences:

- Week-range and injury controls are hidden in season scope; the volume sliders
  scale up to season totals.
- The Conditional tab drops its by-week chart in season scope.
- The Touchdowns tab judges the projected TD **count** (MAE, rank correlation,
  expected-vs-actual calibration, season totals) instead of the per-game
  binary "scored ≥1 TD" reliability, which carries no information over a full
  season (nearly every real player scores at least once).

All views respond to filters: position, week range, team, minimum actual
volume, and exclude-injury-suspect.

## Live weekly ingestion

As the season runs, projections and actuals are pulled straight from RotoWire's
JSON feeds and saved as **committed per-week snapshots** — no more hand-uploaded
CSVs.

### Feeds

Projections (Floor / Median / Ceiling), keyed by RotoWire `playerid`:

| Split  | Endpoint |
| ------ | -------- |
| Median | `weekly-projections.php?pos=QBRBWRTE&week=N` |
| Ceiling| `projections-ceil-floor-weekly.php?pos=QBRBWRTE&week=N&ceilFloor=C` |
| Floor  | `projections-ceil-floor-weekly.php?pos=QBRBWRTE&week=N&ceilFloor=F` |

Actual stats, keyed by RotoWire `pid` (the **same** id space as `playerid`, so
projections and actuals join with no crosswalk):

`player-stats.php?view={passing|rushing|receiving}&type=basic&scoring=standard&season=YYYY&timeperiod=N&pergame=totals&endweek=N&position=ALL`

The three stat views are merged per player (a QB's passing + rushing, a back's
rushing + receiving) into one actual row.

The projection feed's receiving volume is **receptions** (`offrecatt`), plus
receiving yards and TDs. It does **not** project a target count, so the Targets
column is left blank until a separate targets source is supplied (see below).

### Snapshots & persistence

`scripts/ingest.mjs` fetches a week, normalizes it into the exact
`weekly_projections` / `actual_games` column schemas, and writes:

```
data/projections/{season}/week-NN.csv    # Floor/Median/Ceiling rows
data/actuals/{season}/week-NN.csv        # merged passing+rushing+receiving
```

These snapshots are committed and become the durable record.

**Projections refresh daily.** RotoWire keeps revising a week's numbers as
injuries and other context land right up to kickoff, so the projection snapshot
is re-pulled every day and **replaced whenever it changes** (identical re-pulls
are a no-op — no commit churn). This keeps every comparison anchored to the most
up-to-date pre-game forecast. Because the projection endpoints take a `week` but
no `season` (they only serve the current season), the daily run targets the
**upcoming/in-progress** week and rolls forward to the next week once that week's
games finish — so a completed week's snapshot then stays frozen at its last
pre-game state. A `--force`-overridable guard refuses to let a week-rollover or
partial feed shrink an existing snapshot.

**Actuals** take `season`+`week`, so they can be (re)fetched and are rewritten to
absorb stat corrections.

```bash
npm run ingest                                           # auto: refresh proj + fetch actuals
npm run ingest -- --season 2025 --week 1                 # both, one explicit week
npm run ingest -- --only actuals --season 2025 --week 1  # just actuals (backfill)
npm run ingest -- --dry-run                              # fetch+parse, write nothing
npm test                                                 # verify mapping + week math
```

### Automation

`.github/workflows/ingest-weekly.yml` (all overridable via **Run workflow**):

- **Daily** — refresh the current week's projections; commits only when they
  changed.
- **Tuesday** — capture the completed week's actuals after Monday night.

Schedules are gated to the season months (Sep–Feb). If the feeds require a
session, set a `ROTOWIRE_COOKIE` repo secret.

> **Note — post-kickoff refreshes:** snapshots are per player-week, so a player
> whose game kicks off early (e.g. Thursday) can still have that week's row
> refreshed later the same week. In practice RotoWire's numbers settle before
> games and the change guard keeps rows stable; strict per-game freezing would
> require a game-schedule source.

> **Caveat — projected targets:** these endpoints project receptions, not
> targets, so the **target-denominated** metrics (Targets volume, Rec
> Yds/Target, Catch Rate, Rec TD/Target) are skipped for ingested weeks until a
> separate targets source is wired in. Projected receptions/yards/TDs and all
> passing & rushing metrics run normally.
>
> **Wiring a targets source:** `normalizeProjections(feeds, { season, week,
> targetsByPlayer })` accepts an optional `Map` keyed by RotoWire `playerid`
> whose value is either a single number (applied to every split) or a per-split
> object `{ M, C, F }`. Supplying it fills the Targets column and re-enables all
> four receiving metrics — no other changes needed. Fetch that source in
> `scripts/ingest.mjs` and pass the map through (search for `TARGETS_SOURCE`).

## Data join

Live snapshots join projections `PlayerID` ↔ actuals `ID` (both the RotoWire
player id) on `{player, week}`. The legacy 2025 CSVs used two different id
schemes bridged by a crosswalk column:

```
actual_games.csv  .ID   ===  weekly_projections.csv  .PlayerID
```

(4,508 player-weeks match across the legacy 2025 season.)

## Local development

```bash
npm install
npm run dev      # predev rebuilds public/data/dashboard.json from the CSVs
```

Open http://localhost:3000.

## How the data is built

`scripts/build-data.mjs` pivots projections into C/F/M per player-week, joins to
actuals, computes every volume/efficiency comparison with the relevance + injury
rules above, and writes a compact `public/data/dashboard.json`. It runs
automatically on `predev` and `prebuild`, so the generated JSON is **not
committed** — it's always rebuilt from source.

**Source resolution:** if `data/projections/*` snapshots exist, the weekly
dataset is built from them (targeting the latest season present, or `SEASON=…`);
otherwise it falls back to the legacy root CSVs (`weekly_projections.csv` +
`actual_games.csv`), so the dashboard keeps building before any ingest has run.
`meta.dataSource` in the JSON records which path was used. The Season-long scope
still reads `season_projections.csv` + `actual_season_stats.csv`.

## Deploying to Vercel

1. Push this repo to GitHub (the two CSVs live at the repo root and ship with it).
2. Import the project in Vercel — framework auto-detected as **Next.js**.
3. No env vars needed. The `prebuild` script regenerates the dataset during
   Vercel's build, so updating projections/actuals is just: replace the CSV,
   commit, redeploy.
