# Is the projection's band too narrow? — 2026

10,037 live markets (every rung of every ladder) with a graded outcome, weeks 1, 2, 3, 4, 5. Every projection is the one that capture actually had, rebuilt from git history.

## 1. Is the band too narrow?

The projection's own P(over) against how often the over happened, all rungs, all weeks. A band that is too narrow prices tails it should not: a 1% over that happens 4% of the time. `widened` applies the best single multiplier (descriptive, fitted on these same rows).

**yards** (passYds, rushYds, recYds) — best multiplier 1.70

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 935 | 0.9% | 6.8% | 10.2% |
| 3–10% | 833 | 6.3% | 18.1% | 15.7% |
| 10–25% | 1,071 | 17.1% | 28.6% | 25.0% |
| 25–50% | 1,500 | 38.1% | 42.8% | 38.7% |
| 50–75% | 2,045 | 61.7% | 57.0% | 54.4% |
| 75–90% | 788 | 81.7% | 70.4% | 74.9% |
| 90–100% | 131 | 92.8% | 80.7% | 83.2% |

**counts** (passAtt, completions, rushAtt, receptions) — best multiplier 1.20

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 212 | 1.2% | 2.7% | 5.2% |
| 3–10% | 312 | 6.4% | 10.2% | 10.9% |
| 10–25% | 447 | 17.1% | 21.4% | 18.1% |
| 25–50% | 742 | 38.6% | 40.4% | 40.4% |
| 50–75% | 669 | 61.2% | 59.4% | 62.0% |
| 75–90% | 281 | 82.0% | 77.8% | 81.9% |
| 90–100% | 71 | 92.9% | 89.1% | 83.1% |

"Happened" tends to sit a little above any price: the actuals feed omits players with an all-zero line, which tilts outcomes toward overs.

## 2. How wide, and is it stable?

Multiplier on the floor and ceiling distances from the median (1 = as projected), fitted by log-loss on every rung, pooled over a group's stats. **Used** is the number the walk-forward applies: marked down by one bootstrap standard error, capped at 1.6, and only if the log-loss gain clears a clustered z of 2 on at least 150 player-weeks.

| as of | group | rungs | player-weeks | best | ± se | used | why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| going into week 1 | yards | 0 | 0 | – | – | 1.00 | too-few-player-weeks |
| going into week 1 | counts | 0 | 0 | – | – | 1.00 | too-few-player-weeks |
| going into week 2 | yards | 247 | 169 | 2.50 | 0.12 | **1.60** | applied |
| going into week 2 | counts | 201 | 171 | 2.50 | 0.41 | 1.00 | not-solid |
| going into week 3 | yards | 401 | 183 | 2.50 | 0.13 | **1.60** | applied |
| going into week 3 | counts | 283 | 185 | 2.00 | 0.51 | 1.00 | not-solid |
| going into week 4 | yards | 708 | 211 | 1.80 | 0.37 | 1.00 | not-solid |
| going into week 4 | counts | 415 | 206 | 1.40 | 0.33 | 1.00 | not-solid |
| going into week 5 | yards | 1,403 | 261 | 2.50 | 0.27 | **1.60** | applied |
| going into week 5 | counts | 616 | 238 | 1.40 | 0.23 | 1.00 | not-solid |

Each week on its own (best multiplier from that week's rows alone; – under 150 rows):

| group | wk 1 | wk 2 | wk 3 | wk 4 | wk 5 |
| --- | --- | --- | --- | --- | --- |
| yards | 2.50 | 2.50 | 1.20 | 2.50 | 1.60 |
| counts | 2.50 | – | – | 1.30 | 1.10 |

It is above 1 everywhere it can be measured, but how far above moves with the week and the amount of ladder. That is why the used number is pooled, marked down and capped rather than the best fit.

## 3. Walk-forward: does it price the projection better?

Weeks 2, 3, 5, each priced with the multiplier fitted on the weeks before it. Projection-alone Brier against what happened (lower is better); the difference is widened − as-projected, clustered by player-week, so negative is better.

|  | markets | player-weeks | as projected | widened | widened − projected | log-loss: projected → widened |
| --- | --- | --- | --- | --- | --- | --- |
| near the money | 4,423 | 225 | 0.2455 | 0.2410 | -0.0045 (z -2.9) | 0.6989 → 0.6851 |
| long-shot overs (books 3–15%) | 2,125 | 223 | 0.0865 | 0.0858 | -0.0007 (z -0.2) | 0.3363 → 0.3117 |
| all rungs | 8,693 | 226 | 0.1862 | 0.1840 | -0.0022 (z -1.5) | 0.5715 → 0.5538 |

## 3b. Does the cap decide it?

The same walk-forward under other caps, so the choice of cap does not quietly decide the answer (Brier difference widened − projected, and the share near the money):

| cap | near the money: Brier | z | share near the money | all rungs: Brier | z |
| --- | --- | --- | --- | --- | --- |
| 1.2 | -0.0025 | -3.9 | 0.00 ±0.29 | -0.0019 | -3.1 |
| 1.4 | -0.0039 | -3.4 | 0.00 ±0.31 | -0.0024 | -2.2 |
| 1.6 | -0.0045 | -2.9 | -0.00 ±0.31 | -0.0022 | -1.5 |
| 2.0 | -0.0048 | -2.3 | -0.00 ±0.31 | -0.0005 | -0.2 |

## 4. Does a better-calibrated projection earn a share of the price?

The share of the books' price to move toward the projection to match what happened (0 = ignore it, 1 = believe it), unpenalised, same weeks as above. This is the question the price cares about: a projection can be better calibrated and still add nothing the books do not already have.

|  | markets | player-weeks | share: as projected | share: widened | Brier: projected | widened | books |
| --- | --- | --- | --- | --- | --- | --- | --- |
| near the money | 4,423 | 225 | 0.00 ±0.25 | -0.00 ±0.31 | 0.2455 | 0.2410 | 0.2332 |
| long-shot overs (books 3–15%) | 2,125 | 223 | 0.24 ±0.23 | 0.49 ±0.52 | 0.0865 | 0.0858 | 0.0868 |
| all rungs | 8,693 | 226 | 0.08 ±0.16 | 0.14 ±0.28 | 0.1862 | 0.1840 | 0.1784 |

## 5. Reading it

- **Widening prices the projection better** (walk-forward, each week fitted on earlier ones): near the money -0.0045 Brier, z -2.9; all rungs -0.0022 Brier, z -1.5.
- Every applied fit hit the 1.6 cap: the data want a wider band than the cap allows, and how much wider changes from week to week (section 2). The cap is a guard against a noisy week, not an estimate.
- Better-calibrated is not better than the books: near the money the widened projection scores 0.2410 against the books' 0.2332.
- It earns **no share near the money** (-0.00 ±0.31). Better calibration is not new information: the books already carry what the projection knows, and the share is what the price uses.
- Nothing here reaches a price. The fit lives in `lib/spread-fit.mjs` and is not wired into capture: the shares in use were fitted on the projection as it was, and mixing the two would move them under the price. If the share clears zero, wire it in and refit the shares on the widened projection in the same change.
