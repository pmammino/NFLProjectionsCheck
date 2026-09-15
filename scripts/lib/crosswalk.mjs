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
// Matching runs in strict-to-loose tiers, stopping at the first tier that
// yields exactly ONE candidate:
//   1. normalized name + team   — the overwhelming majority of rows
//   2. normalized name, league-wide — catches a player whose team changed
//      mid-week (waiver claims, practice-squad elevations) where the two
//      sources disagree on team
//   3. first-initial + last name + team — catches "D.J. Moore"/"DJ Moore",
//      "Josh Allen"/"Joshua Allen", "Marquise Brown"/"Hollywood Brown"
// A tier producing two or more candidates is treated as ambiguous and the
// match fails rather than falling through to a looser tier, because a looser
// tier cannot possibly disambiguate what a stricter one could not.

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
  const byNameTeam = new Map();
  const byName = new Map();
  const byInitialLastTeam = new Map();

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
    push(byName, nKey, entry);
    if (team) {
      push(byNameTeam, `${nKey}|${team}`, entry);
      push(byInitialLastTeam, `${initialLastKey(name)}|${team}`, entry);
    }
  }

  return { byNameTeam, byName, byInitialLastTeam, size: byName.size };
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
export function matchPlayer(index, { name, team } = {}) {
  const nKey = normalizeName(name);
  if (!nKey) return { playerId: null, reason: "no-name" };
  const tKey = canonicalTeam(team);

  const tiers = [];
  if (tKey) tiers.push(["name+team", index.byNameTeam.get(`${nKey}|${tKey}`)]);
  tiers.push(["name", index.byName.get(nKey)]);
  if (tKey) tiers.push(["initial+last+team", index.byInitialLastTeam.get(`${initialLastKey(name)}|${tKey}`)]);

  for (const [method, candidates] of tiers) {
    if (!candidates || candidates.length === 0) continue;
    // Distinct ids only: the same player legitimately appears more than once
    // if the roster carries duplicate rows for them.
    const ids = [...new Set(candidates.map((c) => c.playerId))];
    if (ids.length === 1) {
      return { playerId: ids[0], method, entry: candidates[0] };
    }
    // Two different players share this key. A looser tier can only make that
    // worse, so stop here rather than falling through.
    return { playerId: null, reason: "ambiguous", candidates: ids };
  }

  return { playerId: null, reason: "not-found" };
}
