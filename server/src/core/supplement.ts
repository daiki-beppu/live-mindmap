import { Schema, type Effect } from "effect";
import { SupplementOrigin, type MapNode } from "./map.ts";
import type { Remark } from "./remark.ts";
import type { DiffUpdateError, DiffUsage } from "./session.ts";

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

export const SupplementOutput = Schema.Struct({
  op: Schema.NullOr(SupplementOperation),
  category: Schema.NullOr(SupplementCategory),
  term: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter((value) => value.op === null || value.op.op === "delete"
  || (value.category !== null && (value.category !== "用語" || value.term !== undefined))
  || "補足の追加・言い直しには区分、用語には説明した語が必要"));
export type SupplementResult = typeof SupplementOutput.Type & { readonly usage?: DiffUsage };
export type SupplementContext = {
  readonly node: MapNode;
  readonly ancestors: readonly MapNode[];
  readonly siblings: readonly MapNode[];
  readonly supplement: MapNode | undefined;
  readonly evidence: readonly (Remark & { readonly speakerName?: string })[];
};
export type SupplementInput = {
  readonly targets: readonly SupplementContext[];
  readonly carriedTerms: readonly string[];
  readonly explainedTerms: readonly string[];
};
export type SupplementAsk = (input: SupplementInput) => Effect.Effect<SupplementResult, DiffUpdateError>;
