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

### 4b. The books as the pricing guide, the projection alongside

**Plain English.** The price is now a weighted average of every book, with the
projection taking whatever share of the price it has earned. The books are not
treated as equals: a one-sided Hard Rock price is not as informed as a two-sided
Pinnacle one. Looking at how the market *moved* between the first posted price and
the close, Pinnacle, BetMGM and Circa open close to where everyone ends up; Hard
Rock and FanDuel open off the pack and then correct. So each book is graded every
week on how much of its early disagreement the others adopted by the close, and
weighted by that record. The projection is graded every week too — but on a
different test, because "did the market later follow it" can only fail a
projection that is written daily and read on Tuesday. Its test is: at the moment
of the price, how much of the price should come from it? It starts at zero and
earns a share per stat, per capture slot.

**Stats — the books.** For book `s`, with `L0` the median logit of the *other*
books at the early board and `Lc` the same at the close:

```
(Lc − L0) = lead_s · (L_s − L0) + ε          slope through the origin,
                                              errors clustered on (week, player)
```

If the best estimate of the closing price is a weighted average of the early
sources, `lead_s` is exactly `w_s / Σw` — so a measurement that needs no outcomes
(one number per market instead of one coin flip) can set the weights. `s` is
excluded from its own target (a frozen price would otherwise "lead" because its
close is inside the target). A source is a book *and* whether it quoted both sides.

```
w_s = (clusters·lead_s + K·prior) / (clusters + K)      K = 150 player-weeks, prior 0.15, w ≥ 0.01
L_books = Σ w_s·clip(L_s, median ± 1.5) / Σ w_s
```

The weights are **per stat**: each (stat, book) lead is pulled toward that book's global weight by the same
`K = 150` prior, `w_{stat,s} = (clusters·lead_{stat,s} + K·w_s) / (clusters + K)`, so a thin stat prices like the
global model. Out of sample this predicts the sharp close better than global weights (Pinnacle MSE −0.0005,
z −3.6; Circa −0.0002, z −2.3); against outcomes it changes nothing detectable.

**Stats — the projection.** One parameter per (stat, slot), fitted against
outcomes with the books as the offset:

```
logit P(over) = L_books + share · (L_proj − L_books)
share = clip( shrunk_estimate − 1·SE , 0, 0.75 )       prior 0, worth 150 player-weeks
```

Both are fitted **as of a week** (strictly earlier weeks only), on live captures for
the projection (a backfilled board's projection is the week's *final* snapshot: against
it the market appears to follow the projection by ~8%, z ≈ 10; against the one it had on
Tuesday, ~0.8%, z ≈ 2 — it has caught up with the market, not led it). `ProjProb` records what the
projection alone said on every row, because `OurProb` is the pool's after re-pricing.

2026 weeks 1–4: weights Pinnacle 0.72, BetMGM 0.47, Circa 0.37, theScore 0.36,
Caesars 0.34, DraftKings 0.25, BetRivers 0.19, Hard Rock 0.09, FanDuel 0.06. On the
live Tuesday captures every projection share is inside its own error bar, so every
share used is zero and the price is currently the weighted books.

**What this does to the ledger.** Rows clearing the 3% edge bar on the Tuesday
boards fall from 1,057 / 4,203 / 4,176 (weeks 3 / 4 / 5) to 7 / 3 / 6. Almost every
edge the projection-only ledger found was the projection disagreeing with a price
that already carried the news. What survives is stale outliers bettable after the
margin. `--price-model projection` restores the old price.

What the weighting does and does not show: weighted retail books predict Pinnacle's
close better than the equal median (MSE 0.0174 → 0.0165, z −3.9) — partly circular,
and not reproduced against Circa's close (z +1.4). Against outcomes it makes no
detectable difference (Brier −0.00003, z −0.4), which four weeks cannot resolve in
either direction. The weights describe an **early** board only, and live Tuesday
captures carry no Pinnacle yet (0 rows in week 5), so on a Tuesday drop the pool is
the weighted retail books.

### 4c. Why the projection earns so little

**Plain English.** Four things could make a projection lose to the books: it is
*early* (read before it has settled), its *middle* is in the wrong place,
its *band* is too narrow (too sure of itself), or its *tails* are too thin. Tested
separately on weeks 2–4 against the book at the same moment, near the money:

| cause | result |
|---|---|
| **late** | the biggest. Gap to the closing book **+0.0178** on Tuesday's snapshot, **+0.0073** on the last snapshot before the game: the projection gets better every day. It is not shown to be news the books priced: the Tuesday gap is as large where the book barely moved after the open (+0.0194) as where it moved a lot (+0.0145) |
| **band too narrow** | second. Widening 1.75× (pre-kickoff) takes +0.0073 → +0.0041; 2.5× on Tuesday's, +0.0178 → +0.0119 |
| **tails too thin** | negligible: Student-t with the same quartiles moves the gap ≤ 0.0003. The tail miscalibration is real (the projection says 2%, the book and the outcomes 9–12%) but small in Brier terms |
| **middle in the wrong place** | rushing and receiving yards only; about a quarter of the gap (median correction) |

So the problem is not "the books have many prices and we have one"; it is that the
projection is worse early in the week than late, and it is read on Tuesday. With a fresh
snapshot the projection earns a share on the volume stats — against outcomes
0.53 ± 0.46 on receptions (z 2.3), 0.25 on receiving yards — and negative on
passing yards, where the books simply know more (weather, matchup, pace). With
Tuesday's, about nothing anywhere.

**Stats.** Position on the curve is the line's distance from the median in the
projection's own two-piece standard deviations. A heavier tail is a two-piece
Student-t with the *same quartiles*, so only the tails move; the band multiplier
scales both half-spreads; each is scored by the Brier gap to the book at the same
moment, clustered on (week, player). Reproduce with `npm run projection-miss`
(needs a full clone: the daily snapshots live in git history).

### 4d. Is there value in big disagreements, in stat-specific weights, or in a two-stage blend?

Research on 2026 weeks 2–4, point-in-time (Tuesday's snapshot against the opening book; the last
snapshot before the game against the closing book). These are ad-hoc analyses, not scripts in the
repo. Shares are fitted against outcomes **with an intercept**, which absorbs a +0.1 to +0.5 logit tilt
that the actuals feed's missing zero-stat rows put into outcomes. The tilt barely moves the shares
(receptions 0.54 → 0.51, receiving yards 0.24 → 0.11, all stats 0.11 → 0.02), so the earlier receptions
share stands and the receiving-yards share was partly that bias.

**Large disagreements carry no extra information.** The projection's share, by how far it sits from the book:

| disagreement (logit; ≈ prob. points) | Tuesday vs open | pre-kickoff vs close |
|---|---|---|
| 0.25–0.5 (≈ 8) | −0.10 ± 0.42 | −0.12 ± 0.42 |
| 0.5–1 (≈ 13) | +0.07 ± 0.29 | +0.11 ± 0.28 |
| above 1 (≈ 13–20) | **−0.02 ± 0.12** | **−0.01 ± 0.15** |

The trend with size is flat (slope +0.00 ± 0.08). The biggest disagreements are about as reliable as the
smallest, which is to say not at all, and they are measured with decent precision. That supports the
20-point market-disagreement cap in `calibration.mjs`: a big gap from the book is our error. There is no
pocket of value in the extreme discrepancies. (Splitting by whether the projection says over or under looks
asymmetric, +0.27 vs −0.40, but that is the missing-zero-row tilt again: it makes over disagreements look
informative and under ones anti-informative.)

**The books should be weighted by stat (now built); the projection earns a share on one.**
- *Books.* Each book's lead differs by stat. On receptions the sharp books lead hard (Pinnacle 0.99, Circa
  1.05, BetMGM 0.73) while the retail books barely do (Caesars 0.10, DraftKings 0.18, FanDuel 0.03–0.09,
  Hard Rock −0.04). On receiving yards the retail books lead almost as much as the sharp ones (0.59–0.70 vs
  0.64–0.76). Rushing sits between; passing yards is too thin to read (73 player-weeks). Weights fitted per
  stat, shrunk toward the global weights, predict the sharp close better than global weights in every cell I
  could test, out of sample: receptions −0.0022 MSE (z −3.7), receiving yards −0.0004 (z −4.0), all stats
  −0.0007 against Pinnacle (z −4.1) and −0.0004 against Circa (z −3.1). Real and modest.
- *Projection.* With a fresh snapshot: receptions **0.51 ± 0.47**, receiving yards 0.11 ± 0.39, rushing yards
  0.41 ± 0.66, passing yards −1.4 ± 1.4. With Tuesday's: about 0 everywhere. Receptions is the only cell
  distinguishable from zero, and it is also the stat where the retail books are slowest, which is consistent
  with the projection's volume signal adding something there. That is a coincidence to watch, not a result.

**The two-stage blend is the same model.** "Treat the projection as a book, weight it, then blend that into the
market as another book" is, in logit space, `L_M + γ·(L_B − L_M)` with `L_B = L_M + β·(L_P − L_M)`, which
equals `L_M + (γβ)·(L_P − L_M)`: one share, checked numerically to 1e-12. Assessing the blend as a book by
lead gives the projection's own lead back, rescaled. Walk-forward (weeks 3–4, trained on earlier weeks), the
single-stage and two-stage versions, in logit and in probability space, are identical to the market, because
after one or two weeks every fitted share is still zero. The one variant that differed, a fitted blend that
also recalibrates the market (intercept `a`, slope `c`), was **worse**: +0.009 Brier (z 2.1) on Tuesday and
+0.007 (z 1.7) pre-kickoff, because the intercept learns the missing-zero tilt and bets overs. Do not add it.

**The ceiling is small whatever the structure.** Fitting the best per-stat shares on the same weeks they are
scored on, an upper bound, gains 0.0004 Brier overall on Tuesday's snapshot and 0.0006 pre-kickoff
(receptions +0.0018, receiving yards +0.0008, rushing and passing about 0). No arrangement of weights can
extract more than that from the current projection. A better projection is the lever, not a cleverer blend.

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
| Source weights, weighted pool | `scripts/lib/source-weights.mjs`, `scripts/lib/source-model.mjs`, `npm run source-weights` |
| Where the projection loses, and why | `scripts/lib/projection-diagnosis.mjs`, `npm run projection-miss` |
| Median correction | `scripts/lib/median-correction.mjs`, `npm run median-correction` |
| Guards (support floor, disagreement cap) | `scripts/lib/calibration.mjs` |
| Edges and bets | `scripts/capture-props.mjs`, `scripts/lib/personas.mjs` |
| Per-line view of all of the above | Line Pricer tab (`npm run build:lines`) |
