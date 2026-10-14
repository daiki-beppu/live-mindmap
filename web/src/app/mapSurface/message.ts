// マップの表示面（Issue #814・#815・#816・#819）が受ける Message。Mount と Subscription は DOM で起きた事実だけを届け、パンの量・軸・クリックかドラッグかの判定とズームの倍率・比の計算は update が行う
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Snapshot } from "../../../../server/src/core/index.ts";

// 倍率・位置を変えるキー（viewing.ts の ViewKey と同じ）
const ViewKey = Schema.Literals(["=", "-", "0", "F", "Z", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"]);

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
  // 隠れた数の丸・畳む小さな丸を押した（開閉の意味は update が reduceViewing で決める）
  ClickedFoldDot: { nodeId: Schema.String },
  // 縁の点を押した（そのノードへ寄る。意味は update が reduceViewing で決める）
  ClickedEdgeDot: { nodeId: Schema.String },
  // 表示面の上の wheel。timeStamp はイベントの時刻（ms）。x・y はポインタの位置（表示面の左上が原点）
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
  // 表示面で ⌘/Ctrl を押しながら click した（ノードの選択には届かない）。x・y は押した位置（表示面の左上が原点）
  ClickedMapSurfaceWithModifier: { x: Schema.Finite, y: Schema.Finite, ctrlKey: Schema.Boolean, metaKey: Schema.Boolean, altKey: Schema.Boolean },
  // Safari の gesture（トラックパッドのピンチ）が始まった
  StartedMapSurfaceGesture: {},
  // Safari の gesture が変わった。scale は始まりからの累積の倍率（前回との比は update が求める）。x・y は位置（表示面の左上が原点）
  ChangedMapSurfaceGesture: { scale: Schema.Finite, x: Schema.Finite, y: Schema.Finite },
  // --- 右の列から ---
  // 「変わったこと」の項目を押した（そのノードへ移る。祖先と開くかは update が畳む見せ方から求める）
  ClickedChangeItem: { nodeId: Schema.String },
  // 根拠のシートの閉じるボタンを押した（選びだけを外す。狭い幅でキーボードなしに選びを外す手段）
  ClickedEvidenceClose: {},
  // 右の列の Disclosure が出し入れを求めた（isOpen: 出す向きか）
  ToggledSide: { isOpen: Schema.Boolean },
  // --- 親から ---
  // マップ（Snapshot）が新しくなった（差分更新の反映）。位置は補間で新しい目標へ移る
  ChangedSnapshot: { snapshot: Snapshot },
  // 人が見返しの時刻を動かした（ボタン・シーク・キー。manual・overview なら自動のカメラへ戻る。時刻が変わらない操作でも戻る）
  MovedTime: {},
  // キー。意味（どの倍率・位置になるか）は update が reduceViewing で決める。修飾キーは押されていたかだけを届ける
  PressedViewKey: { key: ViewKey, metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  PressedArrowKey: { dir: Schema.Literals(["left", "right", "up", "down"]), metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  PressedEscapeKey: { metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  // Enter（選んだ議題・論点を開く・畳む）。選択があるかと、フォーカスがボタンの中かの判断は、キーの Subscription が済ませている
  PressedEnterKey: { metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  // E（右の列の出し入れ）。列の幅だけマップの大きさが変わるので、update は大きさの Message を待ってずらす
  PressedSideKey: { metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean },
  // キーの一覧（見返しの Popover）が開閉した。一覧の開閉の結果は見返しが持ち、表示面は見る状態を動かさず 10 秒の計り直し（idleStamp）だけを進める
  ToggledKeyList: {},
  // --- Command の完了 ---
  // 点滅（map-node--blink）のアニメーションを描画の確定の後に最初から再生し直した
  CompletedRestartBlink: {},
  // --- 見返しの 10 秒のタイマーの Subscription から ---
  // 触らずに 10 秒たった（見返しの manual のときだけ効く。時刻は update が読まず、Subscription が計る）
  ElapsedIdleTime: {},
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
