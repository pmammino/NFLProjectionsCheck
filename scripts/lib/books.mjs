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

// ---------------------------------------------------------------------------
// Two lists, because they answer two different questions
// ---------------------------------------------------------------------------
// "Which books do I price against?" and "which books can I actually bet at?"
// are not the same question, and this file used to conflate them into one
// roster. That conflation is what forces the all-or-nothing choice the
// --include-offshore flag was reaching for: Pinnacle's de-vigged price is the
// best available estimate of a true probability, so you want it in the
// consensus — but it is also a book most subscribers cannot reach, so a
// ledger that takes its price books a bet nobody could have placed.
//
// Split in two, both are satisfiable at once:
//
//   BETTABLE_BOOKS   you hold an account here. ONLY these can be the price on
//                    a bet — they alone reach data/edges/, the personas and
//                    the best-price comparison.
//   REFERENCE_BOOKS  priced, captured and recorded, never staked. They exist
//                    to sharpen the fair-value consensus the model is judged
//                    against (see MARKET_SETS in consensus.mjs).
//
// Every row in data/props/ carries a `Bettable` column saying which it was,
// so an archived capture can always be re-read without knowing the roster of
// the day.
//
// Adding reference books is close to free. /fixtures/odds takes 5 sportsbooks
// per request, so a roster of 8 and a roster of 10 both cost two book batches
// per fixture batch — the 9th and 10th book ride along at no extra quota.

// Books a bet can actually be placed at, as written by a human. These are
// matched against the live list rather than used verbatim — see resolveBookIds.
export const BETTABLE_BOOKS = [
  "draftkings",
  "fanduel",
  "betmgm",
  "caesars",
  "betrivers",
  "hardrock",
  "thescore",
  // Spelled out in full, and that is not cosmetic. This entry used to read
  // "circa", which resolved fine until OpticOdds' live list gained a second
  // Circa id: from then on "circa" matched BOTH circa_sports and circa_vegas,
  // resolveBookIds reported it ambiguous, and it was dropped from every
  // capture. Observed in a 2026 week-3 run: "7 of 8 requested" books, with
  // `"circa" is ambiguous (circa_sports, circa_vegas) — skipped`.
  //
  // The cost was invisible in the ledger and large in the analysis. Circa is
  // the only sharp book in this roster, so the `sharp` market set that
  // price-model.mjs compares against went from thin to unusable — it holds
  // 114 markets, all from week 1, the last week before the id went ambiguous.
  //
  // Only ONE of the two is listed on purpose: the consensus gives each book a
  // single vote, and two ids for one operator would weight Circa double.
  "circa_sports",
];

// Books captured for their PRICE but never staked.
//
// Pinnacle alone, deliberately. It is the canonical sharp book — low margin,
// high limits, the number other books move to — so it is worth far more to a
// fair-value consensus than a long tail of smaller names, and one extra book
// stays inside the same request budget. Others can be added here; each one
// that fails to resolve against the live list prints a warning on every
// capture, so an id nobody has confirmed is a recurring cost rather than a
// free option.
//
// This is NOT the `--all-books` escape hatch. That one pulls every active NFL
// book and takes the best price across all of them, which produces returns
// nobody could have earned. Reference books never become a price.
export const REFERENCE_BOOKS = ["pinnacle"];

// Kept as the old name for anything still asking for "the roster". It is the
// BETTABLE list: that is what the name meant before the split, and silently
// widening it to include books you cannot bet at is precisely the bug this
// split exists to make impossible.
export const DEFAULT_BOOKS = BETTABLE_BOOKS;

// Everything a capture requests from the API: both lists, de-duplicated. A
// name appearing in both is bettable — the stronger claim wins, since a book
// you can bet at is also a book you can price against.
export function booksToFetch({ bettable = BETTABLE_BOOKS, reference = REFERENCE_BOOKS } = {}) {
  const seen = new Set(bettable.map(normalizeBookName));
  return [...bettable, ...reference.filter((b) => !seen.has(normalizeBookName(b)))];
}

// Lowercase, strip everything that isn't alphanumeric. "Hard Rock Bet" and
// "hard_rock_bet" both become "hardrockbet".
export function normalizeBookName(name) {
  if (name === undefined || name === null) return "";
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// OpticOdds ids and display names drift across captures: the 2026 files hold
// "mgm" and "BetMGM", "circasports" and "circa". They are one book each, and
// counting them twice would show a book that is not there — or, in a weighted
// consensus, give one book two votes and two separate track records.
const BOOK_ALIASES = { mgm: "betmgm", hardrockbet: "hardrock", circa: "circasports" };

// The one key a book is known by everywhere downstream of a capture.
export function canonicalBookKey(book) {
  const k = normalizeBookName(book);
  return BOOK_ALIASES[k] ?? k;
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
  const resolved = []; // { requested, id, name } — every spelling, for bookKeySet
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
      resolved.push({ requested: want, id: distinct[0].id, name: distinct[0].name });
      ids.push(distinct[0].id);
    }
  }

  return { ids: [...new Set(ids)], matched, resolved, missing, ambiguous };
}

// Every spelling by which a resolved book might appear in a captured row:
// what we asked for, the live id, and the live display name. A capture writes
// whichever of these OpticOdds returns — the 2026 files hold "DraftKings",
// "draftkings" and "hard_rock" across different weeks — so membership has to
// be tested against all of them, normalized.
//
// `resolved` is resolveBookIds().resolved, filtered to the books in question.
export function bookKeySet(resolved) {
  const keys = new Set();
  for (const r of resolved ?? []) {
    for (const form of [r.requested, r.id, r.name]) {
      const k = normalizeBookName(form);
      if (k) keys.add(k);
    }
  }
  return keys;
}

// Is this book one a bet can be placed at? Unknown books are NOT bettable:
// a capture that returns a book nobody listed is a book with no account
// behind it, and defaulting it to bettable would put its price in a ledger.
export function isBettableBook(book, bettableKeys) {
  return (bettableKeys ?? new Set()).has(normalizeBookName(book));
}
