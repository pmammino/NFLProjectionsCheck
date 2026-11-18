# Agreement study — 2026, weeks 1–11

Does the price deserve to move harder when the projection and the sharp books lean the same way? Live boards only (main, thursday, saturday): the prices and the projection that existed at the time. Every interval is cluster-robust on player-week.

## Verdict

**No definition clears the bar. Do not change the price.** The bar, fixed in `decide()` in this script before the walk-forward was run, needs all three of: a cautious gated price that beats the pool out of sample (z ≤ −2), the same for the uncautious point-estimate price, and an agree-cell projection share whose 95% interval sits above zero.

| definition | cautious beats pool | point-estimate beats pool | agree-cell share > 0 | ship? |
| --- | --- | --- | --- | --- |
| books | no | no | no | no |
| sharp | no | no | no | no |

## 1. Coverage — how much of the board can this even be measured on

74,180 markets on live boards; 69,466 graded; **6,027 (8.1%) have a Pinnacle or Circa quote**; 47,535 have a late board. Pinnacle prices main lines, not the alternate-line ladder, and Circa quotes a fraction of that. 33,462 graded markets sit near the money, which is where the price is tested.

| definition | agree | disagree | flat (not leaning) | not measurable |
| --- | --- | --- | --- | --- |
| books | 3026 | 2847 | 27589 | 0 |
| sharp | 833 | 797 | 3974 | 27858 |

"Leaning" means the sharp signal sits more than 0.03 logit (about 0.75 points of probability at a coin flip) from its reference.

## 2. Bets at a price — is the profit the projection's, or the books'?

One bet per market at the best bettable price (−400 to +200), first capture only, 90,201 bets in all. **No edge cut**: the paper-trading file stores only rows where some price shows 3%, which empties the "books confirm, projection against" cell by construction. ROI counts an Over on a player the feed omitted as a loss. CLV is the late market's fair price minus the break-even of the price taken (positive = the market moved toward the bet).

### The books' lead-weighted pool confirms the price

The confirming source is held fixed and only the projection varies. If the projection were doing the work, the three rows would differ.

**Confirm ≥ 0%** (773 bets)

|  | bets | ROI (±95%) | bets with a close | CLV (±95%) | beat the close |
| --- | --- | --- | --- | --- | --- |
| projection edge ≥ 3% (agrees) | 356 | -3.7% ±12.9 | 266 | +1.20 pts ±0.48 | 70% |
| projection 0–3% | 64 | -22.6% ±28.3 | 53 | +1.45 pts ±0.68 | 77% |
| projection ≤ 0 (against) | 353 | -1.6% ±13.5 | 248 | +0.43 pts ±0.42 | 62% |
| **agrees − against** |  |  |  | +0.76 pts ±0.64 (z 2.3) |  |

**Confirm ≥ 1%** (236 bets)

|  | bets | ROI (±95%) | bets with a close | CLV (±95%) | beat the close |
| --- | --- | --- | --- | --- | --- |
| projection edge ≥ 3% (agrees) | 109 | -8.3% ±22.5 | 84 | +1.97 pts ±0.73 | 79% |
| projection 0–3% | 22 | -19.5% ±48.3 | 18 | +2.46 pts ±1.08 | 89% |
| projection ≤ 0 (against) | 105 | +5.8% ±25.7 | 70 | +0.77 pts ±0.58 | 67% |
| **agrees − against** |  |  |  | +1.21 pts ±0.93 (z 2.5) |  |

**Confirm ≥ 2%** (67 bets)

|  | bets | ROI (±95%) | bets with a close | CLV (±95%) | beat the close |
| --- | --- | --- | --- | --- | --- |
| projection edge ≥ 3% (agrees) | 36 | -4.9% ±40.0 | 26 | +2.78 pts ±1.63 | 81% |
| projection 0–3% | 4 | -50.0% ±98.0 | 4 | +3.43 pts ±2.92 | 100% |
| projection ≤ 0 (against) | 27 | -11.2% ±55.1 | 9 | +1.37 pts ±1.77 | 67% |
| **agrees − against** |  |  |  | +1.41 pts ±2.41 (z 1.1) |  |

### Pinnacle/Circa confirm the price

The confirming source is held fixed and only the projection varies. If the projection were doing the work, the three rows would differ.

**Confirm ≥ 0%** (484 bets)

|  | bets | ROI (±95%) | bets with a close | CLV (±95%) | beat the close |
| --- | --- | --- | --- | --- | --- |
| projection edge ≥ 3% (agrees) | 200 | -0.6% ±14.8 | 151 | -0.08 pts ±0.41 | 46% |
| projection 0–3% | 54 | +11.1% ±28.1 | 46 | +0.12 pts ±0.88 | 50% |
| projection ≤ 0 (against) | 230 | -13.4% ±13.9 | 177 | -0.64 pts ±0.45 | 38% |
| **agrees − against** |  |  |  | +0.56 pts ±0.61 (z 1.8) |  |

**Confirm ≥ 1%** (176 bets)

|  | bets | ROI (±95%) | bets with a close | CLV (±95%) | beat the close |
| --- | --- | --- | --- | --- | --- |
| projection edge ≥ 3% (agrees) | 78 | +7.5% ±24.8 | 58 | +0.50 pts ±0.66 | 53% |
| projection 0–3% | 18 | -18.6% ±49.5 | 16 | +0.34 pts ±1.18 | 50% |
| projection ≤ 0 (against) | 80 | -10.0% ±25.0 | 60 | +0.09 pts ±0.91 | 45% |
| **agrees − against** |  |  |  | +0.40 pts ±1.12 (z 0.7) |  |

**Confirm ≥ 2%** (51 bets)

|  | bets | ROI (±95%) | bets with a close | CLV (±95%) | beat the close |
| --- | --- | --- | --- | --- | --- |
| projection edge ≥ 3% (agrees) | 27 | -1.0% ±43.7 | 20 | +1.52 pts ±1.11 | 75% |
| projection 0–3% | 6 | -30.9% ±87.2 | 5 | +1.48 pts ±3.26 | 80% |
| projection ≤ 0 (against) | 18 | +47.3% ±51.9 | 13 | +0.81 pts ±1.64 | 62% |
| **agrees − against** |  |  |  | +0.71 pts ±1.98 (z 0.7) |  |

### The projection alone, split by what the books say

| projection edge ≥ 3%, and… | bets | ROI (±95%) | bets with a close | CLV (±95%) | beat the close |
| --- | --- | --- | --- | --- | --- |
| books pool says the price is worse than −2% | 7179 | -11.1% ±4.6 | 4277 | -2.56 pts ±0.15 | 12% |
| books pool −2% to 0 | 2445 | -4.5% ±6.2 | 1768 | -0.37 pts ±0.20 | 36% |
| books pool 0 to +2% | 320 | -3.5% ±13.5 | 240 | +1.03 pts ±0.50 | 69% |
| books pool ≥ +2% (confirms) | 36 | -4.9% ±40.0 | 26 | +2.78 pts ±1.63 | 81% |
| Pinnacle/Circa quoted, price worse than fair | 1593 | -9.3% ±5.7 | 965 | -1.92 pts ±0.16 | 11% |
| Pinnacle/Circa confirm (≥ 0) | 200 | -0.6% ±14.8 | 151 | -0.08 pts ±0.41 | 46% |

## 3. The price — how much of the projection should be in it, by cell

Fitted on outcomes, near the money: `logit P(over) = books + share · (projection − books)`. 0 = ignore the projection, 1 = believe it over the books. This is the pipeline's own fit with no shrinkage and no markdown, so it is the raw number and its error.

| definition | cell | markets | player-weeks | share (±95%) |
| --- | --- | --- | --- | --- |
| books | agree | 3,026 | 986 | +0.043 ±0.153 |
| books | disagree | 2,847 | 942 | -0.011 ±0.138 |
| books | flat | 27,589 | 1459 | -0.010 ±0.108 |
| sharp | agree | 833 | 536 | -0.178 ±0.205 |
| sharp | disagree | 797 | 547 | +0.228 ±0.303 |
| sharp | flat | 3,974 | 1130 | +0.006 ±0.137 |
| (all near-the-money markets) | — | 33,462 | 1460 | -0.002 ±0.102 |

## 4. Where the market goes next

Outcomes are one coin flip per market; the late board is a price. Regress `close − price` on the projection's gap and on how far the lead-weighted books sit from the median (both in logit points, clustered). **proj** is how far the late market goes toward the projection; **shift** is how far it carries on in the direction the books already lean (negative: it comes back).

| definition | cell | markets | player-weeks | proj | shift |
| --- | --- | --- | --- | --- | --- |
| books | agree | 1,936 | 843 | +0.016 ±0.022 | -0.738 ±0.180 |
| books | disagree | 1,942 | 814 | +0.040 ±0.019 | -0.631 ±0.205 |
| books | flat | 18,344 | 1248 | +0.031 ±0.007 | -0.773 ±0.144 |
| books | all | 22,222 | 1253 | +0.030 ±0.007 | -0.766 ±0.085 |
| sharp | agree | 654 | 451 | +0.027 ±0.017 | -0.534 ±0.259 |
| sharp | disagree | 637 | 452 | +0.021 ±0.023 | -0.440 ±0.251 |
| sharp | flat | 2,745 | 983 | +0.012 ±0.006 | -0.795 ±0.155 |
| sharp | all | 4,036 | 1054 | +0.015 ±0.007 | -0.584 ±0.132 |

Side finding: as a predictor of the late board's median, the lead-weighted pool has a mean squared error of 0.0116 logit² against 0.0112 for the plain median of the same books (difference 0.00037, z 6.6, 22,222 markets). Positive means the pool is worse. The late median is a median of the same books, which favours a median predictor, so treat the size (about 3%) as the finding, not the z.

## 5. Walk-forward — would the gated price have beaten the pool?

For each week after the first 3: fit the projection's share in the agree cell and in everything else on earlier weeks only, price that week with it, score against the pool as it stands (share 0). Brier difference, **negative = better than the pool**, clustered by player-week. *cautious* is the pipeline's own rule (shrunk to zero, marked down a standard error); *point* takes the fit at face value and is the best the idea can look.

| definition | variant | avg share used: agree | avg share used: other | Brier vs pool: all markets | Brier vs pool: agree cell only |
| --- | --- | --- | --- | --- | --- |
| books | cautious | 0.000 | 0.000 | identical to the pool | identical to the pool, 2998 markets |
| books | point | 0.014 | 0.002 | 0.00001 (z 0.97) | 0.00003 (z 0.28), 2998 markets |
| sharp | cautious | 0.000 | 0.000 | identical to the pool | identical to the pool, 820 markets |
| sharp | point | 0.000 | 0.002 | 0.00001 (z 0.77) | identical to the pool, 820 markets |

## 6. What it would take to see it

- **books**: the agree-cell share is 0.043 ±0.153 on 3,026 markets (986 player-weeks). Halving that interval takes about four times the data — roughly 3,944 player-weeks in the cell. A share under 0.153 cannot be told from zero with what is here.
- **sharp**: the agree-cell share is -0.178 ±0.205 on 833 markets (536 player-weeks). Halving that interval takes about four times the data — roughly 2,144 player-weeks in the cell. A share under 0.205 cannot be told from zero with what is here.
- Whatever the share, it moves the price by `share × (projection − books)`. Near the money the median gap is about 0.45 logit, so a share of 0.1 is about 1 point of probability. A market maker's overround is 7%.

