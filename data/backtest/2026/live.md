# Live backtest — 2026, through week 11

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
| 8 | main | pool | 11,804 | 5,062 | 7 | 68 | 21% | 1 |
| 8 | saturday | pool | 23,334 | 6,723 | 9 | 1,020 | 67% | 21 |
| 8 | thursday | pool | 22,481 | 6,362 | 9 | 918 | 71% | 28 |
| 9 | main | pool | 6,135 | 2,037 | 8 | 66 | 73% | 16 |
| 9 | saturday | pool | 24,859 | 7,231 | 9 | 1,038 | 68% | 17 |
| 9 | thursday | pool | 22,266 | 6,760 | 9 | 830 | 69% | 16 |
| 10 | main | pool | 4,931 | 1,712 | 8 | 56 | 73% | 10 |
| 10 | saturday | pool | 24,095 | 6,779 | 9 | 1,016 | 67% | 12 |
| 10 | thursday | pool | 22,567 | 6,580 | 9 | 688 | 69% | 28 |
| 11 | main | pool | 8,205 | 2,770 | 8 | 72 | 73% | 4 |
| 11 | saturday | pool | 22,095 | 6,196 | 9 | 912 | 67% | 15 |
| 11 | thursday | pool | 19,866 | 5,787 | 9 | 806 | 68% | 8 |

## 2. Pricing on live boards

Brier score against what happened, markets within 0.25 of 50/50 by the book's price (lower is better). Gap = worse than the reference, clustered by player-week.

|  | markets | player-weeks | book | projection | pool | projection − book | pool − book |
| --- | --- | --- | --- | --- | --- | --- | --- |
| week 1 | 449 | 178 | 0.2490 | 0.2602 | 0.2488 | +0.0112 (z 1.5) | -0.0002 (z -1.3) |
| week 2 | 124 | 14 | 0.2523 | 0.2979 | 0.2522 | +0.0457 (z 2.5) | -0.0001 (z -0.3) |
| week 3 | 233 | 27 | 0.2330 | 0.2398 | 0.2333 | +0.0067 (z 0.6) | +0.0002 (z 0.5) |
| week 4 | 469 | 50 | 0.2391 | 0.2563 | 0.2392 | +0.0172 (z 1.7) | +0.0001 (z 0.5) |
| week 5 | 4,557 | 198 | 0.2341 | 0.2466 | 0.2341 | +0.0125 (z 2.6) | +0.0000 (z 0.1) |
| week 6 | 4,409 | 193 | 0.2305 | 0.2497 | 0.2305 | +0.0192 (z 2.8) | -0.0001 (z -0.5) |
| week 7 | 4,390 | 194 | 0.2357 | 0.2428 | 0.2356 | +0.0071 (z 1.1) | -0.0001 (z -0.6) |
| week 8 | 3,454 | 194 | 0.2357 | 0.2564 | 0.2355 | +0.0207 (z 3.6) | -0.0002 (z -1.7) |
| week 9 | 3,728 | 204 | 0.2305 | 0.2462 | 0.2301 | +0.0157 (z 2.8) | -0.0004 (z -2.9) |
| week 10 | 3,686 | 199 | 0.2364 | 0.2475 | 0.2364 | +0.0111 (z 2.4) | +0.0000 (z 0.3) |
| week 11 | 3,647 | 187 | 0.2319 | 0.2403 | 0.2315 | +0.0084 (z 1.6) | -0.0003 (z -2.6) |
| **all weeks** | 29,146 | 1638 | 0.2339 | 0.2475 | 0.2338 | +0.0135 (z 6.4) | -0.0001 (z -2.8) |

The z-scores use cluster-robust errors, which are unreliable under about 30 player-weeks (weeks 2, 3). Read the all-weeks row.

## 2b. Monitor: does the projection say anything about long-shot overs?

Overs the books price at 3–15% (the high rungs of the alternate-line ladders). The projection's share of the price is zero everywhere near 50/50; this is the one band that showed any lean, and **it is a monitor, not a price**: nothing here reaches the pool.

share = how far to move the books' price toward the projection to match what happened (0 = ignore it, 1 = believe it). Unpenalised, so it is the raw number and its error, not the cautious one the price would use.

|  | markets | player-weeks | share (±95%) | books | projection | happened |
| --- | --- | --- | --- | --- | --- | --- |
| week 2 | 41 | 13 | 0.08 ±0.67 | 10.2% | 8.2% | 14.6% |
| week 3 | 94 | 26 | 0.30 ±0.57 | 9.7% | 7.9% | 4.3% |
| week 4 | 227 | 47 | -0.31 ±0.27 | 9.4% | 5.1% | 18.1% |
| week 5 | 2,244 | 198 | 0.15 ±0.25 | 9.1% | 6.0% | 10.7% |
| week 6 | 2,123 | 192 | 0.13 ±0.19 | 9.3% | 5.9% | 6.3% |
| week 7 | 2,149 | 192 | 0.08 ±0.23 | 9.3% | 5.4% | 7.1% |
| week 8 | 1,429 | 194 | 0.01 ±0.20 | 9.7% | 5.8% | 9.4% |
| week 9 | 1,509 | 201 | 0.15 ±0.23 | 9.8% | 6.1% | 7.6% |
| week 10 | 1,525 | 196 | 0.18 ±0.43 | 9.9% | 11.6% | 9.9% |
| week 11 | 1,435 | 187 | 0.04 ±0.39 | 10.2% | 12.6% | 7.8% |
| **all weeks** | 12,776 | 1446 | 0.09 ±0.09 | 9.6% | 7.3% | 8.5% |

Walk-forward (each week priced with the share fitted on earlier weeks, floored at 0; weeks 4 @ 0.19, 5 @ 0.00, 6 @ 0.07, 7 @ 0.10, 8 @ 0.09, 9 @ 0.07, 10 @ 0.08, 11 @ 0.09): Brier -0.0000 against the books' pool (z -0.3, 1407 player-weeks). Positive = worse than the books, negative = better.

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
| 7 | saturday | pool | 44 | 25 | 23 | 0 + 2 no line | -69.7% ±39% | -72.1% | 9% of 22, -0.0 pts |
| 7 | thursday | pool | 38 | 16 | 15 | 0 + 1 no line | -48.3% ±75% | -51.5% | 27% of 15, +0.2 pts |
| 8 | main | pool | 1 | 1 | 1 | 0 | -100.0% ±?% | -100.0% | – |
| 8 | saturday | pool | 21 | 9 | 7 | 0 + 2 no line | -21.4% ±157% | -38.9% | 17% of 6, -0.2 pts |
| 8 | thursday | pool | 28 | 20 | 18 | 0 + 2 no line | -22.4% ±106% | -30.2% | 50% of 20, +2.1 pts |
| 9 | main | pool | 16 | 3 | 3 | 0 | -100.0% ±0% | -100.0% | 100% of 3, +4.5 pts |
| 9 | saturday | pool | 17 | 12 | 11 | 0 + 1 no line | -0.6% ±156% | -8.9% | 18% of 11, +0.1 pts |
| 9 | thursday | pool | 16 | 13 | 11 | 0 + 1 no line + 1 ungradable | +4.2% ±103% | +4.2% | 50% of 12, +1.1 pts |
| 10 | main | pool | 10 | 3 | 3 | 0 | -100.0% ±0% | -100.0% | 0% of 2, -1.8 pts |
| 10 | saturday | pool | 12 | 9 | 9 | 0 | -100.0% ±0% | -100.0% | 33% of 9, +1.0 pts |
| 10 | thursday | pool | 28 | 15 | 15 | 0 | -8.3% ±85% | -8.3% | 69% of 13, +2.3 pts |
| 11 | main | pool | 4 | 1 | 0 | 1 | – | – | – |
| 11 | saturday | pool | 15 | 11 | 11 | 0 | -57.1% ±86% | -57.1% | 40% of 10, +0.7 pts |
| 11 | thursday | pool | 8 | 5 | 5 | 0 | -100.0% ±0% | -100.0% | 60% of 5, +2.9 pts |
| **all** |  |  |  | 454 | 422 | 1 + 19 no line + 12 ungradable | **-1.8% ±22%** | -4.8% | 40% of 370, +0.3 pts |

Verdict on the live total: **within noise**. "Rows at the edge bar" are the rows on the board that clear the minimum edge; the bets are what is left after the Firehose keeps one price per player and stat and the calibration guards (support floor, 20-point disagreement cap) are applied.

By the price the board was captured under:

| price | bets | settled | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- |
| projection | 227 | 208 | +10.9% ±28% | 40% of 164, -0.5 pts |
| pool | 227 | 214 | -14.2% ±34% | 41% of 206, +1.0 pts |

## 3b. CLV by book

Where the bets came from and what their prices were worth. Each bet is taken at the best price across the books, so a book appears here when it was the best price. **Own close** is the ledger's CLV: that book's closing price on the same line. **Market close** is the closing fair price of the *other* books on that line (at least two of them). They can disagree: a slow book that never moves scores about zero against its own close even when its price was stale against everyone else. † = fewer than 20 measurable bets. ±2σ.

| book | bets | settled | ROI (±2σ) | own close: measurable · beat · avg | market close: measurable · beat · avg |
| --- | --- | --- | --- | --- | --- |
| DraftKings | 198 | 188 | -10.9% ±35% | 168 · 47% · +0.7 pts | 87 · 69% · +1.4 ±0.7 pts |
| BetRivers | 104 | 90 | +5.9% ±46% | 89 · 48% · +1.1 pts | 87 · 82% · +3.0 ±0.8 pts |
| Hard Rock | 82 | 78 | -35.1% ±22% | 60 · 10% · -2.6 pts | 23 · 52% · +0.7 ±1.2 pts |
| FanDuel | 26 | 25 | +14.7% ±55% | 22 · 41% · +0.2 pts | 22 · 45% · +0.5 ±2.2 pts |
| Caesars | 24 | 22 | +22.2% ±92% | 20 · 35% · +1.8 pts | 20 · 55% · +1.3 ±3.1 pts |
| theScore | 13 | 12 | +215.4% ±335% | 10 · 50% · +1.8 pts † | 5 · 80% · +4.2 ±2.9 pts † |
| Betr | 3 | 3 | -36.4% ±127% | – | – |
| BetMGM | 2 | 2 | +76.7% ±28% | 1 · 0% · -2.4 pts † | 2 · 50% · -0.5 ±3.7 pts † |
| Circa | 2 | 2 | -4.5% ±191% | – | – |

9 books. 208 of 454 bets have no market close: fewer than two other books quoted that exact line at the close, which is common for the one-sided alternate lines the slow books post.

## 4. The same live boards under the other price

Each live board re-priced under the model it was *not* captured under and run through the same persona engine: boards captured on the projection price with the pool as it would have stood that week (weights fitted on earlier weeks), and boards captured on the pool with the projection price. The two directions are separate questions and are not added together.

|  | bets | settled | pending | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- | --- |
| projection-priced boards (5): as captured | 227 | 208 | 0 + 8 no line + 11 ungradable | +10.9% ±28% | 40% of 164, -0.5 pts |
| … re-priced with the pool | 14 | 14 | 0 | +195.6% ±225% | 79% of 14, +3.5 pts |
| pool-priced boards (20): as captured | 227 | 214 | 1 + 11 no line + 1 ungradable | -14.2% ±34% | 41% of 206, +1.0 pts |
| … re-priced with the projection | 3576 | 3285 | 19 + 138 no line + 134 ungradable | +0.6% ±5% | 31% of 3055, -0.4 pts |

Boards: week 1 main, week 2 main, week 3 main, week 4 main, week 5 main (projection → pool); week 5 saturday, week 5 thursday, week 6 main, week 6 saturday, week 6 thursday, week 7 main, week 7 saturday, week 7 thursday, week 8 main, week 8 saturday, week 8 thursday, week 9 main, week 9 saturday, week 9 thursday, week 10 main, week 10 saturday, week 10 thursday, week 11 main, week 11 saturday, week 11 thursday (pool → projection).

## 5. Every persona, live only

| persona | bets | settled | pending | ROI (±2σ) | CLV: beat the close |
| --- | --- | --- | --- | --- | --- |
| The Firehose | 454 | 422 | 1 + 19 no line + 12 ungradable | -1.8% ±22% | 40% of 370, +0.3 pts |
| The Disciplined Flat Bettor | 63 | 62 | 0 + 1 no line | -67.7% ±29% | 55% of 53, +1.1 pts |
| The Line Shopper | 70 | 65 | 1 + 4 no line | -51.0% ±32% | 49% of 59, +1.0 pts |
| The Kelly Compounder | 166 | 157 | 1 + 8 no line | +1.6% ±50% | 41% of 152, +0.7 pts |
| The Weekly Budget | 70 | 65 | 1 + 4 no line | -52.6% ±32% | 49% of 59, +1.0 pts |
| The Purist | 22 | 21 | 0 + 1 no line | +16.5% ±52% | 33% of 15, -0.5 pts |

## 6. Can you read it?

- **Settled live bets: 422.** A verdict needs at least 200, and the per-bet spread is 2.26 units.
- Seeing an ROI of -1.8% at two sigma takes about 59,801 settled bets; you have 422.
- Seeing a **5%** ROI takes about 8,183 settled bets. At the current 38 settled a week that is about 203 more weeks — longer than a season.
- CLV resolves far faster than ROI because it is a price difference, not a coin flip, but it is partly mechanical: a slow book's off-market price stays off-market until the close.
- Pending bets in finished weeks have no stat line. For an over that is almost always a loss the settlement cannot see; the conservative column counts them.
- Bets on one player are correlated, so the bands are if anything too narrow.
