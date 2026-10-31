import { HashMap, Option, Schema, Struct } from "effect";
import { Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { personLine, supportsCriteria, TalkStatus, Snapshot, SnapshotNode, type SpeakerNames } from "../../../../server/src/core/index.ts";
import { Camera, initialCamera, stepCamera, cameraFocus, changedFocus, CLICK_ZOOM_FACTOR, edgeDots, pinchZoomFactor, scrollAlongAxis, scrollAxis, scrollPanDelta, zoomAtPoint, type CameraInput, type CameraSeen, type Viewport } from "../../camera.ts";
import { FOLD_DOT_CLASSES, MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { foldView, keepTargetOf, type FoldView } from "../../folding.ts";
import { KIND_COLOR, markOf } from "../../kinds.ts";
import { layout, NODE_WIDTH, type Position } from "../../layout.ts";
import { interpolate, startPositions } from "../../motion.ts";
import { relocations } from "../../relocation.ts";
import { type ArrowDir, INITIAL_VIEWING, reduceViewing, relocateSelection, ViewingState, type ViewingEvent, type ViewKey, type VisibleTree } from "../../viewing.ts";
import { RestartBlink } from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { ObserveMapSurface } from "./mount.ts";

const FoldingContext = Schema.Struct({
  currentTopic: Schema.Option(Schema.String),
  now: Schema.Option(Schema.Finite),
  touchedAt: Schema.Record(Schema.String, Schema.Option(Schema.Finite)),
  talkStatus: Schema.Record(Schema.String, Schema.Option(TalkStatus)),
});
const sameFoldingContext = Schema.toEquivalence(FoldingContext);
const foldingContextOf = (snapshot: Snapshot): typeof FoldingContext.Type => ({
  currentTopic: Option.fromUndefinedOr(snapshot.currentTopic),
  now: Option.fromUndefinedOr(snapshot.now),
  touchedAt: Object.fromEntries(snapshot.nodes.map((node) => [node.id, Option.fromUndefinedOr(node.touchedAt)])),
  talkStatus: Object.fromEntries(snapshot.nodes.map((node) => [node.id, Option.fromUndefinedOr(node.talkStatus)])),
});

const CONTENT_IGNORED = ["criteria", "evidence", "evidenceRound", "touchedAt", "talkStatus"] as const;
const sameNodeContent = Schema.toEquivalence(SnapshotNode.mapMembers(([regular, supplement]) => [
  regular.mapFields(Struct.omit(CONTENT_IGNORED)),
  supplement.mapFields(Struct.omit(CONTENT_IGNORED)),
]));
const sameNodes = Schema.toEquivalence(Schema.Array(SnapshotNode));
const sameCriteria = Schema.toEquivalence(Schema.Array(Schema.String));
const changedOnlyCriteria = (before: Snapshot, after: Snapshot): boolean => {
  if (before.nodes.length !== after.nodes.length) return false;
  const byId = new Map(before.nodes.map((node) => [node.id, node]));
  const linked = new Set(after.nodes.filter((node) => {
    const previous = byId.get(node.id);
    return previous !== undefined && !sameCriteria(previous.criteria ?? [], node.criteria ?? []);
  }).map((node) => node.id));
  if (linked.size === 0) return false;
  const reopened = new Set<string>();
  for (const id of linked) {
    for (let node = byId.get(id); node; node = node.parent ? byId.get(node.parent) : undefined) reopened.add(node.id);
  }
  return after.nodes.every((node, index) => {
    const previous = before.nodes[index]!;
    return sameNodeContent(previous, node)
      && (linked.has(node.id) || (sameCriteria(previous.evidence, node.evidence) && previous.evidenceRound === node.evidenceRound))
      && (reopened.has(node.id) || previous.touchedAt === node.touchedAt)
      && (previous.talkStatus === node.talkStatus || (reopened.has(node.id) && node.talkStatus === undefined));
  });
};

export const Model = Schema.Struct({
  mode: Schema.Literals(["still", "live", "review"]),
  snapshot: Snapshot,
  foldingContext: FoldingContext,
  size: Schema.Option(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
  nodeHeights: Schema.HashMap(Schema.String, Schema.Finite),
  isMac: Schema.Boolean,
  pointer: Schema.Option(Schema.Union([Schema.TaggedStruct("PanningPane", { x: Schema.Finite, y: Schema.Finite, button: Schema.Finite }), Schema.TaggedStruct("HoldingNode", {})])),
  nodePress: Schema.Option(Schema.Struct({ nodeId: Schema.String, x: Schema.Finite, y: Schema.Finite, dragged: Schema.Boolean })),
  scrollAxisLock: Schema.Option(Schema.Struct({ axis: Schema.Literals(["x", "y"]), at: Schema.Finite })),
  motion: Schema.Option(Schema.Struct({ start: Schema.HashMap(Schema.String, Schema.Struct({ x: Schema.Finite, y: Schema.Finite })), elapsedMs: Schema.Finite })),
  viewing: ViewingState,
  gestureScale: Schema.Option(Schema.Finite),
  camera: Camera,
  idleStamp: Schema.Finite,
  speakerNames: Schema.Record(Schema.String, Schema.String),
});
export type Model = typeof Model.Type;

const IDENTITY: Viewport = { x: 0, y: 0, zoom: 1 };

export const init = (snapshot: Snapshot, mode: Model["mode"], isMac: boolean): Model => ({
  mode,
  snapshot,
  foldingContext: foldingContextOf(snapshot),
  size: Option.none(),
  nodeHeights: HashMap.empty(),
  isMac,
  pointer: Option.none(),
  nodePress: Option.none(),
  scrollAxisLock: Option.none(),
  motion: Option.none(),
  viewing: INITIAL_VIEWING,
  gestureScale: Option.none(),
  camera: initialCamera(),
  idleStamp: 0,
  speakerNames: {},
});

const MOTION_DURATION_MS = 500;

type Seen = CameraSeen & { selection: ViewingState["selection"] };

const positionsOf = (motion: Model["motion"], target: Record<string, Position>): Record<string, Position> =>
  Option.match(motion, {
    onNone: () => target,
    onSome: ({ start, elapsedMs }) => interpolate(Object.fromEntries(HashMap.toEntries(start)), target, elapsedMs / MOTION_DURATION_MS),
  });

const surfaceOf = (model: Model) => {
  const context = model.foldingContext;
  const snapshot = {
    ...model.snapshot,
    currentTopic: Option.getOrUndefined(context.currentTopic),
    now: Option.getOrUndefined(context.now),
    nodes: model.snapshot.nodes.map((node) => ({
      ...node,
      touchedAt: Option.getOrUndefined(context.touchedAt[node.id] ?? Option.none()),
      talkStatus: Option.getOrUndefined(context.talkStatus[node.id] ?? Option.none()),
    })),
  };
  const view = model.mode === "still" ? null : foldView(snapshot, model.viewing.humanFolds, model.viewing.selection?.id ?? null);
  const shown = view?.nodes ?? model.snapshot.nodes;
  const heights = Object.fromEntries(HashMap.toEntries(model.nodeHeights).map(([id, height]) => [id, Math.round(height)]));
  const targets = layout(shown, heights);
  const ids = shown.map((node) => node.id);
  const parents = Object.fromEntries(shown.map((node) => [node.id, node.parent]));
  const shownIdOf = (id: string): string => keepTargetOf(view, id);
  const focus = cameraFocus(model.snapshot);
  const changed = changedFocus(model.snapshot, shownIdOf);
  const tree: VisibleTree = {
    ids,
    targets,
    parents,
    fold: view,
    currentTopic: model.snapshot.currentTopic,
  };
  const seen: Seen = {
    scope: model.mode,
    currentTopic: model.snapshot.currentTopic,
    round: model.snapshot.round,
    hasChanges: model.snapshot.lastChanged !== undefined || model.snapshot.changes.some((change) => change.round === model.snapshot.round),
    sideHidden: model.viewing.sideHidden === true,
    size: model.size,
    targets,
    positions: positionsOf(model.motion, targets),
    dims: Object.fromEntries(Object.entries(heights).map(([id, height]) => [id, { height }])),
    ids,
    parents,
    shownIdOf,
    focus: focus === null ? null : { ids: [...new Set(focus.ids.map(shownIdOf))], center: shownIdOf(focus.center) },
    changed,
    selection: model.viewing.selection,
  };
  return { view, shown, tree, seen };
};
type Surface = ReturnType<typeof surfaceOf>;

const drawnHeightOf = (model: Model, id: string): number => Option.getOrThrow(HashMap.get(model.nodeHeights, id));

export const displayedPositions = (model: Model): Record<string, Position> => surfaceOf(model).seen.positions;

const samePositions = (a: Record<string, Position>, b: Record<string, Position>): boolean => {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => b[id] !== undefined && a[id]!.x === b[id].x && a[id]!.y === b[id].y);
};

const followTarget = (before: Model, after: Model, previous: Seen, surface: Surface): Model => {
  if (after.mode === "still") return after;
  const target = surface.seen.targets;
  if (samePositions(previous.targets, target)) return after;
  const shown = HashMap.size(before.nodeHeights) === 0 ? {} : previous.positions;
  const start = startPositions(surface.shown, shown, target);
  return modifyFields(after, {
    motion: () => (samePositions(start, target) ? Option.none() : Option.some({ start: HashMap.fromIterable(Object.entries(start)), elapsedMs: 0 })),
  });
};

const seenAfterMotion = (model: Model, seen: Seen): Seen => ({ ...seen, positions: positionsOf(model.motion, seen.targets) });

export const fitsAllOf = (model: Model): Option.Option<boolean> => {
  const { seen } = surfaceOf(model);
  if (Option.isNone(seen.size)) return Option.none();
  const { width, height } = seen.size.value;
  if (!seen.ids.every((id) => seen.dims[id] !== undefined)) return Option.none();
  if (seen.ids.length === 0) return Option.some(true);
  const positions = seen.positions;
  const { x, y, zoom } = model.camera.viewport;
  const left = Math.min(...seen.ids.map((id) => positions[id]!.x));
  const top = Math.min(...seen.ids.map((id) => positions[id]!.y));
  const right = Math.max(...seen.ids.map((id) => positions[id]!.x + NODE_WIDTH));
  const bottom = Math.max(...seen.ids.map((id) => positions[id]!.y + seen.dims[id]!.height));
  return Option.some(left * zoom + x >= 0 && top * zoom + y >= 0 && right * zoom + x <= width && bottom * zoom + y <= height);
};

const updateCamera = (model: Model, input: CameraInput, previous: Seen, seen: Seen): Model =>
  modifyFields(model, { camera: () => stepCamera(model.camera, input, previous, seen) });

const keepsIdleTimer = (event: ViewingEvent): boolean => event.type === "side" || event.type === "select" || event.type === "deselect";

type PreviousSurface = { model: Model; surface: Surface };

const applyViewing = (model: Model, event: ViewingEvent, previous: PreviousSurface = { model, surface: surfaceOf(model) }, current: Surface = previous.surface): Model => {
  const { state, input, preserveIdleTimer } = reduceViewing(model.viewing, event, current.tree);
  const reduced = modifyFields(model, { viewing: () => state, idleStamp: (stamp) => (preserveIdleTimer || keepsIdleTimer(event) || (event.type === "timeMoved" && model.camera.mode === "auto") ? stamp : stamp + 1) });
  if (model.mode === "still") return reduced;
  const surface = state.humanFolds === model.viewing.humanFolds && state.selection?.id === model.viewing.selection?.id
    ? { ...current, seen: { ...current.seen, selection: state.selection, sideHidden: state.sideHidden === true } }
    : surfaceOf(reduced);
  const followed = followTarget(previous.model, reduced, previous.surface.seen, surface);
  const seen = seenAfterMotion(followed, surface.seen);
  return updateCamera(followed, input, previous.surface.seen, seen);
};

const reflectionOf = (before: PreviousSurface, after: Model, surface: Surface): ViewingEvent | null => {
  if (after.mode === "still" || before.model.snapshot.round === after.snapshot.round) return null;
  const replaced = relocations({ tree: before.surface.tree, snapshot: before.model.snapshot, selectedId: before.model.viewing.selection?.id ?? null }, { tree: surface.tree, snapshot: after.snapshot });
  return { type: "reflect", replaced };
};

const sameSnapshot = Schema.toEquivalence(Snapshot);
const NODE_DISPLAY_FIELDS = ["id", "parent", "kind", "text", "planStatus", "assignee", "assigneeSpeaker", "proposer", "due", "pointStatus", "talkStatus", "touchedAt"] as const satisfies readonly (keyof SnapshotNode)[];

function onlyDigressionChanged(before: Snapshot, after: Snapshot): boolean {
  if (before.currentTopic !== after.currentTopic || before.nodes.length !== after.nodes.length) return false;
  const markedDifferently = (old: SnapshotNode, next: SnapshotNode) => !!old.digression !== !!next.digression;
  if (!before.nodes.some((old, i) => markedDifferently(old, after.nodes[i]!))) return false;
  return before.nodes.every((old, i) => {
    const next = after.nodes[i]!;
    if (!NODE_DISPLAY_FIELDS.every((field) => old[field] === next[field])) return false;
    return markedDifferently(old, next) || (old.evidenceRound === next.evidenceRound
      && old.evidence.length === next.evidence.length && old.evidence.every((id, j) => id === next.evidence[j]));
  });
}

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

const CLICK_SLOP = 4;
const awayFrom = (press: { x: number; y: number }, x: number, y: number): boolean => Math.hypot(x - press.x, y - press.y) > CLICK_SLOP;
const startsPan = (button: number, ctrlKey: boolean): boolean => button <= 1 && !ctrlKey;
// MouseEvent.buttons のビットは主=1・右=2・中=4 で、button の番号（主=0・中=1）とは並びが違う。押したボタンに対応するビットを返す
const buttonsBit = (button: number): number => (button === 1 ? 4 : 1);

const movedByUser = (model: Model, viewport: Viewport): Model => {
  if (model.mode === "still") return model;
  const seen = surfaceOf(model).seen;
  return modifyFields(updateCamera(model, { type: "movedByUser", viewport }, seen, seen), { idleStamp: (stamp) => stamp + 1 });
};

const panBy = (model: Model, x: number, y: number): Model => movedByUser(model, { x: model.camera.viewport.x + x, y: model.camera.viewport.y + y, zoom: model.camera.viewport.zoom });

const zoomBy = (model: Model, point: { x: number; y: number }, factor: number): Model => movedByUser(model, zoomAtPoint(model.camera.viewport, point, factor));

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
  return (surfaceOf(after).view?.blink.size ?? 0) > 0 ? [RestartBlink()] : [];
};

export const changedSnapshot = (model: Model, snapshot: Snapshot): Model => update(model, Message.ChangedSnapshot({ snapshot })).model;

export const movedTime = (model: Model): Model => update(model, Message.MovedTime()).model;

const clickedNode = (model: Model, nodeId: string): Return => {
  const surface = surfaceOf(model);
  return surface.view?.openness[nodeId]?.state === "bundle" ? { model } : { model: applyViewing(model, { type: "select", id: nodeId }, { model, surface }), outMessage: OutMessage.SelectedNode({ nodeId }) };
};

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    MeasuredMapSurface: ({ width, height, nodeHeights }) => {
      const measured = modifyFields(model, {
        size: () => Option.some({ width, height }),
        nodeHeights: (current) => HashMap.setMany(current, Object.entries(nodeHeights)),
      });
      const heightsChanged = Object.entries(nodeHeights).some(([id, nodeHeight]) => Option.getOrUndefined(HashMap.get(model.nodeHeights, id)) !== nodeHeight);
      const previous = surfaceOf(model);
      const surface = surfaceOf(measured);
      const followed = followTarget(model, measured, previous.seen, surface);
      const sizeUnchanged = Option.isSome(model.size) && model.size.value.width === width && model.size.value.height === height;
      const changedHeights = Object.keys(nodeHeights).filter((id) => Option.getOrUndefined(HashMap.get(model.nodeHeights, id)) !== nodeHeights[id]);
      if (sizeUnchanged && changedHeights.length > 0 && changedHeights.every((id) => model.snapshot.nodes.find((n) => n.id === id)?.kind === "補足")) return { model: followed };
      const seen = seenAfterMotion(followed, surface.seen);
      return { model: updateCamera(followed, { type: "measured", heightsChanged }, previous.seen, seen) };
    },
    ChangedSnapshot: ({ snapshot }) => {
      const replaced = modifyFields(model, { snapshot: () => snapshot });
      const unchangedWhileHeld = sameNodes(model.snapshot.nodes, snapshot.nodes) && !sameFoldingContext(model.foldingContext, foldingContextOf(model.snapshot));
      if (model.mode === "live" && (changedOnlyCriteria(model.snapshot, snapshot) || unchangedWhileHeld)) return { model: replaced };
      if (sameSnapshot(model.snapshot, snapshot)) return { model: replaced };
      if (onlyDigressionChanged(model.snapshot, snapshot) && samePositions(surfaceOf(model).seen.targets, surfaceOf(replaced).seen.targets)) return { model: replaced };
      const refreshed = modifyFields(replaced, { foldingContext: () => foldingContextOf(snapshot) });
      const previous = { model, surface: surfaceOf(model) };
      const surface = surfaceOf(refreshed);
      const reflection = reflectionOf(previous, refreshed, surface);
      if (reflection !== null) return { model: applyViewing(refreshed, reflection, previous, surface) };
      const selectedSupplement = model.snapshot.nodes.some((node) => node.id === model.viewing.selection?.id && node.kind === "補足");
      const reconciled = refreshed.mode === "still" || !selectedSupplement ? refreshed : modifyFields(refreshed, {
        viewing: (state) => relocateSelection(state, relocations({ tree: previous.surface.tree, snapshot: model.snapshot, selectedId: state.selection?.id ?? null }, { tree: surface.tree, snapshot })),
      });
      const current = surfaceOf(reconciled);
      const followed = followTarget(model, reconciled, previous.surface.seen, current);
      if (snapshot.round === model.snapshot.round && snapshot.currentTopic === model.snapshot.currentTopic && snapshot.lastChanged === model.snapshot.lastChanged
        && sameNodes(model.snapshot.nodes.filter((n) => n.kind !== "補足"), snapshot.nodes.filter((n) => n.kind !== "補足"))) return { model: followed };
      const seen = seenAfterMotion(followed, current.seen);
      return { model: updateCamera(followed, { type: "replacedSnapshot" }, previous.surface.seen, seen) };
    },
    MovedTime: () => pressed(model, { type: "timeMoved" }),
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
      return { model: updateCamera(ticked, { type: "frame" }, surfaceOf(model).seen, surfaceOf(ticked).seen) };
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

function criteriaView(h: H, node: SnapshotNode, criteria: readonly string[]): Html | null {
  if (!criteria.length || !supportsCriteria(node.kind)) return null;
  return h.span([h.Class("map-node__criteria")], [
    h.span([h.Class("map-node__criteria-reserve"), h.AriaHidden(true)], criteria.map((axis) => h.span([], [axis]))),
    h.span([h.Class("map-node__criteria-value")], (node.criteria ?? []).map((axis) => h.span([], [axis]))),
  ]);
}

const digressionDescription = (h: H, node: SnapshotNode, openness: FoldView["openness"][string] | undefined) =>
  node.kind === "議題" && node.digression === true
    ? [h.AriaDescription(openness?.state === "bundle" ? "脱線した議題を含む" : "会議の目的に答えていない議題（脱線）")]
    : [];

const supplementClasses = (node: SnapshotNode): string => node.kind === "補足" ? classes("map-node--supplement", node.origin === "会議の外" && "map-node--external") : "";

function nodeBody(h: H, node: SnapshotNode, view: FoldView | null, selected: boolean, speakerNames: SpeakerNames, criteria: readonly string[]): Html {
  const openness = view?.openness[node.id];
  const fold = openness?.state === "folded" || openness?.state === "bundle" ? openness : null;
  const mark = markOf(node);
  const person = personLine(node, speakerNames);
  return h.div(
    [
      h.Class(
        classes("map-node", supplementClasses(node), node.kind === "案" && node.planStatus === "却下" && "map-node--rejected", node.kind === "議題" && node.digression === true && "map-node--digression", fold !== null && "map-node--folded", selected && "map-node--selected", view?.blink.has(node.id) === true && "map-node--blink", "nopan"),
      ),
      h.Style({ "--kind-color": KIND_COLOR[node.kind] }),
    ],
    [
      h.button(
        [h.Type("button"), h.Class(MAP_NODE_BUTTON_CLASS), h.AriaPressed(String(selected)), ...digressionDescription(h, node, openness)],
        [mark === null ? null : h.span([h.Class("map-node__mark")], [mark]), h.span([h.Class("map-node__text")], [node.text]), person === null ? null : h.span([h.Class("map-node__person text-[12px] text-gray-500")], [person]),
          criteriaView(h, node, criteria),
          fold?.hint ? h.span([h.Class("map-node__hint")], [fold.hint]) : null],
      ),
      fold === null
        ? null
        : h.button([h.Type("button"), h.Class(`map-node__count ${FOLD_DOT_CLASSES[0]}`), h.AriaLabel("開く"), h.OnClick(Message.ClickedFoldDot({ nodeId: node.id }))], [String(fold.hidden)]),
      openness?.state === "open" && openness.byHuman ? h.button([h.Type("button"), h.Class(FOLD_DOT_CLASSES[1]), h.AriaLabel("畳む"), h.OnClick(Message.ClickedFoldDot({ nodeId: node.id }))], []) : null,
    ],
  );
}

export const view = Submodel.defineView<Model, Message, { readonly notice: () => Html | null }>((model, slots, h): Html => {
  const { view: view_, tree, shown, seen } = surfaceOf(model);
  const selectedId = view_ === null ? null : (seen.selection?.id ?? null);
  const positions = seen.positions;
  const measured = shown.filter((n) => HashMap.has(model.nodeHeights, n.id));
  const viewport = model.camera.viewport;

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
      [nodeBody(h, node, view_, node.id === selectedId, model.speakerNames, model.snapshot.criteria ?? [])],
    ),
  );

  const dots =
    view_ === null || model.camera.mode === "auto"
      ? []
      : Option.match(model.size, {
          onNone: () => [],
          onSome: (size) =>
            edgeDots(
              tree.ids.filter((id) => view_.blink.has(id) && HashMap.has(model.nodeHeights, id)),
              tree.targets,
              seen.dims,
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
      h.div([h.Class("map-overlays")], [model.snapshot.criteria?.length ? h.div([h.Class("criteria-strip"), h.AriaLabel("判断軸（優先順）")], [
        h.span([], ["判断軸（優先順）"]),
        h.ol([], model.snapshot.criteria.map((axis) => h.li([], [axis]))),
      ]) : null, slots.notice()]),
      h.div([h.Class("map-viewport absolute left-0 top-0 w-full h-full origin-top-left pointer-events-none z-2"), h.Style({ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` })], [h.svg([h.Class("map-edges absolute left-0 top-0 w-[1px] h-[1px] overflow-visible pointer-events-none")], edges), h.div([h.Class("map-nodes absolute left-0 top-0 pointer-events-none")], nodes)]),
      ...(edgeDotButtons.length === 0 ? [] : [h.div([h.Class("edge-dots absolute inset-0 z-4 pointer-events-none overflow-hidden")], edgeDotButtons)]),
    ],
  );
});
