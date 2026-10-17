// 話者の名前（Issue #1026、GLOSSARY「話者の名前」）。相手の話者のラベル（相手 B）に付く名前の型と規則。
// Node の実行環境に依存しない（ADR 0003）。名前は表示と差分更新の発言の行だけを変え、発言の話者（ラベル）は変えない。
import { Schema } from "effect";

// 名前の出どころ。推定は後の sub-issue が書く。今回の画面とサーバーが書くのは手入力だけ
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
export type SpeakerNameLogEvent = { type: "speaker-name"; label: string; name: string; source: SpeakerNameSource };

export const speakerNamesFrame = (table: SpeakerNameTable): SpeakerNamesFrame => ({
  type: "speaker-names",
  names: [...table].map(([label, { name }]) => ({ label, name })),
});

// 名前を付ける規則。表が変わるときだけ新しい表を返し、変わらないときは undefined を返す（渡した表は書き換えない）。
// - namesNeverRemoved: 空（trim 後）の名前では付いた名前を外さない（名前を消す操作は無い）
// - manualNameSticks: 手入力の名前は手入力でしか替わらない（推定は変えない）
// - 同じ名前・同じ出どころの入れ直しは変えない
export const nameSpeaker = (current: SpeakerNameTable, change: { label: string; name: string; source: SpeakerNameSource }): SpeakerNameTable | undefined => {
  const name = change.name.trim();
  if (name === "") return undefined;
  const existing = current.get(change.label);
  if (existing?.source === "手入力" && change.source === "推定") return undefined;
  if (existing?.name === name && existing.source === change.source) return undefined;
  return new Map(current).set(change.label, { name, source: change.source });
};
