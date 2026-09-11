// Shared edge-size bucketing, used by capture-props.mjs (to label each bet)
// and build-betting-data.mjs (to keep rollup ordering consistent). Buckets
// assume the default --min-edge of 0.03 — bets below that never reach here.
export const EDGE_BUCKETS = [
  { max: 0.05, label: "3-5%" },
  { max: 0.1, label: "5-10%" },
  { max: 0.15, label: "10-15%" },
  { max: Infinity, label: "15%+" },
];

export function edgeBucket(edge) {
  for (const b of EDGE_BUCKETS) if (edge < b.max) return b.label;
  return EDGE_BUCKETS[EDGE_BUCKETS.length - 1].label;
}
