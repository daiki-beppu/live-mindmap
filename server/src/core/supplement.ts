import { Schema } from "effect";
import { SupplementOrigin } from "./map.ts";

const Content = {
  text: Schema.String,
  evidence: Schema.mutable(Schema.Array(Schema.String)).check(Schema.isMinLength(1)),
  origin: SupplementOrigin,
};

export const SupplementOperation = Schema.Union([
  Schema.Struct({ op: Schema.Literal("add"), parent: Schema.String, ...Content }),
  Schema.Struct({ op: Schema.Literal("update"), node: Schema.String, ...Content }),
  Schema.Struct({ op: Schema.Literal("delete"), node: Schema.String }),
]);
export type SupplementOperation = typeof SupplementOperation.Type;
export const SupplementCategory = Schema.Literals(["用語", "背景", "案の違い", "理由", "前の決定とのつながり", "未確認", "推奨"]);
