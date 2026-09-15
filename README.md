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

- **Weekly** — per-game projections vs. weekly actuals, one row per player-week.
- **Season-long** — season-to-date projections vs. season totals, one row per
  player.

> **Season-long is disabled until the season is complete.** A running-total
> grade mid-season is noise, so the toggle is greyed out until a full slate of
> weeks (18) has been ingested. When it unlocks it is built by **aggregating the
> live weekly snapshots** into per-player season totals (summed projections and
> actuals) and grading those — there is no separate season projection feed. On
> the legacy fallback path (no live snapshots) it shows the complete 2025 season
> CSVs. Force it on/off for testing with `SEASON_LONG=on|off` at build time.

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

## Paper trading

A **Paper Trading** tab compares our own Floor/Median/Ceiling projections
against live sportsbook prop lines, tracking how a simple edge-based betting
strategy would have done — split by stat, by side, and by edge size.

**Odds come from [OpticOdds](https://developer.opticodds.com).** Projections
and actuals still come from RotoWire; only the odds source changed.

### How the edge is computed

1. **Our probability.** Each player-week's Floor(25th pct)/Median(50th)/
   Ceiling(75th pct) projection is turned into a full probability
   distribution, not just three points:
   - **Yardage/attempt/completion/reception props** use a **two-piece
     normal**: a normal distribution anchored at the Median whose lower half
     is scaled so its 25th percentile lands on Floor, spliced with an upper
     half scaled so its 75th percentile lands on Ceiling, joined continuously
     at the Median. This preserves whatever skew the Floor/Ceiling spread
     already implies, rather than forcing a symmetric distribution.
   - **TD & turnover-count props** (Anytime TD, Pass/Rush/Rec TD, INT) use a
     **Poisson** model off the projected median count — the same approach
     `lib/td.ts` already uses for the Touchdowns tab's scoring probability.
2. **Market probability.** OpticOdds is queried for every book it offers, for
   every market we model. It returns **both sides** of each market, which the
   previous RotoWire feed did not, and that unlocks two things the old
   pipeline could not do:
   - **A de-vigged fair price.** Raw implied probabilities on a two-way market
     sum to more than 1; the excess is the book's margin. Stripping it out
     recovers what the market actually *believes*. See
     `scripts/lib/devig.mjs` for the four methods available
     (`multiplicative` — the default — plus `additive`, `power` and `shin`;
     the last two correct the favorite–longshot bias and matter most on
     longshot props like Anytime TD).
   - **Betting unders.** A one-sided feed can only ever offer overs. Each
     market is now evaluated from both directions.

   Different books post different lines for the same player/stat, so every
   (book, line, side) combination is scanned and the best one is used.

   **Which books.** Only **active, onshore books that actually price the NFL**.
   That last filter matters for speed: `/sportsbooks` takes no league argument
   and returns several hundred books globally, so the NFL set is derived from
   `/markets` (which nests sports → leagues → sportsbooks) and intersected with
   the `is_active` / `is_onshore` flags. Pulling the unfiltered list would spend
   a request per 5 books per fixture batch on books that never quote an NFL
   game.

   Two caveats on `is_onshore`:

   - It's OpticOdds' own flag and means *regulated*, not specifically *US* —
     "888sport (Canada)" is flagged onshore too. For strictly the books you can
     personally bet at, `--books "DraftKings,FanDuel,..."` is the exact control;
     it bypasses every filter.
   - The sharpest books (Pinnacle above all) are **offshore**. This doesn't
     affect `Edge` — you can only bet what you can reach — but it does mean
     `ModelEdge` is measured against softer books, which makes "we disagree
     with the market" a weaker claim than it would be against Pinnacle.
     `--include-offshore` adds them back when that comparison is the point.

3. **Edge** — two numbers, which answer different questions:

   | | Formula | Answers |
   |---|---|---|
   | `Edge` | OurProb − **ImpliedProb** (raw) | *Does this bet make money?* |
   | `ModelEdge` | OurProb − **FairProb** (de-vigged) | *Do we know something the market doesn't?* |

   **`Edge` is what selects bets**, because the break-even probability at a
   price *is* its raw implied probability — at −110 you must win 52.4% of the
   time, not 50%. The vig is a cost actually paid, not an artifact to remove.

   `ModelEdge` is the more interesting diagnostic but a trap as a filter: it
   is *always* larger than `Edge`, by about half the hold, so selecting on it
   would clear a 3% bar on markets carrying no EV at all and then size them
   with Kelly as though they did. `--edge-basis novig` switches to it for
   research; treat the result as a study, not a ledger.

   A bet is placed when the selected edge clears `--min-edge` (default 3%).
   Markets where only one side is quoted can't be de-vigged, so `FairProb`
   falls back to the raw price and the row is flagged `OneSided`.
4. **Sizing.** Every bet that clears the bar is staked two ways, tracked in
   parallel so the edge-bucket analysis isn't confounded by stake size:
   - **Flat 1 unit** — clean for asking "does a bigger edge actually win
     more/pay more," independent of sizing.
   - **Quarter-Kelly, capped at 3 units** — a more realistic bankroll-growth
     view. 1 unit = 1% of bankroll (a Kelly fraction is bankroll-size-
     independent, so no bankroll amount is ever needed).

   A result landing exactly on a whole-number line is a **push**: the stake is
   returned, and it counts toward staked volume (so ROI is unaffected) but not
   toward the win-rate denominator. Half-point lines can never push.

### Pipeline

```
scripts/optic-discover.mjs  # one-off: print what the OpticOdds API actually
                             #   returns (books, markets, fixtures, raw odds
                             #   records beside our parse of them)
scripts/capture-props.mjs   # Wednesday AM: fetch lines, price vs. our model,
                             #   write data/props/{season}/week-NN.csv (every
                             #   price scanned) and data/bets/{season}/week-NN.csv
                             #   (the ones that clear --min-edge)
scripts/grade-bets.mjs      # daily, as actuals land: fills in Won/Lost/Push +
                             #   PnL for bets whose player's game has completed
scripts/build-betting-data.mjs  # predev/prebuild: aggregates the ledger into
                             #   public/data/betting.json (bet log + ROI/win-
                             #   rate rollups by stat, side and edge bucket)
```

```bash
export OPTICODDS_API_KEY=...                       # required

npm run capture-props                              # this week, auto season/week
npm run capture-props -- --season 2026 --week 1 --min-edge 0.05
npm run capture-props -- --season 2026 --week 1 --historical   # closing lines
npm run optic-discover -- --all                    # what the API actually returns
npm run capture-props -- --devig-method power --edge-basis novig  # research
npm run capture-props -- --include-offshore        # add Pinnacle et al.
npm run capture-props -- --books "DraftKings,FanDuel"   # exactly these
npm run grade-bets                                 # grade every week with a ledger
npm run grade-bets -- --season 2026 --week 1
```

Tracked stats: Anytime TD, Pass Yards, Pass Attempts, Completions, Pass TD,
Interceptions, Rush Yards, Rush Attempts, Rush TD, Receptions, Rec Yards, Rec
TD — each defined once in `scripts/lib/markets.mjs` (its OpticOdds market
aliases, its probability model, and the projection and actuals columns it maps
to). Market names OpticOdds returns that we don't model are counted and
reported at the end of a run rather than failing it.

### Backfilling a played week

`--historical` uses `/fixtures/odds/historical`, which returns each odd's
**opening** (`olv`) and **closing** (`clv`) line value directly — no scan of a
price series needed. Closing is used by default: it's the most informed price
the market produced and the one we could realistically have taken. The endpoint
only covers up to kickoff, so look-ahead bias is excluded at the source.
`--use-opening` grades against the opening line instead; the gap between the two
measures how far a line moved after posting.

**Backfilled props are OPENING lines, not closing lines.** OpticOdds returns
`olv` (opening) and `clv` (closing) per odd, but `clv` is populated only on
*game* markets. On a real week-1 pull it was present on 93-100% of moneyline
and half/quarter totals and on **0 of 122 player-prop odds**. So a backfilled
prop falls back to its opening price.

This matters for interpretation, not correctness. An opening line is softer —
the book has not yet absorbed sharp action — so a model backtested against it
looks better than it would have performed betting at close. Every row therefore
records a `LineSource` (`live` / `closing` / `opening`), the dashboard rolls up
`byLineSource`, and a run that falls back says so loudly. Treat backfilled
weeks as a separate cohort rather than pooling them with live-captured ones.

**Verify access before spending a week's requests.** A historical response can
come back as a valid fixture with an empty `odds` array — an unauthorized key,
a week past the retention window, and a book with nothing archived all look
identical. Check one fixture first:

```bash
curl -H "X-Api-Key: $OPTICODDS_API_KEY" \
  'https://api.opticodds.com/api/v3/fixtures/odds/historical?fixture_id=<ID>&sportsbook=BetMGM'
```

If `odds` is empty there, the backfill cannot work and the most likely cause is
that the key lacks historical-odds permission.

Because of that, **a run producing zero rows will not overwrite a populated
snapshot** — it refuses and says so. The files under `data/` are the durable
record of what we actually saw and can't be reconstructed once lost.
`--allow-empty` overrides it when clearing a week is genuinely intended.

Two further constraints make this slow and time-limited:

- **One fixture per request.** Unlike `/fixtures/odds` (5 fixtures, 5 books),
  the historical endpoint takes a single `fixture_id`. A 16-game week across 20
  books is 64+ requests at 10 per 15 seconds — budget a couple of minutes.
- **History is retained on a rolling 2-month window.** A week older than that
  can't be backfilled at any price, so backfilling is a deadline, not a task
  that waits.

### The player crosswalk

OpticOdds identifies players by name; the rest of this project is keyed on
RotoWire's `playerid`. `scripts/ingest.mjs` therefore writes
`data/players/{season}.csv` (PlayerID, Name, Team, Pos) — the projection feed
carries player names even though the projection *snapshot* schema drops them.

This matters more than it sounds, and the live feed is stranger than the docs
suggest:

- An odd has **no player-name field**. It carries `player_id` (an OpticOdds hex
  id) and `selection`, which holds the player on a prop. `name` is the full
  label (`"Tom Kennedy Over 0.5"`), so it is deliberately not used as a
  fallback — it would produce a key matching nothing.
- **Player props carry no team at all.** `team_id` is `null` on every one of
  them; it appears only on team markets. So the thing that separates two
  players sharing a name is the **fixture**: a prop belongs to one game, a game
  has two teams, and at most one namesake is usually in it.
- A player market can contain **team** entries — an Anytime-TD market includes
  `"Buffalo Bills D/ST"` rows. Those are dropped before the crosswalk sees them.

`scripts/lib/crosswalk.mjs` joins the two, matching in strict-to-loose tiers
(name+team → name league-wide → first-initial+surname+team), normalizing
punctuation, accents, generational suffixes and team-abbreviation variants
along the way. **It refuses to guess**: two different players sharing a key
report as ambiguous and are skipped, because a wrong join would price a bet
against the wrong player's projection and corrupt the ledger silently. Every
unmatched name is printed at the end of a capture run — a rising count there
means the roster snapshot is stale.

### Workflows

| Workflow | When | What |
|---|---|---|
| `ingest-weekly.yml` | daily, 13:00 UTC | RotoWire projections + actuals, and `data/players/{season}.csv` — **run this before the first capture**, the crosswalk needs it |
| `optic-discover.yml` | manual | Prints what the OpticOdds API actually returns. Run `markets` first: it prints OK/MISS per stat and is how a wrong market alias gets caught |
| `props-weekly.yml` | Wednesday ~12:00 UTC | The capture. Has a `dryRun` input that prices everything and writes nothing |

`.github/workflows/props-weekly.yml` needs the **`OPTICODDS_API_KEY`** repository secret;
`.github/workflows/ingest-weekly.yml`'s existing daily run grades pending bets
right after it refreshes actuals.

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

`.github/workflows/ingest-weekly.yml` runs **daily** during the season (Sep–Feb)
and ingests **both** projections and actuals (all overridable via **Run
workflow**):

- **Projections** refresh in place — the current week's snapshot is replaced
  whenever the numbers change (a no-op otherwise), targeting the
  upcoming/in-progress week and freezing once its games finish.
- **Actuals** re-pull daily too, so results appear as games complete through the
  week; each run targets the just-completed / in-progress week.

### Authentication — `ROTOWIRE_COOKIE` (required for full projections)

RotoWire returns only a **~top-10 preview** to unauthenticated requests and the
full slate (hundreds of players) only to a logged-in session. So the ingest
needs a session cookie, provided via the `ROTOWIRE_COOKIE` repo secret:

1. Log in to rotowire.com in your browser.
2. Open DevTools → **Network**, load a projections page, click the
   `weekly-projections.php` request, and copy the **`Cookie`** request header
   (the whole string).
3. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, name `ROTOWIRE_COOKIE`, paste the value.

The workflow already passes it to the ingest. If projections come back tiny, the
ingest logs a loud warning — that means the cookie is missing or expired (RotoWire
sessions expire periodically, so this may need refreshing).

### Authentication — `OPTICODDS_API_KEY` (required for odds)

All odds come from OpticOdds, which authenticates with an `X-Api-Key` header.
Set the key as the `OPTICODDS_API_KEY` repository secret (**Settings → Secrets
and variables → Actions**) and export it locally to run a capture by hand.
`scripts/capture-props.mjs` fails fast without it rather than writing an empty
ledger, and the workflow checks for it before running.

The key is only ever sent as a header, never as a query parameter, so it can't
leak into a logged URL or an error message.

Two API limits shape how a week is pulled, and `scripts/lib/opticodds.mjs`
handles both: `/fixtures/odds` accepts at most **5 sportsbooks and 5 fixtures
per request** (as repeated query params, not comma-joined), and the historical
endpoints are rate-limited to **10 requests per 15 seconds**. A full week is
therefore dozens of requests, issued through a sliding-window limiter with
jittered backoff on 429s.

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
