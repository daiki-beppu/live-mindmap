// 録画からのセッション（cli recorded）の進み具合。サーバーが NDJSON の 1 行ずつで流し、CLI が 1 行に整形して出す。
// Node の実行環境に依存しない（ADR 0003）。
import { Schema } from "effect";

// 録画からのセッションの経過を伝える 1 行。started の次から progress が続き、finished で終わる。
// finished の failure は、ヘルパーが 0 以外で終わったとき（入れた分で終えた）の終わり方と標準エラーの末尾
export const RecordedEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), dir: Schema.String, warnings: Schema.Array(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    position: Schema.Finite, // セッションに入れた位置（秒）
    duration: Schema.NullOr(Schema.Finite), // 録画の全体の長さ（秒）。届く前は null
    rounds: Schema.Int, // マップの更新回数
  }),
  // 音声のトラックが 2 本以上ある。最初の 1 本だけを使った。count は本数
  Schema.Struct({ type: Schema.Literal("audio-tracks"), count: Schema.Int }),
  // 動画の映像が読めなかった。共有画面なしで、音声だけで続けた
  Schema.Struct({ type: Schema.Literal("screen-off") }),
  Schema.Struct({
    type: Schema.Literal("finished"),
    paths: Schema.Array(Schema.String),
    failure: Schema.optionalKey(Schema.Struct({
      code: Schema.NullOr(Schema.Finite),
      signal: Schema.NullOr(Schema.String),
      stderrTail: Schema.Array(Schema.String),
    })),
  }),
]);
export type RecordedEvent = typeof RecordedEvent["Type"];
export type RecordedProgress = Extract<RecordedEvent, { type: "progress" }>;

// 秒を m:ss（1 時間以上は h:mm:ss）にする。長さが届く前（null）は --:--
export const formatClock = (seconds: number | null): string => {
  if (seconds === null) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
};

// 例: 音声のトラックが 2 本あります。最初のトラックだけを使いました（分けたいときは --self を使えます）
export const formatAudioTracksNotice = (count: number): string =>
  `音声のトラックが ${count} 本あります。最初のトラックだけを使いました（分けたいときは --self を使えます）`;

// 録画で screen-off が届くのは、動画の映像が読めなかったときだけ
export const formatScreenOffNotice = (): string => "動画の映像を読めませんでした。共有画面なしで、音声だけで続けました";

// 例: 12:30 / 58:04  マップの更新 3 回
export const formatRecordedProgress = (progress: RecordedProgress): string =>
  `${formatClock(progress.position)} / ${formatClock(progress.duration)}  マップの更新 ${progress.rounds} 回`;
