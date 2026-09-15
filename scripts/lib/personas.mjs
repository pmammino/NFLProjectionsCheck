// Simulated bettors, and the engine that decides what each one would have bet.
// Pure — no I/O, unit tested directly (see personas.test.mjs).
//
// ---------------------------------------------------------------------------
// What this is for, and what it is NOT for
// ---------------------------------------------------------------------------
// The question behind the paper trading is "would these projections help
// someone find bets?", and the honest answer depends on WHO is asking. Nobody
// tails four hundred edges a week. Real people hold accounts at one or two
// books, place somewhere between five and thirty bets, and either run a fixed
// weekly budget or a bankroll they let compound.
//
// So the pipeline splits in two:
//
//   THE EDGE SET (data/edges/) is every qualifying edge at drop time. It is the
//   statistical instrument: with thousands of bets a season, its ROI has a
//   tight enough confidence interval to say whether the model is predictive.
//
//   THE PERSONAS (data/bets/{persona}/) are what individual strategies would
//   have experienced. They are the realism instrument, and they CANNOT settle
//   whether the model works — a persona taking ten bets a week accumulates
//   ~180 a season, where the 2-sigma band on ROI is roughly +/-14%. That is
//   wide enough to swallow any edge a real model could have.
//
// Keeping those two apart is the point. Presenting a persona's ROI as evidence
// the projections work would be reading noise as signal.
//
// ---------------------------------------------------------------------------
// The dimensions that actually separate bettors
// ---------------------------------------------------------------------------
//   books        which books they can reach (line shopping vs one account)
//   maxBets      how many bets they will actually place in a week
//   select       how they choose among more candidates than they have slots
//   diversify    whether they'll stack correlated bets on one player or game
//   staking      how much goes on each bet
//   bankroll     whether the money resets weekly or compounds
//
// `diversify.maxPerPlayer` deserves a note. The raw edge set will happily
// surface Over Rushing Yards AND Anytime Touchdown on the same running back —
// bets that win and lose together. Treating them as independent overstates
// both the return and, more dangerously, understates the variance. A real
// bettor with ten slots does not spend two of them on the same player's
// afternoon.

import { americanToDecimal, kellyFraction } from "./odds.mjs";

// Expected profit per unit staked, at the price actually available.
// Positive means the bet makes money at that price; this is the same quantity
// `Edge` measures, expressed in payout terms rather than probability.
export function expectedValue(ourProb, americanOdds) {
  const dec = americanToDecimal(americanOdds);
  if (dec === null || !(ourProb >= 0 && ourProb <= 1)) return null;
  return ourProb * (dec - 1) - (1 - ourProb);
}

// ---- Bankroll ----------------------------------------------------------------
// Stakes are in "units" throughout, where a unit is 1% of the STARTING
// bankroll. A persona begins the season with 100 units. That keeps flat and
// Kelly stakes directly comparable and means no dollar figure is ever needed.
export const STARTING_BANKROLL_UNITS = 100;

export const BANKROLL_KINDS = ["weekly-budget", "compounding", "flat"];

// How much the persona has available to stake this week.
//   weekly-budget  a fixed allowance that resets every week, spent or not.
//                  Matches "I put $500 a week through" — the most common way
//                  recreational bettors actually behave.
//   compounding    one bankroll for the season; stakes scale with it. This is
//                  the only setting where Kelly means what Kelly is supposed
//                  to mean, since Kelly sizes a FRACTION of current wealth.
//   flat           stake size never varies; bankroll is tracked for reporting
//                  but never constrains.
export function weeklyCapacity(persona, bankrollUnits) {
  const b = persona.bankroll ?? { kind: "flat" };
  if (b.kind === "weekly-budget") return b.units;
  if (b.kind === "compounding") return bankrollUnits;
  return Infinity;
}

// ---- Selection ---------------------------------------------------------------

// Candidates this persona is willing to consider at all.
export function eligible(edges, persona) {
  const books = persona.books ? new Set(persona.books.map((b) => b.toLowerCase())) : null;
  const markets = persona.markets ? new Set(persona.markets) : null;

  return edges.filter((e) => {
    if (books && !books.has(String(e.book).toLowerCase())) return false;
    if (markets && !markets.has(e.stat)) return false;
    if (persona.requireTwoSided && e.oneSided) return false;
    const edge = persona.edgeBasis === "novig" ? e.modelEdge : e.edge;
    if (edge === null || edge === undefined) return false;
    if (edge < (persona.minEdge ?? 0)) return false;
    // A price we cannot compute a payout for cannot be staked.
    if (americanToDecimal(e.odds) === null) return false;
    // Some books publish a max stake. An "edge" only available at a trivial
    // limit is not a strategy, so a persona may require real capacity.
    if (persona.minLimit && e.maxStake !== null && e.maxStake !== undefined && e.maxStake < persona.minLimit) {
      return false;
    }
    return true;
  });
}

// Collapse a player's stat to ONE bet: the best price available to this
// persona.
//
// The edge set carries a row per (player, stat, book, line, side), because a
// persona that can only reach DraftKings needs DraftKings' own quote. But a
// bettor does not place the same wager at five books — that is one bet, taken
// at the best number. Skipping this step inflates the ledger with perfectly
// correlated duplicates: the Firehose went from 1,606 "bets" to a few hundred
// real ones when it was added, and every duplicate was the same outcome
// counted again.
//
// It runs AFTER the book filter, so the single-book persona collapses to the
// best price IT could reach rather than the best price anywhere. That is
// precisely what makes the shopper-vs-single-book comparison measure line
// shopping.
//
// Multiple lines at one book (Over 249.5 and Over 259.5) collapse the same
// way — they are alternatives, not additive positions.
export function dedupe(edges, persona) {
  if (persona.dedupe === false) return edges;
  const basis = persona.edgeBasis === "novig" ? "modelEdge" : "edge";
  const best = new Map();
  for (const e of edges) {
    const key = `${e.playerId}|${e.stat}`;
    const cur = best.get(key);
    if (!cur || (e[basis] ?? -Infinity) > (cur[basis] ?? -Infinity)) best.set(key, e);
  }
  return [...best.values()];
}

// Rank candidates, best first.
//   top-edge  biggest probability edge. What a bettor scanning a list does.
//   top-ev    biggest expected profit per unit. Prefers longer prices at the
//             same edge, because the same edge on a +300 shot is worth more
//             per unit than on a -300 favourite.
export function rank(edges, persona) {
  const basis = persona.edgeBasis === "novig" ? "modelEdge" : "edge";
  const score = (e) =>
    persona.select === "top-ev" ? (expectedValue(e.ourProb, e.odds) ?? -Infinity) : e[basis];
  // Tie-break on the other measure, then on a stable key, so a re-run of the
  // same week always produces the same ledger.
  return [...edges].sort(
    (a, b) =>
      score(b) - score(a) ||
      (b[basis] ?? 0) - (a[basis] ?? 0) ||
      String(a.playerId).localeCompare(String(b.playerId)) ||
      String(a.stat).localeCompare(String(b.stat))
  );
}

// Walk the ranked list taking bets until the slots run out, refusing any that
// would breach a diversification rule.
export function diversify(ranked, persona) {
  const maxPerGame = persona.diversify?.maxPerGame ?? Infinity;
  const maxPerPlayer = persona.diversify?.maxPerPlayer ?? Infinity;
  const maxBets = persona.maxBetsPerWeek ?? Infinity;

  const perGame = new Map();
  const perPlayer = new Map();
  const taken = [];

  for (const e of ranked) {
    if (taken.length >= maxBets) break;
    const gameKey = e.fixtureId || `${e.team}|${e.opp}`;
    const playerKey = e.playerId;
    if ((perGame.get(gameKey) ?? 0) >= maxPerGame) continue;
    if ((perPlayer.get(playerKey) ?? 0) >= maxPerPlayer) continue;
    perGame.set(gameKey, (perGame.get(gameKey) ?? 0) + 1);
    perPlayer.set(playerKey, (perPlayer.get(playerKey) ?? 0) + 1);
    taken.push(e);
  }
  return taken;
}

// ---- Staking -----------------------------------------------------------------
export const STAKING_KINDS = ["flat", "kelly", "proportional", "tiered"];

// Raw stake per bet, before any bankroll constraint.
function rawStakes(bets, persona, bankrollUnits) {
  const s = persona.staking ?? { kind: "flat", units: 1 };

  if (s.kind === "flat") return bets.map(() => s.units ?? 1);

  if (s.kind === "kelly") {
    // Kelly is a fraction of CURRENT wealth, so it is only meaningful against
    // a compounding bankroll. Against a flat one it degenerates into a
    // constant, which is the caller's choice to make, not ours to prevent.
    const base = persona.bankroll?.kind === "compounding" ? bankrollUnits : STARTING_BANKROLL_UNITS;
    return bets.map((e) => {
      const f = kellyFraction(e.ourProb, americanToDecimal(e.odds));
      const capped = Math.min(f * (s.fraction ?? 0.25), s.cap ?? 0.03);
      return capped * base;
    });
  }

  if (s.kind === "tiered") {
    // Bigger edge, bigger bet — the heuristic a lot of people actually use,
    // and worth testing against Kelly rather than assuming Kelly wins.
    const tiers = s.tiers ?? [
      { minEdge: 0.10, units: 3 },
      { minEdge: 0.05, units: 2 },
      { minEdge: 0, units: 1 },
    ];
    const basis = persona.edgeBasis === "novig" ? "modelEdge" : "edge";
    return bets.map((e) => tiers.find((t) => e[basis] >= t.minEdge)?.units ?? 1);
  }

  if (s.kind === "proportional") {
    // Spread a fixed budget across the slate in proportion to edge. The budget
    // is fully committed regardless of how many candidates there are, which is
    // what "I'm putting $500 through this week" actually means.
    const basis = persona.edgeBasis === "novig" ? "modelEdge" : "edge";
    const total = bets.reduce((sum, e) => sum + Math.max(0, e[basis]), 0);
    const budget = persona.bankroll?.units ?? STARTING_BANKROLL_UNITS;
    if (!(total > 0)) return bets.map(() => budget / Math.max(1, bets.length));
    return bets.map((e) => (Math.max(0, e[basis]) / total) * budget);
  }

  throw new Error(`Unknown staking kind: ${s.kind}`);
}

// Apply stakes, scaling down if the week's capacity would be exceeded.
//
// Scaling proportionally rather than dropping bets keeps the persona's
// SELECTION intact — we want to know how its choices performed, not how a
// budget ceiling happened to truncate them.
export function stake(bets, persona, bankrollUnits) {
  const raw = rawStakes(bets, persona, bankrollUnits);
  const capacity = weeklyCapacity(persona, bankrollUnits);
  const total = raw.reduce((s, x) => s + x, 0);

  const scale = Number.isFinite(capacity) && total > capacity && total > 0 ? capacity / total : 1;
  return bets.map((e, i) => ({ ...e, stakeUnits: round4(raw[i] * scale), scaledBy: round4(scale) }));
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

// ---- One week, one persona ---------------------------------------------------
// edges: candidate rows for the week. bankrollUnits: the persona's bankroll
// going in. Returns the staked bets; the caller settles them and rolls the
// bankroll forward.
export function simulateWeek(edges, persona, bankrollUnits = STARTING_BANKROLL_UNITS) {
  const pool = dedupe(eligible(edges ?? [], persona), persona);
  const ranked = rank(pool, persona);
  const chosen = diversify(ranked, persona);
  return stake(chosen, persona, bankrollUnits);
}

// Roll the bankroll forward after a week settles. Only a compounding persona
// actually moves; the others report their bankroll for continuity but stake
// off a fixed base.
export function advanceBankroll(persona, bankrollUnits, weekPnlUnits) {
  if (persona.bankroll?.kind !== "compounding") return bankrollUnits;
  // Floor at a small positive value: a bankrupt persona should stop betting,
  // not stake negative amounts. The ledger records the ruin either way.
  return Math.max(0, round4(bankrollUnits + weekPnlUnits));
}

// ---- The roster --------------------------------------------------------------
// Chosen so the DIFFERENCES between them answer questions:
//   firehose vs anyone      what does discipline cost, or save?
//   shopper vs single-book  what is line shopping actually worth?
//   purist vs firehose      do de-viggable edges beat raw-price ones?
//   tiered vs kelly         does a simple heuristic keep up with Kelly?
export const PERSONAS = [
  {
    id: "firehose",
    label: "The Firehose",
    description:
      "Every qualifying edge, one unit each, best price across all books. Not a person — this is the statistical benchmark the other personas are measured against.",
    minEdge: 0.03,
    staking: { kind: "flat", units: 1 },
    bankroll: { kind: "flat" },
  },
  {
    id: "disciplined",
    label: "The Disciplined Flat Bettor",
    description:
      "Ten bets a week, one unit each, DraftKings only. Never two bets on the same player. The most realistic recreational profile.",
    books: ["draftkings"],
    minEdge: 0.03,
    maxBetsPerWeek: 10,
    select: "top-edge",
    diversify: { maxPerGame: 2, maxPerPlayer: 1 },
    staking: { kind: "flat", units: 1 },
    bankroll: { kind: "weekly-budget", units: 10 },
  },
  {
    id: "shopper",
    label: "The Line Shopper",
    description:
      "Same rules as the Disciplined Flat Bettor, but shops all eight books for the best price. The gap between the two is what line shopping is worth.",
    minEdge: 0.03,
    maxBetsPerWeek: 10,
    select: "top-edge",
    diversify: { maxPerGame: 2, maxPerPlayer: 1 },
    staking: { kind: "flat", units: 1 },
    bankroll: { kind: "weekly-budget", units: 10 },
  },
  {
    id: "kelly",
    label: "The Kelly Compounder",
    description:
      "Quarter-Kelly on a bankroll that compounds all season, up to 25 bets a week across all books. Stakes grow after good runs and shrink after bad ones.",
    minEdge: 0.03,
    maxBetsPerWeek: 25,
    select: "top-ev",
    diversify: { maxPerGame: 3, maxPerPlayer: 1 },
    staking: { kind: "kelly", fraction: 0.25, cap: 0.03 },
    bankroll: { kind: "compounding" },
  },
  {
    id: "budget",
    label: "The Weekly Budget",
    description:
      "Twenty units a week, fully committed, spread across the top ten edges in proportion to edge size. Bets the same amount every week regardless of how good the slate is.",
    minEdge: 0.03,
    maxBetsPerWeek: 10,
    select: "top-edge",
    diversify: { maxPerGame: 2, maxPerPlayer: 1 },
    staking: { kind: "proportional" },
    bankroll: { kind: "weekly-budget", units: 20 },
  },
  {
    id: "purist",
    label: "The Purist",
    description:
      "Only markets where both sides are quoted, so the price can be de-vigged and the edge measured against what the market actually believes. Ranked by that de-vigged disagreement.",
    minEdge: 0.04,
    requireTwoSided: true,
    edgeBasis: "novig",
    maxBetsPerWeek: 15,
    select: "top-edge",
    diversify: { maxPerGame: 2, maxPerPlayer: 1 },
    staking: { kind: "kelly", fraction: 0.25, cap: 0.03 },
    bankroll: { kind: "compounding" },
  },
];

export const PERSONA_BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));
