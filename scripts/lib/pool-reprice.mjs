// Re-pricing a props file's rows under the weighted pool, as it would have stood
// that week. Shared by the live backtest's counterfactual and the filtered paper
// trading dataset, which both need every row of a board on the pool price.
//
// Rows in, rows out: the same shape as the CSV (strings), with OurProb, ProjProb,
// Edge, ModelEdge and PriceModel rewritten. The projection's own probability is
// what the pool takes as its input, so a row that cannot say what the projection
// said falls back to its OurProb exactly as the capture does.

import { repriceWithPool } from "../capture-props.mjs";
import { projectionProbOf } from "./backtest-live.mjs";

// `model` is source-model.at(week): the weights and shares going INTO that week.
export function asPoolPriced(rows, model, slot) {
  const cand = rows.map((r) => {
    const proj = projectionProbOf(r);
    return {
      r,
      rotowirePlayerId: r.PlayerID,
      statKey: r.Stat,
      line: Number(r.Line),
      side: r.Side || "over",
      sportsbook: r.Book,
      odds: Number(r.Odds),
      oppositeOdds: r.OppositeOdds === "" || r.OppositeOdds === undefined ? null : Number(r.OppositeOdds),
      impliedProb: Number(r.ImpliedProb),
      fairProb: Number(r.FairProb),
      hold: r.Hold === "" || r.Hold === undefined ? null : Number(r.Hold),
      // The pool takes the projection's own probability as its input.
      ourProb: proj ?? Number(r.OurProb),
      projProb: proj ?? Number(r.OurProb),
      edge: Number(r.Edge),
      modelEdge: Number(r.ModelEdge),
    };
  });
  repriceWithPool(cand, model, { slot });
  return cand.map((c) => ({
    ...c.r,
    OurProb: c.ourProb.toFixed(4),
    ProjProb: c.projProb.toFixed(4),
    Edge: c.edge.toFixed(4),
    ModelEdge: c.modelEdge.toFixed(4),
    PriceModel: c.priceModel ?? c.r.PriceModel ?? "projection",
  }));
}

