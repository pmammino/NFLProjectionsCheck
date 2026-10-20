# Is the projection's band too narrow? — 2026

19,042 live markets (every rung of every ladder) with a graded outcome, weeks 1, 2, 3, 4, 5, 6. Every projection is the one that capture actually had, rebuilt from git history.

## 1. Is the band too narrow?

The projection's own P(over) against how often the over happened, all rungs, all weeks. A band that is too narrow prices tails it should not: a 1% over that happens 4% of the time. `widened` applies the best single multiplier (descriptive, fitted on these same rows).

**yards** (passYds, rushYds, recYds) — best multiplier 1.60

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 1,920 | 0.9% | 5.6% | 8.9% |
| 3–10% | 1,602 | 6.2% | 16.6% | 14.7% |
| 10–25% | 2,052 | 17.1% | 27.4% | 23.3% |
| 25–50% | 2,848 | 38.0% | 42.3% | 38.4% |
| 50–75% | 3,742 | 62.0% | 57.6% | 55.5% |
| 75–90% | 1,529 | 81.7% | 71.6% | 75.0% |
| 90–100% | 257 | 92.7% | 82.0% | 87.2% |

**counts** (passAtt, completions, rushAtt, receptions) — best multiplier 1.40

| projection says | rungs | projection | widened | happened |
| --- | --- | --- | --- | --- |
| 0–3% | 443 | 1.1% | 4.4% | 10.2% |
| 3–10% | 596 | 6.3% | 13.5% | 11.6% |
| 10–25% | 873 | 17.1% | 24.7% | 21.4% |
| 25–50% | 1,298 | 38.3% | 41.5% | 41.7% |
| 50–75% | 1,200 | 61.3% | 58.2% | 62.6% |
| 75–90% | 560 | 82.1% | 74.6% | 82.9% |
| 90–100% | 122 | 93.1% | 85.8% | 78.7% |

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

Each week on its own (best multiplier from that week's rows alone; – under 150 rows):

| group | wk 1 | wk 2 | wk 3 | wk 4 | wk 5 | wk 6 |
| --- | --- | --- | --- | --- | --- | --- |
| yards | 2.50 | 2.50 | 1.20 | 2.50 | 1.70 | 1.40 |
| counts | 2.50 | – | – | 1.30 | 1.20 | 1.70 |

It is above 1 everywhere it can be measured, but how far above moves with the week and the amount of ladder. That is why the used number is pooled, marked down and capped rather than the best fit.

## 3. Walk-forward: does it price the projection better?

Weeks 2, 3, 5, 6, each priced with the multiplier fitted on the weeks before it. Projection-alone Brier against what happened (lower is better); the difference is widened − as-projected, clustered by player-week, so negative is better.

|  | markets | player-weeks | as projected | widened | widened − projected | log-loss: projected → widened |
| --- | --- | --- | --- | --- | --- | --- |
| near the money | 9,063 | 432 | 0.2494 | 0.2438 | -0.0056 (z -4.1) | 0.7125 → 0.6947 |
| long-shot overs (books 3–15%) | 4,332 | 429 | 0.0792 | 0.0820 | +0.0028 (z 1.6) | 0.3316 → 0.3144 |
| all rungs | 17,698 | 433 | 0.1856 | 0.1842 | -0.0015 (z -1.3) | 0.5748 → 0.5591 |

## 3b. Does the cap decide it?

The same walk-forward under other caps, so the choice of cap does not quietly decide the answer (Brier difference widened − projected, and the share near the money):

| cap | near the money: Brier | z | share near the money | all rungs: Brier | z |
| --- | --- | --- | --- | --- | --- |
| 1.2 | -0.0030 | -5.3 | -0.05 ±0.17 | -0.0016 | -3.5 |
| 1.4 | -0.0047 | -4.6 | -0.06 ±0.18 | -0.0019 | -2.3 |
| 1.6 | -0.0056 | -4.1 | -0.06 ±0.19 | -0.0015 | -1.3 |
| 2.0 | -0.0060 | -3.8 | -0.06 ±0.18 | -0.0006 | -0.4 |

## 4. Does a better-calibrated projection earn a share of the price?

The share of the books' price to move toward the projection to match what happened (0 = ignore it, 1 = believe it), unpenalised, same weeks as above. This is the question the price cares about: a projection can be better calibrated and still add nothing the books do not already have.

|  | markets | player-weeks | share: as projected | share: widened | Brier: projected | widened | books |
| --- | --- | --- | --- | --- | --- | --- | --- |
| near the money | 9,063 | 432 | -0.03 ±0.16 | -0.06 ±0.19 | 0.2494 | 0.2438 | 0.2325 |
| long-shot overs (books 3–15%) | 4,332 | 429 | 0.14 ±0.15 | 0.14 ±0.21 | 0.0792 | 0.0820 | 0.0773 |
| all rungs | 17,698 | 433 | 0.04 ±0.11 | 0.01 ±0.14 | 0.1856 | 0.1842 | 0.1745 |

## 5. Reading it

- **Widening prices the projection better** (walk-forward, each week fitted on earlier ones): near the money -0.0056 Brier, z -4.1; all rungs -0.0015 Brier, z -1.3.
- Every applied fit hit the 1.6 cap: the data want a wider band than the cap allows, and how much wider changes from week to week (section 2). The cap is a guard against a noisy week, not an estimate.
- Better-calibrated is not better than the books: near the money the widened projection scores 0.2438 against the books' 0.2325.
- It earns **no share near the money** (-0.06 ±0.19). Better calibration is not new information: the books already carry what the projection knows, and the share is what the price uses.
- Nothing here reaches a price. The fit lives in `lib/spread-fit.mjs` and is not wired into capture: the shares in use were fitted on the projection as it was, and mixing the two would move them under the price. If the share clears zero, wire it in and refit the shares on the widened projection in the same change.
