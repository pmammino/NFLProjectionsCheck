// Verifies the OpticOdds -> RotoWire player join, with an emphasis on the
// failure modes that would silently corrupt the bet ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  initialLastKey,
  canonicalTeam,
  buildPlayerIndex,
  matchPlayer,
  givenNamesCompatible,
  NFL_TEAMS,
} from "./crosswalk.mjs";

// ---- Teams -------------------------------------------------------------------
test("canonical team codes pass through unchanged", () => {
  assert.equal(NFL_TEAMS.length, 32);
  for (const t of NFL_TEAMS) assert.equal(canonicalTeam(t), t);
});

test("alternate provider abbreviations normalize to RotoWire codes", () => {
  assert.equal(canonicalTeam("JAC"), "JAX");
  assert.equal(canonicalTeam("WSH"), "WAS");
  assert.equal(canonicalTeam("LA"), "LAR");
  assert.equal(canonicalTeam("SD"), "LAC");
  assert.equal(canonicalTeam("OAK"), "LV");
  assert.equal(canonicalTeam("STL"), "LAR");
  assert.equal(canonicalTeam("gnb"), "GB"); // case-insensitive
});

test("full team names resolve via their nickname", () => {
  assert.equal(canonicalTeam("Kansas City Chiefs"), "KC");
  assert.equal(canonicalTeam("San Francisco 49ers"), "SF");
  assert.equal(canonicalTeam("New York Giants"), "NYG");
  assert.equal(canonicalTeam("New York Jets"), "NYJ");
  assert.equal(canonicalTeam("Los Angeles Rams"), "LAR");
  assert.equal(canonicalTeam("Los Angeles Chargers"), "LAC");
  assert.equal(canonicalTeam("Washington Commanders"), "WAS");
});

test("unrecognized teams return null rather than a wrong guess", () => {
  assert.equal(canonicalTeam("XYZ"), null);
  assert.equal(canonicalTeam(""), null);
  assert.equal(canonicalTeam(null), null);
  assert.equal(canonicalTeam(undefined), null);
});

// ---- Names -------------------------------------------------------------------
test("name normalization strips punctuation, accents and suffixes", () => {
  assert.equal(normalizeName("D.J. Moore"), "dj moore");
  assert.equal(normalizeName("Ja'Marr Chase"), "jamarr chase");
  assert.equal(normalizeName("Amon-Ra St. Brown"), "amonra st brown");
  assert.equal(normalizeName("Marvin Harrison Jr."), "marvin harrison");
  assert.equal(normalizeName("Michael Pittman Jr"), "michael pittman");
  assert.equal(normalizeName("Odell Beckham Jr."), "odell beckham");
  assert.equal(normalizeName("Robert Griffin III"), "robert griffin");
  assert.equal(normalizeName("  Travis   Kelce  "), "travis kelce");
});

test("differently-punctuated spellings of one player collapse together", () => {
  assert.equal(normalizeName("D.J. Moore"), normalizeName("DJ Moore"));
  assert.equal(normalizeName("A.J. Brown"), normalizeName("AJ Brown"));
  assert.equal(normalizeName("Kenneth Walker III"), normalizeName("Kenneth Walker"));
});

test("a bare surname is never treated as a full name", () => {
  // Only a suffix-plus-surname collapses; a lone token keeps its identity so
  // it can't accidentally key against a real two-part name.
  assert.equal(normalizeName("Jr"), "jr");
  assert.equal(initialLastKey("Kelce"), "");
  assert.equal(initialLastKey(""), "");
});

test("initial+last key tolerates given-name variants", () => {
  assert.equal(initialLastKey("Joshua Allen"), initialLastKey("Josh Allen"));
  assert.equal(initialLastKey("Mike Evans"), "m evans");
  assert.equal(initialLastKey("Marvin Harrison Jr."), "m harrison");
});

test("a hyphenated surname stays one token", () => {
  // The reason hyphens are removed rather than spaced: spacing would key
  // this player's last name as "schuster" and lose "smith".
  assert.equal(normalizeName("JuJu Smith-Schuster"), "juju smithschuster");
  assert.equal(initialLastKey("JuJu Smith-Schuster"), "j smithschuster");
  assert.equal(initialLastKey("Amon-Ra St. Brown"), "a brown");
});

// ---- Matching ----------------------------------------------------------------
const ROSTER = [
  { PlayerID: "100", Name: "Ja'Marr Chase", Team: "CIN", Pos: "WR" },
  { PlayerID: "101", Name: "D.J. Moore", Team: "CHI", Pos: "WR" },
  { PlayerID: "102", Name: "Marvin Harrison Jr.", Team: "ARI", Pos: "WR" },
  { PlayerID: "103", Name: "Joshua Allen", Team: "BUF", Pos: "QB" },
  { PlayerID: "104", Name: "Travis Kelce", Team: "KC", Pos: "TE" },
  // The genuine ambiguity case: two distinct active players, same name,
  // different teams. (Josh Allen the Buffalo QB vs Josh Allen the edge
  // rusher had exactly this collision for years.)
  { PlayerID: "200", Name: "Mike Williams", Team: "NYJ", Pos: "WR" },
  { PlayerID: "201", Name: "Mike Williams", Team: "PIT", Pos: "WR" },
];
const INDEX = buildPlayerIndex(ROSTER);

test("a unique name resolves with no narrowing needed", () => {
  const r = matchPlayer(INDEX, { name: "Ja'Marr Chase", team: "CIN" });
  assert.equal(r.playerId, "100");
  assert.equal(r.method, "name");
});

test("punctuation and suffix differences still match", () => {
  assert.equal(matchPlayer(INDEX, { name: "DJ Moore", team: "CHI" }).playerId, "101");
  assert.equal(matchPlayer(INDEX, { name: "Marvin Harrison", team: "ARI" }).playerId, "102");
  assert.equal(matchPlayer(INDEX, { name: "JaMarr Chase", team: "CIN" }).playerId, "100");
});

test("a team spelled a different way still matches", () => {
  // OpticOdds may say "Kansas City Chiefs" or "KAN" where RotoWire says "KC".
  assert.equal(matchPlayer(INDEX, { name: "Travis Kelce", team: "Kansas City Chiefs" }).playerId, "104");
  assert.equal(matchPlayer(INDEX, { name: "Travis Kelce", team: "KAN" }).playerId, "104");
});

test("a stale or missing team falls back to a league-wide name match", () => {
  // Mid-week team change: the two sources disagree on team, but the name is
  // unique league-wide, so the join is still safe.
  const r = matchPlayer(INDEX, { name: "Travis Kelce", team: "PHI" });
  assert.equal(r.playerId, "104");
  assert.equal(r.method, "name");
  assert.equal(matchPlayer(INDEX, { name: "Travis Kelce", team: null }).playerId, "104");
});

test("a given-name variant matches on initial plus surname", () => {
  const r = matchPlayer(INDEX, { name: "Josh Allen", team: "BUF" });
  assert.equal(r.playerId, "103");
  assert.equal(r.method, "initial+last");
});

test("two players sharing a name resolve by team", () => {
  assert.equal(matchPlayer(INDEX, { name: "Mike Williams", team: "NYJ" }).playerId, "200");
  assert.equal(matchPlayer(INDEX, { name: "Mike Williams", team: "PIT" }).playerId, "201");
});

// ---- The fixture as the disambiguator ----------------------------------------
// OpticOdds player props carry NO team (team_id is null on every one), so the
// fixture's two teams are what separate two players sharing a name.
test("a shared name resolves via the fixture's two teams", () => {
  const r = matchPlayer(INDEX, {
    name: "Mike Williams",
    team: null, // exactly what a real prop gives us
    fixtureTeams: ["NYJ", "BUF"],
  });
  assert.equal(r.playerId, "200"); // the Jets one; the Steelers one isn't in this game
  assert.equal(r.method, "name+fixture");
});

test("the fixture narrows even when the odd has no team at all", () => {
  const r = matchPlayer(INDEX, { name: "Mike Williams", fixtureTeams: ["PIT", "CLE"] });
  assert.equal(r.playerId, "201");
});

test("full team names work as fixture teams", () => {
  // Competitors can arrive as names rather than abbreviations.
  const r = matchPlayer(INDEX, {
    name: "Mike Williams",
    fixtureTeams: ["New York Jets", "Buffalo Bills"],
  });
  assert.equal(r.playerId, "200");
});

test("a fixture containing BOTH namesakes still refuses to guess", () => {
  // They play each other. Nothing can separate them, so nothing should try.
  const r = matchPlayer(INDEX, { name: "Mike Williams", fixtureTeams: ["NYJ", "PIT"] });
  assert.equal(r.playerId, null);
  assert.equal(r.reason, "ambiguous");
});

test("a fixture containing neither namesake refuses too", () => {
  const r = matchPlayer(INDEX, { name: "Mike Williams", fixtureTeams: ["DAL", "PHI"] });
  assert.equal(r.playerId, null);
  assert.equal(r.reason, "ambiguous");
});

test("an explicit team still wins over the fixture when both are given", () => {
  const r = matchPlayer(INDEX, {
    name: "Mike Williams",
    team: "PIT",
    fixtureTeams: ["NYJ", "PIT"],
  });
  assert.equal(r.playerId, "201");
  assert.equal(r.method, "name+team");
});

test("a unique name ignores an irrelevant fixture", () => {
  // Narrowing only engages on a collision.
  const r = matchPlayer(INDEX, { name: "Travis Kelce", fixtureTeams: ["DAL", "PHI"] });
  assert.equal(r.playerId, "104");
});

test("a shared name with no usable team refuses to guess", () => {
  // This is the case that must never silently pick one. Pricing a Jets prop
  // against a Steelers projection would corrupt the ledger invisibly.
  const r = matchPlayer(INDEX, { name: "Mike Williams", team: null });
  assert.equal(r.playerId, null);
  assert.equal(r.reason, "ambiguous");
  assert.deepEqual(r.candidates.sort(), ["200", "201"]);
});

test("a shared name with an unrelated team refuses rather than falling through", () => {
  // Team is real but matches neither candidate. The league-wide tier is
  // ambiguous, so we stop — a looser tier could only guess.
  const r = matchPlayer(INDEX, { name: "Mike Williams", team: "DAL" });
  assert.equal(r.playerId, null);
  assert.equal(r.reason, "ambiguous");
});

test("unknown players report not-found", () => {
  const r = matchPlayer(INDEX, { name: "Nobody Atall", team: "CIN" });
  assert.equal(r.playerId, null);
  assert.equal(r.reason, "not-found");
});

test("a missing name reports no-name", () => {
  assert.equal(matchPlayer(INDEX, { name: "", team: "CIN" }).reason, "no-name");
  assert.equal(matchPlayer(INDEX, {}).reason, "no-name");
});

// ---- Index construction ------------------------------------------------------
test("roster rows without an id or name are skipped", () => {
  const idx = buildPlayerIndex([
    { PlayerID: "", Name: "No Id", Team: "CIN" },
    { PlayerID: "900", Name: "", Team: "CIN" },
    { PlayerID: "901", Name: "Real Player", Team: "CIN" },
  ]);
  assert.equal(idx.size, 1);
  assert.equal(matchPlayer(idx, { name: "Real Player", team: "CIN" }).playerId, "901");
});

test("duplicate roster rows for one player are not ambiguous", () => {
  // Same id twice is a roster artifact, not a genuine name collision.
  const idx = buildPlayerIndex([
    { PlayerID: "300", Name: "Nick Chubb", Team: "CLE", Pos: "RB" },
    { PlayerID: "300", Name: "Nick Chubb", Team: "CLE", Pos: "RB" },
  ]);
  assert.equal(matchPlayer(idx, { name: "Nick Chubb", team: "CLE" }).playerId, "300");
});

test("an empty roster matches nothing without throwing", () => {
  const idx = buildPlayerIndex([]);
  assert.equal(matchPlayer(idx, { name: "Travis Kelce", team: "KC" }).reason, "not-found");
  assert.equal(buildPlayerIndex(null).size, 0);
  assert.equal(buildPlayerIndex(undefined).size, 0);
});

// ---- The given-name guard on the loose tier ----------------------------------
// The first-initial + surname tier exists for "Josh Allen"/"Joshua Allen" — one
// player, two renderings. Without a check on the given name it also matches
// "Josh Williams" to "Javonte Williams", who are different people. Against the
// real 506-player roster that is not hypothetical: "Josh Williams" (absent from
// the roster) keys to the same slot as BOTH Javonte and Jameson Williams. With
// only one of them present, the tier would silently have priced one player's
// prop against the other's projection.

test("a short form matches its formal given name", () => {
  assert.ok(givenNamesCompatible("Josh Allen", "Joshua Allen"));
  assert.ok(givenNamesCompatible("Matt Stafford", "Matthew Stafford"));
  assert.ok(givenNamesCompatible("Cam Ward", "Cameron Ward"));
  assert.ok(givenNamesCompatible("Zach Wilson", "Zachary Wilson"));
});

test("a -y diminutive reaches its formal name", () => {
  // Real pair from the feed: OpticOdds says "Kenneth Gainwell", the RotoWire
  // roster says "Kenny Gainwell".
  assert.ok(givenNamesCompatible("Kenneth Gainwell", "Kenny Gainwell"));
  assert.ok(givenNamesCompatible("Danny Amendola", "Daniel Amendola"));
  assert.ok(givenNamesCompatible("Sammy Watkins", "Samuel Watkins"));
  assert.ok(givenNamesCompatible("Willie Snead", "William Snead"));
});

test("nicknames that are not prefixes still match", () => {
  assert.ok(givenNamesCompatible("Mike Evans", "Michael Evans"));
  assert.ok(givenNamesCompatible("Bob Smith", "Robert Smith"));
  assert.ok(givenNamesCompatible("Tony Pollard", "Antonio Pollard"));
  assert.ok(givenNamesCompatible("Gabe Davis", "Gabriel Davis"));
});

test("different people sharing an initial and surname do NOT match", () => {
  assert.ok(!givenNamesCompatible("Josh Williams", "Javonte Williams"));
  assert.ok(!givenNamesCompatible("Josh Williams", "Jameson Williams"));
  assert.ok(!givenNamesCompatible("Ke'Shawn Williams", "Kyren Williams"));
  assert.ok(!givenNamesCompatible("Ke'Shawn Williams", "Kyle Williams"));
});

test("a two-letter prefix is too permissive to count", () => {
  // "Jo" would otherwise match half the league.
  assert.ok(!givenNamesCompatible("Jo Smith", "Jonathan Smith"));
  assert.ok(!givenNamesCompatible("Al Smith", "Alexander Smith"));
});

test("the guard only applies to the loose tier, never to an exact name", () => {
  // An exact-name match must not be second-guessed by the given-name rule.
  const idx = buildPlayerIndex([{ PlayerID: "7", Name: "Josh Williams", Team: "CIN", Pos: "RB" }]);
  assert.equal(matchPlayer(idx, { name: "Josh Williams", team: "CIN" }).playerId, "7");
});

test("an unrelated player with a shared initial reports not-found, not a match", () => {
  // The whole point: a miss is correct here, a join would be corruption.
  const idx = buildPlayerIndex([
    { PlayerID: "10", Name: "Javonte Williams", Team: "DAL", Pos: "RB" },
  ]);
  const r = matchPlayer(idx, { name: "Josh Williams", fixtureTeams: ["CIN", "TB"] });
  assert.equal(r.playerId, null);
  assert.equal(r.reason, "not-found");
});

test("the diminutive rule still resolves through the full match path", () => {
  const idx = buildPlayerIndex([{ PlayerID: "11", Name: "Kenny Gainwell", Team: "TB", Pos: "RB" }]);
  const r = matchPlayer(idx, { name: "Kenneth Gainwell", fixtureTeams: ["CIN", "TB"] });
  assert.equal(r.playerId, "11");
  assert.equal(r.method, "initial+last");
});
