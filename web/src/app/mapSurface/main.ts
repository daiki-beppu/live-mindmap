import { HashMap, Match, Option, Schema } from "effect";
import { Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { personLine, Snapshot, type SnapshotNode, type SpeakerNames } from "../../../../server/src/core/index.ts";
import {
  anchoredViewport,
  cameraFocus,
  changedFocus,
  clampUserZoom,
  CLICK_ZOOM_FACTOR,
  edgeDots,
  fitViewport,
  focusViewport,
  nodeFocusViewport,
  nodeRect,
  OVERVIEW_MIN_ZOOM,
  overviewViewport,
  panViewport,
  pinchZoomFactor,
  revealViewport,
  screenPoint,
  scrollAlongAxis,
  scrollAxis,
  scrollPanDelta,
  shiftIntoView,
  shouldMoveCamera,
  subtreeViewport,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  zoomAroundCenter,
  zoomAtPoint,
  type Rect,
  type Viewport,
} from "../../camera.ts";
import { FOLD_DOT_CLASSES, MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { foldView, keepTargetOf, type FoldView } from "../../folding.ts";
import { KIND_COLOR, markOf } from "../../kinds.ts";
import { layout, NODE_WIDTH, type Position } from "../../layout.ts";
import { interpolate, startPositions } from "../../motion.ts";
import { relocations } from "../../relocation.ts";
import { type ArrowDir, type CameraCommand, INITIAL_VIEWING, reduceViewing, ViewingState, type ViewingEvent, type ViewKey, type VisibleTree } from "../../viewing.ts";
import { RestartBlink } from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { ObserveMapSurface } from "./mount.ts";

export const Model = Schema.Struct({
  mode: Schema.Literals(["still", "live", "review"]),
  snapshot: Snapshot,
  size: Schema.Option(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
  nodeHeights: Schema.HashMap(Schema.String, Schema.Finite),
  isMac: Schema.Boolean,
  pointer: Schema.Option(Schema.Union([Schema.TaggedStruct("PanningPane", { x: Schema.Finite, y: Schema.Finite, button: Schema.Finite }), Schema.TaggedStruct("HoldingNode", {})])),
  nodePress: Schema.Option(Schema.Struct({ nodeId: Schema.String, x: Schema.Finite, y: Schema.Finite, dragged: Schema.Boolean })),
  scrollAxisLock: Schema.Option(Schema.Struct({ axis: Schema.Literals(["x", "y"]), at: Schema.Finite })),
  motion: Schema.Option(Schema.Struct({ start: Schema.HashMap(Schema.String, Schema.Struct({ x: Schema.Finite, y: Schema.Finite })), elapsedMs: Schema.Finite })),
  viewing: ViewingState,
  gestureScale: Schema.Option(Schema.Finite),
  viewport: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, zoom: Schema.Finite }),
  placedRound: Schema.Option(Schema.Finite),
  keepAnchor: Schema.Option(Schema.Struct({ id: Schema.String, point: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }) })),
  pendingShift: Schema.Boolean,
  idleStamp: Schema.Finite,
  speakerNames: Schema.Record(Schema.String, Schema.String),
});
export type Model = typeof Model.Type;

const IDENTITY: Viewport = { x: 0, y: 0, zoom: 1 };

export const init = (snapshot: Snapshot, mode: Model["mode"], isMac: boolean): Model => ({
  mode,
  snapshot,
  size: Option.none(),
  nodeHeights: HashMap.empty(),
  isMac,
  pointer: Option.none(),
  nodePress: Option.none(),
  scrollAxisLock: Option.none(),
  motion: Option.none(),
  viewing: INITIAL_VIEWING,
  gestureScale: Option.none(),
  viewport: IDENTITY,
  placedRound: Option.none(),
  keepAnchor: Option.none(),
  pendingShift: false,
  idleStamp: 0,
  speakerNames: {},
});

const MOTION_DURATION_MS = 500;

const foldViewOf = (model: Model): FoldView | null => {
  if (model.mode === "still") return null;
  return foldView(model.snapshot, model.viewing.humanFolds, model.viewing.selection?.id ?? null);
};
const shownNodesOf = (model: Model): SnapshotNode[] => foldViewOf(model)?.nodes ?? model.snapshot.nodes;
const layoutHeightsOf = (model: Model): Record<string, number> => Object.fromEntries(HashMap.toEntries(model.nodeHeights).map(([id, height]) => [id, Math.round(height)]));
const drawnHeightOf = (model: Model, id: string): number => Option.getOrThrow(HashMap.get(model.nodeHeights, id));
const dimsOf = (model: Model): Record<string, { height: number }> => Object.fromEntries(Object.entries(layoutHeightsOf(model)).map(([id, height]) => [id, { height }]));
const targetOf = (model: Model): Record<string, Position> => layout(shownNodesOf(model), layoutHeightsOf(model));

const treeOf = (model: Model, view: FoldView | null = foldViewOf(model)): VisibleTree => {
  const shown = view?.nodes ?? model.snapshot.nodes;
  return {
    ids: shown.map((n) => n.id),
    targets: layout(shown, layoutHeightsOf(model)),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    fold: view,
    changed: changedFocus(model.snapshot, view?.shownAs ?? {})?.ids ?? [],
    currentTopic: model.snapshot.currentTopic,
  };
};

export const displayedPositions = (model: Model): Record<string, Position> => {
  const target = targetOf(model);
  return Option.match(model.motion, {
    onNone: () => target,
    onSome: ({ start, elapsedMs }) => interpolate(Object.fromEntries(HashMap.toEntries(start)), target, elapsedMs / MOTION_DURATION_MS),
  });
};

const samePositions = (a: Record<string, Position>, b: Record<string, Position>): boolean => {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => b[id] !== undefined && a[id]!.x === b[id].x && a[id]!.y === b[id].y);
};

const followTarget = (before: Model, after: Model): Model => {
  if (after.mode === "still") return after;
  const target = targetOf(after);
  if (samePositions(targetOf(before), target)) return after;
  const shown = HashMap.size(before.nodeHeights) === 0 ? {} : displayedPositions(before);
  const start = startPositions(shownNodesOf(after), shown, target);
  return modifyFields(after, {
    motion: () => (samePositions(start, target) ? Option.none() : Option.some({ start: HashMap.fromIterable(Object.entries(start)), elapsedMs: 0 })),
  });
};

type Size = { width: number; height: number };

const setViewport = (model: Model, viewport: Viewport): Model => modifyFields(model, { viewport: () => viewport });

const minZoomOf = (model: Model): number => (model.mode === "still" ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM);

const fittedOf = (model: Model, size: Size): Viewport => {
  const heights = layoutHeightsOf(model);
  const positions = displayedPositions(model);
  const rects = shownNodesOf(model)
    .filter((n) => HashMap.has(model.nodeHeights, n.id))
    .map((n): Rect => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  return fitViewport(rects, size, minZoomOf(model), USER_MAX_ZOOM) ?? IDENTITY;
};

export const fitsAllOf = (model: Model): Option.Option<boolean> => {
  if (Option.isNone(model.size)) return Option.none();
  const { width, height } = model.size.value;
  const shown = shownNodesOf(model);
  if (!shown.every((n) => HashMap.has(model.nodeHeights, n.id))) return Option.none();
  if (shown.length === 0) return Option.some(true);
  const heights = layoutHeightsOf(model);
  const positions = displayedPositions(model);
  const { x, y, zoom } = model.viewport;
  const left = Math.min(...shown.map((n) => positions[n.id]!.x));
  const top = Math.min(...shown.map((n) => positions[n.id]!.y));
  const right = Math.max(...shown.map((n) => positions[n.id]!.x + NODE_WIDTH));
  const bottom = Math.max(...shown.map((n) => positions[n.id]!.y + heights[n.id]!));
  return Option.some(left * zoom + x >= 0 && top * zoom + y >= 0 && right * zoom + x <= width && bottom * zoom + y <= height);
};

const focusBoxesOf = (model: Model, focus: { ids: string[]; center: string }): { rects: Rect[]; center: Rect } => {
  const shownAs = foldViewOf(model)?.shownAs ?? {};
  const shownId = (id: string) => shownAs[id] ?? id;
  const target = targetOf(model);
  const dims = dimsOf(model);
  return { rects: [...new Set(focus.ids.map(shownId))].map((id) => nodeRect(id, target, dims)), center: nodeRect(shownId(focus.center), target, dims) };
};

const diffCamera = (model: Model, size: Size): Model => {
  if (Option.isSome(model.keepAnchor)) return model;
  const changed = changedFocus(model.snapshot, foldViewOf(model)?.shownAs ?? {});
  if (changed === null) return model;
  const boxes = focusBoxesOf(model, changed);
  return setViewport(model, focusViewport(boxes.rects, boxes.center, size, USER_MIN_ZOOM));
};

const autoCamera = (model: Model): Model => {
  if (Option.isNone(model.size)) return model;
  const size = model.size.value;
  if (model.mode === "still") return setViewport(model, fittedOf(model, size));
  if (model.viewing.mode === "manual") return model;
  if (model.viewing.mode === "overview") {
    if (Option.isSome(model.keepAnchor)) return model;
    const viewport = overviewViewport(treeOf(model).ids, targetOf(model), dimsOf(model), size);
    return viewport === null ? model : setViewport(model, viewport);
  }
  if (model.viewing.mode === "diff") return diffCamera(model, size);
  const focus = cameraFocus(model.snapshot);
  if (focus === null) return setViewport(modifyFields(model, { placedRound: () => Option.none() }), fittedOf(model, size));
  if (!shouldMoveCamera(model.snapshot, Option.getOrNull(model.placedRound))) return model;
  const boxes = focusBoxesOf(model, focus);
  return setViewport(modifyFields(model, { placedRound: () => Option.some(model.snapshot.round) }), focusViewport(boxes.rects, boxes.center, size));
};

const reanchor = (model: Model): Model =>
  Option.match(model.keepAnchor, {
    onNone: () => model,
    onSome: ({ id, point }) => {
      const at = displayedPositions(model)[id];
      return at === undefined ? model : setViewport(model, anchoredViewport(model.viewport, at, point));
    },
  });

const applyPendingShift = (before: Model, after: Model): Model => {
  if (!after.pendingShift || Option.isNone(after.size)) return after;
  const size = after.size.value;
  if (Option.isSome(before.size) && before.size.value.width === size.width) return after;
  const settled = modifyFields(after, { pendingShift: () => false });
  const focus = after.mode === "still" || after.viewing.sideHidden ? null : cameraFocus(after.snapshot);
  return focus === null ? settled : setViewport(settled, shiftIntoView(after.viewport, focusBoxesOf(after, focus).rects, size));
};

type CommandContext = { size: Size; previous: Model };
type CommandStep = (model: Model, context: CommandContext) => Model;

const clampedViewport = (viewport: Viewport, size: Size): Viewport => zoomAroundCenter(viewport, clampUserZoom(viewport.zoom), size);

const commandStepOf = Match.type<CameraCommand>().pipe(
  Match.withReturnType<CommandStep>(),
  Match.discriminatorsExhaustive("type")({
    follow: () => (model) => model,
    hold: () => (model) => model,
    fitAll: () => (model) => model,
    fitChanged: () => (model) => model,
    shiftIntoView: () => (model) => model,
    refocus: () => (model) => modifyFields(model, { placedRound: () => Option.none() }),
    zoomBy: ({ factor }) => (model, { size }) => setViewport(model, zoomAroundCenter(model.viewport, clampUserZoom(model.viewport.zoom * factor), size)),
    zoomTo: ({ zoom }) => (model, { size }) => setViewport(model, zoomAroundCenter(model.viewport, clampUserZoom(zoom), size)),
    pan: ({ dx, dy }) => (model, { size }) => setViewport(model, panViewport(clampedViewport(model.viewport, size), { dx, dy }, size)),
    focusNode: ({ id }) => (model, { size }) => setViewport(model, nodeFocusViewport(nodeRect(id, targetOf(model), dimsOf(model)), model.viewport.zoom, size)),
    revealNode: ({ id }) => (model, { size }) => setViewport(model, revealViewport(clampedViewport(model.viewport, size), nodeRect(id, targetOf(model), dimsOf(model)), size)),
    fitSubtree: ({ id }) => (model, { size }) => setViewport(model, subtreeViewport(id, treeOf(model), targetOf(model), dimsOf(model), size)),
    keepNode: ({ id }) => (model, { previous }) => {
      const at = displayedPositions(previous)[id] ?? displayedPositions(model)[id];
      return at === undefined ? model : modifyFields(model, { keepAnchor: () => Option.some({ id: keepTargetOf(foldViewOf(model), id), point: screenPoint(model.viewport, at) }) });
    },
  }),
);

const applyCommand = (model: Model, command: CameraCommand, previous: Model): Model => {
  const reset = modifyFields(model, { pendingShift: () => command.type === "shiftIntoView", keepAnchor: () => Option.none() });
  if (Option.isNone(model.size)) return reset;
  return commandStepOf(command)(reset, { size: model.size.value, previous });
};

const keepsIdleTimer = (event: ViewingEvent): boolean => event.type === "side" || event.type === "select" || event.type === "deselect";

const applyViewing = (model: Model, event: ViewingEvent, previous: Model = model): Model => {
  const { state, camera, preserveIdleTimer } = reduceViewing(model.viewing, event, treeOf(model), model.mode === "review" ? "review" : "live");
  const reduced = modifyFields(model, { viewing: () => state, idleStamp: (stamp) => (preserveIdleTimer || keepsIdleTimer(event) ? stamp : stamp + 1) });
  if (model.mode === "still") return reduced;
  const followed = followTarget(previous, reduced);
  const commanded = applyCommand(followed, camera, previous);
  return reanchor(camera.type === "shiftIntoView" || camera.type === "keepNode" ? commanded : autoCamera(commanded));
};

const reflectionOf = (before: Model, after: Model): ViewingEvent | null => {
  if (after.mode === "still" || before.snapshot.round === after.snapshot.round) return null;
  const replaced = relocations({ tree: treeOf(before), snapshot: before.snapshot, selectedId: before.viewing.selection?.id ?? null }, { tree: treeOf(after), snapshot: after.snapshot });
  return { type: "reflect", replaced };
};

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

const CLICK_SLOP = 4;
const awayFrom = (press: { x: number; y: number }, x: number, y: number): boolean => Math.hypot(x - press.x, y - press.y) > CLICK_SLOP;
const startsPan = (button: number, ctrlKey: boolean): boolean => button <= 1 && !ctrlKey;
// MouseEvent.buttons のビットは主=1・右=2・中=4 で、button の番号（主=0・中=1）とは並びが違う。押したボタンに対応するビットを返す
const buttonsBit = (button: number): number => (button === 1 ? 4 : 1);

const movedByUser = (model: Model, viewport: Viewport): Model => {
  if (model.mode === "still") return model;
  const moved = applyViewing(modifyFields(setViewport(model, viewport), { keepAnchor: () => Option.none() }), { type: "userMoved" });
  return Option.match(moved.size, { onNone: () => moved, onSome: (size) => setViewport(moved, clampedViewport(moved.viewport, size)) });
};

const panBy = (model: Model, x: number, y: number): Model => movedByUser(model, { x: model.viewport.x + x, y: model.viewport.y + y, zoom: model.viewport.zoom });

const zoomBy = (model: Model, point: { x: number; y: number }, factor: number): Model => movedByUser(model, zoomAtPoint(model.viewport, point, factor));

const followDisplayed = (model: Model): Model => {
  const follows = model.mode !== "still" && model.viewing.mode === "auto" && cameraFocus(model.snapshot) === null;
  const anchored = reanchor(model);
  return follows ? autoCamera(anchored) : anchored;
};

const pressed = (model: Model, event: ViewingEvent): Return => ({ model: model.mode === "still" ? model : applyViewing(model, event) });

export type KeyModifiers = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };
export const pressViewKey = (model: Model, input: KeyModifiers & { key: ViewKey }): Return => update(model, Message.PressedViewKey(input));
export const pressArrowKey = (model: Model, input: KeyModifiers & { dir: ArrowDir }): Return => update(model, Message.PressedArrowKey(input));
export const pressEscapeKey = (model: Model, input: KeyModifiers): Return => update(model, Message.PressedEscapeKey(input));
export const pressSideKey = (model: Model, input: KeyModifiers): Return => update(model, Message.PressedSideKey(input));
export const pressEnterKey = (model: Model, input: KeyModifiers): Return => update(model, Message.PressedEnterKey(input));

export const toggledKeyList = (model: Model): Model => update(model, Message.ToggledKeyList()).model;

export const blinkRestartsOf = (before: Model, after: Model): ReadonlyArray<ReturnType<typeof RestartBlink>> => {
  if (after.mode === "still" || Option.isNone(after.size) || before.snapshot.round === after.snapshot.round) return [];
  return (foldViewOf(after)?.blink.size ?? 0) > 0 ? [RestartBlink()] : [];
};

export const changedSnapshot = (model: Model, snapshot: Snapshot): Model => update(model, Message.ChangedSnapshot({ snapshot })).model;

export const movedTime = (model: Model): Model => update(model, Message.MovedTime()).model;

const clickedNode = (model: Model, nodeId: string): Return =>
  foldViewOf(model)?.openness[nodeId]?.state === "bundle" ? { model } : { model: applyViewing(model, { type: "select", id: nodeId }), outMessage: OutMessage.SelectedNode({ nodeId }) };

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    MeasuredMapSurface: ({ width, height, nodeHeights }) => {
      const measured = modifyFields(model, {
        size: () => Option.some({ width, height }),
        nodeHeights: (current) => HashMap.setMany(current, Object.entries(nodeHeights)),
      });
      const settlesShift = model.pendingShift && Option.isSome(model.size) && model.size.value.width !== width;
      const changed =
        Option.isNone(model.size) ||
        (!settlesShift && (model.size.value.width !== width || model.size.value.height !== height)) ||
        Object.entries(nodeHeights).some(([id, nodeHeight]) => Option.getOrUndefined(HashMap.get(model.nodeHeights, id)) !== nodeHeight);
      const followed = followTarget(model, measured);
      return { model: applyPendingShift(model, reanchor(changed ? autoCamera(followed) : followed)) };
    },
    ChangedSnapshot: ({ snapshot }) => {
      const replaced = modifyFields(model, { snapshot: () => snapshot });
      const reflection = reflectionOf(model, replaced);
      return { model: reflection === null ? reanchor(autoCamera(followTarget(model, replaced))) : applyViewing(replaced, reflection, model) };
    },
    MovedTime: () => (model.viewing.mode === "auto" ? { model } : pressed(model, { type: "timeMoved" })),
    PressedViewKey: ({ key, metaKey, ctrlKey, altKey }) => pressed(model, { type: "key", key, meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedArrowKey: ({ dir, metaKey, ctrlKey, altKey }) => pressed(model, { type: "arrow", dir, meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedEscapeKey: ({ metaKey, ctrlKey, altKey }) => pressed(model, { type: "escape", meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedEnterKey: ({ metaKey, ctrlKey, altKey }) => pressed(model, { type: "enter", meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedSideKey: ({ metaKey, ctrlKey, altKey }) => pressed(model, { type: "side", meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    ElapsedIdleTime: () => pressed(model, { type: "idle" }),
    CompletedRestartBlink: () => ({ model }),
    ToggledKeyList: () => ({ model: modifyFields(model, { idleStamp: (stamp) => stamp + 1 }) }),
    TickedAnimationFrame: ({ deltaMs }) => {
      const ticked = modifyFields(model, {
        motion: Option.flatMap(({ start, elapsedMs }) => (elapsedMs + deltaMs >= MOTION_DURATION_MS ? Option.none() : Option.some({ start, elapsedMs: elapsedMs + deltaMs }))),
      });
      return { model: followDisplayed(ticked) };
    },
    PressedMapSurface: ({ clientX, clientY, button, ctrlKey, insideNoPan }) => ({
      model:
        model.mode !== "still" && !insideNoPan && startsPan(button, ctrlKey)
          ? modifyFields(model, { pointer: () => Option.some({ _tag: "PanningPane" as const, x: clientX, y: clientY, button }) })
          : model,
    }),
    PressedNodeButton: ({ nodeId, clientX, clientY }) => ({
      model: modifyFields(model, {
        nodePress: () => Option.some({ nodeId, x: clientX, y: clientY, dragged: false }),
        pointer: () => Option.some({ _tag: "HoldingNode" as const }),
      }),
    }),
    MovedPointer: ({ clientX, clientY, buttons }) => {
      if (Option.isNone(model.pointer)) return { model };
      const pointer = model.pointer.value;
      const heldBit = pointer._tag === "PanningPane" ? buttonsBit(pointer.button) : 1;
      if ((buttons & heldBit) === 0) return { model: modifyFields(model, { pointer: () => Option.none() }) };
      const panned =
        pointer._tag === "PanningPane"
          ? modifyFields(panBy(model, clientX - pointer.x, clientY - pointer.y), { pointer: () => Option.some({ _tag: "PanningPane" as const, x: clientX, y: clientY, button: pointer.button }) })
          : model;
      return { model: modifyFields(panned, { nodePress: Option.map((press) => (awayFrom(press, clientX, clientY) ? { ...press, dragged: true } : press)) }) };
    },
    ReleasedPointer: () => ({ model: modifyFields(model, { pointer: () => Option.none() }) }),
    CanceledPointer: () => ({ model: modifyFields(model, { pointer: () => Option.none() }) }),
    ClickedNodeButton: ({ nodeId, clientX, clientY }) => {
      const press = Option.filter(model.nodePress, (p) => p.nodeId === nodeId);
      const consumed = Option.isNone(press) ? model : modifyFields(model, { nodePress: () => Option.none() });
      const dragged = Option.isSome(press) && (press.value.dragged || awayFrom(press.value, clientX, clientY));
      return dragged ? { model: consumed } : clickedNode(consumed, nodeId);
    },
    ClickedNodeButtonWithoutPointer: ({ nodeId }) => clickedNode(model, nodeId),
    ClickedFoldDot: ({ nodeId }) => ({ model: applyViewing(model, { type: "foldDot", id: nodeId }) }),
    ClickedEdgeDot: ({ nodeId }) => ({ model: applyViewing(model, { type: "edgeDot", id: nodeId }) }),
    ClickedChangeItem: ({ nodeId }) => ({ model: applyViewing(model, { type: "pointChange", id: nodeId }) }),
    ClickedEvidenceClose: () => ({ model: applyViewing(model, { type: "deselect" }) }),
    ToggledSide: ({ isOpen }) => (isOpen === (model.viewing.sideHidden !== true) ? { model } : { model: applyViewing(model, { type: "side", meta: false, ctrl: false, alt: false }) }),
    WheeledMapSurface: ({ x, y, deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey, timeStamp }) => {
      if (model.mode === "still") return { model };
      if ((metaKey || ctrlKey) && shiftKey) {
        const lock = scrollAxis(Option.getOrNull(model.scrollAxisLock), timeStamp, { x: deltaX, y: deltaY });
        const moved = scrollAlongAxis(IDENTITY, lock.axis, { x: deltaX, y: deltaY });
        return { model: modifyFields(panBy(model, moved.x, moved.y), { scrollAxisLock: () => Option.some(lock) }) };
      }
      // Ctrl 付きの wheel はトラックパッドのピンチ
      if (ctrlKey) return { model: zoomBy(model, { x, y }, pinchZoomFactor({ deltaY, deltaMode, ctrlKey }, model.isMac)) };
      if (model.isMac && metaKey) return { model };
      const moved = scrollPanDelta({ deltaX, deltaY, deltaMode, shiftKey }, model.isMac);
      return { model: panBy(model, moved.x, moved.y) };
    },
    ClickedMapSurfaceWithModifier: ({ x, y, altKey }) => ({ model: zoomBy(model, { x, y }, altKey ? 1 / CLICK_ZOOM_FACTOR : CLICK_ZOOM_FACTOR) }),
    StartedMapSurfaceGesture: () => ({ model: modifyFields(model, { gestureScale: () => Option.none() }) }),
    ChangedMapSurfaceGesture: ({ scale, x, y }) => {
      if (model.mode === "still") return { model };
      const factor = scale / Option.getOrElse(model.gestureScale, () => 1);
      return { model: modifyFields(zoomBy(model, { x, y }, factor), { gestureScale: () => Option.some(scale) }) };
    },
  });

const HANDLE_OUTSET = 3;

const CURVATURE = 0.25;
const controlOffset = (distance: number): number => (distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance));
const bezier = (source: Position, target: Position): string => {
  const offset = controlOffset(target.x - source.x);
  return `M${source.x},${source.y} C${source.x + offset},${source.y} ${target.x - offset},${target.y} ${target.x},${target.y}`;
};

const classes = (...names: ReadonlyArray<string | false>): string => names.filter(Boolean).join(" ");

type H = HtmlBuilder<Message>;

function nodeBody(h: H, node: SnapshotNode, view: FoldView | null, selected: boolean, speakerNames: SpeakerNames): Html {
  const openness = view?.openness[node.id];
  const fold = openness?.state === "folded" || openness?.state === "bundle" ? openness : null;
  const mark = markOf(node);
  const person = personLine(node, speakerNames);
  return h.div(
    [
      h.Class(
        classes("map-node", node.kind === "案" && node.planStatus === "却下" && "map-node--rejected", fold !== null && "map-node--folded", selected && "map-node--selected", view?.blink.has(node.id) === true && "map-node--blink", "nopan"),
      ),
      h.Style({ "--kind-color": KIND_COLOR[node.kind] }),
    ],
    [
      h.button(
        [h.Type("button"), h.Class(MAP_NODE_BUTTON_CLASS), h.AriaPressed(String(selected))],
        [mark === null ? null : h.span([h.Class("map-node__mark")], [mark]), h.span([h.Class("map-node__text")], [node.text]), person === null ? null : h.span([h.Class("map-node__person text-[12px] text-gray-500")], [person]), fold?.hint ? h.span([h.Class("map-node__hint")], [fold.hint]) : null],
      ),
      fold === null
        ? null
        : h.button([h.Type("button"), h.Class(`map-node__count ${FOLD_DOT_CLASSES[0]}`), h.AriaLabel("開く"), h.OnClick(Message.ClickedFoldDot({ nodeId: node.id }))], [String(fold.hidden)]),
      openness?.state === "open" && openness.byHuman ? h.button([h.Type("button"), h.Class(FOLD_DOT_CLASSES[1]), h.AriaLabel("畳む"), h.OnClick(Message.ClickedFoldDot({ nodeId: node.id }))], []) : null,
    ],
  );
}

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  const view_ = foldViewOf(model);
  const tree = view_ === null ? null : treeOf(model, view_);
  const selectedId = view_ === null ? null : (model.viewing.selection?.id ?? null);
  const shown = view_?.nodes ?? model.snapshot.nodes;
  const positions = displayedPositions(model);
  const measured = shown.filter((n) => HashMap.has(model.nodeHeights, n.id));
  const viewport = model.viewport;

  const edges = measured.flatMap((child) => {
    const parent = child.parent === null ? undefined : measured.find((n) => n.id === child.parent);
    if (parent === undefined) return [];
    const source = { x: positions[parent.id]!.x + NODE_WIDTH + HANDLE_OUTSET, y: positions[parent.id]!.y + drawnHeightOf(model, parent.id) / 2 };
    const target = { x: positions[child.id]!.x - HANDLE_OUTSET, y: positions[child.id]!.y + drawnHeightOf(model, child.id) / 2 };
    return [h.keyed("path")(`${parent.id}->${child.id}`, [h.D(bezier(source, target)), h.Stroke(KIND_COLOR[child.kind]), h.StrokeWidth("2"), h.Fill("none")])];
  });
  const nodes = shown.map((node) =>
    h.keyed("div")(
      node.id,
      [
        h.Class("map-node-slot absolute left-0 top-0 box-border origin-top-left [pointer-events:all] select-none cursor-default"),
        h.DataAttribute("node-id", node.id),
        h.Style({ transform: `translate(${positions[node.id]!.x}px, ${positions[node.id]!.y}px)`, width: `${NODE_WIDTH}px`, visibility: HashMap.has(model.nodeHeights, node.id) ? "visible" : "hidden" }),
      ],
      [nodeBody(h, node, view_, node.id === selectedId, model.speakerNames)],
    ),
  );

  const dots =
    view_ === null || tree === null || model.viewing.mode === "auto"
      ? []
      : Option.match(model.size, {
          onNone: () => [],
          onSome: (size) =>
            edgeDots(
              tree.ids.filter((id) => view_.blink.has(id) && HashMap.has(model.nodeHeights, id)),
              tree.targets,
              dimsOf(model),
              viewport,
              size,
            ),
        });
  const edgeDotButtons = dots.map((dot) =>
    h.keyed("button")(dot.id, [
      h.Type("button"),
      h.Class("edge-dot nopan nowheel absolute w-[10px] h-[10px] [margin:-5px_0_0_-5px] p-0 [border:0] rounded-[50%] bg-yellow-400 cursor-pointer pointer-events-auto"),
      h.Style({ left: `${dot.x}px`, top: `${dot.y}px` }),
      h.AriaLabel(`画面の外で変わったノードへ寄る（${dot.ids.length} 件）`),
      h.OnClick(Message.ClickedEdgeDot({ nodeId: dot.id })),
    ]),
  );

  return h.div(
    [h.Class("map-surface relative w-full h-full overflow-hidden z-0"), h.OnMount(ObserveMapSurface())],
    [
      h.div([h.Class("map-viewport absolute left-0 top-0 w-full h-full origin-top-left pointer-events-none z-2"), h.Style({ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` })], [h.svg([h.Class("map-edges absolute left-0 top-0 w-[1px] h-[1px] overflow-visible pointer-events-none")], edges), h.div([h.Class("map-nodes absolute left-0 top-0 pointer-events-none")], nodes)]),
      ...(edgeDotButtons.length === 0 ? [] : [h.div([h.Class("edge-dots absolute inset-0 z-4 pointer-events-none overflow-hidden")], edgeDotButtons)]),
    ],
  );
});
