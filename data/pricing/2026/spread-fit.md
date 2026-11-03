# Is the projection's band too narrow? — 2026

33,733 live markets (every rung of every ladder) with a graded outcome, weeks 1, 2, 3, 4, 5, 6, 7, 8. Every projection is the one that capture actually had, rebuilt from git history.

## 1. Is the band too narrow?

The projection's own P(over) against how often the over happened, all rungs, all weeks. A band that is too narrow prices tails it should not: a 1% over that happens 4% of the time. `widened` applies the best single multiplier (descriptive, fitted on these same rows).

**yards** (passYds, rushYds, recYds) — best multiplier 1.60

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 3,430 | 0.9% | 5.6% | 9.5% |
| 3–10% | 2,766 | 6.2% | 16.6% | 13.2% |
| 10–25% | 3,539 | 17.0% | 27.4% | 22.0% |
| 25–50% | 4,890 | 38.0% | 42.4% | 37.6% |
| 50–75% | 6,363 | 62.1% | 57.7% | 54.3% |
| 75–90% | 2,692 | 81.8% | 71.7% | 73.6% |
| 90–100% | 509 | 93.0% | 82.5% | 84.9% |

**counts** (passAtt, completions, rushAtt, receptions) — best multiplier 1.30

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 835 | 1.1% | 3.5% | 9.1% |
| 3–10% | 1,102 | 6.3% | 11.8% | 10.4% |
| 10–25% | 1,658 | 17.0% | 23.0% | 18.5% |
| 25–50% | 2,387 | 38.0% | 40.7% | 39.0% |
| 50–75% | 2,251 | 61.5% | 59.0% | 60.8% |
| 75–90% | 1,065 | 82.1% | 76.2% | 81.1% |
| 90–100% | 246 | 93.2% | 87.6% | 76.0% |

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
| going into week 8 | yards | 19,870 | 844 | 1.60 | 0.09 | **1.51** | applied |
| going into week 8 | counts | 7,539 | 791 | 1.30 | 0.09 | **1.21** | applied |

Each week on its own (best multiplier from that week's rows alone; – under 150 rows):

| group | wk 1 | wk 2 | wk 3 | wk 4 | wk 5 | wk 6 | wk 7 | wk 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| yards | 2.50 | 2.50 | 1.20 | 2.50 | 1.70 | 1.40 | 1.60 | 1.70 |
| counts | 2.50 | – | – | 1.30 | 1.20 | 1.70 | 1.10 | 1.50 |

It is above 1 everywhere it can be measured, but how far above moves with the week and the amount of ladder. That is why the used number is pooled, marked down and capped rather than the best fit.

## 3. Walk-forward: does it price the projection better?

Weeks 2, 3, 5, 6, 7, 8, each priced with the multiplier fitted on the weeks before it. Projection-alone Brier against what happened (lower is better); the difference is widened − as-projected, clustered by player-week, so negative is better.

|  | markets | player-weeks | as projected | widened | widened − projected | log-loss: projected → widened |
| --- | --- | --- | --- | --- | --- | --- |
| near the money | 16,694 | 820 | 0.2489 | 0.2434 | -0.0055 (z -6.0) | 0.7127 → 0.6938 |
| long-shot overs (books 3–15%) | 7,768 | 815 | 0.0783 | 0.0810 | +0.0026 (z 2.3) | 0.3419 → 0.3170 |
| all rungs | 32,389 | 821 | 0.1856 | 0.1839 | -0.0017 (z -2.2) | 0.5776 → 0.5589 |

## 3b. Does the cap decide it?

The same walk-forward under other caps, so the choice of cap does not quietly decide the answer (Brier difference widened − projected, and the share near the money):

| cap | near the money: Brier | z | share near the money | all rungs: Brier | z |
| --- | --- | --- | --- | --- | --- |
| 1.2 | -0.0032 | -7.6 | -0.02 ±0.14 | -0.0016 | -4.9 |
| 1.4 | -0.0048 | -6.6 | -0.03 ±0.15 | -0.0019 | -3.3 |
| 1.6 | -0.0055 | -6.0 | -0.03 ±0.15 | -0.0017 | -2.2 |
| 2.0 | -0.0057 | -5.6 | -0.03 ±0.15 | -0.0012 | -1.4 |

## 4. Does a better-calibrated projection earn a share of the price?

The share of the books' price to move toward the projection to match what happened (0 = ignore it, 1 = believe it), unpenalised, same weeks as above. This is the question the price cares about: a projection can be better calibrated and still add nothing the books do not already have.

|  | markets | player-weeks | share: as projected | share: widened | Brier: projected | widened | books |
| --- | --- | --- | --- | --- | --- | --- | --- |
| near the money | 16,694 | 820 | -0.02 ±0.12 | -0.03 ±0.15 | 0.2489 | 0.2434 | 0.2338 |
| long-shot overs (books 3–15%) | 7,768 | 815 | 0.09 ±0.11 | 0.08 ±0.15 | 0.0783 | 0.0810 | 0.0760 |
| all rungs | 32,389 | 821 | 0.04 ±0.08 | 0.03 ±0.11 | 0.1856 | 0.1839 | 0.1758 |

## 5. Reading it

- **Widening prices the projection better** (walk-forward, each week fitted on earlier ones): near the money -0.0055 Brier, z -6.0; all rungs -0.0017 Brier, z -2.2.
- Better-calibrated is not better than the books: near the money the widened projection scores 0.2434 against the books' 0.2338.
- It earns **no share near the money** (-0.03 ±0.15). Better calibration is not new information: the books already carry what the projection knows, and the share is what the price uses.
- Nothing here reaches a price. The fit lives in `lib/spread-fit.mjs` and is not wired into capture: the shares in use were fitted on the projection as it was, and mixing the two would move them under the price. If the share clears zero, wire it in and refit the shares on the widened projection in the same change.
