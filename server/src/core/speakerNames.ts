import { Schema } from "effect";
import type { Remark } from "./remark.ts";

export type SpeakerNameSource = "推定" | "手入力";

export type SpeakerNameEntry = { readonly name: string; readonly source: SpeakerNameSource };

export type SpeakerNameTable = ReadonlyMap<string, SpeakerNameEntry>;

export const SpeakerNamesFrame = Schema.Struct({
  type: Schema.Literal("speaker-names"),
  names: Schema.Array(Schema.Struct({ label: Schema.String, name: Schema.String })),
});
export type SpeakerNamesFrame = typeof SpeakerNamesFrame["Type"];

export const SpeakerNameLogEvent = Schema.Struct({
  type: Schema.Literal("speaker-name"),
  label: Schema.String,
  name: Schema.String,
  source: Schema.Literals(["推定", "手入力"]),
});
export type SpeakerNameLogEvent = typeof SpeakerNameLogEvent["Type"];

export const restoreSpeakerName = (current: SpeakerNameTable, event: SpeakerNameLogEvent): SpeakerNameTable =>
  new Map(current).set(event.label, { name: event.name, source: event.source });

export const SPEAKER_NAME_BASES = ["名乗り", "呼びかけへの応答"] as const;
export type SpeakerNameBasis = (typeof SPEAKER_NAME_BASES)[number];

export const InferredSpeakerName = Schema.Struct({
  label: Schema.String.annotate({ description: "名前を付ける相手のラベル。行頭の「相手 X」（「（名前）」の部分は除く）" }),
  name: Schema.String.annotate({ description: "推定した名前。確かなときだけ出す" }),
  evidence: Schema.String.annotate({ description: "そのラベルが話した、名乗りまたは呼びかけへの応答の発言の id" }),
  basis: Schema.Literals(SPEAKER_NAME_BASES).annotate({ description: "根拠の種類。本人の名乗りか、呼びかけの直後の応答か" }),
});
export type InferredSpeakerName = typeof InferredSpeakerName["Type"];

export type SpeakerNameChange = { label: string; name: string } & ({ source: "手入力" } | { source: "推定"; basis: SpeakerNameBasis });
export const nameSpeaker = (current: SpeakerNameTable, change: SpeakerNameChange): SpeakerNameTable | undefined => {
  const name = change.name.trim();
  if (name === "") return undefined;
  const existing = current.get(change.label);
  if (existing?.source === "手入力" && change.source === "推定") return undefined;
  if (existing?.name === name && existing.source === change.source) return undefined;
  if (existing?.source === "推定" && change.source === "推定" && change.basis !== "名乗り") return undefined;
  return new Map(current).set(change.label, { name, source: change.source });
};

export const acceptInferredNames = (names: readonly InferredSpeakerName[] | undefined, known: ReadonlySet<string>, remarks: ReadonlyMap<string, Remark>): InferredSpeakerName[] =>
  (names ?? []).filter((n) => {
    if (!known.has(n.evidence)) return false;
    const remark = remarks.get(n.evidence);
    return remark !== undefined && remark.track === "相手" && remark.speaker === n.label;
  });

export const speakerNameMap = (table: SpeakerNameTable): ReadonlyMap<string, string> =>
  new Map([...table].map(([label, { name }]) => [label, name] as const));
