import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Snapshot } from "../../../../server/src/core/index.ts";

const ViewKey = Schema.Literals(["=", "-", "0", "F", "Z", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"]);

export const Message = defineMessageUnion({
  MeasuredMapSurface: { width: Schema.Finite, height: Schema.Finite, nodeHeights: Schema.Record(Schema.String, Schema.Finite) },
  PressedMapSurface: { clientX: Schema.Finite, clientY: Schema.Finite, button: Schema.Finite, ctrlKey: Schema.Boolean, insideNoPan: Schema.Boolean },
  PressedNodeButton: { nodeId: Schema.String, clientX: Schema.Finite, clientY: Schema.Finite },
  ClickedNodeButton: { nodeId: Schema.String, clientX: Schema.Finite, clientY: Schema.Finite },
  ClickedFoldDot: { nodeId: Schema.String },
  ClickedEdgeDot: { nodeId: Schema.String },
  WheeledMapSurface: {
    x: Schema.Finite,
    y: Schema.Finite,
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
    deltaMode: Schema.Finite,
    shiftKey: Schema.Boolean,
    ctrlKey: Schema.Boolean,
    metaKey: Schema.Boolean,
    timeStamp: Schema.Finite,
  },
  ClickedMapSurfaceWithModifier: { x: Schema.Finite, y: Schema.Finite, ctrlKey: Schema.Boolean, metaKey: Schema.Boolean, altKey: Schema.Boolean },
  StartedMapSurfaceGesture: {},
  // Safari の gesture が変わった。scale は始まりからの累積の倍率（前回との比は update が求める）。x・y は位置（表示面の左上が原点）
  ChangedMapSurfaceGesture: { scale: Schema.Finite, x: Schema.Finite, y: Schema.Finite },
  ClickedChangeItem: { nodeId: Schema.String },
  ClickedEvidenceClose: {},
  ToggledSide: { isOpen: Schema.Boolean },
  ChangedSnapshot: { snapshot: Snapshot },
  MovedTime: {},
  PressedViewKey: { key: ViewKey, metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  PressedArrowKey: { dir: Schema.Literals(["left", "right", "up", "down"]), metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  PressedEscapeKey: { metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  PressedEnterKey: { metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  PressedSideKey: { metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  ToggledKeyList: {},
  CompletedRestartBlink: {},
  ElapsedIdleTime: {},
  TickedAnimationFrame: { deltaMs: Schema.Finite },
  MovedPointer: { clientX: Schema.Finite, clientY: Schema.Finite, buttons: Schema.Finite },
  ReleasedPointer: { ctrlKey: Schema.Boolean, metaKey: Schema.Boolean },
  CanceledPointer: {},
});
export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  SelectedNode: { nodeId: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;
