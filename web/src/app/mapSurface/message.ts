// マップの表示面（Issue #814）が受ける Message。表示面の要素の Mount が「測れた」という事実を 1 つの Message で届ける
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const Message = defineMessageUnion({
  // 表示面の大きさと、変わったノードの高さ（ノードの id → 高さ）。大きさだけが変わったときは nodeHeights が空になる
  MeasuredMapSurface: { width: Schema.Finite, height: Schema.Finite, nodeHeights: Schema.Record(Schema.String, Schema.Finite) },
});
export type Message = typeof Message.Type;
