// The single definition of every stat this project bets on: how to find it in
// OpticOdds, how to model it, which projection columns feed it, and which
// actuals columns grade it. No I/O — unit tested directly (see markets.test.mjs).
//
// This consolidates what used to be spread across two files: props.mjs owned
// `projCols` while grade-bets.mjs kept its own parallel ACTUAL_COLS table. A
// stat defined in two places drifts, so both now live here.
//
// Field reference:
//   optic     OpticOdds market-name aliases. Matched case- and
//             punctuation-insensitively (see matchStatKey). Listed generously
//             because market naming varies and the exact strings have not been
//             confirmed against a live call — run scripts/optic-discover.mjs
//             to print what the API actually offers and prune to the real set.
//   hasLine   true  = over/under market with a real line (e.g. 249.5 yards)
//             false = yes/no market treated as an implicit "over 0.5", which
//                     matches how lib/td.ts already scores anytime TDs.
//   kind      "continuous" -> two-piece-normal model off Floor/Median/Ceiling
//             "poisson"    -> Poisson model off the projected median count
//   projCols  weekly projection column(s) to sum for the projected value
//   actualCols  actuals column(s) to sum when grading. An empty array means
//             the actuals feed has no source for this stat, so bets on it can
//             never be graded and stay pending forever.

export const STAT_DEFS = {
  anytimeTD: {
    optic: ["anytime touchdown scorer", "anytime touchdown", "player anytime td", "to score a touchdown", "anytime td scorer"],
    hasLine: false,
    kind: "poisson",
    projCols: ["RushTDs", "RecTDs"],
    actualCols: ["RushTD", "RecptTD"],
  },
  passYds: {
    optic: ["player passing yards", "passing yards", "pass yards"],
    hasLine: true,
    kind: "continuous",
    projCols: ["PassYards"],
    actualCols: ["PassYards"],
  },
  passAtt: {
    optic: ["player passing attempts", "passing attempts", "pass attempts"],
    hasLine: true,
    kind: "continuous",
    projCols: ["PassAttempts"],
    actualCols: ["PassAtt"],
  },
  completions: {
    optic: ["player passing completions", "passing completions", "pass completions"],
    hasLine: true,
    kind: "continuous",
    projCols: ["PassCompletions"],
    actualCols: ["PassComp"],
  },
  passTD: {
    optic: ["player passing touchdowns", "passing touchdowns", "pass tds"],
    hasLine: true,
    kind: "poisson",
    projCols: ["PassTDs"],
    actualCols: ["PassTD"],
  },
  int: {
    optic: ["player passing interceptions", "interceptions thrown", "player interceptions", "passing interceptions"],
    hasLine: true,
    kind: "poisson",
    projCols: ["PassInts"],
    // The RotoWire actuals feed carries no interception column (see README),
    // so these bets are captured and priced but never graded. Switching
    // actuals to OpticOdds player-results would close this gap.
    actualCols: [],
  },
  rushYds: {
    optic: ["player rushing yards", "rushing yards", "rush yards"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RushYards"],
    actualCols: ["RushYards"],
  },
  rushAtt: {
    optic: ["player rushing attempts", "rushing attempts", "player carries", "rush attempts"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RushAttempts"],
    actualCols: ["Rushes"],
  },
  rushTD: {
    optic: ["player rushing touchdowns", "rushing touchdowns", "rush tds"],
    hasLine: true,
    kind: "poisson",
    projCols: ["RushTDs"],
    actualCols: ["RushTD"],
  },
  receptions: {
    optic: ["player receptions", "receptions", "total receptions"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RecCompletions"],
    actualCols: ["Receptions"],
  },
  recYds: {
    optic: ["player receiving yards", "receiving yards", "rec yards"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RecYards"],
    actualCols: ["ReceptYds"],
  },
  recTD: {
    optic: ["player receiving touchdowns", "receiving touchdowns", "rec tds"],
    hasLine: true,
    kind: "poisson",
    projCols: ["RecTDs"],
    actualCols: ["RecptTD"],
  },
};

export const STAT_KEYS = Object.keys(STAT_DEFS);

// Normalize a market name for comparison: lowercase, drop punctuation, collapse
// whitespace. "Player Passing Yards" and "player_passing_yards" both become
// "player passing yards".
export function normalizeMarketName(name) {
  if (name === undefined || name === null) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Prebuilt alias -> stat key lookup.
const ALIAS_TO_STAT = new Map();
for (const [statKey, def] of Object.entries(STAT_DEFS)) {
  for (const alias of def.optic) {
    const norm = normalizeMarketName(alias);
    if (ALIAS_TO_STAT.has(norm) && ALIAS_TO_STAT.get(norm) !== statKey) {
      throw new Error(
        `Market alias "${alias}" is claimed by both ${ALIAS_TO_STAT.get(norm)} and ${statKey}`
      );
    }
    ALIAS_TO_STAT.set(norm, statKey);
  }
}

// An OpticOdds market name -> our stat key, or null if it isn't one we bet.
//
// Exact (normalized) match only. Substring matching was considered and
// rejected: "player passing touchdowns" contains neither more nor less signal
// than "player rushing touchdowns" under a loose match, and mapping a market
// to the wrong stat would price a bet against the wrong projection column —
// the same class of silent corruption the player crosswalk guards against.
// Unmatched markets are reported by the capture script so real aliases can be
// added here deliberately.
export function matchStatKey(marketName) {
  return ALIAS_TO_STAT.get(normalizeMarketName(marketName)) ?? null;
}

// Every OpticOdds market name we know about — used to narrow the `market`
// query param so we don't pull (and pay for) markets we don't model.
export function allOpticMarketNames() {
  return Object.values(STAT_DEFS).flatMap((d) => d.optic);
}
