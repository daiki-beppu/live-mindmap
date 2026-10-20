// 録画からのセッション（cli recorded）の進み具合。サーバーが NDJSON の 1 行ずつで流し、CLI が 1 行に整形して出す。
// Node の実行環境に依存しない（ADR 0003）。
import { Schema } from "effect";
import { DiffUpdateReason } from "./diffUpdate.ts";

// 録画からのセッションの経過を伝える 1 行。started の次から progress が続き、finished で終わる。
// finished の failure は、ヘルパーの起動し直しを諦めたとき（入れた分で終えた）の最後の終わり方と標準エラーの末尾
export const RecordedEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("vocabulary-excluded"), surfaces: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("started"), dir: Schema.String, warnings: Schema.Array(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    position: Schema.Finite, // セッションに入れた位置（秒）
    duration: Schema.NullOr(Schema.Finite), // 録画の全体の長さ（秒）。届く前は null
    rounds: Schema.Int, // マップの更新回数
    // 差分更新が利用上限で一時停止している間だけ付く。上限待ちの理由と、次に試す時刻（エポックからのミリ秒）
    paused: Schema.optionalKey(Schema.Struct({ reason: DiffUpdateReason, retryAt: Schema.Finite })),
  }),
  // 音声のトラックが 2 本以上ある。最初の 1 本だけを使った。count は本数
  Schema.Struct({ type: Schema.Literal("audio-tracks"), count: Schema.Int }),
  // 動画の映像が読めなかった。共有画面なしで、音声だけで続けた
  Schema.Struct({ type: Schema.Literal("screen-off") }),
  // 話者分離が使えなかった（モデルが無い・読み込みに失敗・途中で停止）。話者なしで続けた。reason はヘルパーの speaker-off と同じ
  Schema.Struct({ type: Schema.Literal("speaker-off"), reason: Schema.Literals(["モデルなし", "読み込みに失敗", "途中で停止"]) }),
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

// 例: 話者分離を使えません（モデルなし）。話者分離なしで続けます
export const formatSpeakerOffNotice = (reason: Extract<RecordedEvent, { type: "speaker-off" }>["reason"]): string =>
  `話者分離を使えません（${reason}）。話者分離なしで続けます`;

// 次に試す時刻（エポックミリ秒）を地方時の時:分にする
const formatRetryAt = (retryAt: number): string => {
  const date = new Date(retryAt);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
};

// 例: 12:30 / 58:04（進んだ位置 / 全体の長さ）
export const formatRecordedPosition = (position: number, duration: number | null): string =>
  `${formatClock(position)} / ${formatClock(duration)}`;

// 例: 12:30 / 58:04  マップの更新 3 回
// 一時停止の間は続けて、例: 12:30 / 58:04  マップの更新 3 回  ChatGPT の利用上限で待機中（次に試す時刻 3:47）
export const formatRecordedProgress = (progress: RecordedProgress): string => {
  const line = `${formatRecordedPosition(progress.position, progress.duration)}  マップの更新 ${progress.rounds} 回`;
  if (progress.paused === undefined) return line;
  return `${line}  ${progress.paused.reason}で待機中（次に試す時刻 ${formatRetryAt(progress.paused.retryAt)}）`;
};
