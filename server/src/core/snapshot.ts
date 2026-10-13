import { Schema } from "effect";
import { Change } from "./changes.ts";
import { MapNode, PointStatus } from "./map.ts";
import { Remark } from "./remark.ts";

// 論点の状態は保存していないので、スナップショットを作るときに導いて載せる
export const SnapshotNode = Schema.Struct({
  ...MapNode.fields,
  pointStatus: Schema.optionalKey(Schema.mutableKey(PointStatus)),
});
export type SnapshotNode = typeof SnapshotNode["Type"];
// 変わったこと（反映の履歴）。round は成功した反映の通し番号、at は反映に渡した新しい発言の end の最大値（会議の中の秒）。
export const ChangeEntry = Schema.Struct({
  ...Change.fields,
  round: Schema.mutableKey(Schema.Finite),
  at: Schema.mutableKey(Schema.Finite),
});
export type ChangeEntry = typeof ChangeEntry["Type"];
// remarks は、いまのノードの根拠に挙がっている発言だけ（受け取った順・重複なし）。evidence の ID から引く。
// currentTopic は今の議題の ID（まだ無ければキーごと付けない）。now は会議の今の時刻（最後に受け取った発言の end。発言が無ければキーごと付けない）。
// lastChanged は今の round で最後に変わったノードの ID（変わったノードが無ければキーごと付けない）。
export const Snapshot = Schema.Struct({
  nodes: Schema.mutableKey(Schema.mutable(Schema.Array(SnapshotNode))),
  round: Schema.mutableKey(Schema.Finite),
  changes: Schema.mutableKey(Schema.mutable(Schema.Array(ChangeEntry))),
  remarks: Schema.mutableKey(Schema.mutable(Schema.Array(Remark))),
  currentTopic: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  lastChanged: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  now: Schema.optionalKey(Schema.mutableKey(Schema.Finite)),
});
export type Snapshot = typeof Snapshot["Type"];

