// 自分の休止（Issue #1069）。ブラウザへ送るフレームと、log.jsonl に残す記録の形。
// Node の実行環境に依存しない（ADR 0003）。休止の理由は今は手動だけ（自動の休止はこのチケットに含めない）。
import { Schema } from "effect";

// helper が休止の理由として流す値（helper/README.md「イベントの形」）。ログの reason にもそのまま写す
export const SELF_PAUSE_REASON = "手動";

// ブラウザへ送るフレーム。paused が false のときは一言を消す。type で他のフレームと見分ける
export const SelfPauseFrame = Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Boolean });
export type SelfPauseFrame = typeof SelfPauseFrame["Type"];

// log.jsonl に残す記録。休止に入ったとき self-paused、戻ったとき self-resumed の組になる。
// start は origin と同じ原点からの秒。知らない種類として復元と cli play に読み飛ばされる
export type SelfPauseLogEvent =
  | { type: "self-paused"; reason: typeof SELF_PAUSE_REASON; start: number }
  | { type: "self-resumed"; reason: typeof SELF_PAUSE_REASON; start: number };
