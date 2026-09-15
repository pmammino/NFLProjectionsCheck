// Which sportsbooks the ledger is allowed to price against, and how a
// human-written name resolves to the id OpticOdds actually uses. No I/O — unit
// tested directly (see books.test.mjs).
//
// ---------------------------------------------------------------------------
// Why this is a curated list and not "every book available"
// ---------------------------------------------------------------------------
// The capture takes the BEST price across every book it pulls. That is the
// right thing to do — different books post different lines and taking the best
// one is the whole point of line shopping — but only among books you can
// actually bet at. A best price landing at a book with no account behind it
// produces a paper return that could never have been earned, and because
// best-of-N systematically finds the most generous outlier, the distortion
// grows with the size of the list rather than averaging out.
//
// The first live run made that concrete: filtering to active + onshore + NFL
// still left 86 books, including bet99, betano and 888sport. `is_onshore` is
// OpticOdds' flag for a REGULATED book, not a US one, so it does not narrow to
// "books a US bettor holds an account with".
//
// Hence an explicit roster. `--books` overrides it; `--all-books` restores the
// old derive-everything behaviour for research.

// The books this project prices against, as written by a human. These are
// matched against the live list rather than used verbatim — see resolveBookIds.
export const DEFAULT_BOOKS = [
  "draftkings",
  "fanduel",
  "betmgm",
  "caesars",
  "betrivers",
  "hardrock",
  "thescore",
  "circa",
];

// Lowercase, strip everything that isn't alphanumeric. "Hard Rock Bet" and
// "hard_rock_bet" both become "hardrockbet".
export function normalizeBookName(name) {
  if (name === undefined || name === null) return "";
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Resolve requested book names against the live /sportsbooks rows.
//
// Exact normalized match wins. Failing that, a UNIQUE containment match is
// accepted, which is what lets "hardrock" find "hard_rock_bet" and "circa"
// find "circa_sports" without anyone having to know the API's exact spelling.
// Anything matching two or more live books is reported ambiguous rather than
// guessed, and anything matching none is reported missing.
//
// Reporting those failures matters more than it might seem: a book id the API
// does not recognise is not an error, it simply returns no odds. Silently
// dropping DraftKings from a capture would look identical to DraftKings not
// pricing that week.
//
// Returns { ids, matched, missing, ambiguous }.
export function resolveBookIds(requested, liveBooks) {
  const rows = (liveBooks ?? []).map((b) =>
    typeof b === "string" ? { id: b, name: b } : { id: b?.id ?? b?.name, name: b?.name ?? b?.id }
  ).filter((b) => b.id);

  const ids = [];
  const matched = new Map(); // requested -> live id
  const missing = [];
  const ambiguous = new Map(); // requested -> live ids

  for (const want of requested ?? []) {
    const key = normalizeBookName(want);
    if (!key) continue;

    const exact = rows.filter(
      (b) => normalizeBookName(b.id) === key || normalizeBookName(b.name) === key
    );
    const hits = exact.length
      ? exact
      : rows.filter(
          (b) =>
            normalizeBookName(b.id).includes(key) || normalizeBookName(b.name).includes(key)
        );

    const distinct = [...new Map(hits.map((b) => [b.id, b])).values()];
    if (distinct.length === 0) {
      missing.push(want);
    } else if (distinct.length > 1) {
      ambiguous.set(want, distinct.map((b) => b.id));
    } else {
      matched.set(want, distinct[0].id);
      ids.push(distinct[0].id);
    }
  }

  return { ids: [...new Set(ids)], matched, missing, ambiguous };
}
