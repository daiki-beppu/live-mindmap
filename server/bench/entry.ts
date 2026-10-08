// bench の 4 本のスクリプトが共有する入口の部品。runMain は各スクリプトの入口だけが呼ぶ（ここでは呼ばない）。
// 引数の誤りは effect/cli の既定の Formatter が出力し、中身の失敗はタグ付きにして、入口で日本語の説明付きの 1 行（<パス>: <説明>（<理由>））にする。
import { Cause, Console, Effect, Result, Schema } from "effect";
import { CliError } from "effect/cli";
import { describe, fileReason, InvalidTruthFile, oneLine, readTextFile } from "../src/truthFile.ts";

// server/package.json は private で version を持たない。--version の正本はここ
export const BENCH_VERSION = "0.1.0";

// 発言・結果・行の時刻のファイルが読めない、または形が違う
export class InvalidInputFile extends Schema.TaggedError<InvalidInputFile>()("InvalidInputFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}

// セッションのフォルダが無い（読めない）
export class MissingSessionDir extends Schema.TaggedError<MissingSessionDir>()("MissingSessionDir", {
  path: Schema.String,
  reason: Schema.String,
}) {}

// 再生用のセッションを作れない、またはそのログを読めない
export class ReplaySessionFailed extends Schema.TaggedError<ReplaySessionFailed>()("ReplaySessionFailed", {
  path: Schema.String,
  reason: Schema.String,
}) {}

// 入口で 1 行にする失敗の class
const BENCH_FAILURES = [InvalidInputFile, InvalidTruthFile, MissingSessionDir, ReplaySessionFailed] as const;
type BenchFailure = InstanceType<(typeof BENCH_FAILURES)[number]>;

const isBenchFailure = (failure: unknown): failure is BenchFailure => BENCH_FAILURES.some((C) => failure instanceof C);

// 入口の表。タグ付きの失敗を「<パス>: <日本語の説明>（<詳細な理由>）」の 1 行にする（表示はここだけが持つ）
const failureLine = (failure: BenchFailure): string => {
  switch (failure._tag) {
    case "InvalidInputFile":
      return `${failure.path}: 入力ファイルを読めないか、形が違います（${failure.reason}）`;
    case "MissingSessionDir":
      return `${failure.path}: セッションのフォルダが無いか、読めません（${failure.reason}）`;
    case "InvalidTruthFile":
      return `${failure.path}: 正解ファイルが不正です（${failure.reason}）`;
    case "ReplaySessionFailed":
      return `${failure.path}: 再生のセッションを作れないか、そのログを読めません（${failure.reason}）`;
  }
};

// 失敗の表示はここだけ。CliError（help・引数の誤り）は effect/cli が出力済みなので二重に出さない
export const reportFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findError(cause);
  if (Result.isFailure(error)) return Console.error(describe(Cause.squash(cause)));
  const failure = error.success;
  if (CliError.isCliError(failure)) return Effect.void;
  return Console.error(isBenchFailure(failure) ? failureLine(failure) : describe(failure));
};

// 標準出力。Console.log が末尾に改行を足すので、改行で終わる文字列はその 1 つを外して渡す
// （出力のバイト列を今と同じに保つ。改行の規則はこの 1 か所だけが持つ）
export const write = (text: string) => Console.log(text.endsWith("\n") ? text.slice(0, -1) : text);

export const readInputText = (path: string) =>
  readTextFile(path).pipe(Effect.mapError((e) => new InvalidInputFile({ path, reason: fileReason(e) })));

export const inputFileError = (path: string) => (error: Schema.SchemaError) =>
  new InvalidInputFile({ path, reason: oneLine(error.message) });

// JSON のファイルを Schema で decode して読む
export const readJsonFile = <S extends Schema.Decoder<unknown>>(path: string, schema: S) =>
  readInputText(path).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(inputFileError(path))),
    ),
  );
