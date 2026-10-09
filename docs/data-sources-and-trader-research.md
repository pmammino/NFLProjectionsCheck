# OpticOdds streaming and prediction markets, and what former traders say

Two questions, answered against the problems we have actually measured. Where a claim
is tested, the number is from 2026 weeks 2–4 and says how it was tested; where it is
not, it says so. Nothing here changes the pricing code.

**Provenance, because it matters.** The OpticOdds developer docs are blocked from this
sandbox (egress proxy), so Part 1 rests on search-result summaries of those docs and
on third-party pages. Treat every OpticOdds capability below as *to be confirmed*
before building on it. The trader research (Part 2) was read in full from the Drive file
*Practitioner Resources on Trading-Desk Modeling*. Most of its sources are operator-
authored (Circa, Pinnacle, Kambi) or secondary profiles, which the file itself says.

---

## 1. OpticOdds: prediction markets and the streaming endpoint

### What exists (per OpticOdds' docs, via search; unverified here)

| | |
|---|---|
| **Odds stream** | `GET /api/v3/stream/odds/{sport}`, Server-Sent Events. Sportsbooks as a repeated parameter, up to 5 per request, optional `league`. Events: odds, locked-odds, fixture-status, fixture-results, plus connected and ping. Resumable with `last_entry_id`. Described as the replacement for polling `/fixtures/odds`. |
| **Does it carry NFL player props?** | **Not confirmed.** The excerpt I could see shows no market-type filter. This is the first thing to check. |
| **Prediction markets** | Aggregated prices from Kalshi, Polymarket, Betfair Exchange, SX Bet, Sporttrade, Novig, BetDEX and others, with an `order_book` field (bid/ask levels and size), `source_ids` (the exchange's own market ids), tick-level price history, and SSE updates. |
| **Non-sport stream** | A separate guide covers non-sport markets (politics, tech) with a full order-book snapshot per market. Sports go through the normal sports flow. |
| **NFL player props on exchanges** | **Not confirmed by OpticOdds.** Third parties say Kalshi began weekly passing, rushing, receiving and touchdown markets in October 2025, and that trading was light. Trackers show the season-long yardage contracts as low-liquidity (a May 2026 snapshot: volume 3 on one contract, no bids). |

### Would either improve the models?

Measured against what is actually limiting the model:

**The projection's gap to the book is mostly the projection**, not the books' timing (it is
+0.0178 early in the week and +0.0073 by kickoff, `npm run projection-miss`). Neither a
faster odds feed nor more books makes the projection better. So neither is a fix for
the main problem. Each does help something narrower.

**Streaming: useful for measurement, not for the projection.**
- It would give a timestamp on every price change. Today the books' weights are *inferred*
  from the opening and closing boards, and "opening" is each book's first-ever price, not
  one moment. With timestamps, lead and lag become a direct measurement (who moved first,
  by how many seconds) instead of an inference, and the hold-through-the-week question below
  becomes answerable.
- It removes the dependence on `include_timeseries`, the permission we lack for hour-level
  history (README, backfilling). It only helps going forward; it cannot reconstruct past weeks.
- It would allow a **stale-quote guard**: a price that has not moved while the rest of the
  market has is exactly the stale line the pool's best edges come from (see 2.2), and "time
  since this book last updated" is a feature we cannot build today.
- Cost: a persistent consumer. A GitHub Actions cron is the wrong shape for it. The
  options are a long job for the Thursday-to-Sunday window writing hourly aggregates (not
  raw events, which are too large to commit) or a small always-on worker. A cheaper
  intermediate step that needs no streaming: poll the existing endpoint hourly Thursday to Saturday.
- Verdict: **medium value for the books' weights and edge timing, no value for the projection.**
  Do a one-week trial that records only the lag between a price change and its arrival,
  per book, and confirms props are in the stream, before committing to a consumer.

**Prediction markets: one more source for the pool, with open questions.**
- A source like any other: its quotes would enter the pool and its weight would be
  assessed by the same lead measure as the books. That is the point of having built it.
- In their favour: no or low vig (cleaner probabilities, no de-vig assumption), a bid/ask
  spread that is itself an uncertainty measure, and prices set by people who are not
  bookmakers. Threshold contracts ("60+ yards") are a survival function directly.
- Against: player-prop liquidity looks thin, so prices may be stale or wide; they are not
  bettable in our paper ledger, so they would be **reference** prices like Pinnacle;
  and coverage is unconfirmed. Of the exchanges, Novig and Sporttrade (peer-to-peer, built for
  US props) look more promising than Kalshi or Polymarket, and that is a guess to check.
- A risk if added carelessly: a book with no record gets the prior weight (0.15). A thin, stale
  exchange quote at that weight could distort the pool until it has been assessed. It should
  enter with a lower prior, or a minimum depth.
- Verdict: **low-to-medium, contingent on coverage.** The check is cheap and needs no
  code: run the `optic-discover` workflow and look in the sportsbook list for these
  exchanges with NFL player-prop markets. If they are there, add them as reference books
  (`--reference-books pinnacle,novig`) and let a few weeks of lead data decide the weight.

---

## 2. What former traders say, tested against our data

The file's thesis: *the model gives a prior, the market gives the posterior; blend, do not
replace; most risk is adverse selection; closing line value is the main out-of-sample check.*
That is the structure we arrived at independently. What follows is each testable claim, what
we had, what the data says, and what it implies.

### 2.1 Where the file agrees with what we found

| Claim | Our result |
|---|---|
| Blend the model with the market (Peabody's 45% model / 55% market on NFL sides) | The projection earns a share of the price near zero early in the week and up to ~0.5 on receptions with a fresh snapshot. Peabody's model is a good game-level model; a props projection is a weaker one. Same structure, a much smaller share. |
| Sharp market-making books lead; recreational books copy | Pinnacle leads the market (0.88), Circa 0.48, BetMGM 0.58; Hard Rock 0.08 and FanDuel 0.04 correct toward the pack after the open. Matches Circa's "inferior approach" of copying line moves, and Blume's NASDAQ-of-prices. |
| Treat the closing line as the benchmark | `price-model`, the lead weights and the held-out Pinnacle test already do. |
| Overfitting is the default failure | Every multi-cell estimate here is shrunk, marked down by an error bar and floored (see the README). The list of what was tried is in 2.4. |

### 2.2 Closing line value of the pool's edges (tested)

The file's recommendation is to track CLV as the main check. For every opening-board over
quote with three or more other books at the open and the close, the edge against the
other books at the open, and what the price was worth at the close (fair closing price of the
others minus the price paid, in probability points):

| edge vs. the lead-weighted pool | n | mean CLV | beat the close |
|---|---|---|---|
| −3% to 0 | 17,321 | −1.4 pp | 22% |
| 0 to 2% | 3,926 | +1.4 pp | 70% |
| 2% to 4% | 1,216 | +3.2 pp | 87% |
| 4% to 7% | 537 | +6.0 pp | 94% |
| above 7% | 301 | +12.4 pp | 98% |

Slope of CLV on edge: **0.97** for the pool, 0.95 for the plain median, **0.06 for the
projection's own edge**. So a pool edge is realised almost one-for-one at the close, and a
projection edge is not.

How to read it:
- **It is partly mechanical.** A laggard's off-market price stays off-market until the close,
  so an edge against the others at the open is still there at the close. It shows that line-shopping
  edges are real and persistent. It does not show the pool is *right*.
- Edges of 2% or more are concentrated at the laggards: Hard Rock +7.1 pp, FanDuel +6.9 pp,
  theScore +5.6 pp, against DraftKings +4.4 pp. That is the doc's adverse-selection point
  from the bettor's side: the opportunity is the slow book's stale line.
- **Depth is the constraint.** The Tuesday boards are mostly one book per market, so the pool has
  nothing to compare against: 3 to 7 rows a week at 3%. The reconstructed opening boards have
  about 2,000 quotes at 2%+ over three weeks, but those are each book's *first-ever* price, not one
  moment, so they are not all simultaneously bettable. Thursday and Saturday boards, which are
  deeper, are where this lives.
- **Outcomes are not used here on purpose.** The actuals feed omits players who recorded
  nothing, which inflates every over, so a realised ROI on over bets would be biased up. CLV is
  the sound metric, which is also the file's advice.
- **The paper ledger ignores limits.** Blume says novelty props cap at "maybe $1,000, maybe
  $5,000", Circa scales limits up as an event approaches, and Bennett is explicit that books
  limit winners. The early, soft prices are exactly where limits are lowest. A realistic ledger
  would cap stakes and model account restriction; that is a real-money question, not a
  pricing one.

### 2.3 Tested and not supported

| Claim | Test | Result |
|---|---|---|
| **News and injuries beat models**, so a stale projection should lose most where the market moved | Split the markets by how far the book moved between the open and the close | **Not supported.** The Tuesday-snapshot gap is +0.0196 where the book barely moved, +0.0193 where it moved a little, +0.0143 where it moved a lot. The projection improves through the week whether or not the market reacted. |
| **Uncertainty depends on the data regime** (Blume): thin-data players need wider bands | Best band multiplier by projected-volume tercile, per stat | No consistent pattern: receiving yards wants ×2, ×1.5, ×2.5 across low, mid and high volume; passing yards ×4, ×1.25, ×4. No action. |
| **Hold falls and limits rise toward the event** (Circa, Pinnacle) | Median hold by book and board | True only of **Pinnacle**: 6.5% at the open, 4.8% at the close. Every other book's prop hold is flat across the week (DraftKings 5.7%, Circa 4.8%, Hard Rock 7.8% to 7.9%). |
| Hold structure could improve one-sided de-vigging (half the board) | Hide one side of every two-sided quote and estimate its fair price from `raw/(1+H)`, with H fitted on other weeks | Per-book hold cuts the mean error from 0.56 to 0.47 pp (−16%); per price band helps longshots (0.21 to 0.19 pp). The absolute gain is about 0.1 pp against edges of 3%: **real but tiny.** |

**This corrects something I said earlier.** The README and write-up said the timing gap was
news the books had priced and the projection had not read. The move split above does not
support that. What the data do support is that the projection is worse early in the week and
better late, whether or not the book moved. The docs now say that, and `npm run projection-miss`
reproduces the split. The mechanism is not established; roles and practice status resolving
during the week is the obvious candidate, and it is a hypothesis.

### 2.4 Ideas the file raises that we cannot test yet

- **Account-level flow** (who bet, at what limit) carries more than handle, per Trenhaile and
  Circa. We have no account data. The nearest proxy we have is which books lead, which is
  already in the weights.
- **Stale-quote detection** needs the timestamps in Part 1.
- **Head-fakes** (decoy bets that move a line) mean a line move is not a clean signal. Our lead
  measure averages over many markets, which dilutes single decoys, but it cannot detect them.

**Trial log, as the file asks.** Specifications tried in this analysis, so the count is
visible: hold models (8 variants), CLV edge definitions (3), move-split terciles (3 × 2
snapshots), volume tiers (4 stats × 3), band multipliers (7 values, per stat and snapshot),
Student-t tails (3), projection shares (about 20 stat-by-slot cells). Only the CLV result is
large against that count, and it is the mechanical one. The 0.53 share on receptions is one
of about twenty cells, which is why shares are marked down by an error bar before use.

---

## 3. What I would do, in order

1. **Run `optic-discover`** and read the sportsbook list for Novig, Sporttrade, Kalshi
   and Polymarket with NFL player-prop markets. No code. It decides whether Part 1's
   prediction-market question is worth anything.
2. **Confirm whether props are in the SSE stream** and measure per-book update lag over one week.
3. **Push the capture toward deeper boards** (Thursday and Saturday), since the pool's edges
   need three or more books per market. The Saturday slot already exists.
4. **Add stake limits and account restriction to the paper ledger** before reading any
   ROI as real. This changes the conclusions more than any model change here.
5. Only if cheap: per-book hold for one-sided de-vigging. About 0.1 pp.

The CLV, hold and volume-tier numbers above come from ad-hoc analysis, not from a script in
the repo. The move-split test is in `npm run projection-miss`. I can turn the CLV test into
a report if you want it tracked weekly.
