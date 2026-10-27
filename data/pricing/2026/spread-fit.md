# Is the projection's band too narrow? — 2026

27,409 live markets (every rung of every ladder) with a graded outcome, weeks 1, 2, 3, 4, 5, 6, 7. Every projection is the one that capture actually had, rebuilt from git history.

## 1. Is the band too narrow?

The projection's own P(over) against how often the over happened, all rungs, all weeks. A band that is too narrow prices tails it should not: a 1% over that happens 4% of the time. `widened` applies the best single multiplier (descriptive, fitted on these same rows).

**yards** (passYds, rushYds, recYds) — best multiplier 1.60

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 2,835 | 0.9% | 5.6% | 9.5% |
| 3–10% | 2,301 | 6.2% | 16.6% | 13.3% |
| 10–25% | 2,916 | 17.1% | 27.4% | 22.4% |
| 25–50% | 4,023 | 38.0% | 42.3% | 37.4% |
| 50–75% | 5,225 | 62.0% | 57.7% | 54.9% |
| 75–90% | 2,181 | 81.7% | 71.6% | 74.0% |
| 90–100% | 389 | 92.9% | 82.3% | 86.1% |

**counts** (passAtt, completions, rushAtt, receptions) — best multiplier 1.30

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 681 | 1.1% | 3.5% | 8.8% |
| 3–10% | 894 | 6.2% | 11.7% | 9.8% |
| 10–25% | 1,324 | 17.1% | 23.1% | 18.5% |
| 25–50% | 1,878 | 38.1% | 40.7% | 38.7% |
| 50–75% | 1,743 | 61.5% | 59.0% | 62.7% |
| 75–90% | 839 | 82.2% | 76.2% | 81.4% |
| 90–100% | 180 | 93.2% | 87.7% | 76.1% |

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
| going into week 6 | yards | 7,833 | 459 | 1.80 | 0.15 | **1.60** | applied |
| going into week 6 | counts | 2,896 | 426 | 1.20 | 0.10 | 1.00 | not-solid |
| going into week 7 | yards | 13,950 | 651 | 1.60 | 0.10 | **1.50** | applied |
| going into week 7 | counts | 5,092 | 608 | 1.40 | 0.11 | **1.29** | applied |

Each week on its own (best multiplier from that week's rows alone; – under 150 rows):

| group | wk 1 | wk 2 | wk 3 | wk 4 | wk 5 | wk 6 | wk 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| yards | 2.50 | 2.50 | 1.20 | 2.50 | 1.70 | 1.40 | 1.60 |
| counts | 2.50 | – | – | 1.30 | 1.20 | 1.70 | 1.10 |

It is above 1 everywhere it can be measured, but how far above moves with the week and the amount of ladder. That is why the used number is pooled, marked down and capped rather than the best fit.

## 3. Walk-forward: does it price the projection better?

Weeks 2, 3, 5, 6, 7, each priced with the multiplier fitted on the weeks before it. Projection-alone Brier against what happened (lower is better); the difference is widened − as-projected, clustered by player-week, so negative is better.

|  | markets | player-weeks | as projected | widened | widened − projected | log-loss: projected → widened |
| --- | --- | --- | --- | --- | --- | --- |
| near the money | 13,339 | 626 | 0.2473 | 0.2422 | -0.0051 (z -4.7) | 0.7113 → 0.6937 |
| long-shot overs (books 3–15%) | 6,406 | 621 | 0.0759 | 0.0789 | +0.0030 (z 2.3) | 0.3285 → 0.3081 |
| all rungs | 26,065 | 627 | 0.1834 | 0.1821 | -0.0012 (z -1.4) | 0.5722 → 0.5554 |

## 3b. Does the cap decide it?

The same walk-forward under other caps, so the choice of cap does not quietly decide the answer (Brier difference widened − projected, and the share near the money):

| cap | near the money: Brier | z | share near the money | all rungs: Brier | z |
| --- | --- | --- | --- | --- | --- |
| 1.2 | -0.0028 | -5.9 | 0.00 ±0.16 | -0.0014 | -3.7 |
| 1.4 | -0.0043 | -5.2 | -0.01 ±0.17 | -0.0016 | -2.4 |
| 1.6 | -0.0051 | -4.7 | -0.01 ±0.17 | -0.0012 | -1.4 |
| 2.0 | -0.0053 | -4.4 | -0.01 ±0.17 | -0.0006 | -0.6 |

## 4. Does a better-calibrated projection earn a share of the price?

The share of the books' price to move toward the projection to match what happened (0 = ignore it, 1 = believe it), unpenalised, same weeks as above. This is the question the price cares about: a projection can be better calibrated and still add nothing the books do not already have.

|  | markets | player-weeks | share: as projected | share: widened | Brier: projected | widened | books |
| --- | --- | --- | --- | --- | --- | --- | --- |
| near the money | 13,339 | 626 | 0.01 ±0.14 | -0.01 ±0.17 | 0.2473 | 0.2422 | 0.2336 |
| long-shot overs (books 3–15%) | 6,406 | 621 | 0.12 ±0.13 | 0.10 ±0.17 | 0.0759 | 0.0789 | 0.0740 |
| all rungs | 26,065 | 627 | 0.06 ±0.10 | 0.03 ±0.13 | 0.1834 | 0.1821 | 0.1744 |

## 5. Reading it

- **Widening prices the projection better** (walk-forward, each week fitted on earlier ones): near the money -0.0051 Brier, z -4.7; all rungs -0.0012 Brier, z -1.4.
- Better-calibrated is not better than the books: near the money the widened projection scores 0.2422 against the books' 0.2336.
- It earns **no share near the money** (-0.01 ±0.17). Better calibration is not new information: the books already carry what the projection knows, and the share is what the price uses.
- Nothing here reaches a price. The fit lives in `lib/spread-fit.mjs` and is not wired into capture: the shares in use were fitted on the projection as it was, and mixing the two would move them under the price. If the share clears zero, wire it in and refit the shares on the widened projection in the same change.
