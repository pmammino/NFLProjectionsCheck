// The shape of public/data/lines/. Written by scripts/build-lines-data.mjs
// (see scripts/lib/lines-index.mjs for what each field means and why); read by
// the Line Pricer tab. This file is the contract between the two, so a change
// to one is a change to the other.

// [bookIndex, overOdds | null, underOdds | null]. A null is a side the book did
// not quote — a one-sided market — not a missing value to be filled in.
export type BookQuote = [number, number | null, number | null];

export interface BookInfo {
  k: string;
  label: string;
  // 1 = a bet can be placed here. 0 = a reference book: priced and shown, but
  // never offered as a price to take.
  t: 0 | 1;
}

export interface LineEntry {
  l: number; // the line
  p: number | null; // OUR P(over), as priced at this capture
  a: number | null; // ours with the projected median re-centred; null when not applicable
  m: number | null; // retail consensus P(over): median no-vig price across books
  q: number | null; // how m was obtained: index into MARKET_SOURCES
  s: number | null; // sharp-book consensus P(over), when a sharp book quoted it
  b: BookQuote[];
}

export interface Triple {
  F: number | null;
  M: number;
  C: number | null;
}

export interface StatEntry {
  kind: "continuous" | "poisson";
  proj: Triple | null; // the frozen projection snapshot
  adj: Triple | null; // the same, re-centred, where a correction applies
  priced: number | null; // the projected median this capture was priced from
  stale: boolean; // priced from an earlier projection than the snapshot
  actual: number | null;
  lines: LineEntry[];
}

export interface PlayerEntry {
  id: string;
  name: string;
  team: string;
  pos: string;
  opp: string;
  stats: Record<string, StatEntry>;
}

export interface CorrectionInfo {
  applied: boolean;
  reason: string;
  n: number;
  kF: number;
  kM: number;
  kC: number;
  z: number;
}

export interface SlotFile {
  schema: number;
  season: number;
  week: number;
  slot: string;
  generatedAt: string;
  books: BookInfo[];
  correction: Record<string, CorrectionInfo> | null;
  counts: { players: number; markets: number; quotes: number };
  players: PlayerEntry[];
}

export interface IndexSlot {
  slot: string;
  file: string;
  markets: number;
  players: number;
  bytes: number;
}

export interface IndexWeek {
  week: number;
  hasActuals: boolean;
  defaultSlot: string;
  slots: IndexSlot[];
}

export interface LinesIndex {
  schema: number;
  season: number | null;
  generatedAt: string;
  defaultWeek: number | null;
  weeks: IndexWeek[];
}

// What the Paper Trading tab hands over to open a specific bet's line.
export interface LineTarget {
  week: number;
  slot: string;
  playerId: string;
  stat: string;
  line: number;
}

// The file shape this page understands. Mirror of LINES_SCHEMA_VERSION in
// scripts/lib/lines-index.mjs; a test keeps them equal. A file of any other
// version is refused with a "rebuild" message rather than half-rendered, because
// a stale file read as if it were current gives confident wrong answers.
export const LINES_SCHEMA = 2;

// Mirror of MARKET_SOURCES in scripts/lib/lines-index.mjs, which cannot be
// imported here: that module pulls in Node-only code. A test keeps the two
// identical (scripts/lib/lines-view.test.mjs).
export const MARKET_SOURCES = ["devig", "mixed", "assumed-hold"] as const;

export const STAT_LABELS: Record<string, string> = {
  anytimeTD: "Anytime TD",
  passYds: "Pass Yards",
  passAtt: "Pass Attempts",
  completions: "Completions",
  passTD: "Pass TD",
  int: "Interceptions",
  rushYds: "Rush Yards",
  rushAtt: "Rush Attempts",
  rushTD: "Rush TD",
  receptions: "Receptions",
  recYds: "Rec Yards",
  recTD: "Rec TD",
};

// What each capture IS. They are different instruments — the same line is
// priced differently in each — so the page says which one is on screen.
export const SLOT_INFO: Record<string, { label: string; blurb: string }> = {
  main: {
    label: "Tuesday drop",
    blurb: "What was published. Early, so the softest prices — and a thin board, because books have not posted most props yet.",
  },
  opening: {
    label: "Opening board",
    blurb:
      "Every market at the first price its book ever posted. Not one moment: a prop posted on Saturday is shown at its Saturday price.",
  },
  closing: {
    label: "Closing board",
    blurb: "Every market at its last price before kickoff. Only available for games whose closing lines the feed has filled in.",
  },
  thursday: {
    label: "Thursday sweep",
    blurb: "The midweek capture, once the books have posted the board but every game is still pre-kickoff.",
  },
};

export const slotLabel = (slot: string) => SLOT_INFO[slot]?.label ?? slot;
