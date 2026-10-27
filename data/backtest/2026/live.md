# Live backtest — 2026, through week 7

Live means the main, thursday, saturday captures: the prices and the projection that existed when the board was taken. Backfilled boards (opening, closing) are reconstructions with hindsight and are excluded. The Firehose takes every bettable edge of at least 3% at one unit, at the best price per player and stat.

## 1. Boards

| week | slot | priced by | rows | markets | books | Pinnacle rows | one-sided | rows at the edge bar |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | main | projection | 5,382 | 1,351 | 9 | 0 | 0% | 1606 |
| 2 | main | projection | 2,982 | 1,046 | 7 | 0 | 57% | 564 |
| 3 | main | projection | 4,641 | 1,594 | 7 | 0 | 49% | 1057 |
| 4 | main | projection | 20,550 | 8,993 | 7 | 0 | 22% | 4203 |
| 5 | main | projection | 23,197 | 10,066 | 7 | 0 | 23% | 4176 |
| 5 | saturday | pool | 73,668 | 29,283 | 9 | 1,026 | 26% | 31 |
| 5 | thursday | pool | 68,002 | 27,432 | 9 | 952 | 25% | 33 |
| 6 | main | pool | 25,744 | 10,928 | 8 | 176 | 22% | 12 |
| 6 | saturday | pool | 71,199 | 28,517 | 9 | 964 | 25% | 41 |
| 6 | thursday | pool | 62,987 | 25,566 | 9 | 810 | 24% | 29 |
| 7 | main | pool | 22,666 | 9,523 | 8 | 88 | 23% | 6 |
| 7 | saturday | pool | 52,647 | 20,208 | 9 | 900 | 32% | 44 |
| 7 | thursday | pool | 69,880 | 27,770 | 9 | 848 | 25% | 38 |

## 2. Pricing on live boards

Brier score against what happened, markets within 0.25 of 50/50 by the book's price (lower is better). Gap = worse than the reference, clustered by player-week.

|  | markets | player-weeks | book | projection | pool | projection − book | pool − book |
| --- | --- | --- | --- | --- | --- | --- | --- |
| week 1 | 449 | 178 | 0.2490 | 0.2602 | 0.2488 | +0.0112 (z 1.4) | -0.0002 (z -1.3) |
| week 2 | 124 | 14 | 0.2523 | 0.2979 | 0.2522 | +0.0456 (z 2.5) | -0.0001 (z -0.3) |
| week 3 | 233 | 27 | 0.2331 | 0.2398 | 0.2333 | +0.0067 (z 0.6) | +0.0002 (z 0.5) |
| week 4 | 470 | 50 | 0.2387 | 0.2559 | 0.2388 | +0.0172 (z 1.7) | +0.0001 (z 0.4) |
| week 5 | 4,556 | 198 | 0.2340 | 0.2465 | 0.2340 | +0.0124 (z 2.5) | +0.0000 (z 0.1) |
| week 6 | 4,410 | 193 | 0.2305 | 0.2497 | 0.2305 | +0.0192 (z 2.9) | -0.0001 (z -0.5) |
| week 7 | 4,388 | 194 | 0.2355 | 0.2427 | 0.2354 | +0.0072 (z 1.1) | -0.0001 (z -0.6) |
| **all weeks** | 14,630 | 854 | 0.2342 | 0.2474 | 0.2341 | +0.0132 (z 4.0) | -0.0000 (z -0.6) |

The z-scores use cluster-robust errors, which are unreliable under about 30 player-weeks (weeks 2, 3). Read the all-weeks row.

## 2b. Monitor: does the projection say anything about long-shot overs?

Overs the books price at 3–15% (the high rungs of the alternate-line ladders). The projection's share of the price is zero everywhere near 50/50; this is the one band that showed any lean, and **it is a monitor, not a price**: nothing here reaches the pool.

share = how far to move the books' price toward the projection to match what happened (0 = ignore it, 1 = believe it). Unpenalised, so it is the raw number and its error, not the cautious one the price would use.

|  | markets | player-weeks | share (±95%) | books | projection | happened |
| --- | --- | --- | --- | --- | --- | --- |
| week 2 | 42 | 13 | 0.09 ±0.68 | 10.3% | 8.1% | 14.3% |
| week 3 | 95 | 26 | 0.30 ±0.58 | 9.7% | 7.9% | 4.2% |
| week 4 | 227 | 47 | -0.31 ±0.27 | 9.4% | 5.1% | 18.1% |
| week 5 | 2,245 | 198 | 0.15 ±0.25 | 9.1% | 6.0% | 10.6% |
| week 6 | 2,124 | 192 | 0.13 ±0.19 | 9.3% | 5.9% | 6.3% |
| week 7 | 2,149 | 192 | 0.08 ±0.23 | 9.3% | 5.4% | 7.1% |
| **all weeks** | 6,882 | 668 | 0.09 ±0.12 | 9.3% | 5.8% | 8.4% |

Walk-forward (each week priced with the share fitted on earlier weeks, floored at 0; weeks 4 @ 0.20, 5 @ 0.00, 6 @ 0.07, 7 @ 0.10): Brier +0.0000 against the books' pool (z 0.1, 629 player-weeks). Positive = worse than the books, negative = better.

**Status: no evidence.** Nothing a price could use yet.

"Happened" tends to sit above both prices: the actuals feed omits players with an all-zero line, which tilts outcomes toward overs. Read the share (a difference between two prices), not the level.

## 3. Bets: the Firehose, live only

| week | slot | priced by | rows at the edge bar | bets | settled | pending | ROI (±2σ) | ROI if no-line overs lose | CLV: beat the close |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | main | projection | 1606 | 18 | 18 | 0 | -3.6% ±47% | -3.6% | – |
| 2 | main | projection | 564 | 10 | 10 | 0 | +138.1% ±373% | +138.1% | 38% of 8, -0.9 pts |
| 3 | main | projection | 1057 | 26 | 24 | 0 + 2 ungradable | +23.1% ±60% | +23.1% | 40% of 20, +0.3 pts |
| 4 | main | projection | 4203 | 41 | 34 | 0 + 5 no line + 2 ungradable | +23.0% ±59% | +19.4% | 33% of 27, -1.8 pts |
| 5 | main | projection | 4176 | 132 | 122 | 0 + 3 no line + 7 ungradable | -3.2% ±31% | -4.7% | 41% of 109, -0.4 pts |
| 5 | saturday | pool | 31 | 21 | 21 | 0 | -6.6% ±110% | -6.6% | 24% of 21, +0.8 pts |
| 5 | thursday | pool | 33 | 13 | 12 | 0 + 1 no line | +57.3% ±187% | +45.2% | 55% of 11, +0.9 pts |
| 6 | main | pool | 12 | 11 | 10 | 0 + 1 no line | +160.4% ±305% | +136.7% | 89% of 9, +2.4 pts |
| 6 | saturday | pool | 41 | 22 | 22 | 0 | +32.5% ±167% | +32.5% | 35% of 20, +0.8 pts |
| 6 | thursday | pool | 29 | 13 | 13 | 0 | +3.4% ±178% | +3.4% | 54% of 13, +0.7 pts |
| 7 | main | pool | 6 | 4 | 4 | 0 | -66.1% ±68% | -66.1% | 100% of 4, +0.9 pts |
| 7 | saturday | pool | 44 | 25 | 23 | 2 | -69.7% ±39% | -69.7% | 9% of 22, -0.0 pts |
| 7 | thursday | pool | 38 | 16 | 15 | 1 | -48.3% ±75% | -48.3% | 27% of 15, +0.2 pts |
| **all** |  |  |  | 352 | 328 | 3 + 10 no line + 11 ungradable | **+7.9% ±26%** | +6.3% | 39% of 279, -0.1 pts |

Verdict on the live total: **within noise**. "Rows at the edge bar" are the rows on the board that clear the minimum edge; the bets are what is left after the Firehose keeps one price per player and stat and the calibration guards (support floor, 20-point disagreement cap) are applied.

By the price the board was captured under:

| price | bets | settled | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- |
| projection | 227 | 208 | +10.9% ±28% | 40% of 164, -0.5 pts |
| pool | 125 | 120 | +2.7% ±53% | 37% of 115, +0.7 pts |

## 3b. CLV by book

Where the bets came from and what their prices were worth. Each bet is taken at the best price across the books, so a book appears here when it was the best price. **Own close** is the ledger's CLV: that book's closing price on the same line. **Market close** is the closing fair price of the *other* books on that line (at least two of them). They can disagree: a slow book that never moves scores about zero against its own close even when its price was stale against everyone else. † = fewer than 20 measurable bets. ±2σ.

| book | bets | settled | ROI (±2σ) | own close: measurable · beat · avg | market close: measurable · beat · avg |
| --- | --- | --- | --- | --- | --- |
| DraftKings | 159 | 151 | +2.3% ±42% | 134 · 45% · +0.5 pts | 73 · 67% · +1.1 ±0.7 pts |
| Hard Rock | 82 | 78 | -35.1% ±22% | 60 · 10% · -2.6 pts | 23 · 52% · +0.7 ±1.2 pts |
| BetRivers | 50 | 41 | +37.9% ±78% | 41 · 56% · +1.0 pts | 39 · 64% · +1.4 ±1.2 pts |
| FanDuel | 22 | 22 | +23.6% ±61% | 18 · 44% · +0.4 pts † | 18 · 39% · -0.3 ±2.2 pts † |
| Caesars | 20 | 18 | +10.5% ±88% | 16 · 38% · +0.5 pts † | 16 · 44% · -0.8 ±1.6 pts † |
| theScore | 12 | 11 | +244.1% ±362% | 9 · 56% · +2.1 pts † | 5 · 80% · +4.2 ±2.9 pts † |
| Betr | 3 | 3 | -36.4% ±127% | – | – |
| BetMGM | 2 | 2 | +76.7% ±28% | 1 · 0% · -2.4 pts † | 2 · 50% · -0.5 ±3.6 pts † |
| Circa | 2 | 2 | -4.5% ±191% | – | – |

9 books. 176 of 352 bets have no market close: fewer than two other books quoted that exact line at the close, which is common for the one-sided alternate lines the slow books post.

## 4. The same live boards under the other price

Each live board re-priced under the model it was *not* captured under and run through the same persona engine: boards captured on the projection price with the pool as it would have stood that week (weights fitted on earlier weeks), and boards captured on the pool with the projection price. The two directions are separate questions and are not added together.

|  | bets | settled | pending | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- | --- |
| projection-priced boards (5): as captured | 227 | 208 | 0 + 8 no line + 11 ungradable | +10.9% ±28% | 40% of 164, -0.5 pts |
| … re-priced with the pool | 14 | 14 | 0 | +195.6% ±225% | 79% of 14, +3.5 pts |
| pool-priced boards (8): as captured | 125 | 120 | 3 + 2 no line | +2.7% ±53% | 37% of 115, +0.7 pts |
| … re-priced with the projection | 1562 | 1443 | 21 + 37 no line + 61 ungradable | +3.7% ±7% | 23% of 1359, -1.1 pts |

Boards: week 1 main, week 2 main, week 3 main, week 4 main, week 5 main (projection → pool); week 5 saturday, week 5 thursday, week 6 main, week 6 saturday, week 6 thursday, week 7 main, week 7 saturday, week 7 thursday (pool → projection).

## 5. Every persona, live only

| persona | bets | settled | pending | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- | --- |
| The Firehose | 352 | 328 | 3 + 10 no line + 11 ungradable | +7.9% ±26% | 39% of 279, -0.1 pts |
| The Disciplined Flat Bettor | 33 | 32 | 0 + 1 no line | -78.2% ±21% | 56% of 25, +0.9 pts |
| The Line Shopper | 30 | 29 | 0 + 1 no line | -54.7% ±35% | 58% of 24, +1.0 pts |
| The Kelly Compounder | 80 | 77 | 2 + 1 no line | +27.8% ±93% | 37% of 76, +0.4 pts |
| The Weekly Budget | 30 | 29 | 0 + 1 no line | -55.1% ±35% | 58% of 24, +1.0 pts |
| The Purist | 20 | 20 | 0 | +14.6% ±54% | 36% of 14, -0.2 pts |

## 6. Can you read it?

- **Settled live bets: 328.** A verdict needs at least 200, and the per-bet spread is 2.38 units.
- Seeing an ROI of +7.9% at two sigma takes about 3,654 settled bets; you have 328.
- Seeing a **5%** ROI takes about 9,092 settled bets. At the current 47 settled a week that is about 188 more weeks — longer than a season.
- CLV resolves far faster than ROI because it is a price difference, not a coin flip, but it is partly mechanical: a slow book's off-market price stays off-market until the close.
- Pending bets in finished weeks have no stat line. For an over that is almost always a loss the settlement cannot see; the conservative column counts them.
- Bets on one player are correlated, so the bands are if anything too narrow.
