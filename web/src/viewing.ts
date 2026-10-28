import { Schema } from "effect";
import { HumanFolds, refold, type FoldView } from "./folding.ts";
import type { Position } from "./layout.ts";

const AutoCamera = Schema.Struct({ mode: Schema.Literal("auto") });
const ManualCamera = Schema.Struct({ mode: Schema.Literal("manual"), topic: Schema.UndefinedOr(Schema.String) });
const OverviewCamera = Schema.Struct({ mode: Schema.Literal("overview"), topic: Schema.UndefinedOr(Schema.String) });
const DiffCamera = Schema.Struct({ mode: Schema.Literal("diff"), topic: Schema.UndefinedOr(Schema.String) });
type CameraViewing = typeof AutoCamera.Type | typeof ManualCamera.Type | typeof OverviewCamera.Type | typeof DiffCamera.Type;

const overlayFields = {
  sideHidden: Schema.optionalKey(Schema.mutableKey(Schema.Literal(true))),
  selection: Schema.optionalKey(Schema.mutableKey(Schema.Struct({ id: Schema.String, byKey: Schema.Boolean }))),
  humanFolds: Schema.optionalKey(Schema.mutableKey(HumanFolds)),
};
type Overlay = Schema.Struct.Type<typeof overlayFields>;
export const ViewingState = Schema.Union([
  Schema.Struct({ ...AutoCamera.fields, ...overlayFields }),
  Schema.Struct({ ...ManualCamera.fields, ...overlayFields }),
  Schema.Struct({ ...OverviewCamera.fields, ...overlayFields }),
  Schema.Struct({ ...DiffCamera.fields, ...overlayFields }),
]);
const OVERLAY_KEYS = ["sideHidden"] as const satisfies readonly (keyof Overlay)[];
export type ViewingState = typeof ViewingState.Type;

export type ViewKey = "=" | "-" | "0" | "F" | "Z" | "Shift+ArrowLeft" | "Shift+ArrowRight" | "Shift+ArrowUp" | "Shift+ArrowDown";

export type ViewingEvent =
  | { type: "userMoved" }
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

export type ViewingScope = "live" | "review";

export type VisibleTree = {
  ids: string[];
  targets: Record<string, Position>;
  parents: Record<string, string | null>;
  fold: FoldView | null;
  changed: readonly string[];
  currentTopic: string | undefined;
};

export const CameraCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("follow") }),
  Schema.Struct({ type: Schema.Literal("refocus") }),
  Schema.Struct({ type: Schema.Literal("hold") }),
  Schema.Struct({ type: Schema.Literal("zoomBy"), factor: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("zoomTo"), zoom: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("pan"), dx: Schema.Finite, dy: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("fitAll") }),
  Schema.Struct({ type: Schema.Literal("focusNode"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("keepNode"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("revealNode"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("fitSubtree"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("fitChanged") }),
  Schema.Struct({ type: Schema.Literal("shiftIntoView") }),
]);
export type CameraCommand = typeof CameraCommand.Type;

export const INITIAL_VIEWING: ViewingState = { mode: "auto" };

const ZOOM_STEP = 1.25;

const AUTO: ViewingState = { mode: "auto" };
const FOLLOW: CameraCommand = { type: "follow" };
const REFOCUS: CameraCommand = { type: "refocus" };
const HOLD: CameraCommand = { type: "hold" };
const FIT_ALL: CameraCommand = { type: "fitAll" };
const FIT_CHANGED: CameraCommand = { type: "fitChanged" };
const SHIFT_INTO_VIEW: CameraCommand = { type: "shiftIntoView" };

function commandOf(key: Exclude<ViewKey, "F" | "Z">): CameraCommand {
  switch (key) {
    case "=":
      return { type: "zoomBy", factor: ZOOM_STEP };
    case "-":
      return { type: "zoomBy", factor: 1 / ZOOM_STEP };
    case "0":
      return { type: "zoomTo", zoom: 1 };
    case "Shift+ArrowLeft":
      return { type: "pan", dx: -1, dy: 0 };
    case "Shift+ArrowRight":
      return { type: "pan", dx: 1, dy: 0 };
    case "Shift+ArrowUp":
      return { type: "pan", dx: 0, dy: -1 };
    case "Shift+ArrowDown":
      return { type: "pan", dx: 0, dy: 1 };
  }
}

function idle(state: ViewingState): CameraCommand {
  return state.mode === "auto" ? FOLLOW : HOLD;
}

function without(state: ViewingState, key: (typeof OVERLAY_KEYS)[number] | "selection" | "humanFolds"): ViewingState {
  const { [key]: _removed, ...rest } = state;
  return rest;
}

function cameraPart(state: ViewingState): CameraViewing {
  const { sideHidden: _s, selection: _sel, humanFolds: _human, ...rest } = state;
  return rest;
}

function withHumanFolds(state: ViewingState, human: HumanFolds | undefined): ViewingState {
  const rest = without(state, "humanFolds");
  return human === undefined ? rest : { ...rest, humanFolds: human };
}

function withOverlayOf(from: ViewingState, camera: CameraViewing): ViewingState {
  const out: ViewingState = { ...camera };
  for (const key of OVERLAY_KEYS) if (from[key]) out[key] = true;
  if (from.selection) out.selection = from.selection;
  if (from.humanFolds !== undefined) out.humanFolds = from.humanFolds;
  return out;
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

type Reduced = { state: ViewingState; camera: CameraCommand; preserveIdleTimer?: true };

function reduceOverlay(state: ViewingState, event: Extract<ViewingEvent, { type: "side" }>): Reduced {
  if (modified(event)) return { state, camera: idle(state) };
  return { state: state.sideHidden ? without(state, "sideHidden") : { ...state, sideHidden: true }, camera: SHIFT_INTO_VIEW };
}

function reduceArrow(state: ViewingState, event: Extract<ViewingEvent, { type: "arrow" }>, tree: VisibleTree): Reduced {
  if (modified(event)) return { state, camera: idle(state) };
  const id = nextSelection(tree, state.selection?.id, event.dir);
  if (id === undefined) return { state, camera: idle(state) };
  const moved = withOverlayOf(state, { mode: "manual", topic: tree.currentTopic });
  return { state: { ...moved, selection: { id, byKey: true } }, camera: { type: "revealNode", id } };
}

function foldTargetOf(state: ViewingState, event: Extract<ViewingEvent, { type: "enter" | "foldDot" }>): string | undefined {
  if (event.type === "foldDot") return event.id;
  return modified(event) ? undefined : state.selection?.id;
}

function reduceFoldToggle(state: ViewingState, event: Extract<ViewingEvent, { type: "enter" | "foldDot" }>, tree: VisibleTree): Reduced {
  const id = foldTargetOf(state, event);
  if (id === undefined || tree.fold === null) return { state, camera: idle(state) };
  const result = refold(tree.fold, { type: "toggle", id });
  if (result === null) return { state, camera: idle(state) };
  const next = withHumanFolds(state, result.human);
  return {
    state: result.select === undefined ? next : { ...next, selection: { id: result.select, byKey: state.selection?.byKey ?? false } },
    camera: state.mode === "auto" ? REFOCUS : { type: "keepNode", id },
  };
}

function reducePointChange(state: ViewingState, event: Extract<ViewingEvent, { type: "pointChange" }>, tree: VisibleTree): Reduced {
  const result = tree.fold === null ? null : refold(tree.fold, { type: "point", id: event.id });
  if (result === null) return { state: { ...state, selection: { id: event.id, byKey: false } }, camera: idle(state), preserveIdleTimer: true };
  const moved = withOverlayOf(withHumanFolds(state, result.human), { mode: "manual", topic: tree.currentTopic });
  return { state: { ...moved, selection: { id: result.select!, byKey: false } }, camera: { type: "focusNode", id: event.id } };
}

function reduceFitSubtree(state: ViewingState, event: Extract<ViewingEvent, { type: "key" }>, tree: VisibleTree): Reduced {
  const id = state.selection?.id;
  if (modified(event) || id === undefined || !tree.ids.includes(id)) return { state, camera: idle(state) };
  const moved = withOverlayOf(state, { mode: "manual", topic: tree.currentTopic });
  return { state: moved, camera: { type: "fitSubtree", id } };
}

function relocateSelection(state: ViewingState, replaced: Readonly<Record<string, string>>): ViewingState {
  const to = state.selection ? replaced[state.selection.id] : undefined;
  return state.selection && to !== undefined ? { ...state, selection: { ...state.selection, id: to } } : state;
}

function reduceViaCamera(state: ViewingState, event: CameraEvent, tree: VisibleTree, scope: ViewingScope): Reduced {
  const out = reduceCamera(cameraPart(state), event, tree, scope);
  const withSets = withOverlayOf(state, out.state);
  if (event.type === "reflect") {
    const result = tree.fold === null ? null : refold(tree.fold, { type: "reflect" });
    const next = result === null ? withSets : withHumanFolds(withSets, result.human);
    return { state: relocateSelection(next, event.replaced), camera: out.camera };
  }
  if (event.type === "escape" && !modified(event)) return { state: without(without(withSets, "selection"), "humanFolds"), camera: out.camera };
  return { state: withSets, camera: out.camera };
}

export function reduceViewing(
  state: ViewingState,
  event: ViewingEvent,
  tree: VisibleTree,
  scope: ViewingScope = "live",
): Reduced {
  switch (event.type) {
    case "side":
      return reduceOverlay(state, event);
    case "select":
      return { state: { ...state, selection: { id: event.id, byKey: false } }, camera: idle(state) };
    case "deselect":
      return { state: without(state, "selection"), camera: idle(state) };
    case "arrow":
      return reduceArrow(state, event, tree);
    case "enter":
    case "foldDot":
      return reduceFoldToggle(state, event, tree);
    case "pointChange":
      return reducePointChange(state, event, tree);
    case "key":
      return event.key === "Z" ? reduceFitSubtree(state, event, tree) : reduceViaCamera(state, { ...event, key: event.key }, tree, scope);
    case "escape":
      return reduceViaCamera(state, event, tree, scope);
    case "userMoved":
    case "reflect":
    case "edgeDot":
    case "idle":
    case "timeMoved":
      return reduceViaCamera(state, event, tree, scope);
  }
}

type CameraEvent =
  | Exclude<ViewingEvent, { type: "side" | "select" | "deselect" | "arrow" | "enter" | "foldDot" | "pointChange" | "key" }>
  | { type: "key"; key: Exclude<ViewKey, "Z">; meta: boolean; ctrl: boolean; alt: boolean };

function reduceCameraEdgeDot(state: CameraViewing, event: Extract<CameraEvent, { type: "edgeDot" }>, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  if (!tree.ids.includes(event.id)) return { state, camera: idle(state) };
  return { state: { mode: "manual", topic: tree.currentTopic }, camera: { type: "focusNode", id: event.id } };
}

function reduceCameraReflect(state: CameraViewing, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  if (state.mode === "auto") return { state: AUTO, camera: FOLLOW };
  if (tree.currentTopic !== state.topic) return { state: AUTO, camera: REFOCUS };
  if (state.mode === "overview") return { state, camera: FIT_ALL };
  return { state, camera: state.mode === "diff" && tree.changed.length > 0 ? FIT_CHANGED : HOLD };
}

function toggleOverview(state: CameraViewing, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  if (state.mode !== "overview") return { state: { mode: "overview", topic: tree.currentTopic }, camera: FIT_ALL };
  if (tree.changed.length === 0) return { state: AUTO, camera: REFOCUS };
  return { state: { mode: "diff", topic: tree.currentTopic }, camera: FIT_CHANGED };
}

function reduceCameraKey(state: CameraViewing, event: Extract<CameraEvent, { type: "key" }>, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  if (modified(event)) return { state, camera: idle(state) };
  if (event.key !== "F") return { state: { mode: "manual", topic: tree.currentTopic }, camera: commandOf(event.key) };
  return toggleOverview(state, tree);
}

function reduceCamera(
  state: CameraViewing,
  event: CameraEvent,
  tree: VisibleTree,
  scope: ViewingScope,
): { state: CameraViewing; camera: CameraCommand } {
  switch (event.type) {
    case "idle":
      if (scope === "review" && state.mode === "manual") return { state: AUTO, camera: REFOCUS };
      return { state, camera: idle(state) };
    case "timeMoved":
      if (scope === "review" && state.mode !== "auto") return { state: AUTO, camera: REFOCUS };
      return { state, camera: idle(state) };
    case "userMoved":
      return { state: { mode: "manual", topic: tree.currentTopic }, camera: HOLD };
    case "reflect":
      return reduceCameraReflect(state, tree);
    case "edgeDot":
      return reduceCameraEdgeDot(state, event, tree);
    case "escape":
      if (modified(event)) return { state, camera: idle(state) };
      return state.mode === "auto" ? { state, camera: FOLLOW } : { state: AUTO, camera: REFOCUS };
    case "key":
      return reduceCameraKey(state, event, tree);
  }
}
