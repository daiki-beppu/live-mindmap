import { Option, Schema } from "effect";
import type { CameraInput } from "./camera.ts";
import { HumanFolds, refold, type FoldView } from "./folding.ts";
import type { Position } from "./layout.ts";

const overlayFields = {
  sideHidden: Schema.Boolean,
  selection: Schema.Option(Schema.Struct({ id: Schema.String, byKey: Schema.Boolean })),
  humanFolds: Schema.Option(HumanFolds),
};
export const ViewingState = Schema.Struct(overlayFields);
export type ViewingState = typeof ViewingState.Type;

export type ViewKey = Extract<CameraInput, { type: "viewKey" }>["key"] | "F" | "Z";

export type ViewingEvent =
  | { type: "reflect"; replaced: Readonly<Record<string, string>> }
  | { type: "edgeDot"; id: string }
  | { type: "side"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "escape"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "key"; key: ViewKey; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "select"; id: string }
  | { type: "deselect" }
  | { type: "arrow"; dir: ArrowDir; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "enter"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "foldDot"; id: string }
  | { type: "pointChange"; id: string }
  | { type: "idle" }
  | { type: "timeMoved" };

export type ArrowDir = "left" | "right" | "up" | "down";

export type VisibleTree = {
  ids: string[];
  targets: Record<string, Position>;
  parents: Record<string, string | null>;
  fold: FoldView | null;
  currentTopic: string | undefined;
};

export const INITIAL_VIEWING: ViewingState = { sideHidden: false, selection: Option.none(), humanFolds: Option.none() };
const UNRELATED: CameraInput = { type: "unrelated" };

function withHumanFolds(state: ViewingState, human: HumanFolds | undefined): ViewingState {
  return { ...state, humanFolds: Option.fromUndefinedOr(human) };
}

type Modifiers = { meta: boolean; ctrl: boolean; alt: boolean };

function modified(e: Modifiers): boolean {
  return e.meta || e.ctrl || e.alt;
}

function parentOf(tree: VisibleTree, shown: ReadonlySet<string>, id: string): string | null {
  const parent = tree.parents[id];
  return parent != null && shown.has(parent) ? parent : null;
}

function targetY(tree: VisibleTree, id: string): number {
  return tree.targets[id]?.y ?? 0;
}

function depthOf(tree: VisibleTree, shown: ReadonlySet<string>, id: string): number {
  let depth = 0;
  for (let p = parentOf(tree, shown, id); p !== null; p = parentOf(tree, shown, p)) depth++;
  return depth;
}

function initialSelection(tree: VisibleTree, shown: ReadonlySet<string>): string | undefined {
  if (tree.currentTopic !== undefined && shown.has(tree.currentTopic)) return tree.currentTopic;
  return tree.ids.find((id) => {
    const parent = tree.parents[id];
    return parent == null || !shown.has(parent);
  });
}

function nearestChild(tree: VisibleTree, shown: ReadonlySet<string>, from: string): string {
  let best = from;
  let bestGap = Infinity;
  for (const id of tree.ids) {
    if (parentOf(tree, shown, id) !== from) continue;
    const gap = Math.abs(targetY(tree, id) - targetY(tree, from));
    if (gap < bestGap) {
      best = id;
      bestGap = gap;
    }
  }
  return best;
}

function rowNeighbor(tree: VisibleTree, shown: ReadonlySet<string>, from: string, dir: "up" | "down"): string | undefined {
  const depth = depthOf(tree, shown, from);
  const row = tree.ids.filter((id) => depthOf(tree, shown, id) === depth).sort((a, b) => targetY(tree, a) - targetY(tree, b));
  const at = row.indexOf(from);
  return row[dir === "up" ? Math.max(0, at - 1) : Math.min(row.length - 1, at + 1)];
}

function nextSelection(tree: VisibleTree, from: string | undefined, dir: ArrowDir): string | undefined {
  const shown = new Set(tree.ids);
  if (from === undefined || !shown.has(from)) return initialSelection(tree, shown);
  switch (dir) {
    case "left":
      return parentOf(tree, shown, from) ?? from;
    case "right":
      return nearestChild(tree, shown, from);
    case "up":
    case "down":
      return rowNeighbor(tree, shown, from, dir);
  }
}

type Reduced = { state: ViewingState; input: CameraInput; preserveIdleTimer?: true };

function reduceOverlay(state: ViewingState, event: Extract<ViewingEvent, { type: "side" }>): Reduced {
  if (modified(event)) return { state, input: UNRELATED };
  return { state: { ...state, sideHidden: !state.sideHidden }, input: { type: "toggledSide" } };
}

function reduceArrow(state: ViewingState, event: Extract<ViewingEvent, { type: "arrow" }>, tree: VisibleTree): Reduced {
  if (modified(event)) return { state, input: UNRELATED };
  const id = nextSelection(tree, Option.getOrUndefined(state.selection)?.id, event.dir);
  if (id === undefined) return { state, input: UNRELATED };
  return { state: { ...state, selection: Option.some({ id, byKey: true }) }, input: { type: "selectedByKey", id } };
}

function foldTargetOf(state: ViewingState, event: Extract<ViewingEvent, { type: "enter" | "foldDot" }>): string | undefined {
  if (event.type === "foldDot") return event.id;
  return modified(event) ? undefined : Option.getOrUndefined(state.selection)?.id;
}

function reduceFoldToggle(state: ViewingState, event: Extract<ViewingEvent, { type: "enter" | "foldDot" }>, tree: VisibleTree): Reduced {
  const id = foldTargetOf(state, event);
  if (id === undefined || tree.fold === null) return { state, input: UNRELATED };
  const result = refold(tree.fold, { type: "toggle", id });
  if (result === null) return { state, input: UNRELATED };
  const next = withHumanFolds(state, result.human);
  return {
    state: result.select === undefined ? next : { ...next, selection: Option.some({ id: result.select, byKey: Option.exists(state.selection, (selection) => selection.byKey) }) },
    input: { type: "toggledFold", id },
  };
}

function reducePointChange(state: ViewingState, event: Extract<ViewingEvent, { type: "pointChange" }>, tree: VisibleTree): Reduced {
  const result = tree.fold === null ? null : refold(tree.fold, { type: "point", id: event.id });
  if (result === null) return { state: { ...state, selection: Option.some({ id: event.id, byKey: false }) }, input: UNRELATED, preserveIdleTimer: true };
  return { state: { ...withHumanFolds(state, result.human), selection: Option.some({ id: result.select!, byKey: false }) }, input: { type: "pointedNode", id: event.id } };
}

function reduceFitSubtree(state: ViewingState, event: Extract<ViewingEvent, { type: "key" }>, tree: VisibleTree): Reduced {
  const id = Option.getOrUndefined(state.selection)?.id;
  if (modified(event) || id === undefined || !tree.ids.includes(id)) return { state, input: UNRELATED };
  return { state, input: { type: "selectedSubtree", id } };
}

export function relocateSelection(state: ViewingState, replaced: Readonly<Record<string, string>>): ViewingState {
  return { ...state, selection: Option.map(state.selection, (selection) => {
    const to = replaced[selection.id];
    return to === undefined ? selection : { ...selection, id: to };
  }) };
}

function reduceKey(state: ViewingState, event: Extract<ViewingEvent, { type: "key" }>, tree: VisibleTree): Reduced {
  if (event.key === "Z") return reduceFitSubtree(state, event, tree);
  if (modified(event)) return { state, input: UNRELATED };
  return { state, input: event.key === "F" ? { type: "toggledOverview" } : { type: "viewKey", key: event.key } };
}

export function reduceViewing(state: ViewingState, event: ViewingEvent, tree: VisibleTree): Reduced {
  switch (event.type) {
    case "side": return reduceOverlay(state, event);
    case "select": return { state: { ...state, selection: Option.some({ id: event.id, byKey: false }) }, input: UNRELATED };
    case "deselect": return { state: { ...state, selection: Option.none() }, input: UNRELATED };
    case "arrow": return reduceArrow(state, event, tree);
    case "enter":
    case "foldDot": return reduceFoldToggle(state, event, tree);
    case "pointChange": return reducePointChange(state, event, tree);
    case "key": return reduceKey(state, event, tree);
    case "escape": return modified(event) ? { state, input: UNRELATED } : { state: { ...state, selection: Option.none(), humanFolds: Option.none() }, input: { type: "escaped" } };
    case "reflect": {
      const result = tree.fold === null ? null : refold(tree.fold, { type: "reflect" });
      return { state: relocateSelection(result === null ? state : withHumanFolds(state, result.human), event.replaced), input: { type: "reflected" } };
    }
    case "edgeDot": return { state, input: tree.ids.includes(event.id) ? { type: "pointedNode", id: event.id } : UNRELATED };
    case "idle": return { state, input: { type: "elapsedIdle" } };
    case "timeMoved": return { state, input: { type: "movedTime" } };
  }
}
