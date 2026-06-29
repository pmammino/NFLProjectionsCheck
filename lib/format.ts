import type { MetricUnit } from "./types";

export function fmtValue(v: number | null | undefined, unit: MetricUnit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "pct":
      return (v * 100).toFixed(1) + "%";
    case "rate":
      return v.toFixed(3);
    case "yds":
      return v.toFixed(2);
    case "count":
    default:
      return v.toFixed(1);
  }
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(digits) + "%";
}

export function fmtSignedPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = (v * 100).toFixed(digits);
  return (v > 0 ? "+" : "") + s + "%";
}
