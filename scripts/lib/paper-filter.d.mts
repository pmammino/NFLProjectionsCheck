// Types for paper-filter.mjs, which the Filtered Paper Trading tab imports. The
// engine is plain JavaScript so the Node tests and the browser run the same code;
// this file is the contract the component is checked against.

export type Side = "over" | "under";
export type Basis = "projection" | "pool" | "sharp";
export type LadderMode = "all" | "best";
export type Timing = "first" | "every";

export interface Filters {
  slots: string[] | null;
  weeks: number[] | null;
  books: string[] | null;
  bettableOnly: boolean;
  stats: string[] | null;
  sides: "both" | Side;
  oddsMin: number;
  oddsMax: number;
  basis: Basis;
  minEdge: number;
  maxEdge: number | null;
  sharpConfirm: number | null;
  minBooks: number;
  maxRung: number | null;
  ladder: LadderMode;
  shop: boolean;
  timing: Timing;
}

export interface Row {
  week: number;
  slot: string;
  playerId: string;
  name: string;
  team: string;
  pos: string;
  opp: string;
  stat: string;
  book: string;
  bookLabel: string;
  bettable: boolean;
  side: Side;
  line: number;
  odds: number;
  implied: number;
  pProj: number | null;
  pPool: number | null;
  pSharp: number | null;
  pFair: number | null;
  nBooks: number;
  nSharp: number;
  mainLine: number;
  rung: number;
  status: string;
  actual: number | null;
  closeFair: number | null;
}

export interface Bet extends Row {
  edge: number | null;
  dec: number;
  pnl: number | null;
  clv: number | null;
}

export interface ClvSummary {
  n: number;
  avg: number;
  avgBand: number | null;
  beatRate: number;
  beatBand: number;
}

export interface Summary {
  bets: number;
  settled: number;
  won: number;
  lost: number;
  push: number;
  unplayed: number;
  noLine: number;
  pnl: number;
  roi: number | null;
  roiBand: number | null;
  perBetSd: number | null;
  roiConservative: number | null;
  winRate: number | null;
  avgDecimal: number | null;
  avgEdge: number | null;
  clv: ClvSummary | null;
}

export interface Group {
  key: string;
  label: string;
  summary: Summary;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  filters: Partial<Filters>;
}

export interface PackedTables {
  slots: string[];
  opps: string[];
  stats: string[];
  books: string[];
  bookLabels: string[];
  players: string[];
}

export interface Packed {
  tables: PackedTables;
  columns: string[];
  rows: number[][];
}

export interface PlayerInfo {
  id: string;
  name: string;
  team: string;
  pos: string;
}

export const DEFAULT_ODDS_MIN: number;
export const DEFAULT_ODDS_MAX: number;
export const SLOT_ORDER: string[];
export const LIVE_SLOTS: string[];
export const BASES: Basis[];
export const LADDER_MODES: LadderMode[];
export const TIMINGS: Timing[];
export const SIDES: string[];
export const MIN_BETS_FOR_A_VERDICT: number;
export const DEFAULT_FILTERS: Readonly<Filters>;
export const PRESETS: Preset[];
export const COLUMNS: string[];
export const ODDS_BUCKETS: [string, (d: number) => boolean][];
export const EDGE_BUCKETS: [string, (e: number) => boolean][];

export function presetFilters(id: string): Filters;
export function edgeOf(row: Row, basis: Basis): number | null;
export function oddsInRange(american: number, min: number, max: number): boolean;
export function isAmerican(x: number): boolean;
export function passesRow(row: Row, f: Filters): boolean;
export function applyFilters(rows: Row[], filters?: Partial<Filters>): Bet[];
export function summarize(bets: Bet[], opts?: { completeWeeks?: number[] }): Summary;
export function betsToResolve(roi: number, perBetSd: number): number | null;
export function verdict(s: Pick<Summary, "settled" | "roi" | "roiBand">, opts?: { floor?: number }): string;
export function groupSummaries(bets: Bet[], keyOf: (b: Bet) => string, opts?: { completeWeeks?: number[]; label?: (key: string) => string }): Group[];
export function oddsBucket(decimal: number): string;
export function edgeBucket(edge: number): string;
export function pack(rows: unknown[]): Packed;
export function unpack(packed: Packed, players?: PlayerInfo[]): Row[];
