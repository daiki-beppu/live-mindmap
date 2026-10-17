// 話者の名前（Issue #1026、GLOSSARY「話者の名前」）。相手の話者のラベル（相手 B）に付く名前の型と規則。
// Node の実行環境に依存しない（ADR 0003）。名前は表示と差分更新の発言の行だけを変え、発言の話者（ラベル）は変えない。
import { Schema } from "effect";
import type { Remark } from "./remark.ts";

// 名前の出どころ。推定は AI が名乗り・呼びかけへの応答から付け、手入力は画面から付ける
export type SpeakerNameSource = "推定" | "手入力";

export type SpeakerNameEntry = { readonly name: string; readonly source: SpeakerNameSource };

// ラベル → 名前。付いた名前は外れない
export type SpeakerNameTable = ReadonlyMap<string, SpeakerNameEntry>;

// ブラウザへ送るフレーム。名前の表の全体（置き換える）。type で他のフレームと見分ける
export const SpeakerNamesFrame = Schema.Struct({
  type: Schema.Literal("speaker-names"),
  names: Schema.Array(Schema.Struct({ label: Schema.String, name: Schema.String })),
});
export type SpeakerNamesFrame = typeof SpeakerNamesFrame["Type"];

// log.jsonl に残す記録。付いた時刻は全行に付く at で表す。知らない種類として復元と cli play に読み飛ばされる
export const SpeakerNameLogEvent = Schema.Struct({
  type: Schema.Literal("speaker-name"),
  label: Schema.String,
  name: Schema.String,
  source: Schema.Literals(["推定", "手入力"]),
});
export type SpeakerNameLogEvent = typeof SpeakerNameLogEvent["Type"];

export const speakerNamesFrame = (table: SpeakerNameTable): SpeakerNamesFrame => ({
  type: "speaker-names",
  names: [...table].map(([label, { name }]) => ({ label, name })),
});

// 推定の根拠の種類。付け替えは名乗りのときだけ許す（aiRenameOnlyBySelfIntro）
export const SPEAKER_NAME_BASES = ["名乗り", "呼びかけへの応答"] as const;
export type SpeakerNameBasis = (typeof SPEAKER_NAME_BASES)[number];

// AI が差分操作と一緒に返す名前。evidence の発言の実在と話者はサーバーが確かめる（acceptInferredNames）
export const InferredSpeakerName = Schema.Struct({
  label: Schema.String.annotate({ description: "名前を付ける相手のラベル。行頭の「相手 X」（「（名前）」の部分は除く）" }),
  name: Schema.String.annotate({ description: "推定した名前。確かなときだけ出す" }),
  evidence: Schema.String.annotate({ description: "そのラベルが話した、名乗りまたは呼びかけへの応答の発言の id" }),
  basis: Schema.Literals(SPEAKER_NAME_BASES).annotate({ description: "根拠の種類。本人の名乗りか、呼びかけの直後の応答か" }),
});
export type InferredSpeakerName = typeof InferredSpeakerName["Type"];

// 名前を付ける規則。表が変わるときだけ新しい表を返し、変わらないときは undefined を返す（渡した表は書き換えない）。
// - namesNeverRemoved: 空（trim 後）の名前では付いた名前を外さない（名前を消す操作は無い）
// - manualNameSticks: 手入力の名前は手入力でしか替わらない（推定は変えない）
// - aiRenameOnlyBySelfIntro: 推定の名前を推定で替えるのは、名乗りを根拠にしたときだけ
// - 同じ名前・同じ出どころの入れ直しは変えない
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

// AI の名前のうち、根拠の発言が消費済み（known）で実在し、相手の発言で、その話者がラベルと一致するものだけを返す（順序は保つ）。
// 自分の発言は track が相手でないので根拠にならず、自分には名前が付かない
export const acceptInferredNames = (names: readonly InferredSpeakerName[] | undefined, known: ReadonlySet<string>, remarks: ReadonlyMap<string, Remark>): InferredSpeakerName[] =>
  (names ?? []).filter((n) => {
    if (!known.has(n.evidence)) return false;
    const remark = remarks.get(n.evidence);
    return remark !== undefined && remark.track === "相手" && remark.speaker === n.label;
  });

// 名前の表から、ラベル → 名前だけの Map を作る（差分更新の入力と書き出しの対応表が使う。出どころは持ち込まない）
export const speakerNameMap = (table: SpeakerNameTable): ReadonlyMap<string, string> =>
  new Map([...table].map(([label, { name }]) => [label, name] as const));
