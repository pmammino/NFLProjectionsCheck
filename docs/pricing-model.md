# How the pricing works

Two readers in mind: the **plain English** sections say what is happening and
why you should or should not trust it; the **Stats** sections give the
mechanics precisely. Every number quoted is from 2026 weeks 1–4 and is out of
sample unless stated. Code references are in `scripts/lib/`.

---

## 0. The whole thing in one paragraph

**Plain English.** For every prop line a book offers ("Over 64.5 rushing
yards"), we want one number: *the chance the player goes over*. We have two
sources of opinion. One is our own projection (a low, middle and high guess for
the player). The other is the betting market itself — what a dozen sportsbooks
are charging. We turn each into a probability, and then ask: where we disagree
with the books, who has been right? So far the honest answer is **mostly the
books**. The pricing system exists to make that comparison rigorous, to protect
the paper-trading bets from our known weak spots, and to show, line by line,
what each source says (the Line Pricer tab).

**Stats.** The target is `P(Y > L)` for outcome `Y` and line `L`. We have
`p_proj` (from the Floor/Median/Ceiling), `p_mkt` (a de-vigged multi-book
consensus), and a binary realised outcome. The model is a penalised logistic
pool of the two, scored out-of-sample with Brier score and log loss against the
market as the baseline.

---

## 1. Turning a projection into a probability

### Plain English

A projection arrives as three numbers: a **Floor**, a **Median** and a
**Ceiling**. We treat them as the 25th, 50th and 75th percentile of what the
player might do — "one time in four he does worse than the floor, one in four
better than the ceiling, and it is a coin flip around the median." To price
"Over 64.5", we ask how much of that spread sits above 64.5.

Touchdowns and interceptions are different. They are rare, whole-number events
(0, 1, 2…), so there is no meaningful "spread" — we use the projected number of
touchdowns as an average rate and compute the chance of at least one, two, etc.

### Stats

**Continuous stats** (yards, attempts, completions, receptions) use a
**two-piece normal**. Two half-normals are joined at the median `M`, each with
its own scale:

```
σ_low  = (M − F) / z75        σ_high = (C − M) / z75        z75 = Φ⁻¹(0.75) ≈ 0.6745

P(Y > L) = 1 − Φ((L − M) / σ_low)    if L ≤ M
         = 1 − Φ((L − M) / σ_high)   if L > M
```

Using separate scales above and below `M` keeps whatever skew the F/C spread
implies (a running back's upside is usually longer than his downside) without
inventing a heavier-tailed model. A tiny floor on each scale
(`max(spread, 0.05, 1% of M)`) stops a zero-width band from becoming a step
function. `probability.mjs`.

**Count stats** (TDs, INTs): `Y ~ Poisson(λ)` with `λ` = projected median count;
`P(Y > L) = 1 − P(Y ≤ ⌊L⌋)` (lines are conventionally `k + 0.5`).

**What this assumes.** That F/M/C really are the 25/50/75th percentiles, and
that two half-normals are a good shape. The first assumption fails for rushing
and receiving yards (§6).

---

## 2. Turning betting odds into a "market probability"

### Plain English

A sportsbook's odds are not its honest opinion — they include a **margin** (the
"vig" or "hold"). If a book offers Over at −110 and Under at −110, the prices
imply 52.4% on each side, which adds to 104.8%. That extra 4.8% is the book's
cut. To recover what the book *believes*, we strip the cut out. We do that for
every book, then take the **middle value** (median) across books, so that one
stale or off-market book can't drag the answer.

Some lines are quoted on **one side only** (only an Over price exists). We
can't see the other side to remove the cut exactly, so we assume the book's
usual margin for that stat (about 6.5–7.7%, which barely varies) and strip that.
Every row is tagged so we can tell measured from assumed — the Line Pricer shows
assumed ones with a **†**.

### Stats

**De-vig, per book** (`devig.mjs`, default multiplicative). With raw implied
probabilities `r_o, r_u` from the two prices:

```
hold = r_o + r_u − 1
fair_over = r_o / (r_o + r_u)
```

**One-sided quotes** (`consensus.mjs: bookFairProb`): `fair = r / (1 + H)` where
`H` is the median *observed* hold for that stat (default 7% when none observed).
The share of the committed board quoted one-sided was 100%, 52%, 39% and 15%
in weeks 1–4 as the capture widened. Pairing an Over at one book with an Under at another
buys nothing: the number of markets where two books quote opposite sides and no
single book quotes both is exactly zero.

**Consensus across books**:

```
p_mkt = sigmoid( median_b [ logit(fair_b) ] )
```

- *Median* for robustness to one bad price.
- *Logit* because probabilities are compressed near 0 and 1 (2%→4% is a
  doubling of risk, 50%→52% is not), and every downstream model works in logits.
- One vote per book.
- `probSource` is `devig` only if **every** contributing book was two-sided,
  `assumed-hold` if none was, `mixed` otherwise — the weakest input sets the
  label.

**Two book sets.** *Retail* (DraftKings, FanDuel, BetMGM, Caesars, BetRivers,
Hard Rock, theScore, betr) is the board you can actually bet. *Sharp* (Circa,
Pinnacle) is the harder benchmark. Pinnacle is a **reference book**: it feeds
the consensus but is never offered as a price to take (§7).

---

## 3. Edge: what the paper-trading bets are based on

### Plain English

The simplest question is "do we think this is more likely than the price says?"
If the book's price needs a 52.4% chance to break even and we think it's 58%,
that's a 5.6-point **edge**, and (if it clears 3 points and the safety checks
below) a paper bet.

### Stats

```
Edge      = p_ours − r_implied     (raw, vig included)   selects bets
ModelEdge = p_ours − p_fair        (de-vigged)           diagnostic
```

`Edge` is the filter because the break-even probability at a price **is** its
raw implied probability. `ModelEdge` measures disagreement with what the book
believes, but is always larger by about half the hold, so as a filter it would
manufacture bets. Default minimum `Edge` is 0.03.

**Two guards** run before a bet is published (`calibration.mjs`):

1. **Support floor.** Skip markets where the model has been shown not to work:
   rushing/receiving yards lines below 2.5, or projected medians below
   3 (yards), 1 (rush attempts) or 0.5 (receptions). A near-zero projection
   makes the band meaningless.
2. **Market-disagreement cap (20 points).** If our probability differs from the
   *median* fair probability across books by more than 0.20, skip the market.
   Eight books don't misprice something by 40 points; that's our error. It is
   a backstop that turns an unbounded model failure into a skipped bet, not a
   model improvement. It is applied per **market**, not per book row — cutting
   row by row removes the best price while keeping a slightly tamer quote on a
   market we just declared untrustworthy.

Bets are then picked up by "personas" (flat bettor, line shopper, Kelly, …),
each collapsing a player-stat to one bet at the best price it can reach.

---

## 4. The blend: using the books as an input

### Plain English

Instead of only *comparing* ourselves to the books, we can *combine* us with
them. The question is how much of our disagreement with the books to believe.
If the projections really contain information the books lack, the combined
answer should be better than the books alone. If not, the model should learn to
ignore us and simply copy the books. The fitted answer is an honest scorecard
of how much our projections are worth.

### Stats

```
logit(p) = a + c·logit(p_mkt) + b·[ logit(p_proj) − logit(p_mkt) ]
```

| | Meaning | Reading |
|---|---|---|
| `b` | weight on **our disagreement** with the book | `b = 0` ⇒ projections add nothing |
| `c` | weight on the market | ≈ 1 expected; a de-vigged consensus is already calibrated |
| `a` | global over/under tilt | partly a selection effect (§8) |

**Why the difference form.** The "obvious" `a + b·logit(p_proj) + c·logit(p_mkt)`
has two nearly collinear predictors (they agree most of the time), so a
regression cannot separate them. Fitted that way passing yards gave `b = −0.58`,
`c = +2.18` — a pair that fits the data, means nothing individually, and priced
a near-certain Over for markets the projection was confident were Under. The
difference is close to orthogonal to `logit(p_mkt)`, so `b` is identified and
reads directly as a shrinkage factor on our own opinion.

**Estimation** (`pricing.mjs`). Penalised maximum likelihood by Newton/IRLS
(log loss is convex, so there is no local-minimum problem):

```
minimise  −Σ [ y·log p + (1−y)·log(1−p) ] + (λ/2)·‖θ − θ₀‖²
```

- The prior `θ₀ = [0, 1, 0]` is exactly "price off the book" — a fit that
  learns nothing returns the market unchanged, not something arbitrary.
- **Per-stat fits** `(a, b, c)` are pulled toward the global fit with a Gaussian
  prior *inside the likelihood*, worth `k = 200` observations. (Averaging
  separately-fitted coefficients after the fact failed: on 17 near-separable
  passTD rows the standalone fit returned `b = −85`, and even 8% of that
  priced Josh Allen over 4.5 passing TDs at 53% vs the market's 3.8%.)
- Logit inputs are **winsorised at ±6** (0.25%/99.75%) so a slope is never
  applied outside the range it was estimated on.
- **Only the Over is blended**; the Under is set to its complement, so the two
  sides cannot drift into arbitrage against ourselves. A market with no
  consensus keeps its projection price.

---

## 5. How we decide whether it works

### Plain English

Betting results on a few hundred bets are mostly luck, so we don't judge by
profit. Instead we treat each line as a forecast ("62% chance of Over") and
score forecasts on how close the stated chance was to what happened. A forecaster
who says 62% on many lines should see roughly 62% go over. The score is the
**Brier score**: the average squared gap between the forecast and the 0/1
outcome (lower is better; always saying 50% gives 0.25). We then ask whether our
forecasts beat the **books'** forecasts — the bar that matters.

Two traps we avoid:

- **Training on the test.** Each week is priced by a model fitted only on
  *earlier* weeks (walk-forward).
- **Counting one game as many.** Books quote a ladder of lines per player
  (274.5, 284.5, 294.5 passing yards). Those aren't three independent facts —
  one quarterback has one game and they all resolve together. We count each
  player-week as one unit.

### Stats

- **Proper scoring rules:** Brier `mean (p − y)²` and log loss, plus reliability
  (calibration) tables.
- **Walk-forward evaluation:** for week `W`, fit on weeks `< W`, score week `W`.
- **Cluster-robust inference:** paired Brier differences (model − market),
  clustered on `(week, player)`. The report prints naive and clustered `z` side
  by side. On weeks 1–3 the blend-vs-market difference had naive `z = −2.51`
  (2,464 markets) but clustered `z = −0.61` (49 player-weeks): the difference
  between a "finding" and nothing.
- **Near-the-money banding.** Most rungs of a ladder are lopsided (over 10.5
  receiving yards for a 60-yard projection is 98% and everybody gets it right),
  which flatters every pooled score. We therefore band by distance of the
  **market's** price from 50/50 (bands 0.10 / 0.25 / 0.40) and headline the slice
  within 0.25. Banding on the market's price is legitimate because it's known
  before kickoff; banding on *our* probability or the outcome would select the
  rows where we are most confident, or leak the answer.
- **Baselines:** base rate; projection recalibrated; market raw; market
  recalibrated. Comparing blend to *market recalibrated* separates "projections
  add information" from "we just recalibrated the book".

---

## 6. What we found

### Plain English

- Near the money, **our projections price worse than the books**, and it is not
  close to noise.
- The blend learned to mostly ignore us: its weight on our opinion is tiny
  (+0.04) and shrinking as data grows. It converges on "price off the book".
- The books' price isn't better when you move from retail to the sharp books on
  main lines — they agree.
- One specific, fixable flaw: our "Median" for **rushing and receiving yards**
  is too high — it behaves more like an average (pulled up by big games) than a
  true 50/50 point. A correction recovers about a quarter of the gap, and no
  more. Passing yards is the biggest remaining gap and has no tilt to remove; the
  projection just carries less information than the book.

### Stats

Near the money, out of sample, clustered by player-week (2026 wk 1–4):

| | Brier difference | z |
|---|---|---|
| projection alone − market | **+0.0090** | **+3.46** |
| blend − market | +0.0017 | +1.77 |
| blend − recalibrated market | +0.0003 | +0.81 |

Positive = worse than the market. The gap lives where bets are decided:

| band (market's distance from 50/50) | share | projection − market | blend − market |
|---|---|---|---|
| coin flips < 0.10 | 13% | +0.0094 | +0.0021 |
| near money 0.10–0.25 | 21% | +0.0087 | +0.0015 |
| lopsided 0.25–0.40 | 34% | +0.0061 | +0.0008 |
| extreme ≥ 0.40 | 32% | +0.0017 | +0.0001 |

Retail vs sharp consensus on main lines (6,552 markets priced by both): 0.2492
vs 0.2494, base rate 0.2500, `z = 0.59` — indistinguishable; the projection
scored 0.2552.

**Median bias in yardage stats** (`median-correction.mjs`). If M were the true
50th percentile, `P(actual ≤ M)` would be 50%:

| stat | P(actual ≤ M) | z | median(actual/M) |
|---|---|---|---|
| `rushYds` | 63% | 5.5 | 0.80 |
| `recYds` | 56% | 3.7 | 0.88 |
| `passYds` | 50.4% | – | 0.99 |

Right-skewed stats have a mean above their median, so an *expected-value* "Median"
would look like this. This is an inference from the pattern; it has **not** been
checked against RotoWire's own definition.

**Correction:** rescale each of F, M, C by the multiplier `k` that puts it on its
target quantile (`k_F` = 25th percentile of `actual/F`, `k_M` = 50th percentile of
`actual/M`, `k_C` = 75th percentile of `actual/C`). Safeguards: allowlist
(`rushYds`, `recYds` only — `passAtt` cleared the significance bar yet made
Brier worse, 0.2332 → 0.2472, because a noisy week is not a bias); significance
(≥ 100 player-weeks and `|z| ≥ 2.5`); **no look-ahead** (fit strictly on earlier
weeks); bounds `k_M ∈ [0.5, 1.5]`, `k_F, k_C ∈ [0.25, 2.0]` (looser for tails —
a noisy floor multiplier once vetoed a stable median one). Result, near the
money weeks 2–4:

| | Brier | vs book | z |
|---|---|---|---|
| raw projection | 0.2357 | +0.0083 | 3.34 |
| corrected | 0.2338 | +0.0063 | 2.87 |
| book | 0.2275 | | |

About a quarter of the gap closed; **hygiene, not an edge**. Off by default
(`--median-correction auto`); mutually exclusive with `--price-model blend`
because the blend was fitted on uncorrected projection probabilities.

---

## 7. Bettable vs reference books

### Plain English

"Which books tell us the truth?" and "which books can we actually bet at?" are
different questions. Pinnacle is among the best sources of true odds, but most
people can't bet there. So Pinnacle helps set the fair price but is never
offered as a bet. Only the prices at books you can actually use can become an
edge, a bet, or a "best price".

### Stats

`BETTABLE_BOOKS`: DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock,
theScore, Circa Sports. `REFERENCE_BOOKS`: Pinnacle. Both enter the consensus; only
bettable quotes are eligible for edges, bets and best price (`Bettable` column
on every captured row). Taking best-of-N across books you cannot reach finds the
most generous outlier by construction and books returns nobody could have
earned (the unfiltered list was 86 books).

---

## 8. Known limits — read these before trusting any number

1. **Small sample, few clusters.** Four weeks, and a week is a handful of games
   (week 3 was three fixtures, 28 players). Everything is clustered for that
   reason; treat `z` values accordingly.
2. **Selection bias in actuals.** The RotoWire actuals feed has no all-zero
   rows, so a player who played and recorded nothing looks identical to one who
   was inactive (26.8% of week-1 prop players, 16.3% of week-2). Those are
   precisely the players for whom the **Under** won. Dropping them overstates the
   observed over-rate and inflates the fitted intercept (`a ≈ +0.33`); applying
   it would turn a median edge of −3.2% into +0.6% and manufacture 344 over bets
   out of an artefact. The intercept is therefore not shipped as a live price;
   `capture-props` warns when `|a| > 0.1`. Fixing it needs a played/did-not-play
   source.
3. **Read "lean" against the book, not against zero.** Because of (2), every
   price reads low against the observed over-rate.
4. **One-sided markets** use an *assumed* hold. The measured hold barely moves
   (6.5–7.7% across stats) so this is defensible, but `devig` and
   `assumed-hold` rows are scored separately and, if they disagree, the measured
   one wins.
5. **Tuesday drop vs frozen snapshot.** The `main` slot's stored prices came from
   an earlier projection snapshot than the frozen one (8,401 of 10,944 rows
   differ by more than 0.001, up to 0.95). It is excluded from re-pricing
   comparisons rather than scored against the wrong projection.
6. **Closing lines** are patchy on player props and fill in days after games.
7. **Not an edge.** On current evidence the market is the better estimate of a
   near-50/50 line. The honest default remains: price off the projection only
   where a guard says it is trustworthy, and treat the blend as a research
   tool until `b` earns its keep.

---

## 9. Where to look for each piece

| | |
|---|---|
| Projection → probability | `scripts/lib/probability.mjs` |
| De-vig, consensus | `scripts/lib/devig.mjs`, `consensus.mjs` |
| Blend fit, scoring, clustering, bands | `scripts/lib/pricing.mjs`, `npm run price-model` |
| Median correction | `scripts/lib/median-correction.mjs`, `npm run median-correction` |
| Guards (support floor, disagreement cap) | `scripts/lib/calibration.mjs` |
| Edges and bets | `scripts/capture-props.mjs`, `scripts/lib/personas.mjs` |
| Per-line view of all of the above | Line Pricer tab (`npm run build:lines`) |
