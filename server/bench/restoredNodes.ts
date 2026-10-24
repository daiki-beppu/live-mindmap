import { Effect } from "effect";
import { restoreState, snapshotOf } from "../src/core/session.ts";

export const restoredNodes = (events: Iterable<unknown>) =>
  restoreState(events).pipe(Effect.map((state) => {
    const nodes = snapshotOf(state).nodes;
    return { nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
  }));
