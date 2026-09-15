# Legacy bet ledger

`2026/week-01.csv` is the original paper-trading ledger, produced before the
persona rework: one row per (player, stat) at the best price across all books,
flat and quarter-Kelly stakes side by side.

It is kept because it is the only ledger that was graded under the old
methodology, and because it is the record of what was actually published that
week. It is **not** read by anything: `scripts/build-betting-data.mjs` now reads
`data/bets/{persona}/`, and a stray season directory under `data/bets/` would
have been mistaken for a persona named "2026".

Its numbers are reproduced exactly by the `firehose` persona replaying over
`data/props/2026/week-01.csv` — 294 bets, 286 graded, −11.44 units — so nothing
is lost by ignoring it.

Note that week 1 was priced from RotoWire, which quoted one side only. Those
rows carry `Source=rotowire` when replayed and are not methodologically
comparable to OpticOdds weeks.
