// Joining OpticOdds players to RotoWire player ids. No I/O — unit tested
// directly (see crosswalk.test.mjs).
//
// ---------------------------------------------------------------------------
// Why this module exists
// ---------------------------------------------------------------------------
// The old RotoWire props feed handed us its own `playerID` on every row, so
// joining a prop price to that player's Floor/Median/Ceiling projection was
// free. OpticOdds has its own id space, so we have to bridge the two on the
// only things both sides agree about: name, team, and position.
//
// That bridge is the single most dangerous step in the new pipeline. A missed
// match costs us a bet we should have priced; a WRONG match prices a bet
// against the wrong player's projection and silently corrupts the ledger. The
// two failures are not symmetric, so this module is deliberately conservative:
// when the evidence is ambiguous it refuses to guess and reports the row as
// unmatched, leaving a name in the capture log for a human to resolve rather
// than inventing a join.
//
// ---------------------------------------------------------------------------
// The team problem, and how the fixture solves it
// ---------------------------------------------------------------------------
// OpticOdds player-prop odds carry NO TEAM. `team_id` is null on every one of
// them — it is populated only on team markets (moneyline, spreads, and the
// D/ST entries inside an Anytime-TD market). Verified against a live BetMGM
// pull: 0 of 49 player rows had a team_id.
//
// That removes the obvious way to tell two players with the same name apart.
// What replaces it is the FIXTURE: a prop belongs to one game, and a game has
// exactly two teams, so a player on that odd must play for one of them. Passing
// those two teams as `fixtureTeams` is usually enough to resolve a collision
// even though the odd itself says nothing about the team — the two Mike
// Williamses are on different teams, and at most one of them is in this game.
//
// Matching therefore builds a candidate pool by name (exact first, then
// first-initial + surname) and narrows it:
//   1. by an explicit team, when some other source supplied one
//   2. by the fixture's two teams
//   3. otherwise, only a pool that is already a single player resolves
// A pool that stays ambiguous fails the match rather than picking one.

// ---- Teams -------------------------------------------------------------------
// RotoWire's 32 codes are canonical here (they're what data/projections and
// data/actuals are keyed on). Everything else normalizes into them.
export const NFL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
];

// Alternate abbreviations other data providers use, including historical
// relocations (OAK/SD/STL) which still surface in archived odds.
const TEAM_ALIASES = {
  JAC: "JAX", JAG: "JAX",
  WSH: "WAS", WFT: "WAS",
  LA: "LAR", STL: "LAR", RAM: "LAR",
  SD: "LAC", SDG: "LAC",
  OAK: "LV", LVR: "LV", RAI: "LV",
  ARZ: "ARI", CLV: "CLE", HST: "HOU", BLT: "BAL",
  TAM: "TB", NWE: "NE", NOR: "NO", SFO: "SF",
  GNB: "GB", KAN: "KC", CRD: "ARI", RAV: "BAL",
  OTI: "TEN", HTX: "HOU", CLT: "IND",
};

// Nicknames are unique across all 32 franchises, so the last word of a full
// team name ("Kansas City Chiefs" -> "chiefs") identifies it unambiguously.
const TEAM_BY_NICKNAME = {
  cardinals: "ARI", falcons: "ATL", ravens: "BAL", bills: "BUF",
  panthers: "CAR", bears: "CHI", bengals: "CIN", browns: "CLE",
  cowboys: "DAL", broncos: "DEN", lions: "DET", packers: "GB",
  texans: "HOU", colts: "IND", jaguars: "JAX", chiefs: "KC",
  chargers: "LAC", rams: "LAR", raiders: "LV", dolphins: "MIA",
  vikings: "MIN", patriots: "NE", saints: "NO", giants: "NYG",
  jets: "NYJ", eagles: "PHI", steelers: "PIT", seahawks: "SEA",
  niners: "SF", buccaneers: "TB", titans: "TEN", commanders: "WAS",
  // Forms that aren't a clean trailing nickname.
  "49ers": "SF", redskins: "WAS", "football team": "WAS",
};

// Any team spelling -> RotoWire code, or null if unrecognizable.
export function canonicalTeam(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  if (raw === "") return null;

  const upper = raw.toUpperCase();
  if (NFL_TEAMS.includes(upper)) return upper;
  if (TEAM_ALIASES[upper]) return TEAM_ALIASES[upper];

  // Full or partial team name.
  const lower = raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (TEAM_BY_NICKNAME[lower]) return TEAM_BY_NICKNAME[lower];
  const lastWord = lower.split(" ").at(-1);
  if (TEAM_BY_NICKNAME[lastWord]) return TEAM_BY_NICKNAME[lastWord];

  return null;
}

// ---- Names -------------------------------------------------------------------
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// Lowercase, strip accents and punctuation, drop generational suffixes.
// "D.J. Moore" -> "dj moore"; "Amon-Ra St. Brown" -> "amonra st brown";
// "Marvin Harrison Jr." -> "marvin harrison".
export function normalizeName(name) {
  if (name === undefined || name === null) return "";
  let s = String(name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accent marks
    .toLowerCase()
    // Remove apostrophes, periods and hyphens outright rather than spacing
    // them: "Ja'Marr" -> "jamarr", "D.J." -> "dj", "Amon-Ra" -> "amonra".
    // Hyphens matter most on SURNAMES — spacing "Smith-Schuster" into two
    // tokens would make the last-name key "schuster" and break the
    // initial+last tier, whereas removing it keeps "smithschuster" whole.
    .replace(/['’.\-]/g, "")
    .replace(/[_]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = s.split(" ").filter(Boolean);
  while (parts.length > 1 && SUFFIXES.has(parts.at(-1))) parts.pop();
  s = parts.join(" ");
  return s;
}

// First initial + last name: "Joshua Allen" and "Josh Allen" both -> "j allen".
// Returns "" when there's no surname to key on.
export function initialLastKey(name) {
  const parts = normalizeName(name).split(" ").filter(Boolean);
  if (parts.length < 2) return "";
  return `${parts[0][0]} ${parts.at(-1)}`;
}

// ---- Index -------------------------------------------------------------------
// Build lookup tables from roster rows ({ PlayerID, Name, Team, Pos }), as
// written by ingest.mjs to data/players/{season}.csv.
//
// Every tier maps its key to an ARRAY of candidates, so ambiguity is visible
// at match time rather than being silently collapsed by last-write-wins.
export function buildPlayerIndex(rosterRows) {
  const byName = new Map();
  const byInitialLast = new Map();

  const push = (map, key, entry) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };

  for (const row of rosterRows || []) {
    const playerId = String(row.PlayerID ?? row.playerId ?? "").trim();
    if (!playerId) continue;
    const name = row.Name ?? row.name ?? "";
    const team = canonicalTeam(row.Team ?? row.team);
    const pos = String(row.Pos ?? row.pos ?? "").toUpperCase();
    const entry = { playerId, name: String(name), team, pos };

    const nKey = normalizeName(name);
    if (!nKey) continue;
    // Both indexes are league-wide. Narrowing by team happens at match time
    // against the candidate pool, because the team we narrow BY now usually
    // comes from the fixture rather than from the odd itself.
    push(byName, nKey, entry);
    push(byInitialLast, initialLastKey(name), entry);
  }

  return { byName, byInitialLast, size: byName.size };
}

// ---- Matching ----------------------------------------------------------------
// Resolve one OpticOdds player to a RotoWire id.
//
// Returns { playerId, method, entry } on success, or
// { playerId: null, reason } on failure, where reason is "no-name",
// "ambiguous", or "not-found". Callers should count and log the failures —
// a sudden spike in "not-found" means the roster snapshot is stale or a feed
// changed shape, which is exactly the kind of silent rot this pipeline needs
// to surface rather than absorb.
export function matchPlayer(index, { name, team, fixtureTeams } = {}) {
  const nKey = normalizeName(name);
  if (!nKey) return { playerId: null, reason: "no-name" };

  const tKey = canonicalTeam(team);
  const allowed = new Set(
    (Array.isArray(fixtureTeams) ? fixtureTeams : [])
      .map((t) => canonicalTeam(t))
      .filter(Boolean)
  );

  // Exact name first; only if nothing matches at all do we loosen to
  // first-initial + surname. Loosening is for spelling variants ("Josh"/
  // "Joshua"), so it should never override a pool that already exists.
  const tiers = [
    ["name", index.byName.get(nKey)],
    ["initial+last", index.byInitialLast.get(initialLastKey(name))],
  ];

  for (const [tier, candidates] of tiers) {
    if (!candidates || candidates.length === 0) continue;

    // Distinct players only: a roster carrying duplicate rows for one player
    // is not a collision.
    const pool = dedupeById(candidates);
    if (pool.length === 1) return hit(pool[0], tier);

    // Two or more real players share this name. Narrow, most specific first.
    if (tKey) {
      const byTeam = pool.filter((c) => c.team === tKey);
      if (byTeam.length === 1) return hit(byTeam[0], `${tier}+team`);
      if (byTeam.length > 1) return ambiguous(byTeam);
      // Zero on an explicit team means the team disagrees with our roster —
      // fall through to the fixture, which is the more reliable signal.
    }

    if (allowed.size > 0) {
      const byFixture = pool.filter((c) => c.team && allowed.has(c.team));
      if (byFixture.length === 1) return hit(byFixture[0], `${tier}+fixture`);
      if (byFixture.length > 1) return ambiguous(byFixture);
    }

    // Nothing left to narrow by, and more than one candidate stands.
    return ambiguous(pool);
  }

  return { playerId: null, reason: "not-found" };
}

function dedupeById(candidates) {
  const byId = new Map();
  for (const c of candidates) if (!byId.has(c.playerId)) byId.set(c.playerId, c);
  return [...byId.values()];
}

const hit = (entry, method) => ({ playerId: entry.playerId, method, entry });
const ambiguous = (pool) => ({
  playerId: null,
  reason: "ambiguous",
  candidates: pool.map((c) => c.playerId),
});
