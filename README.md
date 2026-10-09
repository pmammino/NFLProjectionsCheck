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

3. **Which books.** **Two curated rosters**, defined in
   `scripts/lib/books.mjs`, because *"which books do I price against?"* and
   *"which books can I actually bet at?"* are different questions:

   | | | |
   |---|---|---|
   | **Bettable** | DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock, theScore, Circa Sports | the only prices that reach `data/edges/`, a persona, or the best-price comparison |
   | **Reference** | Pinnacle | captured and priced, **never staked** — it exists to sharpen the fair-value consensus |

   These were one list until the split, and that conflation forced a false
   choice. Pinnacle's de-vigged price is the best available estimate of a true
   probability, so you want it in the consensus — but it is also a book most
   subscribers cannot reach, so a ledger that takes its price books a bet
   nobody could have placed. Separated, both are satisfiable at once. Every
   row in `data/props/` carries a `Bettable` column, so an archived capture
   can be re-read without knowing the roster of the day.

   Adding reference books is close to free: `/fixtures/odds` takes 5
   sportsbooks per request, so a roster of 8 and one of 10 both cost two book
   batches per fixture batch.

   Deliberately not "every book available". The capture takes the best price
   across whatever it pulls, which is only meaningful among books you can
   actually bet at: a best price at a book with no account behind it is a
   return nobody could have earned, and best-of-N finds the most generous
   outlier by construction. The first live run showed the scale — active +
   onshore + NFL still left **86 books**, including bet99, betano and 888sport,
   because OpticOdds' `is_onshore` flag means *regulated*, not *US*.

   Names resolve against the live list, so `hardrock` finds whatever id the API
   uses (`hard_rock`, as of the 2026 runs). A name matching nothing is reported
   loudly: an unrecognised book isn't an API error, it just returns no odds,
   which is indistinguishable from that book not pricing the week.

   A name matching *two* books is reported too, and that one has bitten us —
   see the `sharp` market set under **Pricing lines** for how `"circa"` went
   ambiguous and silently left the roster. Prefer an exact id over a prefix
   for any book whose operator might list more than one feed.

   `--books` overrides the **bettable** roster only — naming your own accounts
   should not silently also discard the sharp reference the model is judged
   against. `--reference-books` changes the other list and
   `--no-reference-books` drops it. `--all-books` restores the unfiltered
   behaviour for research.

   > `--include-offshore` only ever applied to `--all-books`; on the curated
   > path it did nothing, silently. It now says so. That silent no-op is part
   > of why the starved `sharp` market set was first misdiagnosed as "offshore
   > books were not requested" when the real cause was Circa dropping out of
   > the roster.

4. **Two edges, answering different questions:**

   | | Formula | Answers |
   |---|---|---|
   | `Edge` | OurProb − **ImpliedProb** (raw) | *Does this bet make money?* |
   | `ModelEdge` | OurProb − **FairProb** (de-vigged) | *Do we know something the market doesn't?* |

   `Edge` selects bets, because the break-even probability at a price **is** its
   raw implied probability — at −110 you need 52.4%, not 50%. `ModelEdge` is the
   more interesting diagnostic but a trap as a filter: it is always larger, by
   about half the hold.

   Both of these treat the market purely as a yardstick. For the other
   question — using the books' prices as an *input* to our own, and scoring the
   result with Brier and log loss — see **Pricing lines** below.

### The live backtest — the only one worth reading

```bash
npm run backtest-live                   # prints the report
npm run backtest-live -- --write        # data/backtest/{season}/live.md + live.json
```

`.github/workflows/backtest-weekly.yml` regenerates it every Tuesday morning and commits
`data/backtest/{season}/live.md`. It refreshes the actuals first, re-runs the persona replay (the
report reads the ledgers), then reports.

**Only the captures taken at the time count** — the Tuesday, Thursday and Saturday drops. A
backfilled board (opening, closing) is a reconstruction with hindsight in it, in two ways: each
book's "opening" price is its first-ever price, posted at a different moment, so one book's first price
against another's later first price looks like an edge nobody could have seen; and it is priced from
the week's *final* projection, which has read everything since. On the 2026 backfills the pool's ROI
was +19.5% on the opening board and +7.4% on the closing one, and none of that is a trading result.
Backfills are excluded by slot (`--live-slots` changes the list); a "live" file that contains anything
but live rows is flagged in the report.

What it prints:

1. **Boards** — what each live capture contained: rows, markets, books, Pinnacle rows, how much was
   one-sided, which price it was captured under.
2. **Pricing on live boards** — Brier of the book, the projection and the pool against what happened,
   near the money, clustered by player-week.
3. **Bets** — the Firehose (every bettable edge of at least 3%, one unit, best price) by week and slot:
   settled and pending bets, ROI with a two-sigma band, ROI if every no-stat-line over lost, and CLV.
4. **The same boards under the other price** — boards captured on the projection price re-priced with
   the pool as it would have stood that week, and boards captured on the pool re-priced with the
   projection, through the same persona engine. The two directions are separate questions and are not
   added together.
5. **Every persona**, live only.
6. **Can you read it?** — how many settled bets it takes to see an effect of that size.

Most of it will be noise for a long time, and the report says so. A one-unit bet returns a standard
deviation of roughly 2 units (longshots pay a lot), so a **5% ROI takes about 8,000 settled bets** to see
at two sigma, and the report refuses a verdict under 200. CLV resolves much faster because it is a price
difference rather than a coin flip, but it is partly mechanical (a slow book's off-market price stays
off-market until the close). Pending bets in a finished week have no stat line — for an over, almost
always a loss the settlement cannot see, because the actuals feed omits all-zero rows — so the report
shows ROI with those counted as losses alongside the ledger's.

As of 2026 week 5 it has 119 settled live bets (+22.2% ±41%, "too few to say"), the projection price on
five Tuesday boards and the pool on one Thursday board. Re-priced with the pool, the five projection-priced
boards leave **12 bets where the projection price left 227**: the pool finds almost nothing at the edge bar
on a Tuesday board.

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

### When the board actually exists — slots

The Tuesday drop above is one sample of the market per week, taken at one
hour. Measured against what the same week looked like near kickoff, that hour
catches very little of it:

| | Tuesday drop | near kickoff | |
|---|---|---|---|
| Week 2 | 1,544 markets / **15** of 16 games | 18,692 / 16 | **8%** of the board |
| Week 3 | 2,559 markets / **3** of 16 games | 62,590 / 16 | **4%**, 13 games never seen |

Books post player props game by game through the week, so on Tuesday most of
the board does not exist yet. Two-sided quotes — the only ones that can be
de-vigged into a fair price — go from 51% of the Tuesday board to 74% near
kickoff, which is why so much of `data/props/` is flagged `OneSided`.

The obvious fix, moving the drop later, would throw away something real. Those
Tuesday prices **beat the close by +5.25%** across 45 player-weeks, a 70% beat
rate. Early genuinely is softer, exactly as claimed above. Both facts hold at
once: Tuesday has the best prices and almost none of the board.

So a week can now be captured **more than once**, and each capture writes into
its own **slot** (`scripts/lib/slots.mjs`):

```
data/props/2026/week-03.csv             main     — the Tuesday drop
data/props/2026/thursday/week-03.csv    thursday — the midweek sweep
data/props/2026/saturday/week-03.csv    saturday — the late-week sweep, on a same-day projection
data/props/2026/t-48h/week-03.csv       t-48h    — a backfill reconstruction
```

`main` keeps the original paths, so every committed file and every existing
reader is untouched. Both drops publish edges, the personas bet both — the
dedupe then picks the better price across them, as a subscriber holding both
would — and every row carries a `Slot` column that the ledgers and the
`bySlot` rollup split on. Pooling two sourcing times into one ROI would
destroy the only comparison that decides which one to keep.

> **Read `bySlot` with one caveat.** A persona's dedupe keeps the single best
> price per player-stat across *every* slot, so each bet is attributed to the
> slot whose price won. That makes the per-slot ROI a statement about which
> slot tended to carry the best number, not an independent trial of each slot —
> picking the maximum across slots is a winner's curse by construction. The
> clean comparison of slots is `board-timing` and the per-slot table in
> `price-model`, which score each capture on its own.

| Workflow | When (UTC) | Slot |
|---|---|---|
| `props-weekly.yml` | Tue 14:00 | `main` — softest prices, thin board |
| `props-midweek.yml` | Thu 15:00 | `thursday` — full board, still pre-kickoff |
| `props-saturday.yml` | Sat 15:00 | `saturday` — the fullest board, on a projection written that morning |

Thursday 15:00 sits ~9 hours before Thursday Night Football, so **every** game
of the week is still bettable. Saturday catches the fullest board and, more to the
point, the freshest projection: after Friday's injury designations, with the week's
news read — which is when the projection has most to add (see *Why does the
projection earn so little?*). It costs the Thursday game, which has been played, so
a live capture **leaves out every game that has already kicked off** (a price from
one is not a price anyone could take) and the Saturday board is the Sunday-and-later
games. Which slot is actually better is a measurement, not an argument — see below.

**The Saturday job refreshes the projections first** (`ingest.mjs --only
projections`) rather than trusting the daily ingest, because scheduled runs are
routinely delayed by GitHub for hours and a "late-week" capture that quietly priced
Friday's snapshot would defeat the slot's purpose. If the refresh fails the capture
still runs, with a warning that the snapshot may be a day old.

**Its projection share starts at zero** and is fitted from the live Saturday
captures it writes, per stat, like every other slot: expect several weeks before it
moves, and until then a Saturday board is priced on the weighted books alone. It also
means the books' lead weights, which are assessed on every early board together,
mix a Saturday board (a day ahead of the close) with a Tuesday one (five days ahead).
That attenuates the leads a little and does not change their ranking; once there is
a few weeks of Saturday data it should be assessed per slot.

### Backfilling a past week

```bash
node scripts/capture-props.mjs --historical --at closing --season 2026 --week 3
node scripts/capture-props.mjs --historical --at T-48h  --season 2026 --week 3
```

`--at` reconstructs the board as of a chosen moment from OpticOdds' price
history. An offset like `T-48h` is resolved against **each fixture's own
kickoff**, never against a wall-clock time: NFL games run Thursday, Sunday and
Monday, so one absolute timestamp sits 24 hours from one game and 96 from
another and would compare prices at completely different stages of their own
markets.

A reconstruction defaults its slot to the moment it reconstructs, so it
**cannot overwrite the Tuesday drop**. That matters more than it looks: the
drop is the record of what a subscriber was actually sent, and it is the one
artefact in this repo that no later run can rebuild. Everything else —
ledgers, rollups, the dashboard dataset — is a pure function of the snapshots.

Run it from the **Backfill props** workflow, which takes a list of weeks and
carries on past a week that fails rather than discarding the ones that
succeeded. It is slow: the historical endpoint takes one fixture per request
and is rate-limited to 10 requests per 15 seconds.

> **What this project's key actually allows — measured, 2026-10-01.** A dry
> `--at T-48h` run over week 3, then a full `--at closing` backfill of weeks
> 1–4, settled it:
>
> | | |
> |---|---|
> | Historical odds endpoint | **works** — 16 fixtures, 123,464 odds returned |
> | `entries` price history | **absent** — 0 of 123,464 odds carried one |
> | `clv` (closing) on player props | **patchy** — 86% of week 3, 0% of week 4 |
> | `olv` (opening) on player props | reliably present |
> | Usable moments | `--at opening`, `--at closing` only |
>
> **`--at` is strict about which endpoint it takes, and the backfill is why.**
> `historicalLineValue` falls back to the other endpoint when the requested
> one is missing, which is right for grading one bet and wrong for building a
> board. With the fallback on, one `--at closing` run produced a slot that was
> 86% closing lines in week 3 and **100% opening lines in week 4** — under one
> name, and mixed *inside* a single week, so a market's consensus could blend
> one book's closing price with another's opening price. That is a number
> belonging to no moment the market ever occupied, and it is invisible in the
> file: every row looks fine alone and only `LineSource` betrays it.
>
> So `--at closing` now means closing, a row with no closing price is **absent
> from that board**, and a capture that still ends up mixed says so loudly.
> `--allow-line-fallback` restores the old behaviour knowingly. Run each
> endpoint as its own slot. The first backfill, which mixed the two, was kept
> for a while as `closing-mixed` and has since been deleted: clean `opening` and
> `closing` slots replaced it, and left in place it pooled the same games a
> third time into every report. It is recoverable from git history (created in
> `f5d6066`).
>
> So the key has historical-odds permission and the retention window is fine;
> what it lacks is `include_timeseries`, which is a separate OpticOdds
> permission and the only way to reconstruct an arbitrary hour. Offsets return
> nothing and say so rather than substituting a different price — an opening
> line is not a T-48h line, and quietly swapping one for the other would
> answer the timing question with the wrong data.
>
> **Until that permission is added, `board-timing` can compare opening against
> closing but cannot tell you which hour to drop at.** Opening-vs-closing
> still answers something useful — how far the board moves across a week — it
> just cannot locate the point where coverage has arrived and the price has
> not yet sharpened.
>
> Note also that on this key `clv` comes back **null for player props** (it is
> populated on game markets only), so `--at closing` falls back to the opening
> line for most rows. The capture reports the share this happened to and
> records it in `LineSource`, so those rows stay a separate cohort rather than
> being pooled with live-captured ones. In practice that means an
> opening-vs-closing backfill may collapse into one cohort too; the run's
> `line values:` line is what tells you.
>
> The empty-result diagnostic distinguishes the two causes, because they need
> opposite fixes: "no odds came back at all" (permission, retention, books)
> versus "plenty came back and none covered the moment you asked for".

### Which slot to source from

```bash
npm run board-timing
```

Compares every capture of every week side by side — the live drops, any
backfilled reconstructions, and the daily near-kickoff capture as the ceiling
— on coverage (fixtures, players, markets), the two-sided share, the hold, and
where actuals exist the Brier score of both the market and our projection.

It deliberately does not pick a winner. Coverage and price quality pull in
opposite directions, and how much each matters depends on how many bets you
intend to place. What it removes is the guessing: a slot is worth moving to
when it gains enough coverage to matter *without* its prices having sharpened
away the edge, and the Tuesday drop's +5.25% closing-line value is the number
a later slot has to be weighed against.

Read the Brier columns next to the `clusters` column, never alone. Each slot
is scored only over the markets it actually saw, so a slot with a tiny board
is not being judged on the same bets as a full one.

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

### Line Pricer — look up the price of any bet or quoted line

The **Line Pricer** tab answers "what did we think this line was worth, and what
were the books saying?" for any player, stat and line in a captured board — not
only the ones that became bets. Search a player (accent-insensitive, matches
name words, team, or a name prefix), pick a stat, and the page shows:

- **The projection** — Floor / Median / Ceiling as frozen at the snapshot, and,
  where the median correction applies to that stat, the re-centred triple
  (tick *price off the median-corrected projection* to price with it).
- **A ladder of every quoted line** — our P(over), the market's P(over)
  (retail consensus, with the sharp-book number beside it where one quoted the
  line), our edge against the best *bettable* price, and the actual result once
  the game has been played. Expand a line for the per-book table: every book's
  over/under, bettable books first, reference books (Pinnacle) labelled and
  never offered as a price to take.
- **Which capture you are looking at** — Tuesday drop, Opening board, Closing
  board or Thursday sweep. They are different instruments: the same line is
  priced differently in each, so a line is never merged across them. The
  default is the fullest board for the week.

From **Paper Trading**, every row of the bet log has a **Price ▸** button that
opens the exact capture and line that bet was struck on.

Things the page will not let you misread:

- **`†` on a market price** means it was *inferred*: every book quoted only one
  side, so an assumed margin was stripped to get a probability. An unmarked
  price was measured from two-sided quotes. A "mixed" source is two-sided
  books with a one-sided one filled in; it is described in the tooltip.
- **Far-from-even lines are hidden by default** (market price outside 5–95%).
  They are real quotes but swamp the ladder and carry little information; the
  *Show N far-from-even* toggle brings them back. The line a bet was struck on
  is always shown.
- **Stale projections are flagged.** A Tuesday-drop line can be priced from an
  earlier projection than the snapshot shows; when the two medians differ by
  more than 0.05 the row says so rather than pairing mismatched numbers.
- **The corrected price is only shown when it is the honest one.** It appears
  only if the correction was applied for that stat as of that week, the
  capture itself was priced uncorrected, and recomputing the price reproduces
  the stored one.
- **A stale or mismatched data file is refused**, with a message telling you to
  rebuild, rather than rendered. Files are versioned (`LINES_SCHEMA`), and a
  test keeps the page's copy equal to the builder's.

#### Building the data

```bash
npm run build:lines                 # also runs on predev / prebuild
LINES_MAX_WEEKS=18 npm run build:lines
npm run build:lines -- --force      # ignore the cache
```

Output is `public/data/lines/` — one JSON per (week, capture) plus `index.json`,
generated and **not committed**. A full board is ~3 MB per capture (~0.5 MB
gzipped), so only the latest `LINES_MAX_WEEKS` weeks (default 6) are built and
older files are removed; raise it for a longer look-back. Total size depends on
how many captures exist; keep it in mind for the Vercel deploy limit. The
build is **incremental**: each file is keyed by a fingerprint of its capture,
that week's snapshot and actuals, every earlier week's (the correction is
fitted on them), and the builder's own source, and is skipped when none
changed. A fresh clone builds everything once (~1 minute); after that it is
seconds. The correction shown for week *N* is always fitted on weeks before *N*.

Other env: `SEASON`, `LINES_DATA_DIR`, `LINES_OUT_DIR`, `LINES_CACHE`.

The logic lives in two testable modules: `scripts/lib/lines-index.mjs` (the
builder: compaction, book aliasing, market-source tagging, corrected-price
checks) and `scripts/lib/lines-view.mjs` (client-safe arithmetic: best bettable
price, edge, player search, formatting), with `lib/lines.ts` holding the types.

### Pipeline

```
scripts/capture-props.mjs                 Tuesday: publish data/edges/ (slot main)
scripts/capture-props.mjs --slot thursday Thursday: the same, once the board exists
scripts/capture-props.mjs --slot saturday Saturday: the same, on a projection written that morning
scripts/capture-props.mjs --closing       daily: record data/closing/ near each kickoff
scripts/capture-props.mjs --historical --at T-48h
                                          rebuild a past board at a chosen moment
scripts/simulate-personas.mjs             replay every persona over every slot
scripts/build-betting-data.mjs            aggregate into public/data/betting.json
scripts/board-timing.mjs                  compare the slots — when to source
scripts/price-model.mjs                   score the projections AGAINST the books
                                          (Brier / log loss) — see Pricing lines
scripts/median-correction.mjs             is the projected Median in the right place?
scripts/source-weights.mjs                the books' weights and the projection's share
                                          of the price, as of each week
scripts/projection-miss.mjs               where, and why, the projection loses to the books
scripts/backtest-live.mjs                 the live-only backtest: ledger, pricing, counterfactual
scripts/build-lines-data.mjs              compact the captured board for the Line Pricer tab
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
| `props-weekly.yml` | **Tue 14:00** | The drop: publish edges (slot `main`), replay personas |
| `props-midweek.yml` | **Thu 15:00** | The second drop: the same once the books have posted the board (slot `thursday`) |
| `backtest-weekly.yml` | **Tue 12:30** | Refresh actuals, replay personas, regenerate the live backtest report (`data/backtest/`) |
| `props-saturday.yml` | **Sat 15:00** | The late-week drop: refreshes projections, then the same, leaving out games already played (slot `saturday`) |
| `closing-lines.yml` | daily **15:00** | Record closing lines for games kicking off soon |
| `props-backfill.yml` | manual | Rebuild a past week's board at a chosen moment |
| `optic-discover.yml` | manual | Inspect what the OpticOdds API returns |

The hour between ingest and the drop is load-bearing, not cosmetic. The NFL
week rolls forward on Tuesday (`projectionWeek()` looks two days ahead), so the
drop needs week N+1 projections — and Monday's ingest only wrote week N. They
are created by the run immediately before it. Starting both together races, and
the capture fails with *"No projections snapshot"*.

All the data-writing workflows also share one `concurrency` group. They each
`git add data/` and push to the same branch, so two at once means the second
push is rejected; and because scheduled runs can be delayed by GitHub for many
minutes, clock separation alone is not a guarantee. Each commit step
additionally rebases and retries, since every one of them only ever *adds* data
files — rebasing onto whatever landed first is always the right resolution.

`data/legacy-bets/` holds the pre-rework ledger; see the README there.

## Pricing lines (not just finding edges)

```bash
npm run price-model
```

Everything under **Paper trading** treats the projection as the price and the
market as the yardstick: `Edge = OurProb − ImpliedProb`. That framing can only
ask *do we disagree?*, and it answers with a number that is largest exactly
where our model is worst — because disagreement and error are the same
measurement whenever the market is right.

This report asks the other question. Given a player's Floor/Median/Ceiling
**and** what the books are charging, what is the best available estimate of
`P(actual > line)`? That is a forecasting problem with a ground truth, so it is
scored properly — Brier, log loss, reliability — instead of argued about via
ROI on a few hundred bets.

### The model

    logit(p) = a + c·logit(p_market) + b·[logit(p_proj) − logit(p_market)]

Three parameters, fitted by minimising log loss against realised outcomes:

| | Meaning | What to watch for |
|---|---|---|
| `b` | how much of our **disagreement** with the book to believe | `b = 0` says the projections add nothing on top of the market |
| `c` | how much the market is worth | expect ≈ 1; a de-vigged consensus is already calibrated |
| `a` | a global over/under tilt | on this data it is partly a **selection effect** — see below |

It is written in terms of the *difference* rather than the obvious
`a + b·logit(p_proj) + c·logit(p_market)` because the two predictors are badly
collinear — the projection and the market agree most of the time, which is
precisely when a regression cannot separate them. Fitted the obvious way,
passing yards came out at `b = −0.58` against `c = +2.18`: a pair that
reproduces the data, means nothing individually, and priced a near-certain
Over for any market the projection was confident was Under. The difference form
is close to orthogonal, so `b` is identified and reads directly as a shrinkage
factor on our own opinion.

Each stat gets its own `(a, b, c)`, because `calibration.mjs` establishes the
projections are *not* uniformly miscalibrated. Small stats are pulled toward
the global fit by a Gaussian prior **inside the likelihood**, at a strength
measured in observations (`--shrinkage-k`, default 200).

> That last detail is load-bearing and was got wrong first. Fitting each stat
> alone and then averaging its coefficients with the global ones assumes the
> per-stat fit is a noisy but finite estimate. On 17 near-separable passTD rows
> it is not: the own fit returned `b = −85`, and averaging that in at 8% weight
> still left `b = −6.6`, which priced Josh Allen Over 4.5 passing TDs at **53%**
> against a market price of 3.8%. Eight percent of a divergent number is a
> divergent number. A prior worth 200 observations cannot be moved far by 17
> rows however separable they are.

Logit inputs are winsorised to ±6 (≈ 0.25%/99.75%) so a fitted slope is never
applied outside the range it was estimated across.

### What "the market" means

Per book: de-vig the two-sided quote (`devig.mjs`). Across books: the **median
of the logits**, for the same reason `calibration.mjs` already takes a median —
one stale book should not drag the consensus.

Two definitions are fitted and reported side by side:

- **retail** — DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock,
  theScore, betr. The board you can actually bet, so a disagreement with it is
  a disagreement with a real price.
- **sharp** — Circa, Pinnacle and friends. Beating *this* consensus is the
  stronger claim. Pinnacle is now pulled on every capture as a **reference
  book** (above), so this set fills in from here on without any flag.

  It was starved until now, and the reason turned out to be a bug rather than
  a configuration choice: `books.mjs` asked for `"circa"`,
  which resolved fine until OpticOdds' live list gained a second Circa id.
  From then on it matched both `circa_sports` and `circa_vegas`, was reported
  ambiguous, and was **dropped from every capture** — visible in a week-3 run
  log as `7 of 8 requested` books. Circa is the only sharp book in the roster,
  so the set froze at the 114 markets captured in week 1, the last week before
  the id went ambiguous. The roster now names `circa_sports` exactly, so the
  set fills in as weeks land. `--include-offshore` adds Pinnacle on top.

**One-sided markets.** Roughly half the committed board is quoted one side
only, at every book that prices it — 100% of week 1, 52% of week 2, 39% of
week 3, 15% of week 4 as the capture widened. Cross-book
pairing — an Over at DraftKings against an Under at FanDuel — was the obvious
fix and buys **nothing**: across weeks 1–3 the number of markets where two
books quote opposite sides and no single book quotes both is exactly zero.
One-sidedness is a property of the market, not of the book.

So those rows are de-vigged against an *assumed* overround, `fair = raw/(1+H)`,
with `H` the median observed hold for that stat. That is defensible because the
measured hold barely moves — .0772 recYds, .0769 rushYds/passYds, .0693
receptions, .0652 completions/rushAtt — a 1.2-point spread across the whole
board. Every row records `probSource`, and the report scores `devig` and
`assumed-hold` rows separately. If they disagree, believe the measured one.

### Read the cluster count, not the row count

A week's capture is a handful of games' worth of alternate lines, not a broad
slate:

| Week | Gradable markets | Distinct players |
|---|---|---|
| 1 | 977 | 183 |
| 2 | 881 | **21** |
| 3 | 1,583 | **28** |

2026 week 3 is drawn from **three fixtures**; Lamar Jackson alone accounts for
309 quoted rows, Josh Allen for 137 of week 2's. Over 274.5 / 284.5 / 294.5
passing yards are not three observations about whether we price him correctly —
they are one quarterback having one game, and they resolve together.

Every comparison is therefore clustered on `(week, player)`, and the report
prints the naive `z` beside the clustered one so the size of that mistake stays
visible. On the first three weeks of data it was the difference between a finding and
nothing:

| blend vs. market, out of sample | |
|---|---|
| Brier difference | −0.00203 (negative = better) |
| naive z (2,464 markets) | **−2.51** |
| clustered z (49 player-weeks) | **−0.61** |

### Read the band, not the average

A Brier score pooled over every quoted line mostly measures how easy the board
is. Books quote a ladder of alternate lines around each player and most rungs
are lopsided: over 10.5 receiving yards for a player projected at 60 is a 98%
proposition that every model gets right. About two thirds of the out-of-sample
markets sit more than 0.25 from a coin flip, so the pooled score — and the
market's apparent +0.37 skill over the base rate — is carried by markets where
nobody is being asked to forecast anything.

The report therefore cuts every result by how close the **market's** price is
to 50/50 and headlines the **near-the-money** slice (within 0.25). Bands are
defined on the market's price, never ours and never the outcome: the market's
price is known before kickoff, so slicing on it is legitimate in the same way
ranking fantasy relevance on *projected* points is. Slicing on our own
probability would select the rows where we are most confident.

Cut that way, the gap lives where a bet is decided (2026 weeks 1–4, retail
consensus, 694 player-weeks, out of sample):

| band | share | blend − market | projection − market |
|---|---|---|---|
| coin flips (< 0.10) | 13% | +0.0021 | +0.0094 |
| near money (0.10–0.25) | 21% | +0.0015 | +0.0087 |
| lopsided (0.25–0.40) | 34% | +0.0008 | +0.0061 |
| extreme (≥ 0.40) | 32% | +0.0001 | +0.0017 |

Positive is worse than the market. Everything looks fine in the tails because
everything does.

### The verdict, as of 2026 week 4

Two comparisons, and conflating them is the easiest way to misread the whole
report:

| Comparison | Asks |
|---|---|
| blend vs. `marketRaw` | is our price better than the book's? |
| blend vs. `marketRecal` | do the **projections** contribute, or is the gain just a recalibration of the book? |

Near the money, out of sample, clustered by player-week:

| | diff | z |
|---|---|---|
| blend vs. market | +0.0017 | +1.77 |
| blend vs. recalibrated market | +0.0003 | +0.81 |
| **projection alone vs. market** | **+0.0090** | **+3.46** |

- **The raw projection is significantly worse than the book where it counts.**
  It also leans over: on main lines it averages 53.4% where the outcome rate is
  50.5%.
- **The blend does not beat the market**, and the fitted disagreement weight
  `b` is +0.04 and shrinking as training data grows (the per-fold skill goes
  −0.027, −0.006, +0.002). The blend is converging on "price off the book".
- **The sharp books are not better than the retail ones on main lines.** On
  the 6,552 markets both consensuses priced, retail 0.2492, sharp 0.2494 and
  the base rate 0.2500 are indistinguishable (z = 0.59), while the projection
  scores 0.2552 — worse than both.

So on current evidence the market, not the projection, is the better estimate
of a near-50/50 line, and the honest default is the one already in place:
price off the projection only where a guard says it is trustworthy, and treat
the blend as a research tool until `b` earns its keep. What would change that
is a fix for the over-lean, which is the most likely-fixable thing here, not
more model.

### One caveat that is not noise

`Dropped: no actuals` is a **bias, not missing data**. The RotoWire actuals
feed carries no all-zero rows — a player who dressed and recorded nothing in
every tracked stat is simply absent, indistinguishable from one who was
inactive (26.8% of week-1 prop players, 16.3% of week-2). Those are precisely
the player-weeks where the **Under** won, so dropping them conditions the
sample on the outcome and pushes the observed over-rate up. It is visible in
the fitted intercept (`a = +0.33`), and applying that tilt to week 3 moves the
median edge from −3.2% to +0.6% and takes rows clearing the 3% bar from 1,057
to 1,401 — i.e. it would manufacture 344 over bets out of a data artefact.

Fixing it needs a played/did-not-play source, which this project does not have.
Until then the intercept carries a selection effect as well as any real market
tilt and should not be shipped into a live price on its own. `capture-props`
warns whenever it loads a fit with `|a| > 0.1`.

### The projected "Median" is too high for rushing and receiving yards

```bash
npm run median-correction
```

The projection's tilt against the book is not spread evenly. Near the money
it prices `recYds` overs **+5.7 ± 0.6** points above the book and `rushYds`
overs **+5.0 ± 1.1**, and the passing stats not at all. (A tilt against the
*outcome* is much noisier — in the coin-flip band it is +2.4 ± 3.3, inside its
own error — so the claim rests on the comparison with the book, where the
measurement is tight.)

The cause is the middle of the band. Floor/Median/Ceiling are treated as the
25th/50th/75th percentiles; for these two stats the "Median" is not the 50th.
Across every player-week in 2026 weeks 1–4:

| stat | P(actual ≤ M) — should be 50% | sum(actual) / sum(M) | median(actual / M) |
|---|---|---|---|
| `rushYds` | **63%** (z = 5.5) | 0.95 | 0.80 |
| `recYds` | **56%** (z = 3.7) | 1.05 | 0.88 |
| `passYds` | 50.4% | 1.00 | 0.99 |

A middle value that is right on average but too high as a median is what the
expected value of a right-skewed stat looks like, so that is the working
explanation. **It is inferred from the pattern, not checked against RotoWire's
own definition.** It is not the low-volume problem `calibration.mjs` already
guards: only 6–9% of those rows are zeros, and `rushYds` sits at 60–65% below
its median in every third of projected volume.

#### What the correction does

Each of F, M, C is rescaled by the multiplier that puts it on its target
quantile (`kF` is the 25th percentile of `actual / F`, `kM` the 50th of
`actual / M`, `kC` the 75th of `actual / C` — the same fit
`calibration-report` section 2 prints). Three rules keep it honest:

1. **Allowlist.** Only `rushYds` and `recYds` are eligible. A significance test
   alone is not enough, and the data showed why: on the week-3 refit `passAtt`
   cleared the z bar (2.5), and applying it took near-the-money Brier from
   0.2332 to 0.2472 — worse, because there was no bias, only a noisy week.
2. **Significance.** Within the allowlist a correction applies only on at least
   100 player-weeks with `|z| ≥ 2.5`. As of week 2 neither stat qualifies; both
   do from week 3, which is correct behaviour for a season that has not yet
   produced the evidence.
3. **No look-ahead.** A fit is "as of" a week and reads only weeks *strictly
   before* it. Pricing week W with a multiplier that had seen W's result would
   be grading with the answer in hand, and a backfill of an old week is exactly
   where it would sneak in. It is the same loader for a live Tuesday capture and
   a `--historical` one.

The median multiplier is bounded to [0.5, 1.5] and refused outside it; the
floor and ceiling multipliers get a looser [0.25, 2.0]. That asymmetry is a fix,
not a tidy-up: `recYds`' floor multiplier came out at 0.48 when fitted on week 1
alone, and a single shared bound refused the whole correction on it, although
the median multiplier was a stable 0.83–0.86 — the noisiest of three numbers
vetoing the most reliable one.

The fitted multipliers have been stable as weeks arrived (`recYds` `kM`
0.83 → 0.85 → 0.84; `rushYds` 0.95 on one week of data, then 0.79, 0.79), and the
corrections that apply improve held-out weeks in `calibration-report` section 3
(`rushYards` error 29 → 4) while the passing corrections make them worse.

#### What it does and does not buy

Out of sample, near the money (weeks 2–4, each priced with a fit that saw only
earlier weeks, scored on the frozen-snapshot slots):

| | Brier | vs the book | z |
|---|---|---|---|
| raw projection | 0.2357 | +0.0083 | +3.34 |
| corrected | 0.2338 | +0.0063 | +2.87 |
| the book | 0.2275 | | |

It closes **about a quarter of the projection's gap to the market**. By stat,
`recYds` goes 0.2369 → 0.2343 (book 0.2310) and `rushYds` 0.2309 → 0.2274 (book
0.2199); `passYds` is untouched at 0.2395 against the book's 0.2261, and that
is the largest gap on the board with no bias to remove. The rest is not a tilt a
multiplier can fix — the projection carries less information than the book.
**Treat this as hygiene, not an edge.** Its practical effect is to stop
manufacturing over edges on two stats.

Read the report's "lean" against the *market's* row, not against zero: the
observed over-rate leaves out players who recorded nothing, which are the
unders, so every price reads low against it.

The Tuesday `main` slot is not scored here. Its stored prices came from an
earlier projection snapshot than the frozen one (8,401 of its 10,944 rows differ
from a re-pricing by more than 0.001, by up to 0.95), so re-pricing it would
compare two projections; the report excludes and names those rows rather than
dropping them quietly.

#### Turning it on

```bash
npm run capture-props -- --price-model projection --median-correction auto
```

**It is off by default**, because it changes what the Tuesday drop publishes
and that is a decision, not an upgrade. When on, the capture prints the as-of
fit it used, and every priced row records the multiplier in a `MedianAdj`
column (blank = uncorrected), carried through to the ledgers. It prices the
projection on its own, so it cannot be combined with the default `pool` — whose
projection share was earned by the uncorrected projection — nor with
`--price-model blend`, which was fitted on uncorrected probabilities and would have
its input changed without refitting. `price-model` says so when it finds a mix.

The `Proj` column and the support floors still use the **raw** projected
median. They ask whether a player is projected for a real role, which is a
statement about the feed, not about the shape of the outcome.

### The books as the pricing guide, with the projection alongside

```bash
npm run source-weights                 # the books' weights and the projection's shares, as of each week
npm run projection-miss                # where, and why, the projection loses to the books
npm run capture-props                  # prices with the pool (the default)
npm run capture-props -- --price-model projection   # the long-standing projection-only price
```

**This is now the default price.** `OurProb` is a weighted average of every book,
with the projection taking whatever share of the price it has earned. Both halves
are fitted on earlier weeks only, for the week being priced, from the committed
captures — nothing to refit and nothing that can go stale. `ProjProb` records what
the projection alone said on every row, because after re-pricing `OurProb` no
longer is.

#### What it does to the ledger — read this first

On the 2026 Tuesday boards, rows clearing the 3% edge bar:

| week | projection price | pool |
|---|---|---|
| 3 | 1,057 | **7** |
| 4 | 4,203 | **3** |
| 5 | 4,176 | **6** |

Almost every edge the projection-only ledger found was the projection disagreeing
with a price that already carried the week's news, and a disagreement with the
market is not an edge. What survives is stale outliers: a book out of line with
the weighted rest, bettable after its margin. Expect few or no persona bets from a
Tuesday drop. That is the pool working, not failing — but it makes the paper
ledger a test of line shopping until the projection has earned a share. `--price-model projection`
restores the old behaviour in one flag.

#### The books: weighted by how much their early prices led the market

The median gave a one-sided Hard Rock quote exactly as much say as a two-sided
Pinnacle one. Every book is instead assessed on one question:

> When this book disagreed with the rest of the market at the open, how much of
> that disagreement had the rest of the market adopted by the close?

That is a regression slope (`lead`, through the origin, errors clustered on
player-week) of *where the other books went* on *where this book started*. It is a
weight and not just a correlation: if the best estimate of the closing price is a
weighted average of the early sources, the coefficient on one source in a
regression of the future market on it is exactly its share of the total weight.
It needs no outcomes — one price per market rather than one coin flip — so a few
weeks are enough where a Brier score would need a season. Two details carry the
result: **the book is left out of its own target** (otherwise a frozen price
"leads" by agreeing with itself), and **a source is a book and whether it quoted
both sides** (a one-sided quote has an assumed margin stripped from it, and is a
noisier statement from the same book).

2026 weeks 1–4, 93,141 early/closing market pairs; weights after four weeks:

| book | lead | z | weight |
|---|---|---|---|
| Pinnacle (two-sided) | 0.88 | 19 | 0.72 |
| BetMGM | 0.58 | 13 | 0.47 |
| Circa | 0.48 | 3.4 | 0.37 |
| theScore | 0.42 | 4.9 | 0.36 |
| Caesars | 0.39 | 8.3 | 0.34 |
| DraftKings | 0.27 | 5.9 | 0.25 |
| BetRivers | 0.21 | 3.6 | 0.19 |
| **Hard Rock** (two-sided) | **0.08** | 2.5 | 0.09 |
| **FanDuel** (two-sided) | **0.04** | 0.4 | 0.06 |

Pinnacle, BetMGM and Circa open close to where the market ends up; Hard Rock and
FanDuel open off the pack and then correct. Hard Rock is the most extreme book in
about 40% of markets and carries by far the most volume, so under the median it
pulled the consensus the most while telling it the least. A book with no record
keeps a prior weight (0.15); evidence outweighs the prior at 150 player-weeks.

**The weights are per stat.** A book's lead is not one number. On receptions the sharp
books lead hard (Pinnacle 0.99, Circa 1.05, BetMGM 0.73) and the retail books barely do
(Caesars 0.10, DraftKings 0.18, Hard Rock −0.04); on receiving yards the retail books
lead almost as much as the sharp ones (0.59–0.70 against 0.64–0.76). One weight per book
averages the two and is wrong for both. So each (stat, book) has its own lead, pulled
toward that book's *global* weight by the same prior (`fitStatWeights`): a stat with
little data prices like the global model and departs from it only as evidence arrives.
Out of sample (every week priced with weights fitted on earlier weeks) the per-stat
weights predict a sharp book's close better than the global ones: against Pinnacle MSE
0.0165 → 0.0160 (z −3.6), against Circa 0.0112 → 0.0109 (z −2.3), and by stat most on
receptions. Against outcomes they make no detectable difference (Brier −0.00002, z −0.9),
as with the global weights. `npm run source-weights` prints the leads by stat (§2b).

These weights describe an **early** board — Tuesday or Thursday, hours to days
before kickoff. At the close the books agree with each other and there is nothing
left for them to lead. And **live Tuesday captures carry no Pinnacle yet** (0 rows
in week 5): the weights come from backfilled opening boards, so on a Tuesday drop
the pool is the weighted retail books and the largest weight above does not apply.

#### The projection: a share of the price, per stat and per slot

```
logit P(over) = L_books + share · (L_projection − L_books)
```

`share` is 0 for "ignore the projection" and 1 for "believe it over the books", and
it is **fitted against outcomes**, per stat and per capture slot (a Thursday
projection is not a Tuesday one), on live captures only. The books' yardstick is
the wrong one for it: "did the market later move toward it" asks whether a source
is *ahead* of the market, and a projection written daily and read on Tuesday can
only be behind — on that test it scores 0.01 (z 0.4), and the test cannot tell a
projection with nothing to add from one that is merely late. At the moment of the
price the question that can be answered is how much of the price should come from
it.

- **Point in time.** A backfilled board is priced from the week's *latest*
  snapshot, written days later. Against it the market appears to follow the
  projection by **8%** (z ≈ 10); against the snapshot from the start of the week,
  **0.8%** (z ≈ 2). The first is the projection having caught up with the
  market, not leading it. Only live captures count, via `ProjProb`.
- **No credit on account.** A share starts at zero, is pulled toward zero by a
  prior worth 150 player-weeks, is marked down by one standard error (a couple of
  dozen cells and a few weeks each means the best-looking one is partly luck), is
  floored at zero and capped at 0.75. A cell with no live data prices on the books
  alone. Votes are bounded to within 1.5 logit points of the books, so a
  projection that is confidently far from the market cannot repeat the passTD
  failure above.

On the live Tuesday captures so far every share is inside its own error bar, so
every share *used* is zero and the pool is currently the weighted books. **That is the honest state and
it will move on its own** as captures accumulate — particularly on a later-week
capture, where the research below says the projection has something to add.

#### Why does the projection earn so little? (`npm run projection-miss`)

Four candidate causes, tested separately on weeks 2–4 against the book at the same
moment (near the money, clustered by player-week):

| | what it tests | result |
|---|---|---|
| **Timing** | the projection is read before it has settled | **the largest cause.** Gap to the closing book: **+0.0178** on Tuesday's snapshot → **+0.0073** on the last snapshot before the game. The projection improves every day. It is *not* shown to be news the books priced: the Tuesday gap is as large where the book barely moved after the open (+0.0194) as where it moved a lot (+0.0145). What improves is the projection, not a reaction to the market |
| **Spread** | the band is too narrow, so it is overconfident | **second.** Widening the band 1.75× on the pre-kickoff snapshot takes +0.0073 → +0.0041; 2.5× on Tuesday's takes +0.0178 → +0.0119. The projection's probabilities sit too far from a coin flip given how much it differs from the book |
| **Tails** | the far tails are too thin | **negligible.** A Student-t with the same quartiles moves the gap by ≤ 0.0003. The tail miscalibration is real (where the projection says 2% over, the book and the outcomes say 9–12%) but it is few rows at small Brier weight and not where a bet is decided |
| **Location** | the middle is in the wrong place | rushing and receiving yards only; closes about a quarter of the gap (see the median correction above) |

What remains after a fresh snapshot and a wider band is stat-specific. Receptions
and rushing attempts end level with the book. Receiving yards ends close
(+0.0013). **Passing yards is the outlier** (+0.010 even after repairs, and
*negative* share against outcomes): the books know more about quarterbacks —
weather, matchup, pace, a defence's coverage — than the feed does.

So **no, the problem is not that the books have many prices and we have one**; it
is that the projection is worse early in the week than late, and we read it on Tuesday. With a
fresh snapshot the projection earns a share of the price on the volume stats —
fitted against outcomes it is **0.53 ± 0.46 on receptions** (z 2.3), 0.25 on
receiving yards, ~0 on rushing yards and negative on passing yards. With Tuesday's
snapshot it earns about nothing anywhere.

Two consequences. **Capture later**: the Saturday sweep (`props-saturday.yml`)
exists for this — a projection written that morning, after Friday's injury report —
and each slot earns its own share as live data arrives; the Thursday one is the
midpoint and Tuesday's is the baseline. And the
spread result says the projection's band is a poor description of its own
uncertainty *relative to the book* — a stand-alone fix for that, fitted as of a
week like the median correction, is the obvious next piece if the projection is to
be used on its own.

Caveats on all of this: three or four weeks; several cells with a couple of hundred
player-weeks each; the share of 0.53 is one of about twenty cells, which is why
shares are marked down by an error bar before use. The timing result rests on the
daily snapshots in git history and so needs a full clone (`git fetch --unshallow`).

> **A caveat on the earlier sections.** `price-model` and `median-correction` score
> the projection using the frozen (latest) snapshot. That snapshot is more
> informed than the Tuesday one, so those comparisons *flatter* the projection.
> The conclusion — that it is worse than the market near the money — survives
> that advantage, and would be at least as strong on point-in-time data.

#### Does the weighting work?

| test | result |
|---|---|
| Pool of the **retail** books at the open vs. **Pinnacle's own close** (a price neither the pool nor its weights saw) | MSE 0.0174 → 0.0165, **z −3.9** |
| The same against **Circa's** close | 0.0108 → 0.0112, z +1.4 — no gain |
| Brier vs outcomes, weighted books vs retail median (14,582 markets) | −0.00003, z −0.4 — no difference |

The weighting predicts where the market goes; that is established for Pinnacle's
close and **not** for Circa's, and the Pinnacle result is partly circular
(Pinnacle's later prices are part of what the weights were trained to follow). It
does **not** improve the Brier score against outcomes — at this sample size
nothing could be shown either way. The result is "does no harm".

Pool- and blend-priced rows are **not projection prices**. Nothing may fit a model
on `OurProb` or assess the projection from it: `buildSamples` and the source
assessment read `ProjProb`, refuse a re-priced row that does not carry one
(`isProjectionPrice`), and `price-model` reports how many it set aside. The pool
cannot be combined with `--median-correction auto` (the projection's share was
earned by the uncorrected projection).

### Using it in the betting path

The report changes nothing by itself. To price off the blend:

```bash
npm run price-model -- --write          # fits and writes data/pricing/{season}/model.json
npm run capture-props -- --price-model blend
```

`--price-model` defaults to `pool` (see above); `projection` is the long-standing
Floor/Median/Ceiling price and `blend` the fitted one. Every captured row carries
a `PriceModel` column, so an archived ledger can always say which model priced the
bet, and a `ProjProb` column with what the projection alone said.

The repricing runs as a pass over all candidates (like the disagreement cap),
because a consensus is not a property of any single quote. Two invariants it
maintains: only the Over is blended and the Under is set to its complement, so
the two sides cannot drift into arbitrage against ourselves; and a market with
no consensus keeps its projection price rather than being dropped or silently
defaulted to the book.

### Options

```
--season <y>         season to read (default: latest with captures)
--market-set <s>     retail | sharp | all | both        (default: both)
--stats <list>       comma-separated stat keys          (default: all bettable)
--devig-method <m>   multiplicative | additive | power | shin
--shrinkage-k <n>    per-stat sample worth half the global fit (default: 200)
--min-books <n>      drop markets quoted by fewer books (default: 1)
--include-retired    include bet:false markets (anytimeTD)
--write              persist the fit to data/pricing/{season}/model.json
--json               emit the analysis instead of tables
```

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

`predev`/`prebuild` also run `build-betting-data.mjs` (Paper Trading) and
`build-lines-data.mjs` (Line Pricer, see above); both write generated,
uncommitted files under `public/data/`.

## Deploying to Vercel

1. Push this repo to GitHub (the two CSVs live at the repo root and ship with it).
2. Import the project in Vercel — framework auto-detected as **Next.js**.
3. No env vars needed. The `prebuild` script regenerates the dataset during
   Vercel's build, so updating projections/actuals is just: replace the CSV,
   commit, redeploy.
