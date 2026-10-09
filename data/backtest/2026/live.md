# Live backtest — 2026, through week 5

Live means the main, thursday, saturday captures: the prices and the projection that existed when the board was taken. Backfilled boards (opening, closing) are reconstructions with hindsight and are excluded. The Firehose takes every bettable edge of at least 3% at one unit, at the best price per player and stat.

## 1. Boards

| week | slot | priced by | rows | markets | books | Pinnacle rows | one-sided | rows at the edge bar |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | main | projection | 5,382 | 1,351 | 9 | 0 | 0% | 1606 |
| 2 | main | projection | 2,982 | 1,046 | 7 | 0 | 57% | 564 |
| 3 | main | projection | 4,641 | 1,594 | 7 | 0 | 49% | 1057 |
| 4 | main | projection | 20,550 | 8,993 | 7 | 0 | 22% | 4203 |
| 5 | main | projection | 23,197 | 10,066 | 7 | 0 | 23% | 4176 |
| 5 | thursday | pool | 68,002 | 27,432 | 9 | 952 | 25% | 33 |

## 2. Pricing on live boards

Brier score against what happened, markets within 0.25 of 50/50 by the book's price (lower is better). Gap = worse than the reference, clustered by player-week.

|  | markets | player-weeks | book | projection | pool | projection − book | pool − book |
| --- | --- | --- | --- | --- | --- | --- | --- |
| week 1 | 449 | 178 | 0.2490 | 0.2602 | 0.2488 | +0.0112 (z 1.5) | -0.0002 (z -1.3) |
| week 2 | 124 | 14 | 0.2523 | 0.2979 | 0.2522 | +0.0457 (z 2.5) | -0.0001 (z -0.3) |
| week 3 | 233 | 27 | 0.2331 | 0.2398 | 0.2333 | +0.0067 (z 0.6) | +0.0002 (z 0.5) |
| week 4 | 469 | 50 | 0.2391 | 0.2563 | 0.2392 | +0.0172 (z 1.7) | +0.0001 (z 0.5) |
| week 5 | 303 | 16 | 0.2182 | 0.2144 | 0.2166 | -0.0038 (z -0.3) | -0.0016 (z -3.4) |
| **all weeks** | 1,578 | 285 | 0.2380 | 0.2502 | 0.2377 | +0.0122 (z 2.4) | -0.0003 (z -2.0) |

The z-scores use cluster-robust errors, which are unreliable under about 30 player-weeks (weeks 2, 3, 5). Read the all-weeks row.

## 3. Bets: the Firehose, live only

| week | slot | priced by | rows at the edge bar | bets | settled | pending | ROI (±2σ) | ROI if no-line overs lose | CLV: beat the close |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | main | projection | 1606 | 18 | 18 | 0 | -3.6% ±47% | -3.6% | – |
| 2 | main | projection | 564 | 10 | 10 | 0 | +138.1% ±373% | +138.1% | 38% of 8, -0.9 pts |
| 3 | main | projection | 1057 | 26 | 24 | 0 + 2 ungradable | +23.1% ±60% | +23.1% | 40% of 20, +0.3 pts |
| 4 | main | projection | 4203 | 41 | 34 | 0 + 5 no line + 2 ungradable | +23.0% ±59% | +19.4% | 33% of 27, -1.8 pts |
| 5 | main | projection | 4176 | 132 | 31 | 94 + 7 ungradable | -10.8% ±55% | -10.8% | 54% of 28, +0.5 pts |
| 5 | thursday | pool | 33 | 22 | 2 | 20 | +164.5% ±529% | +164.5% | 0% of 2, +0.0 pts |
| **all** |  |  |  | 249 | 119 | 114 + 5 no line + 11 ungradable | **+22.2% ±41%** | +21.2% | 41% of 85, -0.4 pts |

Verdict on the live total: **too few to say (119 < 200)**. "Rows at the edge bar" are the rows on the board that clear the minimum edge; the bets are what is left after the Firehose keeps one price per player and stat and the calibration guards (support floor, 20-point disagreement cap) are applied.

By the price the board was captured under:

| price | bets | settled | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- |
| projection | 227 | 117 | +19.8% ±41% | 42% of 83, -0.4 pts |
| pool | 22 | 2 | +164.5% ±529% | 0% of 2, +0.0 pts |

## 4. The same live boards under the other price

Each live board re-priced under the model it was *not* captured under and run through the same persona engine: boards captured on the projection price with the pool as it would have stood that week (weights fitted on earlier weeks), and boards captured on the pool with the projection price. The two directions are separate questions and are not added together.

|  | bets | settled | pending | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- | --- |
| projection-priced boards (5): as captured | 227 | 117 | 94 + 5 no line + 11 ungradable | +19.8% ±41% | 42% of 83, -0.4 pts |
| … re-priced with the pool | 12 | 11 | 1 | +129.0% ±212% | 73% of 11, +3.5 pts |
| pool-priced boards (1): as captured | 22 | 2 | 20 | +164.5% ±529% | 0% of 2, +0.0 pts |
| … re-priced with the projection | 412 | 36 | 355 + 21 ungradable | +35.7% ±56% | 0% of 39, -1.3 pts |

Boards: week 1 main, week 2 main, week 3 main, week 4 main, week 5 main (projection → pool); week 5 thursday (pool → projection).

## 5. Every persona, live only

| persona | bets | settled | pending | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- | --- |
| The Firehose | 249 | 119 | 114 + 5 no line + 11 ungradable | +22.2% ±41% | 41% of 85, -0.4 pts |
| The Disciplined Flat Bettor | 13 | 5 | 8 | -66.3% ±67% | 50% of 2, +3.2 pts |
| The Line Shopper | 10 | 2 | 8 | +107.0% ±76% | 100% of 1, +4.5 pts |
| The Kelly Compounder | 30 | 8 | 22 | +71.2% ±475% | 83% of 6, +2.0 pts |
| The Weekly Budget | 10 | 2 | 8 | +109.2% ±76% | 100% of 1, +4.5 pts |
| The Purist | 16 | 3 | 13 | +119.6% ±140% | 67% of 3, +2.5 pts |

## 6. Can you read it?

- **Settled live bets: 119.** A verdict needs at least 200, and the per-bet spread is 2.23 units.
- Seeing an ROI of +22.2% at two sigma takes about 402 settled bets; you have 119.
- Seeing a **5%** ROI takes about 7,926 settled bets. At the current 24 settled a week that is about 329 more weeks — longer than a season.
- CLV resolves far faster than ROI because it is a price difference, not a coin flip, but it is partly mechanical: a slow book's off-market price stays off-market until the close.
- Pending bets in finished weeks have no stat line. For an over that is almost always a loss the settlement cannot see; the conservative column counts them.
- Bets on one player are correlated, so the bands are if anything too narrow.
