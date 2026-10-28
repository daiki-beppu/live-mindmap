import { expect } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { foldView, refold, type FoldAction, type HumanFolds } from "../src/folding.ts";

export function foldingActions(snapshot: Snapshot, actions: readonly FoldAction[], human: HumanFolds | undefined = undefined, selectedId: string | null = null) {
  for (const action of actions) {
    const result = refold(foldView(snapshot, human, selectedId), action);
    if (result === null && action.type === "reflect") continue;
    expect(result, `refold(${JSON.stringify(action)})`).not.toBeNull();
    if (result === null) throw new Error("Expected an effective fold action");
    human = result.human;
    if (result.select !== undefined) selectedId = result.select;
  }
  return { human, selectedId, view: foldView(snapshot, human, selectedId) };
}
