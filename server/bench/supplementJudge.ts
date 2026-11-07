import { NodeRuntime } from "@effect/platform-node";
import { Argument, Command } from "effect/cli";
import { exitNaturally } from "../src/exitNaturally.ts";
import { claudeJudge, type Judge } from "./claudeJudge.ts";
import { benchProgram } from "./entry.ts";
import { judgeSessions } from "./judgeSessions.ts";
import { judgeSupplements, SupplementLabel } from "./supplementJudgement.ts";

const OUTPUT = "supplementJudge.json";

export function createSupplementJudgeCommand<E, R>(judge: Judge<E, R>) {
  return Command.make("supplementJudge", {
    paths: Argument.String("session").pipe(
      Argument.withDescription("合成会議のセッションのフォルダ（log.jsonl があるフォルダ。実会議には使わない）"),
      Argument.atLeast(1),
    ),
  }, ({ paths }) => judgeSessions(paths, {
    header: "| セッション | 補足数 | 要る | 要らない | 誤り | 根拠なし | 出どころ違い |\n| --- | --- | --- | --- | --- | --- | --- |",
    output: OUTPUT,
    judge: (events) => judgeSupplements(events, judge),
    row: (session, result) => {
      const cells = SupplementLabel.literals.map((label) =>
        `${result.counts[label]}（${(result.ratios[label] * 100).toFixed(1)}%）`);
      return `| ${session} | ${result.total} | ${cells.join(" | ")} |`;
    },
  })).pipe(Command.withDescription("合成会議の最終マップの補足を1件ずつ判定し、5ラベルの件数と割合を出す（実会議には使わない。品質の合否は出さない）"));
}

if (import.meta.main) {
  benchProgram(createSupplementJudgeCommand(claudeJudge)).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
