// The single definition of every stat this project bets on: how to find it in
// OpticOdds, how to model it, which projection columns feed it, and which
// actuals columns grade it. No I/O — unit tested directly (see markets.test.mjs).
//
// This consolidates what used to be spread across two files: props.mjs owned
// `projCols` while grade-bets.mjs kept its own parallel ACTUAL_COLS table. A
// stat defined in two places drifts, so both now live here.
//
// Field reference:
//   opticName The EXACT live market name, confirmed against /markets on a real
//             key (317 NFL markets returned; all 12 of ours resolved). This is
//             what gets sent as the `market=` query param, so a capture asks
//             for precisely the markets it models and nothing else.
//   optic     Matching aliases. Matched case- and
//             punctuation-insensitively (see matchStatKey), and either the
//             market `name` ("Player Passing Yards") or its `id`
//             ("player_passing_yards") resolves, since normalization collapses
//             both to the same key.
//
//             These exist because a live market list can be renamed, and a
//             tolerant matcher is cheap. All 12 now resolve, so they are a
//             safety net rather than guesswork.
//
//             EXACT MATCHING IS LOAD-BEARING HERE. The live NFL list runs to
//             317 markets and includes "1st Half Player Passing Yards",
//             "Player Passing Yards (Combo)", "Player Passing Yards (Either)"
//             and "Player Passing Yards Each Half" alongside the one we want.
//             Substring matching would have mapped several of those onto
//             passYds and priced full-game projections against half- and
//             quarter-length markets.
//
//             Note "Player Interceptions" is interceptions THROWN: the list
//             carries a separate "Player Defensive Interceptions" for the
//             defensive side, which is not something we project.
//
//             Player markets seen live that we deliberately do NOT model:
//               "Player Touchdowns" — over/under on TD count. Its 0.5 line is
//                 the same bet as Anytime TD, so modelling both would put two
//                 perfectly correlated wagers in the ledger and double-count
//                 one exposure. Adding it means deduping against anytimeTD.
//               "Player Rushing + Receiving Yards" — a combo market. We project
//                 rushing and receiving separately, but their SUM needs a joint
//                 distribution we don't have; adding two two-piece normals
//                 assumes an independence that isn't real for one player's
//                 touches.
//               "Player Kicking Points" — we don't project kickers at all.
//               "Player Longest Passing Completion" — an extreme-value
//                 statistic. A projection of total yards says nothing about the
//                 distribution of the single longest completion.
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
    opticName: "Anytime Touchdown Scorer",
    optic: ["anytime touchdown scorer", "anytime touchdown", "player anytime td", "to score a touchdown", "anytime td scorer"],
    hasLine: false,
    kind: "poisson",
    projCols: ["RushTDs", "RecTDs"],
    actualCols: ["RushTD", "RecptTD"],
  },
  passYds: {
    opticName: "Player Passing Yards",
    optic: ["player passing yards", "passing yards", "pass yards"],
    hasLine: true,
    kind: "continuous",
    projCols: ["PassYards"],
    actualCols: ["PassYards"],
  },
  passAtt: {
    opticName: "Player Passing Attempts",
    optic: ["player passing attempts", "passing attempts", "pass attempts"],
    hasLine: true,
    kind: "continuous",
    projCols: ["PassAttempts"],
    actualCols: ["PassAtt"],
  },
  completions: {
    opticName: "Player Passing Completions",
    optic: ["player passing completions", "passing completions", "pass completions"],
    hasLine: true,
    kind: "continuous",
    projCols: ["PassCompletions"],
    actualCols: ["PassComp"],
  },
  passTD: {
    opticName: "Player Passing Touchdowns",
    optic: ["player passing touchdowns", "passing touchdowns", "pass tds"],
    hasLine: true,
    kind: "poisson",
    projCols: ["PassTDs"],
    actualCols: ["PassTD"],
  },
  int: {
    opticName: "Player Interceptions",
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
    opticName: "Player Rushing Yards",
    optic: ["player rushing yards", "rushing yards", "rush yards"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RushYards"],
    actualCols: ["RushYards"],
  },
  rushAtt: {
    opticName: "Player Rushing Attempts",
    optic: ["player rushing attempts", "rushing attempts", "player carries", "rush attempts"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RushAttempts"],
    actualCols: ["Rushes"],
  },
  rushTD: {
    opticName: "Player Rushing Touchdowns",
    optic: ["player rushing touchdowns", "rushing touchdowns", "rush tds"],
    hasLine: true,
    kind: "poisson",
    projCols: ["RushTDs"],
    actualCols: ["RushTD"],
  },
  receptions: {
    opticName: "Player Receptions",
    optic: ["player receptions", "receptions", "total receptions"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RecCompletions"],
    actualCols: ["Receptions"],
  },
  recYds: {
    opticName: "Player Receiving Yards",
    optic: ["player receiving yards", "receiving yards", "rec yards"],
    hasLine: true,
    kind: "continuous",
    projCols: ["RecYards"],
    actualCols: ["ReceptYds"],
  },
  recTD: {
    opticName: "Player Receiving Touchdowns",
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
  for (const alias of [def.opticName, ...def.optic]) {
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

// The exact market names to request, one per stat. Used for the `market=`
// query param so a capture asks for precisely what it models.
//
// Deliberately NOT every alias: the aliases are spelling variants kept for
// matching, and sending them would pad each request with names the API does
// not recognise. Every one of these is confirmed present in the live NFL list.
export function allOpticMarketNames() {
  return Object.values(STAT_DEFS).map((d) => d.opticName);
}

// Every alias, for tests and diagnostics that want the full matching surface.
export function allOpticMarketAliases() {
  return Object.values(STAT_DEFS).flatMap((d) => [d.opticName, ...d.optic]);
}
