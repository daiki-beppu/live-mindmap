// マップの表示面（Issue #814・#815）が受ける Message。Mount と Subscription は DOM で起きた事実だけを届け、パンの量・軸・クリックかドラッグかの判定は update が行う
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Snapshot } from "../../../../server/src/core/index.ts";

export const Message = defineMessageUnion({
  // --- 表示面の要素の Mount から ---
  // 表示面の大きさと、変わったノードの高さ（ノードの id → 高さ）。大きさだけが変わったときは nodeHeights が空になる
  MeasuredMapSurface: { width: Schema.Finite, height: Schema.Finite, nodeHeights: Schema.Record(Schema.String, Schema.Finite) },
  // 表示面でポインタを押した。insideNoPan は押した対象が .nopan の中（ノード）にあったこと
  PressedMapSurface: { clientX: Schema.Finite, clientY: Schema.Finite, button: Schema.Finite, ctrlKey: Schema.Boolean, insideNoPan: Schema.Boolean },
  // ノードのボタンを押した（修飾キーに関係なく）
  PressedNodeButton: { nodeId: Schema.String, clientX: Schema.Finite, clientY: Schema.Finite },
  // ノードのボタンの click（キーボードの click も含む）
  ClickedNodeButton: { nodeId: Schema.String, clientX: Schema.Finite, clientY: Schema.Finite },
  // 表示面の上の wheel。timeStamp はイベントの時刻（ms）
  WheeledMapSurface: {
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
    deltaMode: Schema.Finite,
    shiftKey: Schema.Boolean,
    ctrlKey: Schema.Boolean,
    metaKey: Schema.Boolean,
    timeStamp: Schema.Finite,
  },
  // --- 親から ---
  // マップ（Snapshot）が新しくなった（差分更新の反映）。位置は補間で新しい目標へ移る
  ChangedSnapshot: { snapshot: Snapshot },
  // --- 補間中の animationFrame の Subscription から ---
  // 前のフレームからの経過 ms
  TickedAnimationFrame: { deltaMs: Schema.Finite },
  // --- ポインタを押している間の文書全体の Subscription から ---
  MovedPointer: { clientX: Schema.Finite, clientY: Schema.Finite, buttons: Schema.Finite },
  ReleasedPointer: { ctrlKey: Schema.Boolean, metaKey: Schema.Boolean },
  CanceledPointer: {},
});
export type Message = typeof Message.Type;

// 親へ知らせる出来事。ノードが選ばれた（React 版の data.onSelect(id) にあたる）
export const OutMessage = defineMessageUnion({
  SelectedNode: { nodeId: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;
