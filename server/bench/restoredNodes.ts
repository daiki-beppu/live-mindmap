import { Effect } from "effect";
import { restoreState, snapshotOf } from "../src/core/session.ts";

// edgeJudgement と siblingJudgement が、イベントから最終マップのノードと id 引きの表を作る部分。復元の失敗は各判定が自分の class に変える
export const restoredNodes = (events: Iterable<unknown>) =>
  restoreState(events).pipe(Effect.map((state) => {
    const nodes = snapshotOf(state).nodes;
    return { nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
  }));
