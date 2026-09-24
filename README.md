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

- **Yardage** (compared as raw totals): Pass Yards, Rush Yards, Rec Yards —
  graded from **3 projected opportunities** (24 in season scope), below which
  the bimodal point-mass-at-zero problem below applies. These are graded *as
  well as* the per-attempt rates, not instead of them, because the two answer
  different questions and the feed is far more confident about one than the
  other. A rate's Floor-to-Ceiling span is 17–37% of its median; a total's is
  roughly 100%. That makes the totals better calibrated (2026 within-band
  61/41/45% for pass/rush/rec yards, against 27/33/32% for the matching rates)
  and drawn from a larger sample, since a rate needs `MIN_EFF_VOLUME` on both
  sides. **Don't read the rate rows against a 50% coverage target** — their
  tightness is a design choice by the feed, not a miss. Use them to separate
  efficiency from volume, and the totals to judge accuracy.
- **Volume** (compared directly): Pass Attempts, Rush Attempts, Targets. Only
  graded when the **projected median is at least 1** (8 in season scope).
  Below about one expected event the band is degenerate — the floor sits above
  zero while zero is the modal outcome, so no integer can land inside it and
  the row is a miss whichever way it falls. On 2025, rows under that line were
  0.0% within-band when the actual was zero and 1.5% when it wasn't. Grading
  wide receivers on a median of 0.12 carries held Rush Attempts at 15.2%
  (WR 1.0% over 1,351 rows); with the floor it reads 32.1%, and Targets moves
  from 38.9% to 48.6% — a CI of [46.8, 50.4] that contains the 50% target.
  The floor looks only at the *projected* volume, never the actual: gating on
  the outcome would condition the sample on the thing being measured.
- **Efficiency** (compared as *rates*, never totals): each split's rate =
  that split's total / that split's volume.
  - Passing: Yards/Att, Completion %
  - Rushing: Yards/Att
  - Receiving: Yards/Target, Catch Rate
- **Touchdowns** (compared as a *probability*): **not** graded in the metric
  table above — neither as per-attempt/per-target rates nor as raw counts.
  Both framings fail. A TD is a near-binary event and a floor–median–ceiling
  band cannot contain the modal outcome of zero, so a within-band number
  measures the frame rather than the projection. Measured on 2025: the
  projected floor sits above zero in 92% of receiving rows while 85% of them
  score nothing, which drags receiving-TD band coverage to **9.6%** against a
  50% target — an artefact, not a finding.

  Instead, each projected expected-TD count becomes a Poisson
  `P(≥1 TD) = 1 − e^−λ` and is scored against the binary outcome with a
  reliability curve, Brier skill and log loss. See the **Touchdowns** tab.

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
4. **Touchdowns** — TDs are rare count events (0/1/2 per game), so the band /
   error machinery the other tabs use is the wrong frame and they sit this one
   out entirely. This is the **only** place TDs are judged, and it treats them
   as a probability forecast:
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

## Calibration report (CLI)

```bash
npm run build:data && npm run calibration-report
```

The question the dashboard raises but doesn't answer: *the bands are off — by
how much, and should I do anything about it?* The report answers it in three
sections, and the third is the one that matters.

1. **Where each line actually sits.** Share of actuals at or below
   Floor/Median/Ceiling against the 25 / 50 / 75% they claim to be, with a
   z-score and a `noise` / `suggestive` / `solid` verdict. Thresholds are
   deliberately conservative — the report runs three thresholds across every
   metric, so 2-sigma readings turn up by chance.
2. **How far each line would have to move.** The multiplier putting a line
   exactly on target, with a 95% bootstrap interval. An interval spanning 0% is
   not an adjustment. It also counts **inversions** — rows where applying all
   three multipliers would push a line past its neighbour, which any real
   implementation has to clamp.
3. **Whether that move survives data it wasn't fitted to.** Fit on the early
   weeks, score on the later ones. This exists because section 2 is
   self-fulfilling: a fitted multiplier hits 25/50/75 on its own data by
   construction. Early in a season most corrections make held-out weeks
   *worse*. Only ship the ones that improve here.

Options: `--scope weekly|season`, `--metrics a,b`, `--split N` (weeks to fit
on), `--boot N`, `--seed N`, `--fantasy`, `--json`. The bootstrap is seeded, so
two runs on the same data give identical intervals and the output can be
diffed.

> **It never rewrites a projection**, by design. The dashboard reports the
> upstream feed's calibration; a band corrected in the measurement layer would
> report the correction instead. A multiplier that survives section 3 belongs
> in the betting path — see the reasoning already written up in
> `scripts/lib/calibration.mjs`, which found that for the low-volume case a
> variance multiplier can't help at all, because the real distribution is
> bimodal and widening a normal doesn't reconstruct a point mass.

## Team-level analysis

```bash
npm run build:data && npm run calibration-report -- --scope team
```

Offence-wide totals per team-week: the projections summed across the whole
roster against the actuals summed the same way. Four metrics — **Total TDs**,
**Pass Attempts**, **Rush Attempts**, and **Pass Rate** (pass ÷ (pass + rush)).

Three things here are easy to get wrong, and all three are verified against
2026 rather than assumed:

- **Combined TDs are `PassTD + RushTD`, never all three columns.** A passing
  TD and the receiving TD that caught it are the same touchdown — summed
  `PassTD` and summed `RecptTD` are identical in all 64 team-weeks. Adding
  `RecTD` too would inflate every team by its entire passing game.
- **Pass Rate has no band.** It's a ratio, and the ceiling split raises pass
  *and* rush attempts, so the ratio of the ceilings isn't the ceiling of the
  ratio. The "floor" rate came out *above* the "ceiling" rate in 61 of 64
  team-weeks. It ships `banded: false` and is graded on the median alone; the
  report omits it from every band section rather than printing a meaningless
  number.
- **A team band is our construction, not the feed's.** The feed publishes a
  band per player and none for a team. Summing player floors assumes everyone
  has his worst game simultaneously (too wide); adding variances assumes
  independence (too narrow when one player dominates). Neither wins
  everywhere — measured within-band against a 50% target:

  | | summed quantiles | added variances |
  |---|---|---|
  | Total TDs | 53.1% | 29.7% |
  | Pass Attempts | 64.1% | 62.5% |
  | Rush Attempts | 70.3% | 45.3% |

  So the bands are the straightforward summed quantiles, and **point accuracy
  of the median is the primary read** — that one is well defined, since a sum
  of medians is a fair estimate of the median of the sum with no correlation
  assumption. Coverage is reported as a flagged secondary.

> **Caveat — the two sides aren't the same roster.** The projection feed covers
> more players than the actuals do: a median of 16 per team-week against 10 in
> 2026, and 30 against 13 in the legacy CSVs. The extras are bench players
> projected near zero, so the 2026 tilt is small (mean error −0.31 pass
> attempts, +0.33 rush). On the legacy path it is not: projections run ~6.5
> pass attempts and ~6.2 rush attempts under actual, too large for bench noise.
> Treat legacy team totals as unverified.

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
volume, exclude-injury-suspect, and fantasy-relevant-only.

### Fantasy-relevant only

A checkbox restricting every view to players who were projected to matter:
**all QB, top 50 RB / 60 WR / 40 TE**, ranked within each week (or within the
season, in season scope). Thresholds live in `FANTASY_RANKS` in
`scripts/build-data.mjs` and are published in the dataset, so the UI label and
the CLI can't drift from the build.

The rank is by **projected** PPR, never actual. Ranking on what a player
actually scored would select the players who happened to have a good week —
conditioning the sample on the very outcome being graded, which inflates every
coverage number in the dashboard. Projected rank is information you had before
kickoff, so filtering on it is legitimate. Standard PPR scoring, computed from
the projected components rather than read from a feed column, so it works
retroactively on every snapshot already committed.

Players whose position wasn't known at build time are unranked and excluded;
the filter is opt-in, so leaving out the unknown is the conservative side. The
CLI report takes the same cut with `--fantasy`.

## Paper trading

The question this answers is not "did these bets win" but **"would these
projections help someone find bets?"** — and that depends on who is asking.

### The drop

Every **Tuesday morning** the pipeline publishes every prop where our
projection disagrees with a sportsbook by more than the edge bar, to
`data/edges/{season}/week-NN.csv`. That file is the product: what a subscriber
would receive. Everything downstream simulates people acting on it.

Tuesday is deliberate, and it cuts both ways. It is early enough that a
subscriber could still get the price — and it is the **softest line of the
week**, because books post early with low limits and sharpen toward kickoff. So
a healthy ROI measured against Tuesday prices cannot on its own separate "the
projections are good" from "we measured against a stale number". That is what
closing-line value is for.

### How the edge is computed

1. **Our probability.** Each player-week's Floor(25th)/Median(50th)/
   Ceiling(75th) projection becomes a full distribution: a **two-piece normal**
   for yardage, attempts, completions and receptions (preserving whatever skew
   the Floor/Ceiling spread implies rather than forcing symmetry), and a
   **Poisson** for touchdown and turnover counts.

2. **Market probability.** OpticOdds returns both sides where a book quotes
   them, so the price can be de-vigged into what the market actually believes.
   Roughly three quarters of player props are quoted one-sided, and those rows
   are flagged `OneSided` — no fair price can be derived from a single quote.

3. **Which books.** A **curated roster** — DraftKings, FanDuel, BetMGM,
   Caesars, BetRivers, Hard Rock, theScore and Circa — defined in
   `scripts/lib/books.mjs`.

   Deliberately not "every book available". The capture takes the best price
   across whatever it pulls, which is only meaningful among books you can
   actually bet at: a best price at a book with no account behind it is a
   return nobody could have earned, and best-of-N finds the most generous
   outlier by construction. The first live run showed the scale — active +
   onshore + NFL still left **86 books**, including bet99, betano and 888sport,
   because OpticOdds' `is_onshore` flag means *regulated*, not *US*.

   Names resolve against the live list, so `hardrock` finds whatever id the API
   uses (`hard_rock_bet`). A name matching nothing is reported loudly: an
   unrecognised book isn't an API error, it just returns no odds, which is
   indistinguishable from that book not pricing the week.

   `--books` overrides the roster; `--all-books` restores the unfiltered
   behaviour for research, and `--include-offshore` adds Pinnacle and friends
   when a sharper fair-price reference is the point.

4. **Two edges, answering different questions:**

   | | Formula | Answers |
   |---|---|---|
   | `Edge` | OurProb − **ImpliedProb** (raw) | *Does this bet make money?* |
   | `ModelEdge` | OurProb − **FairProb** (de-vigged) | *Do we know something the market doesn't?* |

   `Edge` selects bets, because the break-even probability at a price **is** its
   raw implied probability — at −110 you need 52.4%, not 50%. `ModelEdge` is the
   more interesting diagnostic but a trap as a filter: it is always larger, by
   about half the hold.

### The personas

Nobody tails four hundred edges a week. `scripts/lib/personas.mjs` defines
simulated bettors who differ on the dimensions that actually separate real
ones — **which books they can reach**, **how many bets they place**, **how they
choose**, **how they size**, and **whether their bankroll resets weekly or
compounds**.

| Persona | What it is |
|---|---|
| **The Firehose** | Every qualifying edge, flat 1u, all books. Not a person — the statistical benchmark. |
| **The Disciplined Flat Bettor** | 10 bets/week, 1u, DraftKings only, never two on one player. |
| **The Line Shopper** | Identical rules, all eight books. **The gap to the above is what line shopping is worth.** |
| **The Kelly Compounder** | Quarter-Kelly on a compounding bankroll, up to 25 bets, ranked by EV. |
| **The Weekly Budget** | 20u a week fully committed, split across the top ten in proportion to edge. |
| **The Purist** | Two-sided markets only, ranked by de-vigged disagreement. Tests whether de-viggable edges outperform. |

Ledgers land in `data/bets/{persona}/{season}/week-NN.csv` and are
**regenerated from scratch on every run** — a persona's ledger is a pure
function of (edges, actuals, rules), so changing a rule or adding a persona is
just a re-run, and replaying history is the same operation as running the
current week.

Two modelling choices worth knowing. Each persona collapses a player-stat to
**one** bet at the best price it can reach (you do not place the same wager at
five books), and `maxPerPlayer` stops correlated stacking — Over Rushing Yards
and Anytime TD on the same back win and lose together, so treating them as
independent overstates return and understates variance.

### Read the confidence band, not the ROI

This is the main way the analysis could mislead:

| Cohort | Bets/season | 95% band on ROI |
|---|---|---|
| The Firehose | thousands | ±1-2% — can detect a real edge |
| A 10-bet-a-week persona | ~180 | **±14%** — tells you almost nothing |

Every rollup ships an `evidence` block with its sample size and band, and the
dashboard labels anything too small to be conclusive. A persona's ROI shows
what a strategy would have **felt** like; only the benchmark can establish
whether the projections work.

### Closing line value

The measurement that does not depend on bets winning. `data/closing/` records
each game's last price before kickoff, captured daily (NFL games run Thursday,
Sunday and Monday, so no single weekly pull sits near all of them; each fixture
is recorded once, close to its own kickoff, and never overwrites the Tuesday
drop).

If the price we took consistently beats where the market closed, the
projections are reaching information before the market does. That is the
durable claim — and because CLV is a continuous measurement on every bet rather
than one bit of win/loss, it converges far faster than ROI.

A line that moves to a different **number** (Over 249.5 closing at 251.5) is
reported as a direction only. Converting a half-point into price terms needs a
model of what a half-point is worth for that stat, which we do not have and do
not invent.

### Pipeline

```
scripts/capture-props.mjs            Tuesday: publish data/edges/
scripts/capture-props.mjs --closing  daily: record data/closing/ near each kickoff
scripts/simulate-personas.mjs        replay every persona over the season
scripts/build-betting-data.mjs       aggregate into public/data/betting.json
```

```bash
export OPTICODDS_API_KEY=...

npm run capture-props                              # publish this week's edges
npm run capture-closing                            # record closing lines
npm run simulate                                   # replay all personas
npm run simulate -- --persona kelly --dry-run      # one persona, no writes
```

| Workflow | When (UTC) | What |
|---|---|---|
| `ingest-weekly.yml` | daily **13:00** | RotoWire projections + actuals, the player roster, then replays personas |
| `props-weekly.yml` | **Tue 14:00** | The drop: publish edges, replay personas |
| `closing-lines.yml` | daily **15:00** | Record closing lines for games kicking off soon |
| `optic-discover.yml` | manual | Inspect what the OpticOdds API returns |

The hour between ingest and the drop is load-bearing, not cosmetic. The NFL
week rolls forward on Tuesday (`projectionWeek()` looks two days ahead), so the
drop needs week N+1 projections — and Monday's ingest only wrote week N. They
are created by the run immediately before it. Starting both together races, and
the capture fails with *"No projections snapshot"*.

All three data-writing workflows also share one `concurrency` group. They each
`git add data/` and push to the same branch, so two at once means the second
push is rejected; and because scheduled runs can be delayed by GitHub for many
minutes, clock separation alone is not a guarantee. Each commit step
additionally rebases and retries, since every one of them only ever *adds* data
files — rebasing onto whatever landed first is always the right resolution.

`data/legacy-bets/` holds the pre-rework ledger; see the README there.

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

The projection feed carries both receiving volumes, and they are easy to
conflate: **receptions** are `offrecatt`, **targets** are `offtargets`. Plus
receiving yards and TDs. `TARGET_FIELD` in `scripts/lib/rotowire.mjs` names the
one field read — deliberately a single confirmed key rather than a list of
candidate spellings, since resolving guesses by order would silently read the
wrong column if RotoWire ever adds a similarly-named field.

`scripts/ingest.mjs` counts targets **per split** and warns if any split comes
back empty. Median is served by `weekly-projections.php` while Ceiling and
Floor come from `projections-ceil-floor-weekly.php`, so one endpoint can carry
targets while the other doesn't — and a metric needs all three splits, so a gap
in C or F disables the target metrics even with a complete Median.

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

> **Note — projected targets:** the endpoints now project targets, so the
> Targets column is filled from the feed and the target-denominated metrics
> (Targets volume, Rec Yds/Target, Catch Rate) run for ingested weeks. Weeks
> snapshotted *before* the feed carried targets keep a blank column and skip
> those metrics.
>
> **Repairing an older week —** `--only backfill-targets --week N`:
> re-fetches that week and fills its Targets column. Where the feed has also
> **revised** another column since the snapshot was frozen, the fetched value
> wins and overwrites the frozen one.
>
> That overwrite is a deliberate trade. These endpoints are forward-looking, so
> a value re-served for a past week may have been recomputed with information
> that did not exist before kickoff, and those cells stop being strictly
> pre-game. An earlier version refused the whole week on any such difference,
> which in practice meant no targets at all: on 2026 week 1 the feed had moved
> 50 values out of ~24,600 (0.2%), all small (`5.35 → 5.02`, `1.06 → 1.02`) and
> none in the passing volume columns. Taking that drift to get the targets is
> the better deal — and the pre-refresh snapshot stays recoverable from git
> history.
>
> Every overwrite is reported: the run prints how many values moved, a
> per-column tally and the first few examples. **Read that output** — it is the
> only signal that a week's calibration baseline has shifted.
>
> Rows the feed has dropped keep their blanks; rows the feed has added are
> ignored, because a snapshot of a finished week should not quietly gain or
> lose players. A column the feed has stopped sending is left at its frozen
> value rather than blanked. Run it from the **Ingest weekly** workflow's *Run
> workflow* button (choose `backfill-targets` and set the week), where the
> network and `ROTOWIRE_COOKIE` are already in place — one week per run.
>
> **Overriding the feed's targets:** `normalizeProjections(feeds, { season,
> week, targetsByPlayer })` accepts an optional `Map` keyed by RotoWire
> `playerid` whose value is either a single number (applied to every split) or
> a per-split object `{ M, C, F }`. It takes precedence over the feed value and
> anything absent from it falls back to the feed, so it can patch a partial
> feed or replace it wholesale. Fetch that source in `scripts/ingest.mjs` and
> pass the map through (search for `TARGETS_SOURCE`).

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
