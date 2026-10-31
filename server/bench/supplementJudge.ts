import { basename, join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { Argument, Command } from "effect/cli";
import { exitNaturally } from "../src/exitNaturally.ts";
import { readLogLines } from "../src/sessionFiles.ts";
import { claudeJudge, type Judge } from "./claudeJudge.ts";
import { benchProgram, InvalidInputFile, write } from "./entry.ts";
import { judgeSupplements, SupplementLabel } from "./supplementJudgement.ts";

const OUTPUT = "supplementJudge.json";

export function createSupplementJudgeCommand<E, R>(judge: Judge<E, R>) {
  return Command.make("supplementJudge", {
    paths: Argument.String("session").pipe(
      Argument.withDescription("合成会議のセッションのフォルダ（log.jsonl があるフォルダ。実会議には使わない）"),
      Argument.atLeast(1),
    ),
  }, Effect.fnUntraced(function* ({ paths }) {
    const fs = yield* FileSystem.FileSystem;
    yield* write("| セッション | 補足数 | 要る | 要らない | 誤り | 根拠なし | 出どころ違い |\n| --- | --- | --- | --- | --- | --- | --- |");
    for (const dir of paths) {
      const path = join(dir, "log.jsonl");
      const { events } = yield* readLogLines(path).pipe(
        Effect.mapError((error) => new InvalidInputFile({
          path, reason: error._tag === "BrokenLogLine" ? `行 ${error.line} のJSONが不正です` : "ログの読込に失敗しました",
        })),
      );
      const result = yield* judgeSupplements(events, judge).pipe(
        Effect.mapError((error) => new InvalidInputFile({ path, reason: error.message })),
      );
      const output = join(dir, OUTPUT);
      yield* fs.writeFileString(output, JSON.stringify(result)).pipe(
        Effect.mapError(() => new InvalidInputFile({ path: output, reason: "判定結果の保存に失敗しました" })),
      );
      const cells = SupplementLabel.literals.map((label) =>
        `${result.counts[label]}（${(result.ratios[label] * 100).toFixed(1)}%）`);
      yield* write(`| ${basename(dir)} | ${result.total} | ${cells.join(" | ")} |`);
    }
  })).pipe(Command.withDescription("合成会議の最終マップの補足を1件ずつ判定し、5ラベルの件数と割合を出す（実会議には使わない。品質の合否は出さない）"));
}

if (import.meta.main) {
  benchProgram(createSupplementJudgeCommand(claudeJudge)).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
