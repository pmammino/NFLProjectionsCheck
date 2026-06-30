export type Position = "QB" | "RB" | "WR" | "TE";
export type MetricKind = "volume" | "efficiency";
export type MetricUnit = "count" | "yds" | "pct" | "rate";

export interface MetricMeta {
  key: string;
  label: string;
  group: string; // Passing | Rushing | Receiving
  kind: MetricKind;
  unit: MetricUnit;
  positions: Position[];
}

export interface MetricCell {
  f: number; // floor (25th pct)
  m: number; // median (50th pct)
  c: number; // ceiling (75th pct)
  a: number; // actual
  in: boolean; // actual within [min(f,c), max(f,c)]
  err: number; // actual - median
  pe: number | null; // (actual - median) / |median|
  av: number; // actual volume (for min-volume filtering)
  pv: number; // projected median volume (for min-projected filtering)
}

export interface Row {
  pid: string;
  team: string;
  pos: Position;
  wk: number;
  inj: boolean; // in-game injury / low-usage suspect
  m: Record<string, MetricCell>;
}

export interface TDTypeMeta {
  key: string; // passTD | rushTD | recTD
  label: string;
  positions: Position[];
  volLabel: string; // e.g. "targets"
  minOpp: number;
}

export interface TDRecord {
  type: string;
  pid: string;
  team: string;
  pos: Position;
  wk: number;
  inj: boolean;
  lf: number;
  lm: number;
  lc: number;
  a: number;
  av: number;
  pv: number;
}

export interface Dataset {
  meta: {
    generatedAt: string;
    season: number;
    weeks: number[];
    teams: string[];
    positions: Position[];
    minEffVolume: number;
    metrics: MetricMeta[];
    tdTypes: TDTypeMeta[];
    counts: {
      actualRows: number;
      matchedPlayerWeeks: number;
      emittedRows: number;
      tdRows: number;
      injurySuspect: number;
    };
  };
  rows: Row[];
  td: TDRecord[];
  season: SeasonData;
}

export interface SeasonData {
  metrics: MetricMeta[];
  tdTypes: TDTypeMeta[];
  minEffVolume: number;
  teams: string[];
  counts: {
    actualPlayers: number;
    matchedPlayers: number;
    emittedRows: number;
    tdRows: number;
  };
  rows: Row[];
  td: TDRecord[];
}
