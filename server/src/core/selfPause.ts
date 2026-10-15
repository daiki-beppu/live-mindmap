// 自分の休止（Issue #1069・#1071）。ブラウザへ送るフレームと、log.jsonl に残す記録の形。
// Node の実行環境に依存しない（ADR 0003）。
import { Schema } from "effect";

// 休止の理由。helper が self-pause イベントの reason として流す値（helper/README.md「イベントの形」）。ログの reason にもそのまま写す。
// 手動: 画面の M などで手で選んだ。自動: 会議アプリがマイクを使っていない間の自動の休止。判定できない: マイクの使用を読めない間（取っている）
export const SelfPauseReason = Schema.Literals(["手動", "自動", "判定できない"]);
export type SelfPauseReason = typeof SelfPauseReason["Type"];

// ブラウザへ送るフレーム。paused が false のときは一言を消す。type で他のフレームと見分ける。
// 休止中は理由（手動 / 自動）を持つ。判定できないときは取っているので、休止のフレームには載らない
export const SelfPauseFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(true), reason: Schema.Literals(["手動", "自動"]) }),
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(false) }),
]);
export type SelfPauseFrame = typeof SelfPauseFrame["Type"];

// 画面が持つ、自分の休止の状態。休止中は理由（手動 / 自動）、休止していなければ false
export const SelfPaused = Schema.Union([Schema.Literal(false), Schema.Literals(["手動", "自動"])]);
export type SelfPaused = typeof SelfPaused["Type"];

// helper を起動し直すときに server が送り直す、休止の規則の状態（helper の SelfPauseCarryOver）。
// manual: 手動の状態、basis: 手動の基準、lastKnown: 最後に読めた値、idleFor: 「使っていない」が続いた秒数
export const SelfPauseState = Schema.Struct({
  manual: Schema.Literals(["none", "pause", "take"]),
  basis: Schema.Literals(["using", "idle", "unknown"]),
  lastKnown: Schema.Literals(["using", "idle", "unknown"]),
  idleFor: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SelfPauseState = typeof SelfPauseState["Type"];

// 何も引き継がない初期状態。起動の引数には、これと違う値だけを渡す
export const INITIAL_SELF_PAUSE_STATE: SelfPauseState = { manual: "none", basis: "unknown", lastKnown: "unknown", idleFor: 0 };

// log.jsonl に残す記録。休止に入ったとき self-paused、戻ったとき self-resumed の組になる。
// start は origin と同じ原点からの秒。知らない種類として復元と cli play に読み飛ばされる
export type SelfPauseLogEvent =
  | { type: "self-paused"; reason: SelfPauseReason; start: number }
  | { type: "self-resumed"; reason: SelfPauseReason; start: number };
