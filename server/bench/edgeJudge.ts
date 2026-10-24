import { basename, join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { Argument, Command } from "effect/cli";
import { exitNaturally } from "../src/exitNaturally.ts";
import { readLogLines } from "../src/sessionFiles.ts";
import { claudeJudge, type Judge } from "./claudeJudge.ts";
import { benchProgram, InvalidInputFile, write } from "./entry.ts";
import { formatRow, judgeEdges } from "./edgeJudgement.ts";

const OUTPUT = "edgeJudge.json";

export function createEdgeJudgeCommand<E, R>(judge: Judge<E, R>) {
  return Command.make("edgeJudge", {
    paths: Argument.String("session").pipe(
      Argument.withDescription("合成会議のセッションのフォルダ（log.jsonl があるフォルダ）"),
      Argument.atLeast(1),
    ),
  }, Effect.fnUntraced(function* ({ paths }) {
    const fs = yield* FileSystem.FileSystem;
    yield* write("| セッション | 判定した辺 | 具体化 / 答え / 派生 / なし | なし |\n| --- | --- | --- | --- |");
    for (const dir of paths) {
      const path = join(dir, "log.jsonl");
      const { events } = yield* readLogLines(path).pipe(
        Effect.mapError((error) => new InvalidInputFile({
          path, reason: error._tag === "BrokenLogLine" ? `行 ${error.line} のJSONが不正です` : "ログの読込に失敗しました",
        })),
      );
      const result = yield* judgeEdges(events, judge).pipe(
        Effect.mapError((error) => new InvalidInputFile({ path, reason: error.message })),
      );
      const output = join(dir, OUTPUT);
      yield* fs.writeFileString(output, JSON.stringify(result.edges)).pipe(
        Effect.mapError(() => new InvalidInputFile({ path: output, reason: "判定結果の保存に失敗しました" })),
      );
      yield* write(formatRow(basename(dir), result));
    }
  })).pipe(Command.withDescription("合成会議の最終マップの辺の意味を判定し、本文を残さず件数と「なし」の割合を出す（実会議には使わない）"));
}

if (import.meta.main) {
  benchProgram(createEdgeJudgeCommand(claudeJudge)).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
