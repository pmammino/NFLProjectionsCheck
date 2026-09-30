// More than one capture of the same week. Pure — no I/O, unit tested
// directly (see slots.test.mjs).
//
// ---------------------------------------------------------------------------
// Why a week needs more than one capture
// ---------------------------------------------------------------------------
// The Tuesday drop used to be the only one, so it could own
// data/props/{season}/week-NN.csv outright. It no longer can, for a reason
// the 2026 captures make unarguable: books post player props game by game
// through the week, and on Tuesday most of the board does not exist yet.
// Measured against what the same week looked like near kickoff —
//
//     week 2   Tuesday  1,544 markets / 15 fixtures   vs  18,692 / 16
//     week 3   Tuesday  2,559 markets /  3 fixtures   vs  62,590 / 16
//
// — the Tuesday drop is 8% and 4% of the board respectively, and in week 3 it
// never saw 13 of the 16 games at all. Two-sided quotes, the ones that can be
// de-vigged, go from 51% of the Tuesday board to 74% near kickoff.
//
// The obvious fix — move the drop later — would throw away something real.
// Those Tuesday prices beat the close by +5.25% over 45 player-weeks, a 70%
// beat rate. Early is genuinely softer, exactly as the paper-trading section
// of the README claims. Both facts are true at once: Tuesday has the best
// prices and almost none of the board.
//
// So a week can be captured more than once and each capture writes into its
// own SLOT. Nothing has to be chosen in advance; the slots are compared on
// the evidence they generate.
//
// ---------------------------------------------------------------------------
// The layout, and the one file that must never be overwritten
// ---------------------------------------------------------------------------
// `main` is the canonical Tuesday drop and keeps the original paths, so every
// committed file and every existing reader is untouched. Any other slot nests
// one level deeper:
//
//     data/props/2026/week-03.csv             main — the Tuesday drop
//     data/props/2026/thursday/week-03.csv    a later live sweep
//     data/props/2026/t-48h/week-03.csv       a backfill reconstruction
//
// A backfill defaults its slot to the moment it reconstructs, so it cannot
// overwrite the drop. That matters more than it looks: the drop is the record
// of what a subscriber was actually sent, and it is the one artefact in this
// project that no later run can rebuild. Everything else — ledgers, rollups,
// the dashboard dataset — is a pure function of the snapshots and is
// regenerated from scratch on every run.

export const SLOT_MAIN = "main";

// Slot -> the extra path segment it lives under. `main` adds none.
export function slotDir(slot) {
  return !slot || slot === SLOT_MAIN ? "" : slot;
}

// A slot name has to be safe to use as a directory and stable enough to key a
// rollup on. Rejected loudly rather than sanitized: a typo that silently
// became a new slot would split a season's ledger in two.
export function isValidSlot(slot) {
  return typeof slot === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(slot);
}

export function assertValidSlot(slot) {
  if (!isValidSlot(slot)) {
    throw new Error(`Slot must be a simple directory-safe name, got "${slot}"`);
  }
  return slot;
}

// Rows written before slots existed carry no Slot column, and every one of
// them came from the Tuesday drop.
export function slotOf(row) {
  return row?.Slot || SLOT_MAIN;
}
