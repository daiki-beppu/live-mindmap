import { Schema } from "effect";
import { DiffUpdateReason } from "./diffUpdate.ts";

export const OcrSummary = Schema.Struct({ failed: Schema.Int, images: Schema.Int });

export const formatOcrSummary = (summary: typeof OcrSummary.Type): string =>
  `共有画面の文字を読めなかった画面: ${summary.failed} / ${summary.images} 枚`;

export const RecordedEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("vocabulary-excluded"), surfaces: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("started"), dir: Schema.String, warnings: Schema.Array(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    position: Schema.Finite,
    duration: Schema.NullOr(Schema.Finite),
    rounds: Schema.Int,
    paused: Schema.optionalKey(Schema.Struct({ reason: DiffUpdateReason, retryAt: Schema.Finite })),
  }),
  Schema.Struct({ type: Schema.Literal("audio-tracks"), count: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("screen-off") }),
  Schema.Struct({ type: Schema.Literal("speaker-off"), reason: Schema.Literals(["モデルなし", "読み込みに失敗", "途中で停止"]) }),
  Schema.Struct({
    type: Schema.Literal("finished"),
    paths: Schema.Array(Schema.String),
    ocrSummary: OcrSummary,
    failure: Schema.optionalKey(Schema.Struct({
      code: Schema.NullOr(Schema.Finite),
      signal: Schema.NullOr(Schema.String),
      stderrTail: Schema.Array(Schema.String),
    })),
  }),
]);
export type RecordedEvent = typeof RecordedEvent["Type"];
export type RecordedProgress = Extract<RecordedEvent, { type: "progress" }>;

export const formatClock = (seconds: number | null): string => {
  if (seconds === null) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
};

export const formatAudioTracksNotice = (count: number): string =>
  `音声のトラックが ${count} 本あります。最初のトラックだけを使いました（分けたいときは --self を使えます）`;

export const formatScreenOffNotice = (): string => "動画の映像を読めませんでした。共有画面なしで、音声だけで続けました";

export const formatSpeakerOffNotice = (reason: Extract<RecordedEvent, { type: "speaker-off" }>["reason"]): string =>
  `話者分離を使えません（${reason}）。話者分離なしで続けます`;

const formatRetryAt = (retryAt: number): string => {
  const date = new Date(retryAt);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
};

export const formatRecordedPosition = (position: number, duration: number | null): string =>
  `${formatClock(position)} / ${formatClock(duration)}`;

export const formatRecordedProgress = (progress: RecordedProgress): string => {
  const line = `${formatRecordedPosition(progress.position, progress.duration)}  マップの更新 ${progress.rounds} 回`;
  if (progress.paused === undefined) return line;
  return `${line}  ${progress.paused.reason}で待機中（次に試す時刻 ${formatRetryAt(progress.paused.retryAt)}）`;
};
