import { Console, Effect, type Runtime, Schema } from "effect";
import { Command } from "effect/cli";
import { NodeServices } from "@effect/platform-node";
import { exitCodeTeardown, reportEntryFailure } from "../src/entryFailure.ts";
import { StartupDepsMissing } from "../src/startupDepsMissing.ts";
import { describe, fileReason, InvalidTruthFile, oneLine, readTextFile } from "../src/truthFile.ts";

export const BENCH_VERSION = "0.1.0";

export class InvalidInputFile extends Schema.TaggedError<InvalidInputFile>()("InvalidInputFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}

export class MissingSessionDir extends Schema.TaggedError<MissingSessionDir>()("MissingSessionDir", {
  path: Schema.String,
  reason: Schema.String,
}) {}

export class ReplaySessionFailed extends Schema.TaggedError<ReplaySessionFailed>()("ReplaySessionFailed", {
  path: Schema.String,
  reason: Schema.String,
}) {}

const BENCH_FAILURES = [InvalidInputFile, InvalidTruthFile, MissingSessionDir, ReplaySessionFailed] as const;
type BenchFailure = InstanceType<(typeof BENCH_FAILURES)[number]>;

const isBenchFailure = (failure: unknown): failure is BenchFailure => BENCH_FAILURES.some((C) => failure instanceof C);

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

export const reportFailure = reportEntryFailure((failure) => Console.error(isBenchFailure(failure) ? failureLine(failure) : describe(failure)));

export const exitNaturallyForManagedDeps: Runtime.Teardown = exitCodeTeardown((failure) => (failure instanceof StartupDepsMissing ? 3 : undefined));

export const write = (text: string) => Console.log(text.endsWith("\n") ? text.slice(0, -1) : text);

export const readInputText = (path: string) =>
  readTextFile(path).pipe(Effect.mapError((e) => new InvalidInputFile({ path, reason: fileReason(e) })));

export const inputFileError = (path: string) => (error: Schema.SchemaError) =>
  new InvalidInputFile({ path, reason: oneLine(error.message) });

export const readJsonFile = <S extends Schema.Decoder<unknown>>(path: string, schema: S) =>
  readInputText(path).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(inputFileError(path))),
    ),
  );

export const benchProgram = <Name extends string, Input, Config, E, R>(command: Command.Command<Name, Input, Config, E, R>) =>
  Command.run(command, { version: BENCH_VERSION }).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(NodeServices.layer),
  );
