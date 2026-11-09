# Distribution lab — 2026

Weeks scored: 2, 3, 4, 5, 6, 7, 8, 9 (every fit is as of the week it is applied to, so the earliest weeks only train). 5,163 player-week/stat records and 34,243 live-board rungs. 19,540 rungs use the projection the capture had; 15,172 use the latest committed snapshot, which has read everything since and flatters the projection. That is the same for every model below, so it does not tilt the comparison between them, but it does flatter all of them against the books.

Models:

- **tpn** — two-piece normal (today)
- **tpnWide** — two-piece normal, band widened by a multiplier fitted on earlier weeks (control)
- **normalLaw** — normal with the SAME variance law as gammaLaw (control: isolates shape)
- **gammaExact** — gamma through F/M/C (shifted)
- **gammaLS** — gamma, least squares to F/M/C (from zero)
- **gammaLaw** — gamma, variance law from actuals (Feller/CIR-type)
- **tweedie** — compound Poisson-gamma (Tweedie), variance law (Levy-type, atom at zero)

Counts and yardage totals are integers, so every model is read on the same lattice: integer *a* is the interval [a − ½, a + ½), and a whole-number line prices P(over | no push). The law-based models are centred on the mean of the gamma fitted to Floor/Median/Ceiling; only the spread (and shape) differs, so any gain over `tpn` is about spread and shape, not location.

The two controls matter. `tpnWide` gives the current model the best single band multiplier per stat from earlier weeks; `normalLaw` gives a normal exactly the variance law that `gammaLaw` uses. Credit goes to the gamma/Tweedie *shape* only for what they earn over `normalLaw`, and to the *variance law* only for what `normalLaw` earns over `tpnWide`.

## 1. Shape: how well does each model describe where the stat lands?

Average log-probability the model gave the actual outcome, higher is better, with the difference from the two-piece normal in parentheses. Each player-week-stat counts once.

| stat | n | tpn | tpnWide | normalLaw | gammaExact | gammaLS | gammaLaw | tweedie |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| passYds | 181 | -5.700 | -5.700 (+0.000) | -5.704 (-0.004) | -5.703 (-0.003) | -5.912 (-0.212) | -5.980 (-0.280) | -5.709 (-0.009) |
| passAtt | 181 | -3.882 | -3.699 (+0.183) | -3.611 (+0.271) | -3.717 (+0.165) | -3.870 (+0.013) | -3.784 (+0.098) | -3.660 (+0.222) |
| completions | 181 | -3.267 | -3.267 (+0.000) | -3.248 (+0.019) | -3.256 (+0.011) | -3.475 (-0.208) | -3.519 (-0.251) | -3.278 (-0.011) |
| rushYds | 747 | -5.086 | -4.828 (+0.258) | -4.504 (+0.582) | -6.014 (-0.928) | -5.419 (-0.332) | -4.736 (+0.350) | -4.744 (+0.343) |
| rushAtt | 697 | -3.643 | -3.271 (+0.372) | -2.763 (+0.880) | -4.027 (-0.384) | -3.146 (+0.497) | -2.651 (+0.992) | -2.655 (+0.988) |
| receptions | 1549 | -2.150 | -2.129 (+0.021) | -2.000 (+0.150) | -2.733 (-0.583) | -2.039 (+0.111) | -1.920 (+0.230) | -1.905 (+0.245) |
| recYds | 1627 | -5.118 | -4.847 (+0.271) | -4.569 (+0.549) | -5.375 (-0.257) | -5.075 (+0.043) | -4.526 (+0.592) | -4.426 (+0.693) |
| **all (weighted)** | 5163 | -3.936 | -3.750 (+0.186) | -3.505 (+0.431) | -4.372 (-0.436) | -3.884 (+0.052) | -3.511 (+0.425) | -3.454 (+0.482) |
| paired vs tpn (clustered z) |  | — | z 7.9 | z 10.3 | z -5.7 | z 1.0 | z 7.6 | z 9.1 |

Calibration of the PIT: how often the actual landed in the middle 50% (target 50%) / outside the 5–95% range (target 10%) / was given under 0.1% (a model that rules the outcome out):

| stat | tpn | tpnWide | normalLaw | gammaExact | gammaLS | gammaLaw | tweedie |
| --- | --- | --- | --- | --- | --- | --- | --- |
| passYds | 47% / 10% / 7.2% | 47% / 10% / 7.2% | 51% / 8% / 4.4% | 47% / 10% / 6.1% | 46% / 12% / 6.6% | 61% / 4% / 2.8% | 55% / 6% / 3.3% |
| passAtt | 45% / 19% / 9.4% | 56% / 13% / 2.2% | 58% / 12% / 1.7% | 46% / 18% / 5.5% | 46% / 19% / 4.4% | 64% / 5% / 1.1% | 58% / 11% / 1.1% |
| completions | 52% / 9% / 2.2% | 52% / 9% / 2.2% | 51% / 10% / 1.7% | 54% / 8% / 1.7% | 51% / 9% / 1.1% | 62% / 6% / 1.1% | 52% / 9% / 1.1% |
| rushYds | 38% / 21% / 8.2% | 64% / 8% / 3.9% | 45% / 8% / 3.5% | 36% / 26% / 11.2% | 36% / 31% / 12.9% | 48% / 14% / 4.1% | 47% / 12% / 4.8% |
| rushAtt | 42% / 24% / 7.2% | 66% / 8% / 2.6% | 52% / 8% / 1.1% | 40% / 24% / 7.2% | 40% / 25% / 4.9% | 51% / 11% / 0.9% | 50% / 10% / 1.0% |
| receptions | 52% / 11% / 2.2% | 55% / 9% / 1.4% | 51% / 7% / 0.7% | 51% / 12% / 3.7% | 51% / 12% / 0.6% | 55% / 8% / 0.1% | 53% / 8% / 0.3% |
| recYds | 36% / 18% / 9.6% | 67% / 8% / 3.8% | 53% / 7% / 3.2% | 36% / 21% / 9.6% | 35% / 31% / 10.0% | 49% / 10% / 2.7% | 48% / 10% / 4.2% |

`gammaExact` is shifted: through all three of Floor/Median/Ceiling the lower bound usually lands above zero, so any outcome under it has no probability at all. That last column is the cost.

### The variance law fitted on actuals

`Var = φ · mean^p`. p near 1 is Poisson-like (a Feller/CIR diffusion from zero has a gamma terminal law with exactly this; so does a compound Poisson process); p near 2 is a constant coefficient of variation (a geometric-type diffusion). In-sample on all graded weeks, for reading. A narrow range of means (quarterbacks) cannot identify p, so read the SD, not the exponent. SD is at the stat's median projected mean.

| stat | n | median mean | gamma p | gamma φ | SD at median mean | CV | Tweedie p | normal p |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| passYds | 245 | 228.5 | 0.00 | 8454.42 | 91.9 | 40% | 1.05 | 0.50 |
| passAtt | 245 | 31.4 | 0.00 | 113.02 | 10.6 | 34% | 1.10 | 0.75 |
| completions | 245 | 20.5 | 0.00 | 62.04 | 7.9 | 38% | 1.05 | 1.00 |
| rushYds | 850 | 27.8 | 1.00 | 25.67 | 26.7 | 96% | 1.50 | 1.00 |
| rushAtt | 797 | 6.1 | 1.00 | 2.57 | 4.0 | 65% | 1.10 | 0.75 |
| receptions | 1785 | 2.7 | 1.25 | 1.16 | 2.0 | 74% | 1.10 | 1.00 |
| recYds | 1869 | 23.7 | 1.25 | 14.90 | 27.9 | 118% | 1.30 | 1.00 |

The projection's own Floor-to-Ceiling band implies an SD of about (C − F) / 1.35. Against that, the SD the actuals say (above) is what the books are really up against.

| stat | band-implied SD (median) | actuals-implied SD at median mean | ratio |
| --- | --- | --- | --- |
| passYds | 74.5 | 91.9 | 1.23 |
| passAtt | 6.6 | 10.6 | 1.61 |
| completions | 6.3 | 7.9 | 1.25 |
| rushYds | 18.0 | 26.7 | 1.49 |
| rushAtt | 3.1 | 4.0 | 1.28 |
| receptions | 1.7 | 2.0 | 1.16 |
| recYds | 16.2 | 27.9 | 1.73 |

## 2. Price: does a better shape earn a bigger share of the price?

Live-board rungs, every model on the same rows. Brier is the projection-alone price against what happened. Δ columns are Brier of this model − the reference, clustered by player-week (negative is better). *Share* is how far to move from the books toward the projection to match what happened (0 ignore it, 1 believe it), unpenalised.

**near the money** — 17,641 rungs, 894 player-weeks; the books alone score Brier 0.2336

| model | Brier | Δ vs tpn | Δ vs tpnWide | Δ vs normalLaw | log-loss | share ± 95% |
| --- | --- | --- | --- | --- | --- | --- |
| tpn | 0.2493 | — | — | — | 0.7161 | -0.03 ±0.12 |
| tpnWide | 0.2427 | -0.0066 (z -7.4) | — | — | 0.6940 | -0.04 ±0.16 |
| normalLaw | 0.2461 | -0.0032 (z -2.4) | +0.0034 (z 2.3) | — | 0.6882 | 0.06 ±0.18 |
| gammaExact | 0.2507 | +0.0014 (z 2.4) | +0.0080 (z 6.9) | — | 0.7240 | -0.04 ±0.11 |
| gammaLS | 0.2485 | -0.0008 (z -1.7) | +0.0058 (z 5.8) | — | 0.7061 | -0.01 ±0.14 |
| gammaLaw | 0.2396 | -0.0097 (z -5.0) | -0.0031 (z -2.0) | -0.0064 (z -2.6) | 0.6745 | 0.16 ±0.23 |
| tweedie | 0.2403 | -0.0091 (z -8.4) | -0.0025 (z -2.9) | -0.0058 (z -4.7) | 0.6757 | 0.14 ±0.22 |

**long-shot overs (books 3–15%)** — 8,180 rungs, 885 player-weeks; the books alone score Brier 0.0785

| model | Brier | Δ vs tpn | Δ vs tpnWide | Δ vs normalLaw | log-loss | share ± 95% |
| --- | --- | --- | --- | --- | --- | --- |
| tpn | 0.0807 | — | — | — | 0.3462 | 0.10 ±0.10 |
| tpnWide | 0.0822 | +0.0015 (z 1.5) | — | — | 0.3136 | 0.18 ±0.15 |
| normalLaw | 0.0801 | -0.0006 (z -0.7) | -0.0020 (z -3.2) | — | 0.3030 | 0.23 ±0.23 |
| gammaExact | 0.0804 | -0.0003 (z -0.9) | -0.0017 (z -2.2) | — | 0.3228 | 0.13 ±0.13 |
| gammaLS | 0.0794 | -0.0013 (z -2.7) | -0.0028 (z -4.0) | — | 0.3020 | 0.23 ±0.19 |
| gammaLaw | 0.0808 | +0.0001 (z 0.1) | -0.0014 (z -1.9) | +0.0007 (z 1.1) | 0.3004 | 0.17 ±0.31 |
| tweedie | 0.0801 | -0.0006 (z -0.7) | -0.0021 (z -3.3) | -0.0001 (z -0.1) | 0.2986 | 0.25 ±0.27 |

**all rungs** — 34,243 rungs, 895 player-weeks; the books alone score Brier 0.1763

| model | Brier | Δ vs tpn | Δ vs tpnWide | Δ vs normalLaw | log-loss | share ± 95% |
| --- | --- | --- | --- | --- | --- | --- |
| tpn | 0.1861 | — | — | — | 0.5796 | 0.04 ±0.08 |
| tpnWide | 0.1835 | -0.0027 (z -4.0) | — | — | 0.5569 | 0.06 ±0.12 |
| normalLaw | 0.1841 | -0.0020 (z -2.2) | +0.0006 (z 0.7) | — | 0.5476 | 0.13 ±0.16 |
| gammaExact | 0.1869 | +0.0008 (z 1.8) | +0.0034 (z 4.2) | — | 0.5810 | 0.03 ±0.08 |
| gammaLS | 0.1854 | -0.0007 (z -2.4) | +0.0020 (z 2.8) | — | 0.5625 | 0.06 ±0.11 |
| gammaLaw | 0.1807 | -0.0054 (z -5.1) | -0.0027 (z -3.1) | -0.0033 (z -2.4) | 0.5394 | 0.18 ±0.19 |
| tweedie | 0.1807 | -0.0054 (z -8.1) | -0.0027 (z -5.0) | -0.0034 (z -4.7) | 0.5393 | 0.19 ±0.19 |

### Tails: what happened when the model said …

| model | 0–3% | 3–10% | 10–25% | 75–90% | 90–97% | 97–100% |
| --- | --- | --- | --- | --- | --- | --- |
| tpn | 1.0% → 9.4% (4,310) | 6.2% → 11.6% (3,918) | 17.0% → 20.5% (5,319) | 81.9% → 76.0% (3,967) | 92.8% → 83.1% (756) | 98.0% → 68.5% (54) |
| tpnWide | 1.2% → 9.6% (1,841) | 6.4% → 8.3% (3,229) | 17.3% → 15.1% (6,100) | 80.6% → 82.2% (2,172) | 92.7% → 79.5% (127) | – |
| normalLaw | 1.6% → 6.0% (1,497) | 6.4% → 7.8% (3,823) | 17.0% → 16.2% (5,751) | 81.9% → 77.0% (4,539) | 91.8% → 89.7% (419) | – |
| gammaExact | 1.1% → 9.1% (2,885) | 6.3% → 10.0% (3,998) | 17.0% → 18.7% (6,130) | 82.1% → 73.5% (3,760) | 92.9% → 82.2% (1,003) | 99.4% → 76.5% (544) |
| gammaLS | 1.4% → 8.5% (1,638) | 6.5% → 9.2% (4,534) | 16.9% → 18.4% (7,130) | 82.2% → 72.3% (3,277) | 93.4% → 81.3% (1,488) | 98.3% → 85.1% (422) |
| gammaLaw | 2.0% → 7.4% (135) | 7.4% → 7.6% (2,768) | 17.1% → 15.1% (9,432) | 81.5% → 82.3% (2,345) | 92.4% → 87.1% (310) | – |
| tweedie | 1.8% → 7.5% (683) | 6.8% → 7.8% (3,829) | 17.1% → 15.8% (7,368) | 81.9% → 81.0% (3,445) | 91.9% → 87.5% (335) | – |

### Walk-forward blend

The price as the pipeline would build it: near the money, a share per stat group fitted on earlier weeks (the pricing path's own penalised, marked-down fit), applied to the week in question. Weeks 3, 4, 5, 6, 7, 8, 9. Books alone: Brier 0.2335.

| model | rungs | mean share used | blend Brier | blend − books | blend − tpn blend |
| --- | --- | --- | --- | --- | --- |
| tpn | 17,533 | 0.00 | 0.2335 | -0.0000 (z -0.4) | — |
| tpnWide | 17,533 | 0.00 | 0.2335 | -0.0000 (z -0.4) | +0.0000 (z –) |
| normalLaw | 17,533 | 0.01 | 0.2335 | +0.0000 (z 0.2) | +0.0000 (z 0.2) |
| gammaExact | 17,533 | 0.00 | 0.2335 | -0.0000 (z -0.4) | +0.0000 (z –) |
| gammaLS | 17,533 | 0.00 | 0.2335 | -0.0000 (z -0.4) | +0.0000 (z –) |
| gammaLaw | 17,533 | 0.01 | 0.2335 | +0.0000 (z 0.2) | +0.0000 (z 0.2) |
| tweedie | 17,533 | 0.01 | 0.2335 | +0.0000 (z 0.2) | +0.0000 (z 0.2) |

### Does a better spread raise the projection's weight in the pool?

The pool prices each market as the books' weighted consensus with the projection taking a *share* of the logit (0 = books only, 0.75 = the cap). The pipeline fits one share per (stat, slot) cell from earlier weeks, penalised toward zero and marked down by its standard error. Here that exact fit is run for the as-projected band, the widened band and the Tweedie spread, on markets within 25 points of even. *Mean share used* is what the walk-forward would actually have applied; *> 0* is the fraction of markets that got any weight at all. The unpenalised shares are the evidence on the weight itself.

**all rows**

| model | markets | mean share used | markets with share > 0 | max share used | pool Brier | books Brier | pool − books | unpenalised share: yards | counts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tpn | 17,533 | 0.000 | 0% | 0.00 | 0.2335 | 0.2335 | -0.0000 (z -0.4) | -0.05 ±0.13 | 0.01 ±0.15 |
| tpnWide | 17,533 | 0.000 | 0% | 0.00 | 0.2335 | 0.2335 | -0.0000 (z -0.4) | -0.08 ±0.19 | 0.04 ±0.19 |
| tweedie | 17,533 | 0.004 | 4% | 0.14 | 0.2335 | 0.2335 | -0.0000 (z -0.4) | 0.10 ±0.24 | 0.25 ±0.28 |

| stat | tpn: unpenalised share ±95% | tpnWide: unpenalised share ±95% | tweedie: unpenalised share ±95% |
| --- | --- | --- | --- |
| passYds | 0.21 ±0.71 (136) | 0.21 ±0.71 (136) | 0.23 ±0.80 (136) |
| passAtt | 0.16 ±0.68 (123) | 0.22 ±0.98 (123) | 0.39 ±0.96 (123) |
| completions | 0.31 ±0.91 (125) | 0.31 ±0.91 (125) | 0.38 ±0.95 (125) |
| rushYds | -0.02 ±0.20 (340) | -0.06 ±0.29 (340) | 0.14 ±0.37 (340) |
| rushAtt | -0.11 ±0.29 (193) | -0.05 ±0.51 (193) | -0.04 ±0.52 (193) |
| receptions | 0.03 ±0.20 (680) | 0.02 ±0.21 (680) | 0.33 ±0.36 (680) |
| recYds | -0.10 ±0.16 (681) | -0.18 ±0.23 (681) | 0.03 ±0.34 (681) |

**point-in-time projection only**

| model | markets | mean share used | markets with share > 0 | max share used | pool Brier | books Brier | pool − books | unpenalised share: yards | counts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tpn | 8,177 | 0.000 | 0% | 0.00 | 0.2343 | 0.2343 | +0.0000 (z 0.1) | -0.05 ±0.15 | -0.02 ±0.18 |
| tpnWide | 8,177 | 0.000 | 0% | 0.00 | 0.2343 | 0.2343 | +0.0000 (z 0.1) | -0.06 ±0.22 | 0.01 ±0.22 |
| tweedie | 8,177 | 0.000 | 0% | 0.04 | 0.2343 | 0.2343 | +0.0000 (z 0.6) | 0.09 ±0.30 | 0.17 ±0.33 |

| stat | tpn: unpenalised share ±95% | tpnWide: unpenalised share ±95% | tweedie: unpenalised share ±95% |
| --- | --- | --- | --- |
| passYds | 0.80 ±1.04 (85) | 0.80 ±1.04 (85) | 0.86 ±1.11 (85) |
| passAtt | 0.39 ±0.86 (85) | 0.53 ±1.24 (85) | 0.65 ±1.22 (85) |
| completions | 0.62 ±1.17 (85) | 0.62 ±1.17 (85) | 0.65 ±1.21 (85) |
| rushYds | -0.09 ±0.23 (224) | -0.16 ±0.34 (224) | 0.04 ±0.44 (224) |
| rushAtt | -0.15 ±0.34 (127) | -0.17 ±0.63 (127) | -0.25 ±0.63 (127) |
| receptions | -0.02 ±0.21 (465) | -0.02 ±0.23 (465) | 0.20 ±0.40 (465) |
| recYds | -0.12 ±0.18 (464) | -0.19 ±0.26 (464) | -0.08 ±0.41 (464) |

## 3. Books: what standard deviation is each one quoting?

Books are keyed by canonical name (`Hard Rock` and `hardrock` are one). Each book's latest board per player-week is used; a price is de-vigged where both sides were quoted and stripped of an assumed hold otherwise.

### 3a. From each book's own alternate-line ladder

A gamma is fitted to the book's ladder (rungs between 2% and 98%; at least four rungs spanning at least 30 points of probability; a fit that tracks the ladder and sits near its lines), which gives the book's **implied mean and SD**. The actual is read against it. **Ratio** is the root-mean-square of (actual − implied mean) / implied SD: 1.00 means the book's SD was right on average, above 1 means it quoted too tight. **Robust ratio** is the same from the MAD, which one blown ladder cannot move. **Realised SD** is the standard deviation of the actual about the book's mean, in the stat's units. *Central / tails* are PIT coverage (targets 50% / 10%). A cell needs 25 usable ladders.

| book | stat | ladders | implied mean | implied SD | implied CV | realised SD | ratio | robust ratio | bias (z) | central / tails |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| betrivers | completions | 115 | 21.0 | 4.7 | 22% | 6.4 | **1.33** | 1.13 | -0.07 | 44% / 22% |
| betrivers | passYds | 227 | 229.8 | 65.0 | 28% | 73.4 | **1.12** | 1.08 | -0.01 | 47% / 16% |
| betrivers | receptions | 272 | 3.4 | 2.0 | 59% | 2.1 | **1.01** | 1.05 | +0.05 | 46% / 11% |
| betrivers | recYds | 295 | 42.0 | 31.3 | 74% | 32.9 | **0.99** | 0.86 | -0.01 | 50% / 14% |
| betrivers | rushAtt | 123 | 15.2 | 5.0 | 33% | 4.8 | **0.96** | 0.95 | -0.03 | 50% / 12% |
| betrivers | rushYds | 198 | 50.9 | 29.0 | 58% | 30.9 | **1.06** | 0.83 | -0.12 | 44% / 14% |
| caesars | passYds | 238 | 232.1 | 70.3 | 30% | 75.0 | **1.07** | 1.00 | -0.09 | 50% / 14% |
| caesars | receptions | 244 | 3.7 | 2.1 | 58% | 2.2 | **0.99** | 0.98 | -0.11 | 49% / 14% |
| caesars | recYds | 313 | 32.5 | 27.5 | 83% | 29.2 | **1.07** | 0.85 | -0.00 | 49% / 18% |
| caesars | rushYds | 277 | 41.5 | 29.8 | 69% | 26.2 | **0.93** | 0.79 | -0.12 | 51% / 12% |
| draftkings | completions | 241 | 20.6 | 5.1 | 25% | 6.2 | **1.20** | 1.06 | -0.05 | 47% / 15% |
| draftkings | passAtt | 238 | 31.9 | 7.3 | 23% | 9.0 | **1.23** | 1.06 | -0.04 | 48% / 16% |
| draftkings | passYds | 241 | 228.2 | 68.4 | 30% | 74.5 | **1.08** | 1.01 | -0.05 | 47% / 15% |
| draftkings | receptions | 307 | 3.4 | 2.0 | 60% | 2.2 | **0.99** | 0.86 | -0.06 | 53% / 12% |
| draftkings | recYds | 254 | 41.4 | 31.4 | 76% | 29.5 | **0.91** | 0.90 | +0.00 | 48% / 15% |
| draftkings | rushAtt | 193 | 13.2 | 4.7 | 38% | 4.5 | **0.98** | 0.94 | -0.12 | 52% / 11% |
| draftkings | rushYds | 250 | 41.5 | 29.8 | 69% | 27.3 | **0.92** | 0.78 | -0.10 | 51% / 10% |
| fanduel | passYds | 243 | 228.5 | 75.7 | 33% | 73.8 | **0.97** | 0.92 | -0.03 | 53% / 12% |
| fanduel | receptions | 310 | 3.4 | 2.2 | 64% | 2.3 | **0.99** | 0.90 | -0.07 | 49% / 10% |
| fanduel | recYds | 326 | 34.1 | 29.7 | 84% | 26.9 | **0.89** | 0.74 | -0.04 | 54% / 15% |
| fanduel | rushYds | 290 | 38.7 | 29.7 | 75% | 25.6 | **0.85** | 0.73 | -0.10 | 54% / 9% |
| hardrock | completions | 32 | 21.2 | 5.2 | 24% | 5.3 | **1.02** | 1.01 | -0.17 | 50% / 9% |
| hardrock | passAtt | 33 | 33.3 | 8.1 | 24% | 7.0 | **0.88** | 0.83 | -0.23 | 61% / 3% |
| hardrock | passYds | 240 | 230.1 | 69.5 | 30% | 74.4 | **1.06** | 0.99 | -0.06 | 48% / 14% |
| hardrock | receptions | 296 | 3.4 | 2.0 | 59% | 2.1 | **1.04** | 0.93 | -0.06 | 49% / 13% |
| hardrock | recYds | 254 | 41.8 | 31.1 | 76% | 30.9 | **0.91** | 0.85 | -0.13 | 50% / 18% |
| hardrock | rushAtt | 194 | 12.4 | 5.5 | 53% | 4.6 | **0.82** | 0.71 | -0.14 | 59% / 6% |
| hardrock | rushYds | 226 | 48.1 | 32.2 | 67% | 28.5 | **0.89** | 0.81 | -0.15 | 50% / 12% |
| thescore | completions | 235 | 20.7 | 5.0 | 25% | 6.2 | **1.21** | 1.09 | -0.06 | 46% / 15% |
| thescore | passAtt | 234 | 31.8 | 7.5 | 24% | 8.9 | **1.17** | 0.99 | -0.07 | 52% / 13% |
| thescore | passYds | 241 | 229.0 | 73.2 | 32% | 74.5 | **1.03** | 0.98 | -0.06 | 49% / 12% |
| thescore | receptions | 271 | 3.5 | 2.2 | 62% | 2.0 | **0.89** | 0.80 | -0.05 | 56% / 9% |
| thescore | recYds | 292 | 38.5 | 31.3 | 79% | 28.5 | **0.86** | 0.83 | -0.07 | 50% / 15% |
| thescore | rushAtt | 292 | 13.8 | 5.3 | 43% | 4.8 | **0.91** | 0.87 | -0.09 | 54% / 9% |
| thescore | rushYds | 233 | 42.7 | 30.2 | 68% | 27.9 | **0.88** | 0.83 | -0.14 | 46% / 9% |
| **all books** | completions | 623 | 20.7 | 5.0 | 24% | 6.2 | **1.22** | 1.06 | -0.06 | 46% / 16% |
| **all books** | passAtt | 505 | 32.0 | 7.4 | 23% | 8.8 | **1.18** | 1.03 | -0.07 | 50% / 14% |
| **all books** | passYds | 1,430 | 229.9 | 70.2 | 31% | 74.2 | **1.06** | 0.99 | -0.05 | 49% / 14% |
| **all books** | receptions | 1,700 | 3.5 | 2.1 | 61% | 2.1 | **0.99** | 0.90 | -0.05 | 50% / 11% |
| **all books** | recYds | 1,734 | 38.4 | 30.4 | 78% | 29.6 | **0.94** | 0.83 | -0.04 | 50% / 16% |
| **all books** | rushAtt | 802 | 13.9 | 5.2 | 40% | 4.7 | **0.92** | 0.87 | -0.10 | 54% / 9% |
| **all books** | rushYds | 1,474 | 42.9 | 29.8 | 68% | 27.5 | **0.92** | 0.79 | -0.12 | 50% / 11% |

Per book, across the stats it has enough ladders for:

| book | stats | ladders | median ratio | median robust ratio | range of ratio |
| --- | --- | --- | --- | --- | --- |
| betrivers | 6 | 1,230 | 1.04 | 1.00 | 0.96–1.33 |
| caesars | 4 | 1,072 | 1.03 | 0.92 | 0.93–1.07 |
| draftkings | 7 | 1,724 | 0.99 | 0.94 | 0.91–1.23 |
| fanduel | 4 | 1,169 | 0.93 | 0.82 | 0.85–0.99 |
| hardrock | 7 | 1,275 | 0.91 | 0.85 | 0.82–1.06 |
| thescore | 7 | 1,798 | 0.91 | 0.87 | 0.86–1.21 |

### 3b. From a variance law fitted to each book's centre

Works for books that only post a main line. Each book's quote nearest 50% (kept if between 30% and 70%) is its centre: the line is placed at its quoted quantile of a gamma whose variance follows `φ · mean^p`, and the law is fitted to the actuals by maximum likelihood. **SD at the reference mean** is that book's SD for a player whose mean is the stat's median projection, which makes books directly comparable. *Mean (actual − line)* and *over rate* say whether the book's centre ran high or low. *ll* is the log-likelihood per record: how good the book's *centre* is, on the same footing as the RotoWire projection's own `projection` row.

Reference means: passYds 228.5, passAtt 31.4, completions 20.5, rushYds 27.8, rushAtt 6.1, receptions 2.7, recYds 23.7.

| book | stat | n | p | φ | SD at ref mean | CV | RMSE | mean (actual − line) | over rate | ll |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| projection | completions | 245 | 0.00 | 67.34 | 8.2 | 40% | 6.2 | +0.27 | 52% | -3.456 |
| projection | passAtt | 245 | 0.00 | 125.58 | 11.2 | 36% | 9.0 | +0.36 | 47% | -3.776 |
| projection | passYds | 245 | 0.00 | 9351.99 | 96.7 | 42% | 74.6 | +0.35 | 52% | -5.979 |
| projection | receptions | 1,785 | 1.25 | 1.17 | 2.0 | 75% | 1.9 | +0.18 | 50% | -1.915 |
| projection | recYds | 1,869 | 1.25 | 19.22 | 31.7 | 134% | 26.0 | +1.40 | 44% | -4.586 |
| projection | rushAtt | 797 | 0.75 | 4.76 | 4.3 | 71% | 4.1 | -0.05 | 43% | -2.655 |
| projection | rushYds | 850 | 0.75 | 79.40 | 31.0 | 112% | 24.7 | -1.20 | 36% | -4.770 |
| betmgm | completions | 173 | 0.00 | 68.93 | 8.3 | 40% | 6.2 | +0.19 | 51% | -3.468 |
| betmgm | passAtt | 174 | 0.00 | 122.27 | 11.1 | 35% | 8.9 | +0.31 | 48% | -3.762 |
| betmgm | passYds | 193 | 0.00 | 5894.72 | 76.8 | 34% | 71.9 | +2.15 | 53% | -5.928 |
| betmgm | receptions | 967 | 1.50 | 0.88 | 2.0 | 73% | 2.1 | +0.19 | 50% | -2.071 |
| betmgm | recYds | 1,010 | 1.00 | 45.40 | 32.8 | 138% | 30.1 | +5.33 | 50% | -4.703 |
| betmgm | rushAtt | 174 | 0.75 | 3.20 | 3.5 | 58% | 4.5 | +0.70 | 55% | -2.909 |
| betmgm | rushYds | 433 | 0.75 | 64.13 | 27.8 | 100% | 29.0 | +3.58 | 44% | -4.656 |
| betr | receptions | 130 | 1.25 | 1.06 | 1.9 | 71% | 1.9 | +0.00 | 50% | -2.034 |
| betr | recYds | 136 | 1.25 | 15.28 | 28.3 | 119% | 29.5 | +5.10 | 52% | -5.445 |
| betr | rushYds | 62 | 1.25 | 4.95 | 17.8 | 64% | 26.5 | +8.47 | 56% | -4.354 |
| betrivers | completions | 242 | 0.00 | 71.47 | 8.5 | 41% | 6.3 | +0.05 | 52% | -3.466 |
| betrivers | passYds | 239 | 0.50 | 494.92 | 86.5 | 38% | 74.9 | +2.35 | 54% | -5.988 |
| betrivers | receptions | 1,231 | 1.50 | 0.85 | 1.9 | 72% | 2.1 | +0.16 | 49% | -2.071 |
| betrivers | recYds | 1,259 | 1.25 | 16.42 | 29.3 | 124% | 29.9 | +4.92 | 50% | -4.796 |
| betrivers | rushAtt | 337 | 0.75 | 4.18 | 4.0 | 66% | 4.6 | +0.08 | 46% | -2.892 |
| betrivers | rushYds | 558 | 0.75 | 56.65 | 26.2 | 94% | 27.4 | +2.69 | 44% | -4.626 |
| caesars | completions | 245 | 0.25 | 33.86 | 8.5 | 41% | 6.3 | -0.01 | 51% | -3.476 |
| caesars | passAtt | 243 | 0.00 | 135.05 | 11.6 | 37% | 9.1 | -0.19 | 47% | -3.793 |
| caesars | passYds | 239 | 0.50 | 500.95 | 87.0 | 38% | 75.4 | +1.28 | 54% | -5.991 |
| caesars | receptions | 1,325 | 1.50 | 0.87 | 1.9 | 73% | 2.1 | +0.17 | 49% | -2.052 |
| caesars | recYds | 1,340 | 1.25 | 16.73 | 29.6 | 125% | 29.8 | +5.29 | 49% | -4.789 |
| caesars | rushAtt | 401 | 1.00 | 2.24 | 3.7 | 61% | 4.5 | +0.03 | 46% | -2.826 |
| caesars | rushYds | 586 | 0.75 | 57.92 | 26.5 | 95% | 27.4 | +2.72 | 44% | -4.748 |
| circasports | passYds | 234 | 0.50 | 470.64 | 84.3 | 37% | 73.8 | +2.10 | 55% | -5.973 |
| circasports | receptions | 99 | 1.00 | 1.60 | 2.1 | 77% | 2.6 | +0.32 | 49% | -2.307 |
| circasports | recYds | 554 | 1.50 | 5.09 | 24.3 | 102% | 35.1 | +3.92 | 48% | -4.961 |
| circasports | rushYds | 426 | 1.00 | 22.59 | 25.0 | 90% | 28.0 | +2.51 | 43% | -4.836 |
| draftkings | completions | 243 | 1.00 | 3.26 | 8.2 | 40% | 6.3 | +0.06 | 51% | -3.463 |
| draftkings | passAtt | 229 | 0.00 | 133.06 | 11.5 | 37% | 9.2 | -0.07 | 47% | -3.784 |
| draftkings | passYds | 239 | 0.00 | 7622.42 | 87.3 | 38% | 75.3 | +0.77 | 54% | -5.988 |
| draftkings | receptions | 1,319 | 1.50 | 0.87 | 2.0 | 73% | 2.1 | +0.17 | 49% | -2.057 |
| draftkings | recYds | 1,329 | 1.25 | 16.62 | 29.5 | 124% | 29.5 | +5.08 | 49% | -4.786 |
| draftkings | rushAtt | 391 | 1.00 | 2.21 | 3.7 | 60% | 4.5 | +0.12 | 48% | -2.835 |
| draftkings | rushYds | 599 | 0.75 | 57.94 | 26.5 | 95% | 27.3 | +2.95 | 44% | -4.733 |
| fanduel | passYds | 238 | 0.75 | 123.86 | 85.3 | 37% | 74.8 | +1.50 | 55% | -5.980 |
| fanduel | receptions | 1,328 | 1.50 | 0.87 | 1.9 | 73% | 2.1 | +0.19 | 50% | -2.056 |
| fanduel | recYds | 1,351 | 1.25 | 16.48 | 29.4 | 124% | 29.6 | +5.57 | 50% | -4.775 |
| fanduel | rushYds | 609 | 0.75 | 55.73 | 26.0 | 94% | 26.8 | +3.28 | 45% | -4.734 |
| hardrock | completions | 243 | 0.00 | 72.86 | 8.5 | 42% | 6.3 | +0.08 | 51% | -3.476 |
| hardrock | passAtt | 241 | 0.00 | 136.61 | 11.7 | 37% | 9.1 | -0.11 | 46% | -3.794 |
| hardrock | passYds | 242 | 0.25 | 1957.83 | 87.2 | 38% | 75.1 | -0.51 | 52% | -5.984 |
| hardrock | receptions | 1,326 | 1.50 | 0.88 | 2.0 | 74% | 2.1 | +0.18 | 50% | -2.057 |
| hardrock | recYds | 1,367 | 1.25 | 16.68 | 29.6 | 125% | 29.5 | +4.84 | 49% | -4.760 |
| hardrock | rushAtt | 398 | 1.00 | 2.22 | 3.7 | 60% | 4.5 | +0.05 | 47% | -2.820 |
| hardrock | rushYds | 634 | 1.00 | 22.95 | 25.2 | 91% | 26.4 | +2.69 | 45% | -4.744 |
| pinnacle | completions | 147 | 0.00 | 71.63 | 8.5 | 41% | 6.3 | +0.25 | 54% | -3.484 |
| pinnacle | passAtt | 146 | 0.00 | 118.59 | 10.9 | 35% | 8.7 | -0.11 | 47% | -3.742 |
| pinnacle | passYds | 244 | 0.75 | 121.01 | 84.3 | 37% | 73.9 | +1.90 | 55% | -5.966 |
| pinnacle | receptions | 1,278 | 1.25 | 1.15 | 2.0 | 74% | 2.1 | +0.19 | 49% | -2.054 |
| pinnacle | recYds | 1,273 | 1.25 | 16.38 | 29.3 | 123% | 29.2 | +5.09 | 50% | -4.787 |
| pinnacle | rushAtt | 237 | 1.00 | 2.17 | 3.6 | 60% | 4.5 | -0.00 | 46% | -2.809 |
| pinnacle | rushYds | 592 | 0.75 | 57.82 | 26.4 | 95% | 27.2 | +2.82 | 44% | -4.650 |
| thescore | completions | 239 | 1.00 | 3.33 | 8.3 | 40% | 6.3 | +0.06 | 51% | -3.471 |
| thescore | passAtt | 225 | 0.00 | 132.27 | 11.5 | 37% | 9.1 | -0.23 | 46% | -3.779 |
| thescore | passYds | 237 | 0.50 | 485.07 | 85.6 | 37% | 74.8 | +0.85 | 55% | -5.978 |
| thescore | receptions | 1,262 | 1.50 | 0.86 | 1.9 | 73% | 2.1 | +0.17 | 49% | -2.061 |
| thescore | recYds | 1,217 | 1.25 | 16.24 | 29.2 | 123% | 30.1 | +4.68 | 49% | -4.793 |
| thescore | rushAtt | 359 | 1.00 | 2.19 | 3.7 | 60% | 4.5 | +0.17 | 48% | -2.823 |
| thescore | rushYds | 545 | 1.00 | 21.93 | 24.7 | 89% | 27.5 | +2.62 | 44% | -4.729 |

## 4. What this says, and what it does not

- **Spread explains most of it, shape little.** Average log-probability on the actual, relative to today's two-piece normal: widened band +0.186, normal with the fitted variance law +0.431, gamma with that law +0.425, Tweedie +0.482. Gamma over the equal-law normal: -0.006; Tweedie over it: +0.051.
- **A gamma fitted to Floor/Median/Ceiling is not an improvement.** Through all three points: -0.436; least squares from zero: +0.052. The band's spread is the problem, and a different shape on the same band does not fix it.
- **On the live rungs near the money**, projection-alone Brier: tpn 0.2493, tpnWide 0.2427, gammaLaw 0.2396, Tweedie 0.2403; the books 0.2336. Gamma and Tweedie beat the widened band (-0.0031 (z -2.0); -0.0025 (z -2.9)) and the equal-law normal (-0.0064 (z -2.6); -0.0058 (z -4.7)), so the skewed positive shape does earn something once the spread is right. All rungs: tpn 0.1861 → Tweedie 0.1807, books 0.1763.
- **None of it reaches the price.** Every model is still worse than the books near the money, the shares are indistinguishable from zero, and the walk-forward blend equals the books to four decimals (0.2335). A better-calibrated projection is not new information.
- **Does it raise the projection's weight in the pool? Barely, and not significantly.** Run through the pipeline's own share fit (per stat and slot, from earlier weeks, penalised): mean share used 0.000 as projected, 0.000 widened, 0.004 with the Tweedie spread (4% of markets got any weight, max 0.14); on point-in-time projections only, 0.000. The unpenalised point estimates move up for most stats, but every interval still contains zero, and the pool's Brier equals the books' (0.2335 vs 0.2335).
- **Books.** Section 3a is the answer to what SD each book quotes: a ratio near 1.00 means its quoted SD matched what the actuals did. Counts (completions, pass attempts) read above 1 at the books that post them, i.e. quoted too tight; rushing and receiving yardage read slightly below 1. Books that only post a main line are in 3b. Pinnacle, Circa and BetMGM do not post usable ladders in these captures, so they appear only in 3b.
- **Limits.** One season, nine weeks; about 15k of 34k rungs use a projection with hindsight (git history is shallow); the actuals feed omits players with an all-zero line, which tilts outcomes toward overs; quarterback law exponents sit on the grid boundary because quarterbacks span a narrow range of means, so read their SD, not their p; the stochastic-process models are the closed-form terminal-law kind (Feller/CIR gives the gamma, compound Poisson gives Tweedie) because there is no in-game path to calibrate a diffusion to.
- Nothing here is wired into capture. If a model is adopted, move it into `lib/probability.mjs` and refit the shares on it in the same change, as `spread-fit` says for the widening.

