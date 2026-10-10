import { Schema } from "effect";

// 差分更新を開けなかった失敗。message は入口で改行を保って表示する。
export class UpdaterUnavailable extends Schema.TaggedError<UpdaterUnavailable>()("UpdaterUnavailable", {
  message: Schema.String,
}) {}
